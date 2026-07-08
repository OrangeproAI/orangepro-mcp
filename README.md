# OrangePro

**Find the behaviors your tests miss. Generate grounded tests that actually run.**

`opro` builds a knowledge graph from your local checkout, maps every behavior in your code, shows which ones are tested and which aren't, and generates integration-level tests grounded in real symbols — not hallucinated imports. Runs as a CLI and an MCP server.The architecture follows the same ingest → compile → lint pattern described in Karpathy's LLM Knowledge Bases gist, applied to behavioral verification of code.

```bash
npx @orangepro/mcp-server
cd /path/to/your/repo
opro
```

That's it. You get:

```
.orangepro/
├── behavior-coverage.html   ← open this: interactive gap report
├── rtm.md                   ← requirements traceability matrix
└── evidence-pack.json       ← machine-readable metadata export
```
<img width="895" height="960" alt="Screenshot 2026-07-08 at 1 18 01 AM" src="https://github.com/user-attachments/assets/73b8a812-2eab-43a1-8aed-4289545e630b" />

---

## Install

```bash
# No install needed (npx)
npx @orangepro/mcp-server

# Or global install
npm install -g @orangepro/orangepro-mcp

# Or from source
git clone https://github.com/OrangeproAI/orangepro-mcp.git
cd orangepro-mcp && npm ci && npm run build && npm link
```

---

## Use with your coding agent

OrangePro runs as an MCP server. Any MCP-compatible agent (Cursor, Claude Code, Codex, Copilot, OpenCode) can drive it.

### Quick agent setup

If you already have `opro` on your PATH, print the exact config for your client:

```bash
opro agent --client codex
opro agent --client claude-code
opro agent --client cursor
opro agent --client opencode
opro agent --client generic
```

No global install is required. These commands use the published package:

```bash
# Codex
npx -y @orangepro/mcp-server@latest agent --client codex

# Claude Code
npx -y @orangepro/mcp-server@latest agent --client claude-code

# Cursor
npx -y @orangepro/mcp-server@latest agent --client cursor

# OpenCode
npx -y @orangepro/mcp-server@latest agent --client opencode

# Generic MCP clients, including VS Code/Copilot-style MCP settings
npx -y @orangepro/mcp-server@latest agent --client generic
```

### Manual MCP config

Add to your client's MCP config:

```json
{
  "mcpServers": {
    "orangepro-local": {
      "command": "npx",
      "args": ["-y", "@orangepro/mcp-server@latest", "mcp"]
    }
  }
}
```

| Client | Config location |
| --- | --- |
|--------|----------------|
| Claude Code | `.mcp.json` or `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` or Settings → MCP |
| Codex | Config printed by `opro agent --client codex` or `npx -y @orangepro/mcp-server@latest agent --client codex` |
| VS Code / Copilot | MCP settings; use the `generic` config if your client accepts raw MCP server JSON |
| OpenCode | Config printed by `opro agent --client opencode` |

### The workflow

Tell your agent:

> "Use `orangepro_start`, then `orangepro_generate_tests` with base_ref=main. Write each test to its suggested_path, run it, and report pass/fail."

The agent writes the test, runs it, calls `orangepro_prove`, and the behavior turns Dynamically Proven. One prompt, full loop.

### MCP tools (18 total)

| Tool | What it does |
|------|--------------|
| `orangepro_start` | One-command setup: analyze + report + next actions |
| `orangepro_analyze_sources` | Build/refresh the evidence graph |
| `orangepro_generate_tests` | Generate grounded tests for gaps |
| `orangepro_prove` | Run mutation-kill oracle on a behavior |
| `orangepro_prove_loop` | Setup commands + dynamic proof + report refresh for one behavior |
| `orangepro_find_test_gaps` | List behaviors with weak/missing tests, ranked by risk |
| `orangepro_graph_score` | Graph readiness score (0–100) |
| `orangepro_status` | Workspace state without generating anything |
| `orangepro_doctor` | Recommend next evidence to improve quality |
| `orangepro_rtm` | Requirements traceability matrix |
| `orangepro_stats` | Aggregate statistics |
| `orangepro_changed_impact` | What a diff touches (requires git + base ref) |
| `orangepro_record_run` | Record a test run result |
| `orangepro_explain_test` | Explain why a test was generated |
| `orangepro_export_evidence_pack` | Export metadata-only evidence pack |
| `orangepro_update_graph` | Incremental graph update |
| `orangepro_ai_links` | Weak behavior→symbol suggestions (optional AI) |
| `orangepro_ai_flows` | Candidate flow discovery (optional AI) |

---

## CLI reference

```bash
opro                          # analyze + report + agent next actions
opro start --base main        # same, scoped to a branch diff
opro analyze                  # build the evidence graph
opro score                    # graph readiness (0–100)
opro gaps --limit 10          # top 10 untested behaviors
opro generate --base main     # tests for PR diff
opro generate --single        # top gap, whole repo
opro prove                    # mutation-kill oracle (use the prove_run args returned by generate)
opro rtm                      # traceability matrix
opro export                   # metadata-only evidence pack
opro mcp                      # run as MCP server (stdio)
opro doctor                   # what evidence to add next
opro coverage                 # ingest runtime coverage
```

Add `--json` to any read command for machine output. Run `opro help` for the full reference.

---

## PR workflow

```bash
opro generate --base main              # tests for what this branch changed
opro generate --pr 1234                # checks out PR #1234 — mutates your working tree; needs gh + confirmation (prefer --base)
opro generate --changed                # current branch diff vs main
```

Each generated test includes:
- **Grounding** — the real files, symbols, and existing tests it cites
- **Run hints** — where to write it, how to run it
- **Scenario bucket + technique** — what failure mode it targets and how

---

## Test categories

Generation is evidence-gated. A category is produced only when the graph has supporting evidence — never padded with generic filler. These are the public local generation buckets. The broader concern taxonomy used by planning prompts is not a public coverage taxonomy and does not change report tiers.

| Category | What it targets |
|----------|-----------------|
| Happy path | Primary expected behavior |
| Validation error | Bad/invalid input handling |
| Edge case | Boundaries, empty/null, concurrency, retries |
| Integration flow | Multi-step behavior across services |
| Security / privacy | Auth, injection, data leakage |
| Regression | Pinning a previously-broken behavior |

---

## Evidence tiers

Every behavior gets exactly one tier. Nothing is labeled "tested" on faith.

| Tier | What it means | How you get there |
|------|---------------|------------------|
| **Dynamically Proven** | A real test kills a targeted mutant of this behavior | `opro prove` after writing/running a test |
| **Runtime-covered** | Coverage tool executed this code | `opro start --generate-coverage` |
| **Statically Linked** | Import/name/structural match links a test to this code | Automatic during analysis |
| **No Signal** | Nothing tests this behavior yet | — |

> **"Dynamically Proven 0" is normal on first run.** Static analysis always runs. Dynamic proof requires running tests against targeted mutations. That's the trust model — nothing is Dynamically Proven until a real test kills a real mutant.

---

## Language support

OrangePro separates static mapping, generated tests, runtime coverage, and dynamic proof. Those are different confidence bars.

| Language | Static behavior extraction | Generated tests | Runtime coverage | Dynamic proof |
|----------|:--------------------------:|:---------------:|:----------------:|:-------------:|
| TypeScript / JavaScript | ✓ | ✓ Jest / Vitest / Mocha / AVA-style drafts | ✓ lcov.info | ✓ Vitest / Jest / Mocha |
| Python | ✓ | ✓ pytest | ✓ coverage.py / pytest-cov XML | ✓ pytest |
| Go | ✓ | ✓ same-package `*_test.go` | ✓ coverprofile | ✓ `go test` |
| Java | ✓ | ✓ JUnit 4/5 | ✓ JaCoCo XML | ✓ Maven/JUnit |
| Kotlin, Rust, PHP, C#, Ruby, Swift, C, C++ | ✓ static behavior extraction | planned | planned where standard coverage exists | planned proof profiles |

Static mapping works across many languages through tree-sitter and repo metadata. Dynamic proof is deliberately narrower: each language needs a runner, mutation locator, sandbox profile, and false-proof regressions before it can mint Dynamically Proven.

---

## Model setup (BYOK)

Analysis, scoring, and proof need no model key. Generation does.

| Provider | Environment variable |
|----------|---------------------|
| OpenAI-compatible | `OPENAI_API_KEY` (optional: `OPENAI_BASE_URL`, `OPENAI_MODEL`) |
| Anthropic | `ANTHROPIC_API_KEY` (optional: `ANTHROPIC_MODEL`) |
| Ollama (local, no key) | `OLLAMA_BASE_URL` (optional: `OLLAMA_MODEL`) |

Auto-detect order: OpenAI → Ollama → Anthropic. Override with `--provider` and `--model`.

Run `opro setup` to configure interactively. Keys stay in your environment — never written to graph, config, or artifacts.

---

## AI candidate lanes

With a provider key, OrangePro can stage weak AI behavior→symbol links and AI-suggested candidate flows. These are ready for local use as review/generation worklists, but they are not evidence:

- AI links appear as `AI-linked` suggestions.
- AI flows are stored separately from deterministic flows.
- Neither lane changes Dynamically Proven, Runtime-covered, Statically Linked, denominator counts, or evidence tiers.

Use them when you want the agent to find likely service-boundary flows faster; ignore them when you want a deterministic-only report.

---

## How it works

OrangePro separates **analysis** (what your code does) from **proof** (whether tests actually verify it).

```
┌─────────────┐     ┌──────────────┐     ┌─────────────┐
│  Your Code  │ ──► │  Knowledge   │ ──► │  Evidence   │
│  (any lang) │     │    Graph     │     │   Tiers     │
└─────────────┘     └──────────────┘     └─────────────┘
                           │
                    ┌──────┴──────┐
                    ▼             ▼
             ┌───────────┐  ┌──────────┐
             │ Gap Report│  │ Generate │
             │ + Risks   │  │  Tests   │
             └───────────┘  └──────────┘
```

| Phase | What happens | Needs a model key? |
|-------|-------------|-------------------|
| **Analyze** | AST walk → behaviors, flows, evidence tiers | No |
| **Score** | Graph readiness score (0–100) with reasons | No |
| **Generate** | Grounded tests for top gaps, per-behavior | Yes (BYOK) |
| **Prove** | Mutation-kill oracle confirms test actually breaks if behavior changes | No |

---

## Privacy

- **No stored source.** Reads code in-process. Never uploads to an OrangePro server.
- **No source mutation.** Never edits your existing files. Writes metadata to `.orangepro/`.
- **Metadata-only exports.** File paths, names, hashes, scores — not raw source.
- **Your keys stay yours.** Read from env at call time, never persisted.

---

## What's on the hosted platform

This repo is the free local tool. The [OrangePro platform](https://orangepro.ai) adds:

- Persistent knowledge graph across PRs and repos
- Managed dynamic proof at scale (larger budgets, CI workers, service setup profiles)
- PR/CI policy gates over Dynamically Proven, Runtime-covered, and risk deltas
- Jira / Confluence / TestRail / OpenAPI enrichment
- Cross-repo intelligence and recurring-flow memory
- Production incident correlation and regression targeting
- Full test lifecycle management and team dashboards

---

## Contributing

```bash
npm run build       # compile to dist/
npm test            # vitest
npm run typecheck   # type check without emitting
```

See [docs/local-proof-kit.md](docs/local-proof-kit.md) for the full development reference.

## License

[MIT](LICENSE) © OrangePro
