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
- [Requirements and limits](#requirements-and-limits)
- [Privacy and network use](#privacy-and-network-use)
- [Feedback](#feedback)
- [Reference](#reference)

---

## What you get
Every run writes two reports and a spreadsheet of tests to `.orangepro/`:

| File | For | What's in it |
|---|---|---|
| `short_behavior-coverage.html` | Leads, managers, anyone in a hurry | One page: what to do with the 20 highest-priority functions, the top five with the reason and the tests drafted for each, what changed since the last report, and how to reproduce the run. |
| `behavior-coverage.html` | Developers | **Worklist:** every ranked function with what to do, filters, and a side panel with the evidence, why it ranks, two drafted tests and the proof command. **Map:** where tests reach, by area. **Run details:** inputs, counts, proofs, fingerprints and settings. |
| `tests.csv` | QA, test managers | One row per test slot (preconditions, steps, test data, expected result, priority, folder), ready for Excel, Google Sheets, TestRail, Jira Xray or Zephyr Scale. **Export tests (CSV)** in the detailed report downloads it, and its Run details show how the columns map ([Importing tests.csv](#reference)). |

Every function gets one of four things to do:

| | What it means | What to do |
|---|---|---|
| **Done** | A test fails when this code breaks. | Nothing. It moves back to Prove if the code changes. |
| **Prove** | A test runs it, or a coverage run executes it, but no test is proven to catch a break. | Run the proof command. |
| **Check** | A test file or test name points here, but no call was traced. | Read that test file first; prove it if it drives the function, otherwise write one. |
| **Write** | No test catches a break here yet. | Write a test (two are drafted for the top 20), then prove it. |

### The one-page summary
<img width="880" alt="OrangePro one-page summary: what to do with the 20 highest-priority functions, and the top five with their tests" src="https://github.com/OrangeproAI/orangepro-mcp/raw/main/docs/images/short-report.png" />

### The detailed report
<img width="880" alt="OrangePro detailed report: the worklist with filters and the side panel for one function" src="https://github.com/OrangeproAI/orangepro-mcp/raw/main/docs/images/detailed-report.png" />

*Both from OrangePro run on its own repository at commit `64a5213`, without a model key, so no tests were drafted. With a key, each of the top 20 shows two drafted tests, and the side panel shows their steps and code.*

---

## Why developers use it
- **It tells you what a test actually checks, not just what it runs.** A test that calls a function isn't necessarily checking it. `opro prove` replaces the function body with a fixed return value in an isolated copy and reruns your own test, unchanged. If the test still passes, it wasn't protecting that function.
- **It puts consequences first.** One filter shows the code paths that reach a delete or purge (cache evictions don't count); others show code that changes often, has many callers or runs on a schedule.
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
- **Rerun after a change.** Each report says what changed since the last one. When nothing changed (same commit, files, settings, coverage and proofs), `start` reuses the last reports at once and says so; `--fresh` runs in full anyway.

**What's written:**
```
.orangepro/
├── short_behavior-coverage.html   ← one-page summary
├── behavior-coverage.html         ← detailed report: worklist, map, run details
├── tests.csv                      ← drafted tests, one row per test
├── report-data.json               ← the data both reports show (used to compare and reuse runs)
├── run-key.json, last-start.json  ← what the last run saw, so an unchanged repo is not analysed again
├── graph.json                     ← the evidence graph (deterministic)
├── ledger.json                    ← proof certificates
├── rtm.md                         ← traceability matrix
└── config.json                    ← optional per-repo settings

orangepro_generated/               ← generated tests (only with a model key); your files are never edited
```

---

## Evidence tiers
Every function gets exactly one evidence label. The four things to do above are read from it.

| Evidence | What it means | To do |
|---|---|---|
| **Proven** | A test passed on the original code and failed at its own assertion when this function was broken in an isolated copy. | Done |
| **Runs under tests** | A coverage tool you ran executed this code. | Prove |
| **Linked** | A test calls this exact function. That's a structural link, not proof. | Prove |
| **Unconfirmed** | A test file or a test with a similar name points here, but no call was traced. That's a lead, not evidence. | Check |
| **No test found** | Nothing links a test to it. | Write |

A proof that ran and did not catch the break turns the function into **Write**; a proof made before the code changed turns it back into **Prove**.

**What OrangePro doesn't count, so linked numbers are a floor, not a coverage percentage:**
- tests that only assert on mocks;
- calls made over HTTP or from end-to-end suites;
- in Python, objects that reach a test only through a fixture.

Check the tests before writing new ones for a flagged path.

> **"Proven 0" is normal on a first run.** Proof runs your tests, so it happens only for the functions you choose, or within the attempt budget of `opro start`.

---

## How the ranking works
Each unproven function gets an OrangePro Risk Score, **ORS = P × I × D**:
- **P**: how likely it is to change. Change history, fan-out, new code and size.
- **I**: what it can break. Incoming references, entry-point position, data sensitivity, and a floor for paths that reach a delete or purge within two calls.
- **D**: how hard a break would be to notice. Evidence tier (a linked test or a coverage run makes a break easier to notice than a name match or nothing), and whether it runs unattended (jobs and schedulers).

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
| Language | Map functions | Link tests that call them | Draft tests | Mutation proof |
|----------|:-:|:-:|:-:|:-:|
| TypeScript / JavaScript | ✓ | ✓ | ✓ Jest, Vitest, Mocha | ✓ Jest, Vitest, Mocha |
| Python | ✓ | ✓ | ✓ pytest | ✓ pytest |
| Go | ✓ | ✓ | ✓ `*_test.go` | ✓ `go test` |
| Java | ✓ | ✓ | ✓ JUnit 4 and 5 | ✓ Maven with JUnit 5 only |
| Kotlin, Rust, PHP, C#, Ruby, Swift, C, C++ | ✓ | name match only | not yet | not yet |

- **"Name match only"** means a test file or test name that looks like the function makes it **Unconfirmed** (Check). No call is traced, so these languages never reach **Linked** or **Proven** today.
- **TypeScript and JavaScript** are parsed with the TypeScript compiler; the other languages with tree-sitter.
- **Python proof** runs pytest through the repository's own environment: an existing `.venv` or `venv`, then `uv` or `poetry` when their lock files are present, else `python -m pytest`. Set `proof.python_runner` to use your own command.
- **Java proof** needs Maven (Surefire) and JUnit 5. Gradle and JUnit 4 projects are mapped and linked, but not proven yet.
- **Not traced yet,** so tested code can show as Unconfirmed: calls through Go test-suite methods and helper constructors, dependency injection that is wired at runtime, reflection, and calls made over HTTP or RPC.

---

## Requirements and limits
- **Node.js 20 or newer,** on macOS or Linux. Windows isn't tested: proofs use POSIX paths and symlinks.
- **Git, for change history.** Without it, or in a shallow clone, the ranking uses structure only and the report says so. A folder that isn't a git checkout always runs in full.
- **Install the repository's dependencies first** (`npm ci`, `uv sync`, `go mod download`, `mvn -q install`, …). Proof runs your own tests in an isolated copy and needs them to pass there.
- **What's read:** source and test files, skipping anything in `.gitignore` or `.orangeproignore` (negations with `!` aren't supported), the usual build and dependency folders (`node_modules`, `vendor`, `dist`, `build`, `target`, `coverage`, `.venv`, …), files over 1 MB, and generated code (files marked `Code generated … DO NOT EDIT`). Up to 100,000 files; `ORANGEPRO_MAX_FILES` lowers that and `ORANGEPRO_MAX_ANALYZE_MS` sets a time limit for the scan.
- **Test drafting** covers the 20 highest-priority functions, two tests each, in the order the worklist shows, and the reports show those 20. Drafts are kept until the function's code changes.
- **What counts as "nothing changed"** for reusing a run: the commit, every modified or untracked file that git doesn't ignore, OrangePro's settings and ignore files, coverage files, the proof ledger, the `start` options, whether a model key is set, and the analysis version. A run whose test drafting failed on a provider error (out of credits, rate limit) runs again in full.
- **The CSV column mapping follows each tool's CSV importer** (see [Importing tests.csv](#reference)). Check the import preview the first time.

---

## Privacy and network use
- **Nothing about your code or your runs is sent anywhere.** There is no usage telemetry.
- **Source is read in-process** and never stored or uploaded. Reports and the evidence graph contain metadata, not your source.
- **Your source files are never edited.** Proofs run in an isolated copy.
- **Model calls happen only if you configure a key,** and they go directly from your machine to the provider you chose. Keys are read from your environment or from a `.env.provider.local`, `.env.local` or `.env` file in the repository, and OrangePro never writes them anywhere. `opro setup` saves only the provider and model name.
- **With a key, the reports and `tests.csv` include the tests your model drafted,** and the prompts include the function names, files and evidence they're based on.
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
opro start . --fresh          # run in full even when nothing changed since the last run
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
| `orangepro_start` | Analyze, write both reports and `tests.csv`, return next actions; returns at once with `unchanged_since` when nothing changed (`fresh` forces a full run) |
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
- **Drafts whose code fails the compile check are kept as plans** ("Plan only"), with the reason named. Without a key, each of the top 20 shows two empty slots with a prompt you can copy into your coding agent.
</details>

<details>
<summary><strong>Importing tests.csv</strong></summary>

One row per test, UTF-8. The first 12 columns are for import; the rest keep the priority, evidence and proof command with each test. Priority is `High` for the five highest-ranked functions and `Medium` for the rest.

| Column in `tests.csv` | TestRail | Jira Xray | Zephyr Scale |
|---|---|---|---|
| ID | | Test Case Identifier | (leave Key empty) |
| Title | Title | Summary | Name |
| Section (`a > b`) | Sections Hierarchy | | |
| Folder (`a/b`) | | Test Repository Path | Folder |
| Priority | Priority | Priority | Priority (map Medium to Normal) |
| Test type | Type | Labels | Labels |
| Preconditions | Preconditions | (separate issues in Xray; add to Description if you want them) | Precondition |
| Steps | | Manual Test Step: Action | |
| Test data | | Manual Test Step: Data | |
| Steps with data | Steps | | Test Script (Steps) - Step |
| Expected result | Expected Result | Manual Test Step: Expected Result | Test Script (Steps) - Expected Result |
| References | References | Description | Objective |

- **TestRail:** Import from CSV with the **Test Case (Text)** template, one row per test case.
- **Jira Xray:** Test Case Importer; each test imports as one manual step.
- **Zephyr Scale:** it has no test-data field, so **Steps with data** carries it.
- **Check the importer's preview** before you confirm.
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
