<p align="center">
  <img src="https://github.com/OrangeproAI/orangepro-mcp/raw/main/docs/logo-horizontal.svg" alt="OrangePro" width="320" />
</p>

<p align="center">
  <strong>Find the behaviors your tests miss. Generate grounded tests that actually run.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@orangepro/mcp-server"><img src="https://badge.fury.io/js/@orangepro%2Fmcp-server.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License" /></a>
  <a href="https://www.npmjs.com/package/@orangepro/mcp-server"><img src="https://img.shields.io/npm/dw/@orangepro/mcp-server.svg" alt="npm downloads" /></a>
  <a href="https://glama.ai/mcp/servers/OrangeproAI/orangepro-mcp"><img src="https://glama.ai/mcp/servers/OrangeproAI/orangepro-mcp/badges/score.svg" alt="Glama score" /></a>
  <a href="https://registry.modelcontextprotocol.io/?q=orangepro"><img src="https://img.shields.io/badge/MCP_Registry-orangepro-orange.svg" alt="MCP Registry" /></a>
</p>

---

OrangePro maps every public behavior in your codebase, scores each one by real test evidence, and shows you the structural blind spots before your users find them. Runs locally. Your code never leaves your machine.

```bash
npx -y @orangepro/mcp-server@latest start .
```

<!-- TODO: Replace with a terminal GIF showing the command running and report opening -->

---

## Table of Contents

- [What you get](#what-you-get)
- [Evidence tiers](#evidence-tiers)
- [Quick start](#quick-start)
- [Use with your coding agent](#use-with-your-coding-agent)
- [How it works](#how-it-works)
- [Language support](#language-support)
- [Privacy](#privacy)
- [CLI reference](#cli-reference)
- [MCP tools](#mcp-tools-18-total)
- [Platform](#whats-on-the-hosted-platform)
- [Contributing](#contributing)

---

## What you get

One command produces an interactive HTML report:

```bash
npx -y @orangepro/mcp-server@latest start .
open .orangepro/behavior-coverage.html
```
The report has two modes: **Simple** (integration-level blind spots, plain English) and **Expert** (full behavior list, evidence tiers, flows, system map). Toggle with the pill switch at the top.

**<a href="https://orangeproai.github.io/orangepro-mcp/twenty-crm-behavior-coverage.html" target="_blank">→ Live example: Twenty CRM (5,237 behaviors mapped)</a>**

<img width="895" alt="OrangePro system map — entry lanes, services, evidence tiers" src="https://github.com/user-attachments/assets/1ceba779-e0ec-4ec1-99ce-001bc3589b42](https://github.com/user-attachments/assets/a4d85b98-4f19-4647-8dd9-db5911574f49" />

*System map — entry lanes (GraphQL, HTTP, Jobs) flowing into services, sized by traffic, colored by evidence tier, red-ringed by risk.*


<img width="818" alt="Priority gaps" src="https://github.com/user-attachments/assets/30a512b6-7830-48db-a00f-a616e7176ea8" />

*Priority gaps of another open source Project HONO — top 20 unproven behaviors ranked by blast radius, with generated test drafts.*

---

## Evidence tiers

Every behavior gets exactly one tier. Nothing is labeled "tested" on faith.

| Tier | Color | What it means |
|------|-------|---------------|
| **Dynamically Proven** | 🟢 | A real test kills a targeted mutation of this behavior |
| **Runtime-covered** | 🟢 | Coverage tool executed this code |
| **Statically Linked** | 🟡 | A test imports and calls this code — structural link, not proof |
| **Unconfirmed Candidate** | ⚪ | A similar test file exists — a lead, not evidence |
| **No Signal** | 🔴 | Nothing tests this behavior |

> **"Dynamically Proven 0" is normal on first run.** Proof requires running tests against targeted mutations. That's the trust model.

---

## Quick start

```bash
cd /path/to/your/repo
npm install          # install the repo's own dependencies first

npx -y @orangepro/mcp-server@latest start .
open .orangepro/behavior-coverage.html
```

No API key needed. The report shows your system map, evidence tiers, priority gaps, and delta since last run.

**Want test generation?** Add a model key (BYOK):

```bash
export ANTHROPIC_API_KEY="..."   # or OPENAI_API_KEY / OLLAMA_BASE_URL
npx -y @orangepro/mcp-server@latest start .
```

AI output never changes evidence tiers. Only the mutation-kill oracle can mint Dynamically Proven.

**Output:**

```
.orangepro/
├── behavior-coverage.html   ← open this
├── graph.json               ← deterministic evidence graph
├── COVERAGE_REPORT.md       ← coverage and gap summary
└── ai/                      ← candidate flows (when a key is configured)

orangepro_generated/         ← generated tests; your source files are never touched
```

Each rerun shows a **delta banner**: what entered the codebase, what moved up in risk, what got resolved.

---

## Use with your coding agent

OrangePro runs as an MCP server. Add to your client's config:

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

| Client | Where to put it |
| --- | --- |
| Claude Code | `.mcp.json` or `~/.claude.json` |
| Cursor | `~/.cursor/mcp.json` or Settings → MCP |
| VS Code / Copilot | MCP settings |
| Codex / OpenCode | Run `npx -y @orangepro/mcp-server@latest agent --client codex` |

**The workflow:** Tell your agent:

> "Use `orangepro_start`, then `orangepro_generate_tests` with base_ref=main. Write each test to its suggested_path, run it, and report pass/fail."

The agent writes the test, runs it, calls `orangepro_prove`, and the behavior turns Dynamically Proven. One prompt, full loop.

---

## Works with

<p>
  <strong>Claude Code</strong> · <strong>Cursor</strong> · <strong>GitHub Copilot</strong> · <strong>Codex</strong> · <strong>Windsurf</strong> · <strong>OpenCode</strong> · <strong>VS Code</strong>
</p>

Any MCP-compatible agent can drive OrangePro. No vendor lock-in.

---

## How it works

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
| **Score** | Graph readiness score (0–100) | No |
| **Generate** | Grounded tests for top gaps | Yes (BYOK) |
| **Prove** | Mutation-kill oracle confirms test breaks if behavior changes | No |

Same code = same score. Deterministic. Always.

---

## Language support

| Language | Static mapping | Generated tests | Dynamic proof |
|----------|:-:|:-:|:-:|
| TypeScript / JavaScript | ✓ | ✓ Jest / Vitest / Mocha | ✓ |
| Python | ✓ | ✓ pytest | ✓ |
| Go | ✓ | ✓ `*_test.go` | ✓ |
| Java | ✓ | ✓ JUnit 4/5 | ✓ |
| Kotlin, Rust, PHP, C#, Ruby, Swift, C, C++ | ✓ | planned | planned |

Static mapping works across many languages via tree-sitter. Dynamic proof is deliberately narrower — each language needs a runner, mutation locator, and sandbox profile.

---

## Privacy

- **No stored source.** Reads code in-process. Never uploads to an OrangePro server.
- **No existing-source mutation.** Never edits your source or test files.
- **Your keys stay yours.** Read from env at call time, never persisted.
- **BYOK is direct.** Code context goes to the model provider you configure. OrangePro is not in that path.

---

<details>
<summary><strong>CLI reference</strong></summary>

```bash
opro                          # analyze + report + agent next actions
opro start --base main        # same, scoped to a branch diff
opro analyze                  # build the evidence graph
opro score                    # graph readiness (0–100)
opro gaps --limit 10          # top 10 untested behaviors
opro generate --base main     # tests for PR diff
opro generate --single        # top gap, whole repo
opro prove                    # mutation-kill oracle
opro rtm                      # traceability matrix
opro export                   # metadata-only evidence pack
opro mcp                      # run as MCP server (stdio)
opro doctor                   # what evidence to add next
opro coverage                 # ingest runtime coverage
```

Add `--json` to any read command for machine output. Run `opro help` for the full reference.

</details>

<details>
<summary><strong>MCP tools (18 total)</strong></summary>

| Tool | What it does |
|------|--------------|
| `orangepro_start` | One-command setup: analyze + report + next actions |
| `orangepro_analyze_sources` | Build/refresh the evidence graph |
| `orangepro_generate_tests` | Generate grounded tests for gaps |
| `orangepro_prove` | Run mutation-kill oracle on a behavior |
| `orangepro_prove_loop` | Setup + dynamic proof + report refresh for one behavior |
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

</details>

<details>
<summary><strong>PR workflow</strong></summary>

```bash
opro generate --base main              # tests for what this branch changed
opro generate --pr 1234                # checks out PR #1234
opro generate --changed                # current branch diff vs main
```

Each generated test includes:
- **Grounding** — the real files, symbols, and existing tests it cites
- **Run hints** — where to write it, how to run it
- **Scenario bucket** — what failure mode it targets

If dependencies aren't installed, tests are kept as **Manual tests** (Given/When/Then steps with the blocker named). Install dependencies and re-run to convert them to runnable tests.

</details>

<details>
<summary><strong>Test categories</strong></summary>

Generation is evidence-gated. A category is produced only when the graph has supporting evidence.

| Category | What it targets |
|----------|-----------------|
| Happy path | Primary expected behavior |
| Validation error | Bad/invalid input handling |
| Edge case | Boundaries, empty/null, concurrency, retries |
| Integration flow | Multi-step behavior across services |
| Security / privacy | Auth, injection, data leakage |
| Regression | Pinning a previously-broken behavior |

</details>

<details>
<summary><strong>Model setup (BYOK)</strong></summary>

Analysis, scoring, and proof need no model key. Generation does.

| Provider | Environment variable |
|----------|---------------------|
| OpenAI-compatible | `OPENAI_API_KEY` (optional: `OPENAI_BASE_URL`, `OPENAI_MODEL`) |
| Anthropic | `ANTHROPIC_API_KEY` (optional: `ANTHROPIC_MODEL`) |
| Ollama (local, no key) | `OLLAMA_BASE_URL` (optional: `OLLAMA_MODEL`) |

Auto-detect order: OpenAI → Ollama → Anthropic. Override with `--provider` and `--model`.

Run `opro setup` to configure interactively. Keys stay in your environment — never written to graph, config, or artifacts.

</details>

<details>
<summary><strong>AI candidate lanes</strong></summary>

With a provider key, OrangePro stages weak AI behavior→symbol links and AI-suggested candidate flows. These are review/generation worklists, not evidence:

- AI links appear as `AI-linked` suggestions.
- AI flows are stored separately from deterministic flows.
- Neither lane changes evidence tiers or denominator counts.

Use them when you want the agent to find likely service-boundary flows faster; ignore them for a deterministic-only report.

</details>

---

## What's on the hosted platform

This repo is the free local tool. The [OrangePro platform](https://orangepro.ai) adds:

- Persistent knowledge graph across PRs and repos
- PR/CI policy gates over evidence tiers and risk deltas
- Jira / Confluence / TestRail / OpenAPI enrichment
- Cross-repo intelligence and recurring-flow memory
- Production incident correlation and regression targeting
- Team dashboards and test lifecycle management

---

## Contributing

```bash
git clone https://github.com/OrangeproAI/orangepro-mcp.git
cd orangepro-mcp && npm ci && npm run build
npm test
```

PRs welcome. Please open an issue first for large changes.

---

<p align="center">
  MIT License · <a href="https://orangepro.ai">orangepro.ai</a>
</p>
