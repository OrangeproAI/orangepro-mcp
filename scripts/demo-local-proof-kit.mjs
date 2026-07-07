#!/usr/bin/env node
// OrangePro — reproducible demo for an external tester.
//
// Runs the REAL built CLI (dist/local/cli.js) end-to-end against a target repo,
// in a throwaway workspace so the target stays pristine (no .orangepro written
// into it, no generated tests written anywhere), and prints one readable report:
//   analyze -> score -> doctor -> gaps -> generate (Local KG vs raw prompt) ->
//   export evidence pack + offline graph HTML.
//
// Privacy: source is read in-process for generation only; it is never uploaded
// and never written back. The evidence pack + graph HTML are metadata-only by
// default (generated bodies are opt-in). Model keys (BYOK) are read from env at
// call time and never persisted.
//
// Usage:
//   npm run build
//   node scripts/demo-local-proof-kit.mjs --repo /path/to/repo [--provider openai|anthropic|ollama|deterministic] [--model <name>] [--limit 3]
//
// With no model key and no --provider, the demo uses the offline deterministic
// stand-in so it always runs; set OPENAI_API_KEY / ANTHROPIC_API_KEY / OLLAMA_BASE_URL
// (or pass --provider/--model) to exercise a real BYOK model.

import { execFileSync } from "node:child_process";
import { mkdtempSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = resolve(HERE, "../dist/local/cli.js");

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const t = argv[i];
    if (t.startsWith("--")) {
      const k = t.slice(2);
      const n = argv[i + 1];
      if (n !== undefined && !n.startsWith("--")) { out[k] = n; i++; } else { out[k] = true; }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));
const repo = args.repo ? resolve(String(args.repo)) : process.cwd();
const limit = args.limit ? Number(args.limit) : 3;
const argProvider = typeof args.provider === "string" ? args.provider : undefined;
const argModel = typeof args.model === "string" ? args.model : undefined;

if (!existsSync(CLI)) {
  console.error(`Build first: \`npm run build\` (missing ${CLI}).`);
  process.exit(2);
}
if (!existsSync(repo)) {
  console.error(`Target repo not found: ${repo}. Pass --repo /path/to/repo.`);
  process.exit(2);
}

const ws = mkdtempSync(join(tmpdir(), "op-demo-"));
const hasKey = !!(process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || process.env.OLLAMA_BASE_URL || process.env.ORANGEPRO_PROVIDER);
const genProvider = argProvider || (hasKey ? undefined : "deterministic");

function cli(cmd, ...flags) {
  const a = [CLI, cmd, ...flags, "--json"];
  const raw = execFileSync("node", a, { cwd: ws, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(raw);
}

const hr = (s) => console.log(`\n${"─".repeat(70)}\n${s}\n${"─".repeat(70)}`);
const line = (s = "") => console.log(s);

console.log(`OrangePro — demo`);
console.log(`  target repo : ${repo}`);
console.log(`  workspace   : ${ws}   (throwaway; target stays pristine)`);
console.log(`  generation  : ${genProvider ?? "BYOK (auto-detect from env)"}${argModel ? ` / ${argModel}` : ""}`);

// 1. init + analyze (+ build the offline graph explorer)
cli("init");
const analyzed = cli("analyze", repo, "--graph-html");
hr("1. ANALYZE — evidence graph built from the local checkout (no upload)");
line(`  sources: ${analyzed.sources_count}   entities: ${analyzed.entities_count}   relationships: ${analyzed.relationships_count}   candidates: ${analyzed.candidate_relationships_count}`);
for (const w of analyzed.warnings || []) line(`  warning: ${w}`);

// 2. status + score + doctor
const status = cli("status");
const score = cli("score");
hr("2. READINESS SCORE — how test-ready the graph is, and why not higher");
line(`  score: ${score.overall}/100  (${score.band})`);
for (const [k, v] of Object.entries(score.breakdown)) line(`    ${Number(v).toFixed(2)}  ${k}`);
line("  why it is not higher:");
for (const m of score.missing_evidence.slice(0, 6)) line(`    - ${m}`);

const doctor = cli("doctor");
hr("3. DOCTOR — smallest next steps to improve generated tests");
line(`  status: ${doctor.status}`);
for (const r of doctor.recommendations.slice(0, 4)) line(`    ${r.priority}. ${r.action}  [${r.expected_score_impact}]`);

// 4. gaps
const gaps = cli("gaps", "--limit", "10");
hr("4. TEST GAPS — behaviors with weak/no test evidence");
line(`  ${gaps.gaps.length} of ${gaps.total_behaviors} behaviors flagged:`);
for (const g of gaps.gaps.slice(0, 8)) line(`    [${g.priority}] ${g.title}  (${g.external_id})`);

// 5. generate — Local KG (graph-grounded) vs raw prompt-only, SAME model
const provFlags = genProvider ? ["--provider", genProvider] : [];
const modelFlags = argModel ? ["--model", argModel] : [];
// --single: one arm per call (plain `generate` now defaults to the A/B compare view).
const grounded = cli("generate", "--single", "--limit", String(limit), ...provFlags, ...modelFlags);
const raw = cli("generate", "--single", "--raw", "--limit", String(limit), ...provFlags, ...modelFlags);

const refsOf = (r) => r.generated_tests.reduce((a, t) => a + (t.grounding?.source_refs?.length || 0), 0);
const groundedBy = (r) => r.generated_tests.reduce((a, t) => a + (t.grounding?.entity_ids?.length || 0), 0);

hr(`5. GENERATE — Local KG vs raw prompt-only (same model: ${grounded.model_provider}/${grounded.model_name})`);
line(`  | metric                         | raw prompt-only | Local KG (graph-grounded) |`);
line(`  | ------------------------------ | --------------: | ------------------------: |`);
line(`  | tests generated                | ${String(raw.generated_tests.length).padStart(15)} | ${String(grounded.generated_tests.length).padStart(25)} |`);
line(`  | grounded-by entity refs (total)| ${String(groundedBy(raw)).padStart(15)} | ${String(groundedBy(grounded)).padStart(25)} |`);
line(`  | source/provenance refs (total) | ${String(refsOf(raw)).padStart(15)} | ${String(refsOf(grounded)).padStart(25)} |`);
line(`  | repo files written             | ${String(raw.wrote_repo_files).padStart(15)} | ${String(grounded.wrote_repo_files).padStart(25)} |`);
line("");
const kgBuckets = grounded.generated_tests.map((t) => t.bucket).filter(Boolean);
line("  Local KG is target-focused: up to `limit` bucket-diverse tests for the top behavior");
line("  (raw prompt-only samples one test across several behaviors).");
if (kgBuckets.length) line(`  Local KG scenario buckets: ${kgBuckets.join(", ")}`);
line("");
line("  Local KG sample (titles + what grounds them):");
for (const t of grounded.generated_tests.slice(0, limit)) {
  line(`    ● ${t.title}  [${t.test_type}/${t.framework_hint}]`);
  line(`        grounded by: ${(t.grounding.entity_ids || []).join(", ") || "—"}`);
  line(`        source refs: ${(t.grounding.source_refs || []).join(", ") || "—"}`);
  line(`        weak/candidate evidence used: ${t.weak_evidence_used ? "yes (disclosed)" : "no"}`);
}
for (const w of grounded.warnings || []) line(`  warning: ${w}`);

// 6. export evidence pack + graph HTML (metadata-only by default)
const exp = cli("export", "--out", "orangepro-evidence-pack.json", "--graph-html");
hr("6. EXPORT — metadata-only evidence pack + offline graph explorer");
line(`  evidence pack:   ${exp.pack_path}`);
line(`  markdown summary:${exp.summary_path}`);
line(`  schema valid:    ${exp.valid}`);
if (exp.graph_html_path) line(`  graph explorer:  ${exp.graph_html_path}   (open in a browser; fully offline)`);
line(`  privacy:         pack is metadata-only by default — generated test bodies are NOT embedded`);
line(`                   (opt in with: export --include-generated-bodies); source is never written.`);

hr("DONE");
line(`Artifacts are in the throwaway workspace: ${ws}`);
line(`Open the explorer:  open ${exp.graph_html_path || join(ws, "orangepro-graph.html")}`);
line(`Comparison mode can show prompt-only vs graph-grounded output using your selected model.`);
