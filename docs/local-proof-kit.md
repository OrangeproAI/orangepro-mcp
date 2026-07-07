# OrangePro (`opro`)

Try graph-grounded test generation **on your own machine, before creating a tenant
or granting repo access.** OrangePro builds an evidence graph from a
local checkout, scores its readiness, generates a few grounded tests with **your own
model key**, and exports a portable evidence pack you can inspect — and later promote
into a hosted OrangePro tenant.

## Privacy first

- **No stored source.** Source is read in-process. When model generation is enabled,
  redacted source excerpts may be sent to your configured BYOK provider; OrangePro does
  not upload repos to an OrangePro tenant and does not store raw source in local artifacts.
- **Metadata-only artifacts.** `metadata_only` means **no source code** in the graph,
  manifest, or evidence pack — only file paths, names, hashes, frameworks, and provenance.
  Source files are read in-process only to ground generation, and obvious secrets are
  redacted first. **Generated test bodies are model output kept in the local graph; the
  exported pack and graph HTML exclude them by default — embed bodies in the pack only with
  `--include-generated-bodies`.** *Text you explicitly supply via a CSV/Markdown template* (requirement
  titles, descriptions, acceptance criteria) **is** included in the pack — that text is the
  reviewed evidence you chose to provide, so keep templates to releasable business metadata.
- **Your keys stay yours.** Model API keys are read from the environment at call time
  and are never written into the graph, config, or pack.
- **Local only.** All workspace-local writes live under `.orangepro/`; no source or test files in your repo are written. Add
  `.orangeproignore` (same spirit as `.gitignore`) to exclude paths from analysis.

## Install

```bash
npm ci && npm run build
npm link   # one-time: exposes the short `opro` command on your PATH
# CLI is then available as: opro …  (equivalently node dist/local/cli.js …, or `npm run local -- …` in dev)
```

## Demo (one reproducible run)

```bash
node scripts/demo-local-proof-kit.mjs --repo /path/to/repo --provider deterministic
```

Runs analyze → score → doctor → gaps → generate (Local KG vs raw prompt) → export
end-to-end in a throwaway workspace and prints a readable report when running from a
source checkout. npm users can run the CLI commands below directly.

## CLI

```bash
opro                            # one-command start: analyze, optional AI weak links, graph, RTM, next actions
opro init                       # create the .orangepro/ workspace
opro analyze .                  # build the local evidence graph + write .orangepro/behavior-coverage.html (scan-all by default)
opro status                     # fresh / stale / missing + score + privacy
opro doctor                     # smallest next source that improves test quality
opro score                      # readiness score + breakdown + "why not higher"
opro gaps --limit 10            # behaviors with weak/missing test evidence
opro generate --target REQ-001 --framework playwright --limit 3   # default: A/B (prompt-only vs Local KG), scored + report
opro generate --single --limit 3   # one arm only — persists the tests to the graph
opro generate --base main       # PR-scoped: target only behaviors the diff vs main touches
opro generate --pr 123          # advanced: checks out PR #123 (changes your working tree), re-analyzes, targets its diff
opro generate --base main --background   # PR-scoped + detached; poll with `opro jobs`
opro jobs [<id>]                # list background jobs, or show one (status + outputs + log)
opro explain <generated_test_id># which evidence anchors grounded a test
opro update                     # incremental, non-destructive refresh
opro changed --base main        # changed files + affected behaviors/tests
opro export --out orangepro-evidence-pack.json
opro analyze . --no-coverage-html # skip the behavior report HTML (it is written by default)
opro export --format graph-html # write just the explorer (orangepro-graph.html)
opro mcp                        # run the MCP server (stdio)
```

Report commands default to `.orangepro/`. When you are collecting a public
validation bundle, pass an explicit local path such as
`opro rtm --format json --out /tmp/orangepro-run/rtm.json`.

Runnable Python and Go generation uses local syntax validators before OrangePro
returns a run command: `python3` for pytest bodies and `gofmt` for Go bodies. If
the toolchain is missing or the generated body is not valid for that language,
the test is returned as a grounded draft with no run hint.

Scan-all is the default: `analyze` no longer caps inferred behavior anchors at a low
number (lower it with `ORANGEPRO_MAX_FLOWS` / `ORANGEPRO_MAX_FILES` only to bound a
huge run), and it prints `files scanned: N` plus any cap that was hit.

### Evidence graph explorer

`analyze` writes a **self-contained, offline** behavior report to
`.orangepro/behavior-coverage.html` **by default** (`--no-coverage-html` to skip). The
graph explorer described below is written by `opro export --format graph-html`
(standalone `orangepro-graph.html`) — no CDN, no network, metadata-only (never source,
bodies, or prompts).
It opens
score-first, shows a *summarized* evidence layer (not a 3k-node hairball), and lets you
search a symbol (e.g. `useScaledAmount`), click it, and see the connected files, tests,
behaviors, and provenance — the visual half of "here's *why* the generated tests are
grounded." Tabs: Overview · Coverage (behavior → test → file/symbol) · Gaps. Deep-link with
`?select=<id|label>&view=<overview|coverage|gaps>`.

Add `--json` to any read command for machine-readable output. Optional enrichers:
point `analyze` at a small CSV requirements template or Markdown docs to raise the
score and test specificity (`analyze . --paths payments-template.csv`).

## BYOK (bring your own model key)

Provider adapters, auto-detected in order **OpenAI-compatible → Ollama → Anthropic**:

| Provider | Env |
|---|---|
| OpenAI-compatible | `OPENAI_API_KEY`, optional `OPENAI_BASE_URL`, `OPENAI_MODEL` |
| Ollama (local) | `OLLAMA_BASE_URL`, optional `OLLAMA_MODEL` |
| Anthropic | `ANTHROPIC_API_KEY`, optional `ANTHROPIC_MODEL` |

With **no model key set, no tests are generated** — `generate` returns setup guidance
instead (the BYOK contract never silently degrades to a non-model output). To run fully
offline, opt in explicitly with `--provider deterministic` (CLI) or
`ORANGEPRO_ALLOW_DETERMINISTIC=1`, which uses a clearly-labeled deterministic stand-in.
Static analysis, scoring, gaps, and pack export never need a model.

### v5 batched generation (opt-in)

The auto-prove generation lane (`opro start`, the `orangepro_start` MCP tool, and the PR
diff path) defaults to the **v2** prompt strategy. Opt into the **v5** batched two-phase
strategy (plan scenarios → batch-generate) with `--prompt-version v5` (CLI) or
`prompt_version: "v5"` (MCP). The flag only changes **which** tests are drafted — a
generated test is still marked Proven only when it genuinely kills the null-sentinel mutant
via the **unchanged** dynamic-proof oracle. The default path is unchanged (no key required
for v2/deterministic; existing behavior and CI are untouched).

Exercise the live v5 loop against a tiny fixture with a keyed smoke:

```bash
# LIVE (requires a BYOK key — fails clearly, exit 2, if none is set):
OPENAI_API_KEY=sk-... npm run smoke:generate-prove-v5
# or ANTHROPIC_API_KEY=... / OLLAMA_BASE_URL=...

# Offline plumbing check (flag accepted + start completes; generation lane is key-gated):
node scripts/smoke-generate-prove-v5.mjs --fake
```

**CI note:** `smoke:generate-prove-v5` (LIVE) needs a real provider key and is intentionally
NOT wired into the default CI. To add a keyed job, expose one of `OPENAI_API_KEY` /
`ANTHROPIC_API_KEY` / `OLLAMA_BASE_URL` as a CI secret and run `npm run smoke:generate-prove-v5`.
The end-to-end v5→Proven wiring is covered offline (no key) by
`tests/local/autoProve.test.ts` ("v5 track wiring"), which drives the real v5 branch with a
fake provider.

## Scenario buckets (generation diversity)

`generate` is **target-focused**: it picks the top-gap behavior (or your `--target`)
and produces up to `--limit` tests for that one behavior, each covering a different
lightweight **local scenario bucket** when the evidence supports it:

`happy_path` · `validation_error` · `edge_case` · `integration_flow` · `security_privacy` · `regression`

Buckets are chosen from the behavior's own evidence (acceptance criteria, code
context, related tests, weak/candidate edges) and are **never padded** — an
unjustified bucket is skipped rather than filled with a generic smoke test. Each
generated test reports its bucket, cites the evidence anchors it used, and discloses
any weak evidence. Passing several `--target` ids splits the budget across them (each
gets a test when the budget allows, in priority order). Total caps are unchanged
(default 3, max 5).
These are the local kit's own categories — the hosted platform owns full bucket
orchestration, caps, and lifecycle coverage.

## MCP (any agent: Cursor, Codex, Claude, Copilot, …)

Run `opro agent --client claude-code|cursor|codex|opencode` to print a client-ready MCP
config plus the write/run/report loop. The shipped guide is
[agent-workflow.md](agent-workflow.md), with per-agent setup notes for
[Codex](agents/codex.md), [Claude Code](agents/claude-code.md),
[Cursor](agents/cursor.md), and [OpenCode](agents/opencode.md).

```json
{
  "mcpServers": {
    "orangepro-local": {
      "command": "node",
      "args": ["/absolute/path/to/orangepro-mcp/dist/local/cli.js", "mcp"],
      "env": { "OPENAI_API_KEY": "<your local key>" }
    }
  }
}
```

First-slice MCP tools (same behavior as the CLI, same core): `orangepro_start`, `orangepro_analyze_sources`,
`orangepro_graph_score`, `orangepro_status`, `orangepro_doctor`, `orangepro_find_test_gaps`,
`orangepro_record_run`, `orangepro_prove`, `orangepro_prove_loop`, `orangepro_stats`, `orangepro_rtm`, `orangepro_update_graph`,
`orangepro_changed_impact`, `orangepro_ai_links`, `orangepro_ai_flows`, `orangepro_generate_tests`,
`orangepro_explain_test`, `orangepro_export_evidence_pack`. **No upload or repo-write tools.**

### Tool modes (baseline vs diff/PR)

Two explicit classes, so an agent never fabricates PR analysis when there is no PR:

- **Baseline tools** — the *"try OrangePro on any repo"* entry point. They run on the
  current local graph/checkout and need **no diff or PR**: `orangepro_start`,
  `orangepro_analyze_sources`, `orangepro_status`, `orangepro_graph_score`,
  `orangepro_doctor`, `orangepro_find_test_gaps`, `orangepro_rtm`,
  `orangepro_generate_tests`, `orangepro_record_run`, `orangepro_prove`, `orangepro_prove_loop`, `orangepro_stats`,
  `orangepro_explain_test`, `orangepro_export_evidence_pack`.
- **Diff/PR tools** — only for **real code-review situations**. They require a git repo
  and a real diff vs a base ref (default `main`). Today: `orangepro_changed_impact`
  (future helpers may split risk and test-plan output, but they are not separate MCP
  tools today). When there is nothing to
  analyze they return a structured `status` + `guidance` instead of fabricated output:
  - `not_a_git_repo` — the checkout is not a git repository.
  - `missing_base_ref` — the base ref does not exist; pass an existing `base_ref`.
  - `no_diff` — no changed files; run on a feature branch, pass `base_ref`, or use
    `orangepro_find_test_gaps` for baseline opportunities.

  Still no source/test file writes and no repo upload to an OrangePro tenant — and no hallucinated impact when there is no diff.

## The evidence graph

OrangePro-shaped, test-generation-oriented — **not** a generic code graph. Every node and
edge carries an **evidence strength** (`hard` / `reviewed` / `candidate` / `weak`) and
**provenance**. Explicit source refs, exact ids/paths, and reviewed template rows are hard
evidence; LLM/similarity inference is candidate-only and never counts as proof. Generated
tests link back to the graph evidence that grounded them, and disclose any weak evidence used.

For coverage scoring, OrangePro uses one public glossary:

- **Dynamically Proven** (labeled "Dynamically Proven" in the report/CLI/RTM) means a dynamic
  targeted-proof ledger certificate closed for the behavior: baseline green, target mutated, same
  test failed at an assertion, and the target was not mocked. The static map covers the whole repo;
  the dynamic pass proves only the top few eligible behaviors per run (default 5, `--auto-limit` to raise).
- **Runtime-covered** means the repo's own coverage tool executed the code, but not that an
  assertion checked the behavior.
- **Associated signal** means name, path, import, or structural matches suggest a useful link,
  but not semantic proof.
- **No integration signal** means no direct static test signal was found yet. It does not mean “untested.”

The HTML report presents these as four display tiers: **Dynamically Proven**, **Statically Linked**
(the report's label for an Associated signal — a test file appears to import or call the behavior,
not dynamically verified), **Reachable Untested** (a behavior that appears in a static flow from an
entry point but has no test signal), and **No Signal** (no test or static-flow signal yet). These are
presentation labels over the same statuses above; they change no classification, count, or ledger record.

LLM, similarity inference, and static hard TESTED_BY/COVERS edges are candidate or
associated signals until a dynamic targeted proof closes.

### Dynamic proof language profiles

Dynamic targeted proof ships as per-ecosystem **profiles**, all passing the same trust
gate (baseline green → targeted mutation → the same test fails at an assertion → target
not mocked):

- **TypeScript/JavaScript** — vitest / jest / mocha, monorepo-aware (`tsconfig`
  `extends`/`paths` workspaces).
- **Go** — `go test`, scoped to the target's package.
- **Java** — Maven / JUnit.
- **Python** — pytest.

The static map is broader than the dynamic pass: languages without a proof profile yet
(Kotlin, Rust, ...) still get the full static picture (behaviors, flows, Statically
Linked, Reachable Untested, and any ingested runtime coverage). Where a language's
profile cannot run, dynamic proof does not pretend — it reports a precise "not supported
/ workspace config missing" reason and those behaviors stay in their static tiers.

The local ledger is a trusted local artifact, not a cryptographic attestation. A
hosted/product proof path must bind each dynamic certificate to witnessed run artifacts
before accepting it from an untrusted client or edited checkout.

Runtime coverage is reported separately when local coverage-tool artifacts are present. The
local kit ingests Go coverprofiles, JS/TS `lcov.info`, Python coverage.py XML, and Java JaCoCo
XML. These artifacts show executed lines inside symbols; they are not assertion-level proof and
never promote Associated signal or No integration signal rows to Proven.

## Readiness score

A 0–100 **readiness** signal (not a proof of lift), in bands: `thin` (0–39),
`usable` (40–59), `good` (60–74), `strong` (75+). The report always explains *why the
score is not higher* — that is the trust feature. Exact weights and the formula stay
internal; only the per-dimension breakdown, band, and missing-evidence are exposed.

## Evidence pack

`export` writes a JSON pack (validated against `orangepro.local_evidence_pack.v0`) plus a
Markdown summary. The pack includes facts, provenance, evidence strength, generated outputs,
and high-level score metadata. It **excludes** prompts, prompt templates, ranking traces,
hidden weights, traversal traces, and raw source — promotion-ready, not
reverse-engineering-ready. The strict schema validator enforces this boundary.

## Validation

Before release, the local kit is checked against representative real repositories for
broken graph edges, parser downgrades, symbol truncation, and source-leak regressions.
The public contract is simple: graph construction is deterministic and local; generated
tests cite the file paths, symbols, tests, and evidence labels that grounded them.

### Why graph grounding helps

The headline claim is not "a graph beats a weak prompt." The useful comparison is:
same selected model, same target behavior, but one run receives concrete graph evidence
and the other does not. The graph-grounded run can cite real symbols, nearby tests,
imports, and evidence strength, so it is less likely to invent modules and easier for a
developer to verify.

## What's deferred (hosted/premium or later phases)

Hosted upload/promotion, Docker, watch mode, PDF/DOCX, Jira/Confluence/TestRail/OpenAPI
enrichers, repo file writing (safe patch workflow), continuous coverage intelligence, and
third-party graph import. The hosted KG remains the system of record; this kit is the local
adoption surface.
