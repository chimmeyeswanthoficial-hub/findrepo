# Contributing

Thanks for helping make findrepo better.

## Setup

```bash
git clone https://github.com/YOUR_USERNAME/findrepo
cd findrepo
npm test          # no install step: there are no dependencies
```

## Ground rules

- **Zero dependencies.** The script must run with a bare Node.js 18+ so it works inside any agent sandbox.
- **One file.** All logic lives in `skills/findrepo/scripts/findrepo.mjs` so the skill is self-contained when installed.
- **Be frugal with API calls.** Unauthenticated GitHub search allows about 10 requests per minute. A combined search must stay under that.
- **Ranking changes need a test.** Add a case to `test/scoring.test.mjs` showing the behaviour you are fixing.
- **Keep `SKILL.md` short.** It is loaded into an agent's context; every line costs tokens.

## Good first contributions

- Bad result for a real query? Open an issue with the exact command and what you expected to rank higher.
- More registries for skill search.
- Extra health signals for `inspect` (issue response time, release cadence).
