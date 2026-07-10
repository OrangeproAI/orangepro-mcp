# OrangePro — Quickstart

Map behavior coverage, dynamically prove existing tests, and generate grounded tests for
your repo. No OrangePro account or sign-up is required. Deterministic analysis stays local;
when AI lanes are enabled, grounded context is sent directly to your configured BYOK model.

---

## 1. Install the repository dependencies

```bash
cd /path/to/your/repo
npm install # or pnpm install / bun install / the repository's package manager
```

Dynamic proof runs the repository's real tests, so their dependencies must be available.

## 2. Optional: add one model provider

```bash
export OPENAI_API_KEY="..." # or ANTHROPIC_API_KEY / OLLAMA_BASE_URL
```

No key is required for static mapping or proving existing tests. A key enables AI candidate
links, candidate flows, and grounded test generation. AI output is never proof.

## 3. Run one command

```bash
npx -y @orangepro/mcp-server@latest start . --prompt-version v5
```

This runs deterministic analysis, existing-tests-first dynamic proof, optional AI candidate
flows and top-risk test generation, then writes the final report and RTM. Generated tests are
contained under `orangepro_generated/`; existing source and tests are not edited.

For a global installation instead:

```bash
npm install -g @orangepro/orangepro-mcp
opro start . --prompt-version v5
```

## 4. See the results

```bash
open .orangepro/behavior-coverage.html
open .orangepro/rtm.md           # traceability matrix
```

If proof could not run, inspect the exact blocker:

```bash
npx -y @orangepro/mcp-server@latest doctor --proof
```

## 5. Connect a coding agent

```bash
npx -y @orangepro/mcp-server@latest agent --client codex
npx -y @orangepro/mcp-server@latest agent --client claude-code
npx -y @orangepro/mcp-server@latest agent --client cursor
npx -y @orangepro/mcp-server@latest agent --client generic
```

Use the printed MCP configuration. The agent can write and run generated tests, then call
`orangepro_prove` so only a real mutation kill becomes Dynamically Proven.

---

That's the loop: **install repository dependencies → one OrangePro command → inspect the
report → optionally let an agent close the remaining proof gaps.** Full reference in
[README.md](README.md).
