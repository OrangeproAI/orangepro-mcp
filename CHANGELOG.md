# Changelog

Dates below are America/Los_Angeles (Pacific Time), converted from the npm publish timestamp (`npm view <package> time`) or from a cited GitHub release. This file covers `@orangepro/mcp-server` and `@orangepro/orangepro-mcp`. It includes only versions and dates that were verified, and it does not invent release notes. For versions that already have official notes in the repo or on GitHub, those notes are summarized or linked.

## 0.2.61 — 2026-11-16

Official notes: [docs/releases/0.2.61.md](https://github.com/OrangeproAI/orangepro-mcp/blob/v0.2.61/docs/releases/0.2.61.md). GitHub release: [v0.2.61](https://github.com/OrangeproAI/orangepro-mcp/releases/tag/v0.2.61).

- Add this changelog and `SECURITY.md`.
- Shorten the `@orangepro/mcp-server` npm `description` so it stays within npm's 255-character limit and says that optional BYOK generation sends redacted grounded context directly to the user's own model provider. The 0.2.60 description was 277 characters and was published truncated, ending at "directly to you".
- Ship `CHANGELOG.md` and `SECURITY.md` in the `@orangepro/orangepro-mcp` package (`files`). The `@orangepro/mcp-server` launcher package is unchanged in layout (`bin` and `README.md` only); it still depends on `@orangepro/orangepro-mcp`.

From the official 0.2.61 notes:

- Patch status in the reports: a function that a finished proof run verified shows "Verified test patch (not merged)" beside its evidence. It is not an evidence tier; counts and verbs are unchanged.
- `opro publish-tests` (new) delivers a verified test patch as one draft PR through the GitHub API. It runs no repository code, and refuses when the code under the PR is not the code that was proven.
- `opro install-github-action --deliver draft-pr` (new, opt-in) adds a separate deliver job, the only job with write permissions. The Actions artifact holds both reports, re-rendered with the PR link after a delivery.
- `summary.html` names and links the repository, the merged commit and the source PR.
- The one-page summary says what an `opro start` run did ("Done by this run") and roughly how long it would take by hand, with its assumptions and sources. Both reports link to the OrangePro platform.
- The repository's lockfile moves `hono` to 4.13.19 after five advisories published on 12 Nov. The local server never loads it.
- The first run after upgrading is a full run: the report data format changed.

## 0.2.60 — 2026-11-08

Published to npm at 2026-11-08 3:42 AM PT (`@orangepro/mcp-server`) and 3:43 AM PT (`@orangepro/orangepro-mcp`). GitHub release: [v0.2.60](https://github.com/OrangeproAI/orangepro-mcp/releases/tag/v0.2.60) (published 2026-11-08 3:42 AM PT). Official notes: [docs/releases/0.2.60.md](https://github.com/OrangeproAI/orangepro-mcp/blob/main/docs/releases/0.2.60.md). Changes from 0.2.46 through 0.2.60: [docs/releases/0.2.46-to-0.2.60.md](https://github.com/OrangeproAI/orangepro-mcp/blob/main/docs/releases/0.2.46-to-0.2.60.md).

From the official 0.2.60 notes:

- An opt-in GitHub Actions workflow that replays one targeted mutation proof after each merge (`opro install-github-action`, `opro actions-run`). Tested locally. The workflow asks for `contents: read` only, uses no secret, and opens no pull request. OrangePro here runs after merge on the merged build; it is not a PR or release gate.
- `opro draft-test` lets the user's own model write the new test from the brief, and checks it with `opro verify-test`.
- `--static-only` reads a repository and drafts tests without running any of its code.
- Page objects, fixtures and other test-support code leave the worklist, recognized by the test framework they import.
- The README's five evidence names are now the labels in `rtm.md`, the CLI, `opro doctor`, the MCP text and the agent docs. Tools that parse `rtm.md` need the new status names.
- The reports say what each number counts, and proof runs say what happened, time-outs included.
- `@orangepro/mcp-server` now pins its engine exactly.
- `--proof-limit 0` means no proof attempt, and `--generate-limit 0` no drafted test slots.
- The first run after upgrading is a full run: the report data format changed.

## 0.2.59 — 2026-10-27

Published to npm at 2026-10-27 3:51 PM PT (both packages). GitHub release: [v0.2.59](https://github.com/OrangeproAI/orangepro-mcp/releases/tag/v0.2.59) (published 2026-10-27 3:52 PM PT).

From the official 0.2.59 GitHub release notes:

- OrangePro no longer reads `.env` files. Model keys, the provider, its endpoint and the model come only from the shell environment, or from the `env` block of the MCP client's config.
- Dependency advisories: the MCP SDK moves to 1.32.2, zod to 4.6.7, and the Express dependencies are refreshed. The release notes state that `npm audit --omit=dev` finds no vulnerabilities.
- Proof runs no longer write the test mutation into your own files when the source folder you pass is a symbolic link. This applies in JavaScript, TypeScript, Go, Java and Python.
- More public JavaScript functions are seen (`export { a, b }` lists, `Foo.prototype.x = function …`, methods assigned to an exported object, `module.exports = { a, b }`, and an unnamed `export default function`). Only functions a package actually hands out are counted.
- New commands that take one changed function from a merged change to a reviewable test patch: `opro probe-fault`, `opro test-brief`, `opro verify-test`, and `opro export-tests`. Each writes a run folder with a manifest of checksums. A verified result means one named test caught one specified fault at its declared assertion, on one revision. It is not a claim of general correctness.
- Every build is stamped (`dist/local/build-info.json`). OrangePro refuses to run a build whose files changed after it was built, or that mixes files from two builds.
- Requirements: Node ^22.23.4, ^24.22.1 or >=26.12.1, on macOS or Linux.

## 0.2.42 through 0.2.58

Official in-repo notes:

- [docs/releases/0.2.42.md](https://github.com/OrangeproAI/orangepro-mcp/blob/main/docs/releases/0.2.42.md)
- [docs/releases/0.2.43.md](https://github.com/OrangeproAI/orangepro-mcp/blob/main/docs/releases/0.2.43.md)
- [docs/releases/0.2.44.md](https://github.com/OrangeproAI/orangepro-mcp/blob/main/docs/releases/0.2.44.md)
- [docs/releases/0.2.45.md](https://github.com/OrangeproAI/orangepro-mcp/blob/main/docs/releases/0.2.45.md)
- [docs/releases/0.2.46-to-0.2.60.md](https://github.com/OrangeproAI/orangepro-mcp/blob/main/docs/releases/0.2.46-to-0.2.60.md) (covers 0.2.46 through 0.2.60)

GitHub releases for these and earlier tags: https://github.com/OrangeproAI/orangepro-mcp/releases

Publish dates are in the table below.

## Earlier versions

For 0.2.41 and earlier, and for any version not summarized above, see the [GitHub releases](https://github.com/OrangeproAI/orangepro-mcp/releases) and the npm version history (`npm view @orangepro/mcp-server time` and `npm view @orangepro/orangepro-mcp time`). No release notes are invented here.

## Published versions

Dates are the npm publish time in Pacific Time. Unless noted, both packages were published on that date. Versions 0.2.51, 0.2.52 and 0.2.55 were not found on npm for either package. Git tags such as `v0.2.59-demo.2` and `v0.2.59-demo.3` exist in the repository and are not npm releases.

| Version | Date (PT) | Packages |
| --- | --- | --- |
| 0.2.60 | 2026-11-08 | both |
| 0.2.59 | 2026-10-27 | both |
| 0.2.58 | 2026-10-10 | both |
| 0.2.57 | 2026-10-08 | both |
| 0.2.56 | 2026-10-07 | both |
| 0.2.54 | 2026-10-06 | both |
| 0.2.53 | 2026-10-06 | both |
| 0.2.50 | 2026-10-06 | both |
| 0.2.49 | 2026-10-06 | both |
| 0.2.48 | 2026-10-06 | both |
| 0.2.47 | 2026-10-05 | both |
| 0.2.46 | 2026-10-03 | both |
| 0.2.45 | 2026-10-02 | both |
| 0.2.44 | 2026-09-22 | both |
| 0.2.43 | 2026-09-17 | both |
| 0.2.42 | 2026-09-16 | both |
| 0.2.41 | 2026-09-13 | both |
| 0.2.40 | 2026-09-06 | both |
| 0.2.39 | 2026-09-06 | both |
| 0.2.38 | 2026-09-04 | both |
| 0.2.37 | 2026-09-03 | both |
| 0.2.36 | 2026-09-03 | both |
| 0.2.35 | 2026-09-03 | both |
| 0.2.34 | 2026-09-02 | both |
| 0.2.33 | 2026-09-01 | both |
| 0.2.32 | 2026-08-26 | both |
| 0.2.31 | 2026-08-26 | both |
| 0.2.30 | 2026-08-23 | both |
| 0.2.29 | 2026-08-14 | both |
| 0.2.28 | 2026-08-13 | both |
| 0.2.27 | 2026-08-13 | both |
| 0.2.26 | 2026-08-11 | both |
| 0.2.25 | 2026-08-11 | `@orangepro/mcp-server` only |
| 0.2.24 | 2026-08-11 | both |
| 0.2.23 | 2026-08-09 | both |
| 0.2.22 | 2026-08-09 | both |
| 0.2.21 | 2026-08-04 | both |
| 0.2.20 | 2026-08-04 | both |
| 0.2.19 | 2026-08-04 | both |
| 0.2.18 | 2026-08-04 | both |
| 0.2.17 | 2026-08-04 | both |
| 0.2.16 | 2026-08-04 | `@orangepro/orangepro-mcp` only |
| 0.2.15 | 2026-08-02 | both |
| 0.2.14 | 2026-08-02 | both |
| 0.2.13 | 2026-08-02 | both |
| 0.2.12 | 2026-07-28 | both |
| 0.2.11 | 2026-07-27 | both |
| 0.2.10 | 2026-07-23 | both |
| 0.2.9 | 2026-07-22 | both |
| 0.2.8 | 2026-07-20 | both |
| 0.2.7 | 2026-07-19 | both |
| 0.2.6 | 2026-07-18 | both |
| 0.2.5 | 2026-07-18 | both |
| 0.2.4 | 2026-07-10 | both |
| 0.2.3 | 2026-07-07 | both |
| 0.2.2 | 2026-07-07 | both |
| 0.2.1 | 2026-07-07 | `@orangepro/orangepro-mcp` only |
| 0.2.0 | 2026-07-06 | both |
| 0.1.0 | 2026-07-04 | `@orangepro/orangepro-mcp` only |
