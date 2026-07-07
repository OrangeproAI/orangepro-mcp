# Demo — OrangePro

A single reproducible run that shows OrangePro end-to-end on a real repo, with a
readable report (no digging through raw logs). It demonstrates the core claim on one repo: a
lightweight **Local Knowledge Graph** makes generated tests more grounded and
traceable than a prompt alone — locally, with your own model key, without
uploading source or writing into the repo.

## Prerequisites

```bash
git clone https://github.com/OrangeproAI/orangepro-mcp.git
cd orangepro-mcp
npm ci
npm run build
```

## Run it

```bash
# Offline (no model key) — uses the deterministic stand-in so it always runs:
node scripts/demo-local-proof-kit.mjs --repo /path/to/any/repo --provider deterministic

# With a real model (BYOK) — set a key, then let it auto-detect, or be explicit:
OPENAI_API_KEY=sk-... node scripts/demo-local-proof-kit.mjs --repo /path/to/any/repo --model gpt-4.1
ANTHROPIC_API_KEY=sk-ant-... node scripts/demo-local-proof-kit.mjs --repo /path/to/any/repo --provider anthropic --model claude-sonnet-4-6
```

Flags: `--repo <path>` (target checkout), `--provider openai|anthropic|ollama|deterministic`,
`--model <name>`, `--limit <n>` (tests per arm, default 3).

> Use a strong current model for a real evaluation; cheaper/older models are fine
> for smoke tests but hallucinate more.

## What it does (and where it stays private)

The demo runs the **real built CLI** (`dist/local/cli.js`) in a **throwaway
workspace** (a temp dir), so the target repo stays pristine — nothing is written
into it, and no generated tests are written anywhere. Steps:

1. **analyze** — builds the evidence graph from the local checkout (no upload) and
   the offline graph explorer HTML.
2. **score** — readiness score (0–100) with a breakdown and "why it is not higher".
3. **doctor** — the smallest next steps to improve generated tests.
4. **gaps** — behaviors with weak/no test evidence.
5. **generate** — the same model twice: **Local KG (graph-grounded)** vs **raw
   prompt-only** (`--raw`). The report contrasts grounded-by entity refs and
   source/provenance refs — the Local KG arm cites the real modules/anchors.
6. **export** — a metadata-only evidence pack (`.json` + `.md`) and the offline
   graph explorer (`.html`).

Privacy guarantees demonstrated:

- **No stored source, no source/test file writes.** Source is read in-process for
  generation only; when model generation is enabled, redacted excerpts may be sent
  to your configured BYOK provider. No source or test files in the target repo are
  written (workspace metadata may be written under `.orangepro/`).
- **Metadata-only exports by default.** Generated test bodies are NOT embedded in
  the pack unless you pass `--include-generated-bodies`; raw source is not stored
  in local artifacts.
- **BYOK keys are never persisted** — read from env at call time only.

## Reading the result

The interesting rows in step 5 are **source/provenance refs** and **grounded-by
entity refs**: the raw prompt-only arm has none, while the Local KG arm points at
real files/anchors in the graph. That is the evidence to inspect; it is not
coverage proof or a quality guarantee by itself.

## Notes

- The artifacts (pack + graph HTML) are left in the temp workspace; the demo
  prints the exact paths and an `open` command for the explorer.
- The deterministic stand-in is for offline demos; it produces grounded structure
  but not model-quality prose. For a real evaluation, use a BYOK model.
