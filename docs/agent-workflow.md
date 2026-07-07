# Coding Agent Workflow

OrangePro builds the local evidence graph. Your coding agent writes files, runs
tests, and reports results.

## Setup

The public, supported path today is npm + MCP config:

```bash
npm install -g @orangepro/orangepro-mcp
cd /path/to/your/repo
opro
opro agent --client codex        # or claude-code, cursor, opencode, generic
```

Paste the printed MCP block into your agent. The bundled plugin metadata in this repo is for marketplace submission and maintainer validation; do not assume bare `codex plugin add orangepro` or Claude marketplace install works until OrangePro is listed in that marketplace.

For Cursor, install OrangePro from the Cursor Marketplace when available. Until then, use `opro agent --client cursor` or the bundled plugin directory at `plugins/orangepro` for local testing.

Build the CLI and print a client-ready MCP block:

```bash
npm run build
opro
opro agent --client claude-code
opro agent --client cursor
opro agent --client codex
opro agent --client opencode
```

Use `--json` if your setup script wants structured output:

```bash
opro agent --client generic --json
```

The generated MCP config points at the local `opro mcp` server and intentionally
does not pin a model. If your MCP client does not inherit shell environment
variables, add provider keys/model defaults to that client's local config, or
place provider values in a local `.env.provider.local` file in the
repo/workspace. Do not commit client config files or env files that contain keys.

## Agent Instruction

Use this as the short instruction for Codex, Claude Code, Cursor, OpenCode, Windsurf, or
any MCP-capable coding agent:

```text
Use OrangePro before writing tests.

Start:
1. Call orangepro_start for the local checkout.
2. If it reports a large-repo scope breakdown, prefer the suggested focused scope for AI/generation; full deterministic analysis is still allowed.
3. Use its graph_html_path, rtm path, and next_actions as the test plan.
4. If AI grounding is skipped, continue with the deterministic graph instead of asking the user for extra commands.

For PR work:
1. Call orangepro_generate_tests with base_ref=main.
2. Use the changed behaviors returned by orangepro_start as context.
3. Use only generated tests that include run_hints.
4. Write each body to its suggested_path.
5. Run the run_command from the owning package directory.
6. After a pass, call `orangepro_prove` with the returned `prove_run` args to attempt Dynamically Proven; use `record_run` only for static diagnostics.
7. Report pass/fail with stack traces and exact setup problems.

For baseline work:
1. Call orangepro_find_test_gaps.
2. Pick one high-priority gap.
3. Call orangepro_generate_tests for that target.
4. Write, run, and report only runnable tests.
5. After a pass, call `orangepro_prove` with the returned `prove_run` args to attempt Dynamically Proven; use `record_run` only for static diagnostics.

Do not treat drafts as runnable tests. Drafts are context.
Do not claim coverage changed unless OrangePro reports Proven, Reproven, Runtime-covered, Associated signal, or No integration signal changed.
```

## CLI Fallback

If the agent has shell access but no MCP client, use the CLI:

```bash
opro
opro start . --generate-coverage
opro gaps --limit 10
opro generate --base main --single --limit 3
opro generate --target <target-id> --single --limit 1
opro explain <generated-test-id>
opro export --format graph-html --out .orangepro/graph.html
```

`generate --base main` is read-only: it uses `git diff` and does not check out a
PR. `generate --pr <n>` is the mutating escape hatch and should only be used when
the developer explicitly allows the working tree to switch.

## What Counts

- **Runnable**: the generated test has `run_hints`, the agent writes it to
  `suggested_path`, and the repo's test runner executes it.
- **Draft**: grounded context with no run command. Useful for a developer, but
  not a runnable-test claim.
- **Proven**: dynamic targeted-proof ledger certificate closed for the behavior; no LLM judgment or static-only match is involved.
- **Reproven**: this run produced the dynamic proof certificate. Older static re-analysis records are associated diagnostics until that certificate exists.
- **Runtime-covered**: the repo's own coverage tool executed the code; this is runtime observation, not assertion-level proof.
- **Associated signal**: OrangePro found a name, path, import, or structural test signal, but not semantic proof.
- **No integration signal**: no static test signal was found.

Generated-test promotion numbers should count only tests that run in the target
repo, reference real product symbols, and contain non-vacuous assertions.

## AGENTS.md Snippet

For repos that use an `AGENTS.md`, keep the OrangePro instruction short:

```markdown
## OrangePro Test Workflow

- Run `opro` before adding tests. It writes graph, RTM, optional AI weak grounding when configured, and next actions.
- For PR work, run `opro generate --base main --single --limit 3`.
- For baseline gaps, run `opro gaps --limit 10`, pick one target, then run
  `opro generate --target <target-id> --single --limit 1`.
- Write only tests that include `run_hints`; drafts are context, not runnable claims.
- Write each generated body to `suggested_path`, run `run_command`, call `orangepro_prove` with the returned `prove_run` args after a pass to attempt Dynamically Proven. Use `record_run` only for static diagnostics.
- Report coverage status as Proven / Reproven / Runtime-covered / Associated signal / No integration signal. Do not promote Associated signal or AI links to Proven.
```

## Verification Loop

After the agent writes a passing test:

```bash
opro
opro start . --generate-coverage
opro status
opro gaps --limit 10
```

Report what changed. If nothing moved from No integration signal or Associated signal to Proven, say so
plainly.
