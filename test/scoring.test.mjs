import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  extractKeywords, scoreRepo, explain, buildRepoQueries, mergeAndRank, parseArgs, stem, isList, isSkillRepo,
} from '../skills/findrepo/scripts/findrepo.mjs';

const NOW = Date.parse('2026-01-01T00:00:00Z');
const repo = (o = {}) => ({
  full_name: 'acme/rate-limiter', name: 'rate-limiter', html_url: 'https://github.com/acme/rate-limiter',
  description: 'A fast rate limiter', stargazers_count: 5000, forks_count: 100, open_issues_count: 5,
  language: 'Go', license: { spdx_id: 'MIT' }, topics: ['rate-limiting'], pushed_at: '2025-12-20T00:00:00Z',
  created_at: '2020-01-01T00:00:00Z', archived: false, fork: false, ...o,
});

test('extractKeywords strips filler words', () => {
  assert.deepEqual(extractKeywords('I need the best library for PDF parsing in Python'), ['pdf', 'parsing', 'python']);
  assert.deepEqual(extractKeywords('repo scout'), ['repo', 'scout']); // short queries keep meta nouns
  assert.ok(extractKeywords('a the for').length > 0); // falls back, never empty
  assert.equal(extractKeywords('a b c d e f g h', 3).length, 3);
});

test('stem matches word variants', () => {
  assert.equal(stem('limiter'), 'limit');
  assert.equal(stem('parsing'), 'pars');
  assert.equal(stem('go'), 'go');
});

test('active, licensed, relevant repo scores high', () => {
  const { score } = scoreRepo(repo(), { keywords: ['rate', 'limiter'], rank: 1, hits: 3 }, NOW);
  assert.ok(score > 80, `got ${score}`);
});

test('archived and stale repos are penalised', () => {
  const ctx = { keywords: ['rate', 'limiter'], rank: 1, hits: 1 };
  const good = scoreRepo(repo(), ctx, NOW).score;
  assert.ok(scoreRepo(repo({ archived: true }), ctx, NOW).score < good * 0.5);
  assert.ok(scoreRepo(repo({ pushed_at: '2021-01-01T00:00:00Z' }), ctx, NOW).score < good - 15);
  assert.ok(scoreRepo(repo({ license: null }), ctx, NOW).score < good);
});

test('off-topic mega repo does not beat on-topic repo', () => {
  const ctx = { keywords: ['rate', 'limiter'], rank: 0.9, hits: 1 };
  const mega = repo({ full_name: 'big/framework', name: 'framework', description: 'A web framework', topics: [], stargazers_count: 150000 });
  assert.ok(scoreRepo(repo({ stargazers_count: 800 }), ctx, NOW).score > scoreRepo(mega, ctx, NOW).score);
});

test('awesome lists are detected and demoted', () => {
  const list = repo({ full_name: 'x/awesome-go', name: 'awesome-go', description: 'A curated list of awesome Go rate limiter libs' });
  assert.ok(isList(list));
  assert.ok(!isList(repo()));
  const ctx = { keywords: ['rate', 'limiter'], rank: 1 };
  assert.ok(scoreRepo(list, ctx, NOW).score < scoreRepo(repo(), ctx, NOW).score);
});

test('explain produces warnings', () => {
  const r = repo({ archived: true, license: null, stargazers_count: 3, pushed_at: '2022-01-01T00:00:00Z' });
  const { warn } = explain(r, { relevance: 10 }, NOW);
  assert.ok(warn.some((w) => w.includes('ARCHIVED')));
  assert.ok(warn.includes('no clear license'));
  assert.ok(warn.some((w) => w.includes('2 years')));
});

test('buildRepoQueries applies filters', () => {
  const qs = buildRepoQueries(['rate', 'limiter'], { language: 'go', minStars: 100 });
  assert.equal(qs.length, 3);
  for (const { q } of qs) assert.match(q, /language:go stars:>=100 archived:false/);
  assert.match(qs[2].q, /^topic:rate-limiter/);
  assert.ok(!buildRepoQueries(['a'], { includeArchived: true })[0].q.includes('archived'));
});

test('mergeAndRank dedupes and sorts', () => {
  const a = repo(), b = repo({ full_name: 'other/thing', description: 'unrelated', topics: [], stargazers_count: 10 });
  const out = mergeAndRank([[a, b], [a]], ['rate', 'limiter'], NOW);
  assert.equal(out.length, 2);
  assert.equal(out[0].full_name, 'acme/rate-limiter');
  assert.ok(out[0].score > out[1].score);
});

test('isSkillRepo', () => {
  assert.ok(isSkillRepo({ full_name: 'a/b', topics: ['agent-skills'] }));
  assert.ok(isSkillRepo({ full_name: 'a/b', description: 'Claude skills for testing', topics: [] }));
  assert.ok(!isSkillRepo({ full_name: 'a/quiz', description: 'LinkedIn skill assessments', topics: [] }));
});

test('parseArgs', () => {
  const o = parseArgs(['repos', 'rate', 'limiter', '-l', 'go', '--min-stars=50', '--json']);
  assert.deepEqual(o._, ['repos', 'rate', 'limiter']);
  assert.equal(o.language, 'go');
  assert.equal(o['min-stars'], '50');
  assert.equal(o.json, true);
});

test('isAwesomeList rejects keyword-stuffed repos', async () => {
  const { isAwesomeList } = await import('../skills/findrepo/scripts/findrepo.mjs');
  assert.ok(isAwesomeList({ name: 'awesome-pdf', description: 'Awesome PDF tools', topics: [] }, ['pdf']));
  assert.ok(!isAwesomeList({ name: 'funNLP', description: 'awesome pdf text '.repeat(30), topics: [] }, ['pdf']));
  assert.ok(!isAwesomeList({ name: 'awesome-go', description: 'Go things and pdf', topics: [] }, ['pdf']));
});

test('auto-mode block is idempotent and removable', async () => {
  const { upsertBlock, removeBlock, AUTO_START } = await import('../skills/findrepo/scripts/findrepo.mjs');
  const once = upsertBlock('# My rules\n\nBe nice.\n');
  assert.ok(once.startsWith('# My rules') && once.includes(AUTO_START));
  assert.equal(upsertBlock(once), once);
  assert.equal(removeBlock(once), '# My rules\n\nBe nice.\n');
  assert.ok(upsertBlock('').startsWith(AUTO_START));
});

test('detectStack reads manifests', async () => {
  const { detectStack, median } = await import('../skills/findrepo/scripts/findrepo.mjs');
  const fs = await import('node:fs'); const os = await import('node:os'); const path = await import('node:path');
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  assert.equal(detectStack(d), null);
  fs.writeFileSync(path.join(d, 'package.json'), JSON.stringify({ dependencies: { Express: '^4' }, devDependencies: { vitest: '1' } }));
  const js = detectStack(d);
  assert.deepEqual(js.languages, ['javascript', 'typescript']);
  assert.ok(js.deps.includes('express') && js.deps.includes('vitest'));
  const p = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  fs.writeFileSync(path.join(p, 'requirements.txt'), 'requests==2.31\n# comment\nfastapi>=0.1\n');
  const py = detectStack(p);
  assert.deepEqual(py.languages, ['python']);
  assert.ok(py.deps.includes('requests') && py.deps.includes('fastapi'));
  const r = fs.mkdtempSync(path.join(os.tmpdir(), 'rs-'));
  fs.writeFileSync(path.join(r, 'Cargo.toml'), '[package]\nname = "x"\n\n[dependencies]\ntokio = "1"\nserde = { version = "1" }\n');
  assert.deepEqual(detectStack(r).deps.sort(), ['serde', 'tokio']);
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([]), null);
});

test('multi-language filter and momentum', () => {
  assert.match(buildRepoQueries(['x'], { language: 'javascript,typescript' })[0].q, /language:javascript language:typescript/);
  const young = repo({ created_at: '2025-07-01T00:00:00Z', stargazers_count: 4000 });
  assert.ok(explain(young, { relevance: 50 }, NOW).why.some((w) => w.startsWith('growing fast')));
  assert.ok(!explain(repo(), { relevance: 50 }, NOW).why.some((w) => w.startsWith('growing fast')));
});

test('short keywords match whole words only', async () => {
  const { matches } = await import('../skills/findrepo/scripts/findrepo.mjs');
  assert.ok(!matches('acme/report-scout builds reports', 'repo'));
  assert.ok(matches('x/findrepo finds repos', 'repo'));
  assert.ok(matches('uber-go/ratelimit', 'limiter'));
});
