#!/usr/bin/env node
// findrepo — find the best GitHub repositories and agent skills for any task.
// Zero dependencies. Requires Node.js 18+.
import { execSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const VERSION = '1.1.0';
const API = 'https://api.github.com';
const SKILLS_API = 'https://skills.sh/api/search';

// Filler is always dropped. Meta nouns ("repo", "library"...) are dropped only from longer, sentence-like
// queries, so short keyword queries such as "repo scout" or "github actions" stay intact.
const FILLER = new Set(`a an the for to of in on with and or best good great top most popular how do i we my our
need want find search looking look that this is are be can could should would some any which what build make create
using use like please help me there`.split(/\s+/));
const META = new Set(`repo repos repository repositories github library libraries tool tools project projects package packages`.split(/\s+/));

// ---------- pure helpers (exported for tests) ----------

export function extractKeywords(query, max = 5) {
  const words = String(query).toLowerCase().replace(/[^a-z0-9+#.\-\s]/g, ' ').split(/\s+/).filter(Boolean);
  const dropMeta = words.length > 3;
  const kept = [...new Set(words.filter((w) => !FILLER.has(w) && !(dropMeta && META.has(w)) && w.length > 1))];
  return (kept.length ? kept : [...new Set(words)]).slice(0, max);
}

/** Very light stemming so "limiter" matches "limit"/"limiting", "parsers" matches "parser". */
export function stem(word) {
  const w = word.toLowerCase();
  if (w.length <= 4) return w;
  return w.replace(/(ing|ers|er|ion|ions|es|s)$/, '') .replace(/(.)\1$/, '$1');
}

/** Substring match on the stem; short stems must start a word so "repo" does not match "report". */
export function matches(hay, keyword) {
  const st = stem(keyword);
  if (st.length > 4) return hay.includes(st);
  return hay.split(/[^a-z0-9+#]+/).some((t) => t === st || (t.startsWith(st) && t.length <= st.length + 1));
}

export function isList(repo) {
  const text = `${repo.name ?? repo.full_name ?? ''} ${repo.description ?? ''}`;
  return /\bawesome\b|curated list|a list of|collection of (awesome|resources|links)/i.test(text) ||
    (repo.topics ?? []).some((t) => t === 'awesome' || t === 'awesome-list');
}

export function daysSince(iso, now = Date.now()) {
  if (!iso) return Infinity;
  return Math.max(0, (now - new Date(iso).getTime()) / 86400000);
}

/** Score a repo 0-100. `ctx` = { keywords, rank (0..1, 1 = top search hit), hits (queries matched) } */
export function scoreRepo(repo, ctx = {}, now = Date.now()) {
  const keywords = ctx.keywords ?? [];
  const hay = `${repo.full_name} ${repo.description ?? ''} ${(repo.topics ?? []).join(' ')}`.toLowerCase();
  const coverage = keywords.length ? keywords.filter((k) => matches(hay, k)).length / keywords.length : 0.5;
  const multi = Math.min(1, ((ctx.hits ?? 1) - 1) / 2);
  const relevance = 0.55 * coverage + 0.3 * (ctx.rank ?? 0.5) + 0.15 * multi;

  const stars = repo.stargazers_count ?? 0;
  const popularity = Math.min(1, Math.log10(stars + 1) / 5); // 100k stars = 1.0

  const age = daysSince(repo.pushed_at, now);
  const activity = Math.pow(0.5, age / 240); // half-life of 8 months

  let health = 0;
  if (repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION') health += 0.4;
  if (repo.description) health += 0.2;
  if ((repo.topics ?? []).length) health += 0.2;
  if (!repo.fork) health += 0.2;

  let score = 100 * (0.35 * relevance + 0.25 * popularity + 0.25 * activity + 0.15 * health);
  // Popular-but-off-topic repos must not outrank on-topic ones.
  if (keywords.length) score *= 0.6 + 0.4 * coverage;
  // Link collections are surfaced separately as "curated lists", not as usable repos.
  if (ctx.demoteLists !== false && isList(repo)) score *= 0.6;
  if (repo.archived) score *= 0.4;
  if (repo.disabled) score *= 0.2;

  return {
    score: Math.round(score * 10) / 10,
    parts: {
      relevance: Math.round(relevance * 100),
      popularity: Math.round(popularity * 100),
      activity: Math.round(activity * 100),
      health: Math.round(health * 100),
    },
  };
}

export function explain(repo, parts, now = Date.now()) {
  const why = [];
  const warn = [];
  const age = daysSince(repo.pushed_at, now);
  if (parts.relevance >= 70) why.push('strong match for the query');
  if (repo.stargazers_count >= 10000) why.push('very widely adopted');
  else if (repo.stargazers_count >= 1000) why.push('well adopted');
  if (age <= 30) why.push('pushed in the last month');
  else if (age <= 180) why.push('active in the last 6 months');
  const lived = daysSince(repo.created_at, now);
  const perDay = lived >= 14 && lived !== Infinity ? (repo.stargazers_count ?? 0) / lived : 0;
  if (lived <= 730 && perDay >= 3) why.push(`growing fast (~${Math.round(perDay)} stars/day since creation)`);
  if (repo.license?.spdx_id && repo.license.spdx_id !== 'NOASSERTION') why.push(`${repo.license.spdx_id} license`);
  if (repo.archived) warn.push('ARCHIVED (read-only, unmaintained)');
  if (age > 730) warn.push('no pushes in over 2 years');
  else if (age > 365) warn.push('no pushes in over a year');
  if (!repo.license?.spdx_id || repo.license.spdx_id === 'NOASSERTION') warn.push('no clear license');
  if (repo.fork) warn.push('is a fork');
  if ((repo.stargazers_count ?? 0) < 50) warn.push('low adoption (<50 stars)');
  return { why, warn };
}

export function buildRepoQueries(keywords, opts = {}) {
  const kw = keywords.join(' ');
  const q = [];
  const quals = [];
  for (const l of String(opts.language ?? '').split(',').map((x) => x.trim()).filter(Boolean)) quals.push(`language:${l}`);
  if (opts.minStars) quals.push(`stars:>=${opts.minStars}`);
  if (opts.license) quals.push(`license:${opts.license}`);
  if (opts.since) quals.push(`pushed:>=${opts.since}`);
  if (!opts.includeArchived) quals.push('archived:false');
  const tail = quals.length ? ' ' + quals.join(' ') : '';
  q.push({ q: `${kw} in:name,description,topics${tail}`, sort: null });
  q.push({ q: `${kw} in:name,description,readme${tail}`, sort: 'stars' });
  if (keywords.length >= 1 && keywords.length <= 3) {
    q.push({ q: `topic:${keywords.join('-').replace(/[^a-z0-9-]/g, '')}${tail}`, sort: 'stars' });
  }
  return q;
}

export function mergeAndRank(resultSets, keywords, now = Date.now()) {
  const map = new Map();
  for (const items of resultSets) {
    const n = Math.max(items.length, 1);
    items.forEach((repo, i) => {
      const rank = 1 - i / n;
      const cur = map.get(repo.full_name);
      if (cur) { cur.hits += 1; cur.rank = Math.max(cur.rank, rank); }
      else map.set(repo.full_name, { repo, rank, hits: 1 });
    });
  }
  return [...map.values()]
    .map(({ repo, rank, hits }) => {
      const { score, parts } = scoreRepo(repo, { keywords, rank, hits }, now);
      return { ...slim(repo), score, parts, ...explain(repo, parts, now) };
    })
    .sort((a, b) => b.score - a.score);
}

function slim(r) {
  return {
    full_name: r.full_name, url: r.html_url, description: r.description ?? '',
    stars: r.stargazers_count ?? 0, forks: r.forks_count ?? 0, open_issues: r.open_issues_count ?? 0,
    language: r.language ?? null, license: r.license?.spdx_id ?? null, topics: r.topics ?? [],
    pushed_at: r.pushed_at, created_at: r.created_at, archived: !!r.archived, fork: !!r.fork,
  };
}

/** Detect the project's stack from manifest files so results fit it. Reads file names and dependency names only. */
export function detectStack(dir = process.cwd()) {
  const read = (f) => { try { return readFileSync(join(dir, f), 'utf8'); } catch { return null; } };
  const deps = new Set();
  const add = (n) => n && deps.add(String(n).toLowerCase());
  let languages = null, manifest = null;
  const set = (langs, file) => { if (!languages) { languages = langs; manifest = file; } };

  const pkg = read('package.json');
  if (pkg) {
    try {
      const j = JSON.parse(pkg);
      for (const k of ['dependencies', 'devDependencies', 'peerDependencies']) Object.keys(j[k] ?? {}).forEach(add);
    } catch { /* malformed manifest: still counts as a JS project */ }
    set(['javascript', 'typescript'], 'package.json');
  }
  const py = read('pyproject.toml'), req = read('requirements.txt');
  if (py || req) {
    for (const m of (req ?? '').matchAll(/^\s*([A-Za-z0-9_.-]+)/gm)) add(m[1]);
    for (const m of (py ?? '').matchAll(/^\s*["']?([A-Za-z0-9_.-]+)["']?\s*(?:=|[<>~!]=|\[)/gm)) add(m[1]);
    for (const m of (py ?? '').matchAll(/["']([A-Za-z0-9_.-]+)\s*(?:[<>=~!\[][^"']*)?["']\s*,?\s*$/gm)) add(m[1]);
    set(['python'], py ? 'pyproject.toml' : 'requirements.txt');
  }
  const gomod = read('go.mod');
  if (gomod) { for (const m of gomod.matchAll(/^\s*(?:require\s+)?([\w.-]+\.[a-z]+\/\S+)\s+v/gm)) add(m[1].split('/').pop()); set(['go'], 'go.mod'); }
  const cargo = read('Cargo.toml');
  if (cargo) {
    const sec = cargo.split(/^\[/m).filter((x) => /^(dev-|build-)?dependencies\]/.test(x)).join('\n');
    for (const m of sec.matchAll(/^([A-Za-z0-9_-]+)\s*=/gm)) add(m[1]);
    set(['rust'], 'Cargo.toml');
  }
  if (read('Gemfile')) set(['ruby'], 'Gemfile');
  const composer = read('composer.json');
  if (composer) { try { Object.keys(JSON.parse(composer).require ?? {}).forEach((n) => add(n.split('/').pop())); } catch { /* ignore */ } set(['php'], 'composer.json'); }
  if (existsSync(join(dir, 'pom.xml'))) set(['java', 'kotlin'], 'pom.xml');
  for (const f of ['build.gradle', 'build.gradle.kts']) if (existsSync(join(dir, f))) set(['java', 'kotlin'], f);
  if (existsSync(join(dir, 'pubspec.yaml'))) set(['dart'], 'pubspec.yaml');
  if (existsSync(join(dir, 'Package.swift'))) set(['swift'], 'Package.swift');
  if (!languages) {
    let files = [];
    try { files = readdirSync(dir); } catch { /* unreadable dir */ }
    const cs = files.find((f) => /\.(csproj|sln)$/.test(f));
    if (cs) set(['c#'], cs);
  }
  return languages ? { languages, manifest, deps: [...deps] } : null;
}

export function parseArgs(argv) {
  const opts = { _: [] };
  const alias = { l: 'language', n: 'limit', s: 'min-stars', h: 'help', v: 'version' };
  const bool = new Set(['global', 'remove', 'no-detect', 'no-cache', 'no-packages', 'json', 'help', 'version', 'include-archived', 'no-skills', 'no-lists']);
  for (let i = 0; i < argv.length; i++) {
    let a = argv[i];
    if (a === '--') { opts._.push(...argv.slice(i + 1)); break; }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2)) {
      let key = a.replace(/^-+/, ''); let val;
      if (key.includes('=')) [key, val] = [key.slice(0, key.indexOf('=')), key.slice(key.indexOf('=') + 1)];
      key = alias[key] ?? key;
      if (bool.has(key)) opts[key] = true;
      else opts[key] = val ?? argv[++i];
    } else opts._.push(a);
  }
  return opts;
}

// ---------- network ----------

let cachedToken;
function token() {
  if (cachedToken !== undefined) return cachedToken;
  cachedToken = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
  if (!cachedToken) {
    try { cachedToken = execSync('gh auth token', { stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).toString().trim(); }
    catch { cachedToken = ''; }
  }
  return cachedToken;
}

class ApiError extends Error {}

const CACHE_TTL_MS = 60 * 60 * 1000;
const CACHE_DIR = join(tmpdir(), 'findrepo-cache');
let cacheEnabled = !process.env.FINDREPO_NO_CACHE;

/** GET JSON with a 1-hour disk cache of successful public responses. Returns { status, body, headers }. */
async function getJson(url, headers = {}) {
  const file = join(CACHE_DIR, createHash('sha1').update(String(url)).digest('hex') + '.json');
  if (cacheEnabled) {
    try {
      if (Date.now() - statSync(file).mtimeMs < CACHE_TTL_MS) return { status: 200, body: JSON.parse(readFileSync(file, 'utf8')), headers: null };
    } catch { /* cache miss */ }
  }
  const res = await fetch(url, { headers: { 'User-Agent': `findrepo/${VERSION}`, ...headers }, signal: AbortSignal.timeout(20000) });
  const body = await res.json().catch(() => null);
  if (res.status === 200 && cacheEnabled && body != null) {
    try { mkdirSync(CACHE_DIR, { recursive: true }); writeFileSync(file, JSON.stringify(body)); } catch { /* cache is best-effort */ }
  }
  return { status: res.status, body, headers: res.headers };
}

async function gh(path, params = {}) {
  const url = new URL(API + path);
  for (const [k, v] of Object.entries(params)) if (v != null) url.searchParams.set(k, v);
  const headers = { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' };
  if (token()) headers.Authorization = `Bearer ${token()}`;
  const res = await getJson(url, headers);
  if (res.status === 404) return null;
  if (res.status !== 200) {
    const msg = res.body?.message ?? '';
    if ((res.status === 403 || res.status === 429) && (res.headers?.get('x-ratelimit-remaining') === '0' || /rate limit/i.test(msg))) {
      const reset = Number(res.headers?.get('x-ratelimit-reset')) * 1000;
      const wait = reset ? Math.max(1, Math.ceil((reset - Date.now()) / 1000)) : 60;
      throw new ApiError(`GitHub rate limit hit (resets in ~${wait}s). ${token() ? '' : 'Set GITHUB_TOKEN (or run `gh auth login`) for much higher limits.'}`);
    }
    throw new ApiError(`GitHub API ${res.status}: ${msg || 'request failed'}`);
  }
  return res.body;
}

async function searchRepos({ q, sort }, perPage = 30) {
  const data = await gh('/search/repositories', { q, sort: sort ?? undefined, order: sort ? 'desc' : undefined, per_page: perPage });
  return data?.items ?? [];
}

const settle = async (promises, errors) =>
  (await Promise.allSettled(promises)).map((r) => {
    if (r.status === 'fulfilled') return r.value;
    errors.push(r.reason?.message ?? String(r.reason));
    return [];
  });

export async function findRepos(query, opts = {}) {
  let keywords = extractKeywords(query);
  const errors = [];
  let ranked = [];
  // Relax the query (drop trailing keywords) if GitHub's AND-matching returns too little.
  for (let attempt = 0; attempt < 2 && keywords.length; attempt++) {
    const sets = await settle(buildRepoQueries(keywords, opts).map((qq) => searchRepos(qq)), errors);
    ranked = mergeAndRank(sets, keywords);
    if (ranked.length >= 5 || keywords.length <= 2 || errors.length) break;
    keywords = keywords.slice(0, keywords.length - 1);
  }
  if (!ranked.length && errors.length) throw new ApiError(errors[0]);
  const deps = new Set(opts.deps ?? []);
  for (const r of ranked) {
    if (deps.has(r.full_name.split('/')[1].toLowerCase())) { r.in_project = true; r.why.unshift('ALREADY A DEPENDENCY of this project'); }
  }
  return { keywords, repos: ranked.slice(0, Number(opts.limit) || 10), errors: [...new Set(errors)] };
}

export async function findLists(query) {
  const keywords = extractKeywords(query, 2);
  const items = await searchRepos({ q: `awesome ${keywords[0]} in:name stars:>=100 archived:false`, sort: 'stars' }, 20);
  return items.filter((r) => isAwesomeList(r, keywords)).slice(0, 3).map(slim);
}

/** Strict on purpose: keyword-stuffed descriptions are common, so require "awesome" in the name. */
export function isAwesomeList(r, keywords) {
  const desc = r.description ?? '';
  const name = (r.name ?? '').toLowerCase();
  return name.includes('awesome') && desc.length <= 300 && keywords.some((k) => name.includes(stem(k)));
}

export async function findSkills(query, opts = {}) {
  const keywords = extractKeywords(query, 4);
  const kw = keywords.join(' ');
  const errors = [];
  const limit = Number(opts.limit) || 10;

  const registry = (async () => {
    const url = `${SKILLS_API}?q=${encodeURIComponent(kw)}&limit=${limit}`;
    const res = await getJson(url);
    if (res.status !== 200) throw new Error(`skills.sh search returned ${res.status}`);
    const data = res.body ?? {};
    return (data.skills ?? []).map((s) => ({
      name: s.name ?? s.skillId ?? s.id, source: s.source ?? s.topSource ?? '', installs: s.installs ?? 0,
      url: s.source ? `https://skills.sh/${s.source}/${s.skillId ?? s.name}` : null,
      install: s.source ? `npx skills add ${s.source} --skill ${s.skillId ?? s.name}` : null,
    }));
  })();

  const repoQueries = ['agent-skills', 'claude-skills'].map((t) =>
    searchRepos({ q: `${kw} topic:${t} archived:false`, sort: 'stars' }, 15));
  const generic = searchRepos({ q: `${kw} agent skills in:name,description archived:false`, sort: 'stars' }, 15);

  const [reg, ...sets] = await settle([registry, ...repoQueries, generic], errors);
  const repos = mergeAndRank(sets, keywords)
    .filter(isSkillRepo)
    .slice(0, limit)
    .map((r) => ({ ...r, install: `npx skills add ${r.full_name}` }));
  return { keywords, skills: reg.sort((a, b) => b.installs - a.installs), repos, errors: [...new Set(errors)] };
}

const cleanRepoUrl = (u) => (u ? String(u).replace(/^git\+/, '').replace(/^git:\/\//, 'https://').replace(/\.git$/, '') : null);

/** Search package registries. Download counts show real usage, which stars cannot. */
export async function findPackages(query, opts = {}) {
  const keywords = extractKeywords(query, 4);
  const kw = encodeURIComponent(keywords.join(' '));
  const limit = Math.min(Number(opts.limit) || 5, 10);
  const langs = String(opts.language ?? '').toLowerCase().split(',').map((x) => x.trim()).filter(Boolean);
  const wants = (...ls) => !langs.length || ls.some((l) => langs.includes(l));
  const errors = [];
  const tasks = [];
  if (wants('javascript', 'typescript')) tasks.push((async () => {
    const res = await getJson(`https://registry.npmjs.org/-/v1/search?text=${kw}&size=${limit}`);
    if (res.status !== 200) throw new Error(`npm search returned ${res.status}`);
    return (res.body?.objects ?? []).map((o) => ({
      registry: 'npm', name: o.package.name, description: o.package.description ?? '', version: o.package.version,
      downloads: o.downloads?.weekly ?? null, period: 'week', license: o.package.license ?? null,
      updated: o.package.date ?? null, url: o.package.links?.npm ?? `https://www.npmjs.com/package/${o.package.name}`,
      repo: cleanRepoUrl(o.package.links?.repository), install: `npm install ${o.package.name}`,
    }));
  })());
  if (wants('rust')) tasks.push((async () => {
    const res = await getJson(`https://crates.io/api/v1/crates?q=${kw}&per_page=${limit}`);
    if (res.status !== 200) throw new Error(`crates.io search returned ${res.status}`);
    return (res.body?.crates ?? []).map((c) => ({
      registry: 'crates.io', name: c.name, description: (c.description ?? '').trim(), version: c.max_stable_version ?? c.max_version,
      downloads: c.recent_downloads ?? null, period: '90 days', license: null, updated: c.updated_at ?? null,
      url: `https://crates.io/crates/${c.name}`, repo: cleanRepoUrl(c.repository), install: `cargo add ${c.name}`,
    }));
  })());
  const sets = await settle(tasks, errors);
  const deps = new Set(opts.deps ?? []);
  const packages = sets.flat().map((p) => (deps.has(p.name.toLowerCase()) ? { ...p, in_project: true } : p));
  return { keywords, packages, searched: tasks.length > 0, errors: [...new Set(errors)] };
}

export function median(nums) {
  if (!nums.length) return null;
  const a = [...nums].sort((x, y) => x - y), m = a.length >> 1;
  return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
}

async function scorecard(owner, name) {
  const res = await getJson(`https://api.securityscorecards.dev/projects/github.com/${owner}/${name}`);
  if (res.status !== 200 || typeof res.body?.score !== 'number') return null;
  const weak = (res.body.checks ?? []).filter((c) => c.score >= 0 && c.score <= 3).map((c) => c.name);
  return { score: res.body.score, date: res.body.date, weak_checks: weak };
}

export function isSkillRepo(r) {
  const topics = r.topics ?? [];
  if (topics.some((t) => /^(agent|claude|claude-code|codex|ai|cursor)-?skills?$|^skills$/.test(t))) return true;
  return /(agent|claude|codex|cursor|copilot|ai)[- ]?(code[- ])?skills?|skill\.md|skills? for (ai|agents?|claude|codex|coding)/i
    .test(`${r.full_name} ${r.description ?? ''}`);
}

export async function inspectRepo(fullName) {
  const m = String(fullName).replace(/^https?:\/\/github\.com\//, '').replace(/\.git$/, '').match(/^([\w.-]+)\/([\w.-]+)/);
  if (!m) throw new ApiError(`Expected owner/repo, got "${fullName}"`);
  const base = `/repos/${m[1]}/${m[2]}`;
  const repo = await gh(base);
  if (!repo) throw new ApiError(`Repository ${m[1]}/${m[2]} not found`);
  const opt = (p) => p.catch(() => null);
  const [release, community, contributors, commits, closed, advisories, card] = await Promise.all([
    opt(gh(`${base}/releases/latest`)), opt(gh(`${base}/community/profile`)),
    opt(gh(`${base}/contributors`, { per_page: 100 })), opt(gh(`${base}/commits`, { per_page: 1 })),
    opt(gh(`${base}/issues`, { state: 'closed', sort: 'updated', direction: 'desc', per_page: 100 })),
    opt(gh(`${base}/security-advisories`, { per_page: 30 })), opt(scorecard(m[1], m[2])),
  ]);
  const closedIssues = (Array.isArray(closed) ? closed : []).filter((i) => !i.pull_request && i.closed_at);
  const closeDays = median(closedIssues.map((i) => (new Date(i.closed_at) - new Date(i.created_at)) / 86400000));
  const advs = (Array.isArray(advisories) ? advisories : []).filter((a) => a.state === 'published' || !a.state);
  const { score, parts } = scoreRepo(repo, { keywords: [], rank: 0.5, demoteLists: false });
  const info = explain(repo, parts);
  const nContrib = Array.isArray(contributors) ? contributors.length : null;
  if (nContrib === 1) info.warn.push('single contributor (bus factor 1)');
  if (release && daysSince(release.published_at) < 180) info.why.push('recent release');
  if (card?.score >= 7) info.why.push(`strong OpenSSF Scorecard (${card.score}/10)`);
  if (card && card.score < 4) info.warn.push(`weak OpenSSF Scorecard (${card.score}/10)`);
  if (closeDays != null && closeDays > 90) info.warn.push('issues are slow to close');
  return {
    ...slim(repo), score, parts, ...info,
    default_branch: repo.default_branch, homepage: repo.homepage || null, subscribers: repo.subscribers_count ?? null,
    latest_release: release ? { tag: release.tag_name, published_at: release.published_at } : null,
    last_commit: commits?.[0]?.commit?.committer?.date ?? null,
    contributors: nContrib == null ? null : nContrib >= 100 ? '100+' : nContrib,
    community_health: community?.health_percentage ?? null,
    issues: closedIssues.length ? { sample: closedIssues.length, median_days_to_close: Math.round(closeDays * 10) / 10 } : null,
    security: {
      openssf_scorecard: card,
      published_advisories: advs.length >= 30 ? '30+' : advs.length,
      recent_advisories: advs.slice(0, 3).map((a) => ({ id: a.ghsa_id, severity: a.severity, summary: a.summary, published_at: a.published_at, url: a.html_url })),
    },
    has: community ? Object.fromEntries(['readme', 'license', 'contributing', 'code_of_conduct'].map((k) => [k, !!community.files?.[k]])) : null,
  };
}

// ---------- auto mode ----------

export const AUTO_START = '<!-- findrepo:start -->';
export const AUTO_END = '<!-- findrepo:end -->';
export const AUTO_BLOCK = `${AUTO_START}
## Reuse before you build (findrepo)

Before writing a non-trivial component, choosing a dependency, or starting a workflow you have no skill for,
use the \`findrepo\` skill to search for an existing maintained GitHub repository or agent skill.
Skip this for small edits, questions and debugging.

- Search and compare without asking. Tell me in one line what you found and what you picked.
- Ask me before installing a skill, adding a dependency, or cloning and running code from a repo.
- Avoid archived, unlicensed or stale projects unless nothing better exists, and say so.
${AUTO_END}`;

/** Insert or refresh the auto-mode block in an instructions file's text. Idempotent. */
export function upsertBlock(text, block = AUTO_BLOCK) {
  const i = text.indexOf(AUTO_START), j = text.indexOf(AUTO_END);
  if (i !== -1 && j > i) return text.slice(0, i) + block + text.slice(j + AUTO_END.length);
  return (text.trim() ? text.replace(/\s*$/, '\n\n') : '') + block + '\n';
}

export function removeBlock(text) {
  const i = text.indexOf(AUTO_START), j = text.indexOf(AUTO_END);
  if (i === -1 || j < i) return text;
  return (text.slice(0, i).replace(/\s*$/, '\n') + text.slice(j + AUTO_END.length).replace(/^\s*/, '\n')).replace(/^\n+/, '').replace(/\n+$/, '\n');
}

async function initCommand(o) {
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  let files;
  if (o.file) files = [o.file];
  else if (o.global) files = [path.join(os.homedir(), '.claude', 'CLAUDE.md')];
  else {
    files = ['CLAUDE.md', 'AGENTS.md'].filter((f) => fs.existsSync(f));
    if (!files.length) files = ['CLAUDE.md', 'AGENTS.md'];
  }
  for (const f of files) {
    const before = fs.existsSync(f) ? fs.readFileSync(f, 'utf8') : '';
    const after = o.remove ? removeBlock(before) : upsertBlock(before);
    if (after === before) { console.log(`unchanged  ${f}`); continue; }
    fs.mkdirSync(path.dirname(path.resolve(f)), { recursive: true });
    fs.writeFileSync(f, after);
    console.log(`${o.remove ? 'removed from' : before ? 'updated' : 'created'}  ${f}`);
  }
  if (!o.remove) console.log('\nAuto mode is on: agents reading these files will check for existing repos and skills before building.\nUndo with: findrepo init --remove');
}

// ---------- rendering ----------

const fmtNum = (n) => (n >= 1000 ? `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k` : String(n));
const fmtBig = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : fmtNum(n));
const fmtAge = (iso) => {
  const d = daysSince(iso);
  if (d === Infinity) return 'unknown';
  if (d < 1) return 'today';
  if (d < 30) return `${Math.round(d)}d ago`;
  if (d < 365) return `${Math.round(d / 30)}mo ago`;
  return `${(d / 365).toFixed(1)}y ago`;
};
const clip = (s, n = 160) => (s.length > n ? s.slice(0, n - 1) + '…' : s);

function renderRepo(r, i) {
  const lines = [`${i + 1}. **[${r.full_name}](${r.url})** — score ${r.score}/100`];
  if (r.description) lines.push(`   ${clip(r.description)}`);
  lines.push(`   ★ ${fmtNum(r.stars)} · ${r.language ?? 'n/a'} · ${r.license ?? 'no license'} · pushed ${fmtAge(r.pushed_at)}`);
  if (r.why.length) lines.push(`   + ${r.why.join('; ')}`);
  if (r.warn.length) lines.push(`   ! ${r.warn.join('; ')}`);
  return lines.join('\n');
}

function renderErrors(errors) {
  return errors?.length ? `\n> Note: some lookups failed, results may be incomplete: ${errors.join(' | ')}\n` : '';
}

function renderRepos(res) {
  if (!res.repos.length) return `No repositories found for keywords: ${res.keywords.join(', ')}. Try fewer or different keywords.\n`;
  return `## Repositories (keywords: ${res.keywords.join(', ')})\n\n${res.repos.map(renderRepo).join('\n\n')}\n${renderErrors(res.errors)}`;
}

function renderSkills(res) {
  let out = `## Agent skills (keywords: ${res.keywords.join(', ')})\n\n`;
  if (!res.skills.length && !res.repos.length) return out + 'No skills found. Try broader keywords.\n' + renderErrors(res.errors);
  if (res.skills.length) {
    out += '### From the skills.sh registry\n\n' + res.skills.map((s, i) =>
      `${i + 1}. **${s.name}** (${s.source}) — ${fmtNum(s.installs)} installs\n   ${s.url}\n   install: \`${s.install}\``).join('\n\n') + '\n\n';
  }
  if (res.repos.length) {
    out += '### Skill repositories on GitHub\n\n' + res.repos.map((r, i) => `${renderRepo(r, i)}\n   install: \`${r.install}\``).join('\n\n') + '\n';
  }
  return out + renderErrors(res.errors);
}

function renderPackages(res) {
  if (!res?.packages?.length) return '';
  return `## Packages (real download counts)\n\n${res.packages.map((p) =>
    `- **${p.name}** (${p.registry})${p.in_project ? ' [ALREADY IN THIS PROJECT]' : ''} — ${p.downloads == null ? 'downloads n/a' : `${fmtBig(p.downloads)} downloads/${p.period}`}${p.updated ? ` · updated ${fmtAge(p.updated)}` : ''}${p.license ? ` · ${p.license}` : ''}\n  ${clip(p.description, 120)}\n  \`${p.install}\`${p.repo ? ` · ${p.repo}` : ''}`).join('\n')}\n${renderErrors(res.errors)}`;
}

function renderLists(lists) {
  if (!lists.length) return '';
  return `## Curated lists worth browsing\n\n${lists.map((r) => `- [${r.full_name}](${r.url}) ★ ${fmtNum(r.stars)} — ${clip(r.description, 120)}`).join('\n')}\n`;
}

function renderInspect(r) {
  const yes = (b) => (b ? 'yes' : 'no');
  return [
    `## ${r.full_name} — score ${r.score}/100`, r.url, '', r.description, '',
    `- Stars: ${fmtNum(r.stars)} · Forks: ${fmtNum(r.forks)} · Open issues+PRs: ${fmtNum(r.open_issues)}`,
    `- Language: ${r.language ?? 'n/a'} · License: ${r.license ?? 'none'}`,
    `- Last commit: ${fmtAge(r.last_commit ?? r.pushed_at)} · Created: ${fmtAge(r.created_at)}`,
    `- Latest release: ${r.latest_release ? `${r.latest_release.tag} (${fmtAge(r.latest_release.published_at)})` : 'none published'}`,
    `- Contributors: ${r.contributors ?? 'unknown'}`,
    r.community_health != null ? `- Community health: ${r.community_health}% (README ${yes(r.has.readme)}, LICENSE ${yes(r.has.license)}, CONTRIBUTING ${yes(r.has.contributing)}, CoC ${yes(r.has.code_of_conduct)})` : null,
    r.issues ? `- Issues: median ${r.issues.median_days_to_close} days to close (last ${r.issues.sample} closed)` : null,
    r.security.openssf_scorecard
      ? `- Security: OpenSSF Scorecard ${r.security.openssf_scorecard.score}/10 (${r.security.openssf_scorecard.date})${r.security.openssf_scorecard.weak_checks.length ? `, weak on: ${r.security.openssf_scorecard.weak_checks.join(', ')}` : ''}`
      : '- Security: no OpenSSF Scorecard published for this repo',
    `- Published security advisories: ${r.security.published_advisories}${r.security.recent_advisories.length ? ` — latest: ${r.security.recent_advisories.map((a) => `${a.severity ?? 'unknown'} "${clip(a.summary ?? '', 70)}"`).join('; ')}` : ''}`,
    `- Score breakdown: popularity ${r.parts.popularity}, activity ${r.parts.activity}, health ${r.parts.health}`,
    r.why.length ? `- Strengths: ${r.why.join('; ')}` : null,
    r.warn.length ? `- Warnings: ${r.warn.join('; ')}` : null, '',
  ].filter((l) => l != null).join('\n');
}

const HELP = `findrepo ${VERSION} — find the best GitHub repos and agent skills for any task

Usage:
  findrepo <query>                 Search repos, skills and curated lists together
  findrepo repos <query>           Search and rank repositories only
  findrepo skills <query>          Search agent skills (skills.sh + GitHub)
  findrepo packages <query>        Search npm and crates.io with download counts
  findrepo inspect <owner/repo>    Health + security check on one repository
  findrepo compare <a/b> <c/d>...  Inspect several repositories side by side
  findrepo init [--global]         Turn on auto mode: add the reuse-first rule to CLAUDE.md / AGENTS.md
                                     (--global = ~/.claude/CLAUDE.md, --file <path>, --remove to undo)

Options:
  -l, --language <lang>   Only repos in this language (e.g. python, or javascript,typescript).
                          Default: detected from the project in the current directory
      --no-detect         Do not detect the project's stack; search all languages
      --no-cache          Bypass the 1-hour response cache
  -s, --min-stars <n>     Minimum star count
  -n, --limit <n>         Results per section (default 10)
      --license <spdx>    Only this license (e.g. mit, apache-2.0)
      --since <date>      Only repos pushed since YYYY-MM-DD
      --include-archived  Include archived repositories
      --no-skills         Skip the skills section in combined search
      --no-lists          Skip the curated-lists section in combined search
      --no-packages       Skip the packages section in combined search
      --json              Machine-readable JSON output
  -h, --help / -v, --version

Auth (optional, raises rate limits): set GITHUB_TOKEN, or log in with \`gh auth login\`.

Examples:
  findrepo "rate limiter" --language go
  findrepo repos "pdf text extraction" -l python -s 500
  findrepo skills "react testing"
  findrepo compare fastify/fastify expressjs/express honojs/hono`;

export async function main(argv) {
  const o = parseArgs(argv);
  if (o.version) return console.log(VERSION);
  if (o.help || !o._.length) return console.log(HELP);
  if (o._[0] === 'init') return initCommand(o);
  const opts = { language: o.language, minStars: o['min-stars'], limit: o.limit, license: o.license, since: o.since, includeArchived: o['include-archived'] };
  const commands = new Set(['repos', 'skills', 'packages', 'inspect', 'compare', 'find']);
  const cmd = commands.has(o._[0]) ? o._.shift() : 'find';
  const query = o._.join(' ').trim();
  if (!query) throw new ApiError(`Missing argument for "${cmd}". Run findrepo --help.`);
  if (o['no-cache']) cacheEnabled = false;
  let stack = null;
  if ((cmd === 'find' || cmd === 'repos' || cmd === 'packages') && !o['no-detect']) {
    stack = detectStack();
    if (stack) { opts.deps = stack.deps; if (!opts.language) opts.language = stack.languages.join(','); else stack = { ...stack, overridden: true }; }
  }
  const note = stack && !stack.overridden
    ? `> Stack detected from ${stack.manifest}: ${stack.languages.join(', ')}. Results are filtered to it; pass --no-detect to search all languages.\n\n` : '';
  const print = (json, text) => console.log(o.json ? JSON.stringify(stack ? { stack: { languages: stack.languages, manifest: stack.manifest }, ...json } : json, null, 2) : note + text);
  if (cmd === 'packages') {
    const r = await findPackages(query, opts);
    return print(r, renderPackages(r) || (r.searched ? 'No packages found.\n' : 'Package search covers npm (JavaScript/TypeScript) and crates.io (Rust) only.\n') + renderErrors(r.errors));
  }

  if (cmd === 'repos') { const r = await findRepos(query, opts); return print(r, renderRepos(r)); }
  if (cmd === 'skills') { const r = await findSkills(query, opts); return print(r, renderSkills(r)); }
  if (cmd === 'inspect') { const r = await inspectRepo(query); return print(r, renderInspect(r)); }
  if (cmd === 'compare') {
    if (o._.length < 2) throw new ApiError('compare needs at least two owner/repo arguments.');
    const rs = (await Promise.all(o._.map(inspectRepo))).sort((a, b) => b.score - a.score);
    return print(rs, rs.map(renderInspect).join('\n'));
  }
  // Combined search. Repos first, then the rest, to stay friendly to unauthenticated rate limits.
  const repos = await findRepos(query, { ...opts, limit: opts.limit ?? 8 });
  const [skills, lists, packages] = await Promise.all([
    o['no-skills'] ? null : findSkills(query, { limit: Math.min(Number(opts.limit) || 5, 5) }).catch((e) => ({ keywords: repos.keywords, skills: [], repos: [], errors: [e.message] })),
    o['no-lists'] ? [] : findLists(query).catch(() => []),
    o['no-packages'] ? null : findPackages(query, { language: opts.language, deps: opts.deps, limit: 5 }).catch(() => null),
  ]);
  print({ repos, packages, skills, lists }, [renderRepos(repos), renderPackages(packages), skills ? renderSkills(skills) : '', renderLists(lists)].filter(Boolean).join('\n'));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(`findrepo: ${e instanceof ApiError ? e.message : e.stack ?? e}`);
    process.exit(1);
  });
}
