# findrepo

**Find the best GitHub repositories and agent skills for any task.**

Stop scrolling GitHub search and stop trusting an AI's stale memory of what's popular. `findrepo` searches GitHub and the [skills.sh](https://skills.sh) registry live, ranks what it finds by relevance, adoption, maintenance and health, and flags the traps: archived, abandoned and unlicensed projects.

## What makes it different

- **One search, four sources.** GitHub repositories, package registries (npm, crates.io) with real download counts, agent skills (skills.sh and GitHub), and curated awesome-lists.
- **Knows your project.** It reads your manifest (`package.json`, `pyproject.toml`, `go.mod`, `Cargo.toml` and more), filters results to your language, and tells you when a candidate is *already a dependency*, so your agent reuses it instead of adding a second library.
- **Security in the health check.** `inspect` adds the [OpenSSF Scorecard](https://scorecard.dev), published security advisories and how quickly issues get closed.
- **Automatic, with consent.** Your agent searches before it builds, without being asked, and asks before it installs anything.
- **Nothing to set up.** One file, zero dependencies, no token, no server. Responses are cached for an hour, so repeated searches are instant and don't touch the rate limit.

It ships as an **agent skill** (`findrepo`) for Claude Code, Cursor, Codex and any agent that supports the [Agent Skills](https://agentskills.io) format, a **Claude Code plugin**, and a **CLI** for humans.

## Install

findrepo is a GitHub repo containing an agent skill and a small terminal tool. There is no `.exe` and nothing to compile; the only requirement is [Node.js](https://nodejs.org) 18+ (Windows, macOS or Linux).

Pick one:

### 1. Claude Code plugin: fully automatic (recommended)

Inside Claude Code:

```
/plugin marketplace add YOUR_USERNAME/findrepo
/plugin install findrepo@findrepo
```

This installs the skill **and** a hook that reminds Claude on each substantial prompt to check for an existing repo or skill before building. You never have to mention findrepo.

### 2. Skill for any agent (Claude Code, Cursor, Codex, ...)

```bash
npx skills add YOUR_USERNAME/findrepo
```

The agent uses the skill when your request looks like a "find me a repo/skill" task. To make it check on its own before building anything, turn on auto mode (below).

### 3. Terminal tool for humans

```bash
git clone https://github.com/YOUR_USERNAME/findrepo
cd findrepo
npm link                                  # puts `findrepo` on your PATH
findrepo "rate limiter" --language go
```

## Auto mode

Run once in a project (or with `--global` for every project):

```bash
findrepo init            # adds a short rule to CLAUDE.md / AGENTS.md
findrepo init --global   # adds it to ~/.claude/CLAUDE.md
findrepo init --remove   # undo
```

The rule tells the agent to search for existing repos and skills before writing a non-trivial component, without being asked.

**What is automatic and what is not.** Searching, inspecting and comparing happen silently. Installing a skill, adding a dependency or running code from a repo always needs your yes. That is deliberate: skills and repos are third-party code that runs with your agent's permissions, and anyone can publish one. An agent that installs whatever ranks first can be hijacked by a malicious repo.

## Usage

```bash
findrepo <query>                 # repos + packages + skills + curated lists
findrepo repos <query>           # repositories only
findrepo packages <query>        # npm / crates.io with download counts
findrepo skills <query>          # agent skills only
findrepo inspect <owner/repo>    # health + security check on one repo
findrepo compare <a/b> <c/d>     # several repos side by side
findrepo init [--global]         # turn on auto mode
```

| Option | Meaning |
| --- | --- |
| `-l, --language <lang>` | Only repos in this language (comma-separate several). Default: detected from the current project |
| `--no-detect` | Ignore the current project's stack; search all languages |
| `--no-cache` | Bypass the 1-hour response cache |
| `-s, --min-stars <n>` | Minimum star count |
| `-n, --limit <n>` | Results per section (default 10) |
| `--license <spdx>` | Only this license, e.g. `mit` |
| `--since <YYYY-MM-DD>` | Only repos pushed since this date |
| `--include-archived` | Include archived repos |
| `--no-skills`, `--no-lists`, `--no-packages` | Trim the combined search |
| `--json` | Machine-readable output |

### Example

```
$ findrepo repos "rate limiter" --language go --limit 3

1. failsafe-go/failsafe-go — score 83.7/100
   Fault tolerance and resilience patterns for Go
   ★ 2.3k · Go · MIT · pushed 1mo ago
   + strong match for the query; well adopted; active in the last 6 months; MIT license

2. fabriziosalmi/caddy-waf — score 83.6/100
   Caddy WAF (Regex Rules, IP and DNS filtering, Rate Limiting, GeoIP, Tor, Anomaly Detection)
   ★ 884 · Go · AGPL-3.0 · pushed 8d ago
   + strong match for the query; pushed in the last month; AGPL-3.0 license

3. envoyproxy/ratelimit — score 82.2/100
   Go/gRPC service designed to enable generic rate limit scenarios from different types of applications.
   ★ 2.7k · Go · Apache-2.0 · pushed today
   + strong match for the query; well adopted; pushed in the last month; Apache-2.0 license
```

`inspect` goes deeper on one repo:

```
$ findrepo inspect fastify/fastify

- Stars: 37k · Forks: 3.1k · Open issues+PRs: 189
- Latest release: v5.12.8 (9d ago)
- Contributors: 100+
- Community health: 87% (README yes, LICENSE yes, CONTRIBUTING yes, CoC yes)
- Security: OpenSSF Scorecard 8.4/10 (2026-10-19), weak on: SAST
- Published security advisories: 17 — latest: medium "fastify vulnerable to Denial of Service via ..."
- Strengths: very widely adopted; pushed in the last month; MIT license; recent release; strong OpenSSF Scorecard (8.4/10)
```

## How ranking works

Every repo gets a score from 0 to 100:

| Signal | Weight | Based on |
| --- | --- | --- |
| Relevance | 35% | Keyword coverage in name, description and topics; position in GitHub's results; how many query variants found it |
| Popularity | 25% | Stars, log-scaled, so 100k stars doesn't drown out a focused 1k-star project |
| Activity | 25% | Time since last push, with an 8-month half-life |
| Health | 15% | Has a license, description and topics; is not a fork |

Then penalties apply: off-topic repos, link collections (shown separately as curated lists), archived and disabled repos.

Each search runs several query variants (name/description/topics, README, and topic match), merges and de-duplicates them, and relaxes the query if GitHub's all-terms matching returns too little.

The score is a triage aid. It cannot read code quality, and stars measure attention rather than merit. The skill tells agents to verify finalists with `inspect` and the README before recommending anything.

## How it compares

Checked in November 2026. These are different tools with different goals; pick what fits.

| | findrepo (this) | [vercel find-skills](https://github.com/vercel-labs/skills) | [dufortservice/repo-scout](https://github.com/dufortservice/repo-scout) | [GitHub Repo Scout MCP](https://www.agensi.io/skills/github-repo-scout) |
| --- | --- | --- | --- | --- |
| Finds repositories | yes | no | yes | yes |
| Finds agent skills | yes | yes | no | no |
| Package download counts | npm, crates.io | no | no | no |
| Detects your stack | yes | no | yes | no |
| Flags "already a dependency" | yes | no | no | no |
| OpenSSF Scorecard / advisories | yes | no | no | yes |
| Dependency vulnerability audit | no | no | no | yes |
| Runs without being asked | plugin hook or `init` | on matching questions | on matching questions | no |
| Setup | none (Node 18+) | Node 22+ | Python 3 | MCP server, Node 22+, account |

Where others are ahead: the MCP server audits a repo's dependencies for known vulnerabilities and can browse files, issues and pull requests; find-skills has a far larger install base.

## Rate limits and auth

Works with no credentials. Unauthenticated GitHub search allows roughly 10 requests per minute, and a combined search uses about 7, so pace yourself or authenticate. Results are cached for an hour, so repeating a search is free:

```bash
export GITHUB_TOKEN=ghp_...   # or simply: gh auth login
```

A token with no scopes is enough. The token is sent only to `api.github.com`.

## Search tips

- Use 2–3 concrete nouns: `pdf parser`, not `how do I read pdf files`.
- Put the language in `--language`, not the query.
- Try synonyms when results are thin: `rate limiter` / `throttle`, `job queue` / `task scheduler`.

## Project layout

```
skills/findrepo/
  SKILL.md                  # instructions the agent loads
  scripts/findrepo.mjs    # the whole tool, one file, no dependencies
hooks/                      # Claude Code hook for automatic use
.claude-plugin/             # Claude Code plugin + marketplace manifests
test/scoring.test.mjs       # unit tests for ranking and parsing
```

## Limitations

- Only public GitHub repositories are searched.
- Package search covers npm and crates.io. PyPI has no public search API, so Python results come from GitHub only.
- No dependency vulnerability audit. The security check uses the OpenSSF Scorecard and the repo's own published advisories; many small repos have neither.
- Stack detection reads the current directory only, not monorepo sub-packages.
- Skill search depends on the public skills.sh search endpoint, which is not a documented, versioned API. If it changes, GitHub-hosted skill repos are still returned.
- Skills run with your agent's permissions. Read a skill before installing it.

## Contributing

Bad ranking for a real query is the most useful bug report: open an issue with the command you ran. See [CONTRIBUTING.md](CONTRIBUTING.md).

## License

[MIT](LICENSE)
