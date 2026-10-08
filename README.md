<p align="center">
  <img src="https://github.com/OrangeproAI/orangepro-mcp/raw/main/docs/logo-horizontal.svg" alt="OrangePro" width="320" />
</p>

<p align="center">
  <strong>See which code your tests really protect. Prove it by breaking the code on purpose.</strong>
</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@orangepro/mcp-server"><img src="https://badge.fury.io/js/@orangepro%2Fmcp-server.svg" alt="npm version" /></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg" alt="MIT License" /></a>
  <a href="https://www.npmjs.com/package/@orangepro/mcp-server"><img src="https://img.shields.io/npm/dw/@orangepro/mcp-server.svg" alt="npm downloads" /></a>
  <a href="https://glama.ai/mcp/servers/OrangeproAI/orangepro-mcp"><img src="https://glama.ai/mcp/servers/OrangeproAI/orangepro-mcp/badges/score.svg" alt="Glama score" /></a>
  <a href="https://registry.modelcontextprotocol.io/?q=orangepro"><img src="https://img.shields.io/badge/MCP_Registry-orangepro-orange.svg" alt="MCP Registry" /></a>
</p>

---

OrangePro maps every public function in your repository, links each one to the tests that actually call it, and ranks what's left by what it can break. For a test you care about, it breaks the function in an isolated copy and checks that the test fails. It runs on your machine, uses no AI model for scoring, and sends nothing to OrangePro. Model calls happen only if you add your own key, for optional test generation and suggestions.

```bash
npx -y @orangepro/mcp-server@latest start .
```

---

## Contents
- [What you get](#what-you-get)
- [Why developers use it](#why-developers-use-it)
- [Quick start](#quick-start)
- [Evidence tiers](#evidence-tiers)
- [How the ranking works](#how-the-ranking-works)
- [Prove a test](#prove-a-test)
- [Use with your coding agent](#use-with-your-coding-agent)
- [Configuration](#configuration)
- [Language support](#language-support)
- [Privacy and network use](#privacy-and-network-use)
- [Feedback](#feedback)
- [Reference](#reference)

---

## What you get
Every run writes two reports to `.orangepro/`:

| File | For | What's in it |
|---|---|---|
| `short_behavior-coverage.html` | Leads, reviewers, anyone in a hurry | One page: the headline, where to start, the code paths that delete data and their test evidence, the top-ranked items, the tests behind each proof, and how to reproduce the run. Each name links to its line at the analysed commit (GitHub and GitLab). |
| `behavior-coverage.html` | Developers | The full interactive map: every behavior and its evidence, flows from entry points through services, the ranked list with suggested tests, and the settings used. |

**<a href="https://orangeproai.github.io/orangepro-mcp/twenty-crm-behavior-coverage.html" target="_blank">→ Live example: Twenty CRM (5,237 behaviors mapped)</a>**

<img width="895" alt="OrangePro system map: entry lanes, services, evidence tiers" src="https://github.com/user-attachments/assets/1ceba779-e0ec-4ec1-99ce-001bc3589b42" />

*System map: entry lanes (GraphQL, HTTP, jobs) flowing into services, sized by traffic, colored by evidence tier, red-ringed by risk.*

<img width="818" alt="Priority gaps" src="https://github.com/user-attachments/assets/30a512b6-7830-48db-a00f-a616e7176ea8" />

*Priority gaps in the open-source Hono project: unproven behaviors ranked by what they can break.*

---

## Why developers use it
- **It tells you what a test actually checks, not just what it runs.** A test that calls a function isn't necessarily checking it. `opro prove` replaces the function body with a fixed return value in an isolated copy and reruns your own test, unchanged. If the test still passes, it wasn't protecting that function.
- **It puts consequences first.** Two lists sit above the ranking:
  - **Can destroy data:** code paths that reach a delete or purge with no proven test. Cache evictions don't count.
  - **Changing fast:** code that changes often with nothing proving it works.
- **It's honest about evidence.** A function is "linked" only when a test calls that exact function. A test with a similar name is a lead, never coverage. Tests that only check mocks don't count.
- **It's repeatable.** Same commit, full git history, same config and same version give the same ranking. Each report records fingerprints, so you can tell when a change in results came from the code and when it came from the tool.
- **Your coding agent can drive it.** As an MCP server it gives Claude Code, Cursor, Copilot, Codex and others the ranked gaps, the suggested test location and the proof step in one loop.
- **It's free, local and open source (MIT).** No account, no API key for analysis, and no upload.

---

## Quick start
```bash
cd /path/to/your/repo
# install the repo's own dependencies first (npm ci, uv sync, go mod download, ...)
npx -y @orangepro/mcp-server@latest start .
open .orangepro/short_behavior-coverage.html
```

Analysis, ranking and proof need no model key. Test generation is optional and uses your own key (see [Model setup](#reference)).

**Tips for the most accurate run:**
- **Use a full clone, not a shallow one.** Change history drives part of the ranking, and the report says when history was partial.
- **Exclude what isn't product code** with `rank_exclude_paths` (see [Configuration](#configuration)).
- **Rerun after a change.** The detailed report shows what entered, moved up or got resolved since the last run.

**What's written:**
```
.orangepro/
├── short_behavior-coverage.html   ← one-page summary
├── behavior-coverage.html         ← full interactive report
├── graph.json                     ← the evidence graph (deterministic)
├── ledger.json                    ← proof certificates
├── rtm.md                         ← traceability matrix
└── config.json                    ← optional per-repo settings

orangepro_generated/               ← generated tests (only with a model key); your files are never edited
```

---

## Evidence tiers
Every behavior gets exactly one tier.

| Tier | What it means |
|---|---|
| **Dynamically Proven** | A test passed on the original code and failed at its own assertion when this function was broken in an isolated copy. |
| **Runtime-covered** | A coverage tool you ran executed this code. |
| **Statically Linked** | A test calls this exact function. That's a structural link, not proof. |
| **Name match only** | A test with a similar name exists. That's a lead, not evidence. |
| **No test found** | Nothing links a test to it. |

**What OrangePro doesn't count, so linked numbers are a floor, not a coverage percentage:**
- tests that only assert on mocks;
- calls made over HTTP or from end-to-end suites;
- in Python, objects that reach a test only through a fixture.

Check the tests before writing new ones for a flagged path.

> **"Dynamically Proven 0" is normal on a first run.** Proof runs your tests, so it happens only for the functions you choose, or within the attempt budget of `opro start`.

---

## How the ranking works
Each unproven function gets an OrangePro Risk Score, **ORS = P × I × D**:
- **P**: how likely it is to change. Change history, fan-out, new code and size.
- **I**: what it can break. Incoming references, entry-point position, data sensitivity, and a floor for paths that reach a delete or purge within two calls.
- **D**: how hard a break would be to notice. Evidence tier, and whether it runs unattended (jobs and schedulers).

The score sets the order of work. It is not a defect probability. The weights are fixed and no AI model is involved. The report shows the inputs behind every row.

---

## Prove a test
```bash
# Python: the mutation value is derived from the function (return annotation or its observed result)
opro prove-loop --target-symbol 'sym:app/billing/invoices.py#void_invoice' \
  --test 'tests/test_invoices.py::test_void_marks_invoice_void' --replacement sentinel

# TypeScript / JavaScript: give the inert body to substitute
opro prove-loop --target-symbol 'sym:src/orders.service.ts#OrdersService.cancel' \
  --test src/orders.service.spec.ts --replacement 'return null;'
```
- **Proven:** the test passes on the original code and fails at its own assertion on the broken copy.
- **Not proven:** the test still passes on the broken copy, so it doesn't protect that function. That's a finding too.
- **Unrunnable:** setup failed. This is never counted either way.

**Find weak tests without a model key:**
```bash
opro roast .   # passing tests whose targeted mutant still survives
```

---

## Use with your coding agent
OrangePro runs as an MCP server. Add it to your client's config:

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
| Codex / OpenCode / Windsurf | `npx -y @orangepro/mcp-server@latest agent --client codex` prints the setup |

**A prompt that runs the whole loop:**
> "Use `orangepro_start`, then `orangepro_find_test_gaps`. For the top gap, write a test at the suggested path, run it, then call `orangepro_prove_loop` and tell me whether it was proven."

---

## Configuration
Optional. Put it in `.orangepro/config.json` in the repository, or in `~/.orangepro/config.json` for defaults across repositories. Every setting that changes the ranking is shown in the report.

```json
{
  "classification": {
    "rank_exclude_paths": ["ui/**", "docs/**", "scripts/**"],
    "test_support_paths": ["internal/testutil/**"],
    "destructive_sinks": ["archive*"]
  },
  "tuning": { "churn_window_days": 180 },
  "proof": { "python_runner": "auto", "attempt_limit": 20 },
  "overrides": [
    { "symbol": "sym:src/legacy/shim.ts#shim", "action": "suppress", "reason": "generated shim, not product code" }
  ]
}
```
- **`rank_exclude_paths`** removes paths from the ranking. They are still counted as behaviors.
- **`destructive_sinks`** adds delete-like calls for your codebase.
- **Overrides** (`suppress`, `pin`, `reclassify`) each require a reason, and the report lists them.
- **Weights and tiers can't be configured.**

---

## Language support
| Language | Map and link | Generated tests | Mutation proof |
|----------|:-:|:-:|:-:|
| TypeScript / JavaScript | ✓ | ✓ Jest / Vitest / Mocha | ✓ |
| Python | ✓ | ✓ pytest | ✓ pytest |
| Go | ✓ | ✓ `*_test.go` | ✓ |
| Java | ✓ | ✓ JUnit 4/5 | ✓ |
| Kotlin, Rust, PHP, C#, Ruby, Swift, C, C++ | ✓ | planned | planned |

Mapping uses tree-sitter. Proof is deliberately narrower: each language needs a runner, a mutation locator and a sandbox profile.

---

## Privacy and network use
- **Nothing about your code or your runs is sent anywhere.** There is no usage telemetry.
- **Source is read in-process** and never stored or uploaded. Reports and the evidence graph contain metadata, not your source.
- **Your source files are never edited.** Proofs run in an isolated copy.
- **Model calls happen only if you configure a key,** and they go directly from your machine to the provider you chose. Keys are read from the environment and never written to disk.
- **Reports load nothing from the network.** The only outbound links are ones you click.

---

## Feedback
Reports include a **Give feedback** link and a **This looks wrong** link on each finding. Once in a while, after the findings, they also ask whether the report helped.
- **The links carry nothing about your project.** The form sends only what you review and submit.
- **You stay anonymous** unless you leave an email.

```bash
opro feedback          # print the link and your settings
opro feedback off      # stop the "Did this help?" question (links stay)
ORANGEPRO_FEEDBACK_URL=off   # hide every feedback link
```

The question appears at most once every 14 days (`ORANGEPRO_FEEDBACK_COOLDOWN_DAYS`). That preference is stored only on your machine. MCP clients get the link as optional result metadata (`_meta["ai.orangepro/feedback_url"]`), and your agent is never asked to prompt you for feedback.

---

## Reference
<details>
<summary><strong>CLI</strong></summary>

```bash
opro                          # same as opro start .
opro start . --no-ai --no-auto   # analyze + reports, no model calls, no proof attempts
opro start --base main        # scope to a branch diff
opro analyze                  # build the evidence graph and reports
opro gaps --limit 10          # top unproven behaviors, ranked
opro prove-loop ...           # mutation proof for one function (see above)
opro roast .                  # find tests whose mutant survives (no key needed)
opro doctor --proof           # why top targets aren't proven yet
opro generate --base main     # tests for what this branch changed (needs a model key)
opro rtm                      # traceability matrix
opro export                   # metadata-only evidence pack
opro coverage                 # find or generate runtime coverage artifacts
opro feedback [on|off]        # feedback link and invitation setting
opro mcp                      # run as an MCP server (stdio)
```
Add `--json` to any read command for machine output. Run `opro help` for every flag.
</details>

<details>
<summary><strong>MCP tools (18)</strong></summary>

| Tool | What it does |
|------|--------------|
| `orangepro_start` | Analyze, write both reports, return next actions |
| `orangepro_analyze_sources` | Build or refresh the evidence graph |
| `orangepro_find_test_gaps` | Unproven behaviors ranked by ORS |
| `orangepro_prove_loop` | Setup + mutation proof + report refresh for one behavior |
| `orangepro_prove` | Mutation proof only |
| `orangepro_generate_tests` | Grounded tests for gaps (model key required) |
| `orangepro_changed_impact` | What a diff touches |
| `orangepro_status` | Workspace state without running anything |
| `orangepro_doctor` | What evidence to add next |
| `orangepro_graph_score` | Graph readiness (0–100) |
| `orangepro_rtm` | Traceability matrix |
| `orangepro_stats` | Aggregate statistics |
| `orangepro_record_run` | Record a test run result |
| `orangepro_explain_test` | Why a test was generated |
| `orangepro_export_evidence_pack` | Metadata-only evidence pack |
| `orangepro_update_graph` | Incremental graph update |
| `orangepro_ai_links` | Weak behavior→code suggestions (optional AI, never evidence) |
| `orangepro_ai_flows` | Candidate flows (optional AI, never evidence) |
</details>

<details>
<summary><strong>Coverage artifacts</strong></summary>

Run your own unit and integration coverage first, then `opro start`. OrangePro ingests Go coverprofiles, lcov, coverage.py XML and JaCoCo XML, and keeps unit, integration and unclassified coverage separate. To label artifacts, add `.orangepro/coverage-suites.json`:

```json
{
  "artifacts": {
    ".orangepro/coverage/unit.coverprofile": { "suite": "unit", "command": "make unit-test-coverage" },
    ".orangepro/coverage/integration.coverprofile": { "suite": "integration", "command": "make integration-test-coverage" }
  }
}
```
</details>

<details>
<summary><strong>Model setup (BYOK, only for generation)</strong></summary>

| Provider | Environment variable |
|----------|---------------------|
| OpenAI-compatible | `OPENAI_API_KEY` (optional: `OPENAI_BASE_URL`, `OPENAI_MODEL`) |
| Anthropic | `ANTHROPIC_API_KEY` (optional: `ANTHROPIC_MODEL`) |
| Ollama (local, no key) | `OLLAMA_BASE_URL` (optional: `OLLAMA_MODEL`) |

Auto-detect order: OpenAI → Ollama → Anthropic. Override with `--provider` and `--model`, or run `opro setup`.
- **Model output never changes an evidence tier.** Only the mutation proof can mark a behavior Proven.
- **Generated tests land in `orangepro_generated/`** with the files and existing tests they're grounded on, and where and how to run them.
- **Generated tests that can't run yet are kept as manual steps,** with the blocker named.
</details>

<details>
<summary><strong>PR workflow</strong></summary>

```bash
opro generate --base main     # tests for what this branch changed (read-only git diff)
opro generate --changed       # current branch vs its base
opro generate --pr 1234       # checks out PR #1234 (asks first; refuses on a dirty tree)
```
</details>

---

## Hosted platform
This repository is the free local tool. The [OrangePro platform](https://orangepro.ai) adds:
- a persistent graph across PRs and repositories;
- CI gates on evidence and risk changes;
- requirement and incident correlation;
- team dashboards.

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
