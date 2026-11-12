# Changelog

## 1.1.0

- Detects the project's stack from manifest files and filters results to it.
- Flags candidates that are already dependencies of the project.
- Package search on npm and crates.io with download counts (`findrepo packages`).
- `inspect` adds the OpenSSF Scorecard, published security advisories and issue close time.
- One-hour response cache (`--no-cache` to bypass).
- Claude Code plugin with a prompt hook, and `findrepo init` for automatic use in any agent.
- Fixes: short queries keep words like "repo"; short keywords match whole words only.

## 1.0.0

- Initial release: ranked repository search, skill search, curated lists, `inspect` and `compare`.
