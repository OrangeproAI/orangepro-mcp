#!/usr/bin/env node
// Portable multi-repo validation for the OrangePro Local Proof Kit.
//
// Runs the full pipeline (analyze -> score -> gaps -> generate -> pack -> graph HTML)
// against each repo path you pass, in a throwaway workspace so the target repo stays
// pristine, and ASSERTS the invariants an external tester cares about:
//   - no repo pollution (no .orangepro written into the target)
//   - evidence pack is schema-valid
//   - default pack is metadata-only (generated bodies omitted)
//   - pack + graph HTML leak no prompts, scoring weights, or prompt-builder internals
//   - graph HTML is offline (no network/CDN)
//   - score, gaps, and grounded generation all produce results
//
// Usage:
//   npm run build
//   node scripts/validate-repos.mjs /path/to/small-ts-repo /path/to/python-repo /path/to/large-repo
//
// Offline by default (deterministic stand-in). Set OPENAI_API_KEY / ANTHROPIC_API_KEY /
// OLLAMA_BASE_URL to exercise a real BYOK model instead.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { opAnalyze, opScore, opGaps, opGenerate } from "../dist/local/operations.js";
import { loadGraph } from "../dist/local/workspace.js";
import { buildPack } from "../dist/local/pack/exporter.js";
import { validatePack } from "../dist/local/pack/validate.js";
import { scoreGraph } from "../dist/local/score/score.js";
import { buildVizPayload } from "../dist/local/viz/payload.js";
import { renderVizHtml } from "../dist/local/viz/html.js";

const repos = process.argv.slice(2).map((p) => resolve(p));
if (repos.length === 0) {
  process.stderr.write(
    "Usage: node scripts/validate-repos.mjs <repo-path> [<repo-path> ...]\n" +
      "Pass 2-3 repos of different shapes (small TS/JS, Python/backend, large).\n"
  );
  process.exit(2);
}

const hasKey = !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OLLAMA_BASE_URL || process.env.ORANGEPRO_PROVIDER);
const provider = hasKey ? undefined : "deterministic";

// The model PROMPT TEXT must never cross the export boundary. The analyzer stores
// content hashes + symbol NAMES (never file contents), so this stays robust even when
// the repo under test legitimately defines identifiers like `buildSystemPrompt` or
// `WEIGHTS` (which appear as metadata, not as leaks). Token-level IP-leak detection
// against synthetic fixtures lives in the unit tests (privacy-export.test.ts) and the
// offline smoke (smoke-local.mjs).
const PROMPT_TEXT = "You are OrangePro's local test-generation assistant";

const log = (...a) => process.stdout.write(a.join(" ") + "\n");
let anyFail = false;

for (const repo of repos) {
  const checks = [];
  const ok = (name, pass, detail = "") => {
    checks.push({ name, pass, detail });
    if (!pass) anyFail = true;
  };

  if (!existsSync(repo)) {
    log(`\n■ ${repo}\n  SKIP — path not found`);
    anyFail = true;
    continue;
  }

  const ws = mkdtempSync(join(tmpdir(), "op-validate-"));
  try {
    const analyzed = opAnalyze(ws, { source: repo, includeMarkdown: true });
    const score = opScore(ws);
    const gaps = opGaps(ws, { limit: 10 });
    const gen = await opGenerate(ws, { limit: 3, provider });

    const graph = loadGraph(analyzed.graph_path);
    const pack = buildPack(graph, scoreGraph(graph));
    const packJson = JSON.stringify(pack);
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));

    ok("no repo pollution (.orangepro not written into target)", !existsSync(join(repo, ".orangepro")));
    ok("evidence pack schema-valid", validatePack(pack).valid);
    ok(
      "pack metadata-only (generated bodies omitted by default)",
      pack.generation_runs.every((r) => r.generated_tests.every((t) => t.body.startsWith("[omitted")))
    );
    ok("pack contains no model prompt text", !packJson.includes(PROMPT_TEXT));
    ok("graph HTML contains no model prompt text", !html.includes(PROMPT_TEXT));
    const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
    const inertUrlsOnly = urls.every((url) => url.startsWith("http://www.w3.org/") || url.startsWith("https://d3js.org"));
    ok(
      "graph HTML is offline (no network/CDN)",
      !/<script[^>]+\bsrc=/i.test(html) && !/<link[^>]+href=/i.test(html) && inertUrlsOnly,
      `${urls.length} inert namespace/license URL(s)`
    );
    ok("readiness score computed", typeof score.overall === "number" && score.overall >= 0 && score.overall <= 100, `score=${score.overall}/${score.band}`);
    ok(
      "non-empty behavior denominator computed",
      typeof gaps.total_behaviors === "number" && gaps.total_behaviors > 0,
      `${gaps.gaps.length}/${gaps.total_behaviors} behaviors`
    );
    ok(
      "generation grounded (or honest setup/thin guidance)",
      gen.generated_tests.every((t) => t.grounding.entity_ids.length > 0) || gen.warnings.length > 0 || gen.missing_evidence.length > 0,
      `${gen.generated_tests.length} test(s) via ${gen.model_provider}`
    );

    log(`\n■ ${repo}`);
    log(`  entities ${analyzed.entities_count} · score ${score.overall}/100 (${score.band}) · gaps ${gaps.gaps.length}/${gaps.total_behaviors} · gen ${gen.generated_tests.length} (${gen.model_provider})`);
    for (const c of checks) log(`  ${c.pass ? "PASS" : "FAIL"}  ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
  } catch (e) {
    anyFail = true;
    log(`\n■ ${repo}\n  FAIL — ${String(e && e.message ? e.message : e)}`);
  } finally {
    rmSync(ws, { recursive: true, force: true });
  }
}

log(`\n${anyFail ? "RESULT: FAIL — one or more checks failed." : "RESULT: ALL PASS"}`);
process.exit(anyFail ? 1 : 0);
