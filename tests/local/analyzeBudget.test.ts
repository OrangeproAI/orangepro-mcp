import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { renderCoverageReport } from "../../src/local/pack/coverageReport.js";
import { packToMarkdown } from "../../src/local/pack/summary.js";
import { buildVizPayload } from "../../src/local/viz/payload.js";
import { renderVizHtml } from "../../src/local/viz/html.js";
import { scoreGraph } from "../../src/local/score/score.js";
import { AnalysisMeta, LOCAL_GRAPH_SCHEMA_VERSION, LocalGraph } from "../../src/local/graph/ontology.js";

// Adversarial matrix for Phase 5.4 increment 1 (budget): partial analysis must be
// EXPLICIT — a budget-stopped run discloses what it skipped, is non-defensible, and the
// report says so. It must never silently look complete.

const dirs: string[] = [];
function repoWith(n: number): string {
  const dir = mkdtempSync(join(tmpdir(), "opro-budget-"));
  dirs.push(dir);
  for (let i = 0; i < n; i++) writeFileSync(join(dir, `mod${i}.ts`), `export function fn${i}(): number { return ${i}; }\n`);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

// A clock that stays at 0 for the first `stopAfter`+1 reads (start + N loop checks),
// then jumps past any budget — so the scan stops after exactly `stopAfter` files.
function clockStoppingAfter(stopAfter: number): () => number {
  let calls = 0;
  return () => {
    calls++;
    return calls <= stopAfter + 1 ? 0 : 1_000_000;
  };
}

describe("analyze wall-clock budget (Phase 5.4.1)", () => {
  it("stops after the budget and DISCLOSES the unanalyzed files", () => {
    const frag = analyzeRepo(repoWith(5), { readContent: true, maxAnalyzeMs: 100, now: clockStoppingAfter(2) });
    const a = frag.analysis;
    expect(a.files_scanned).toBe(2);
    expect(a.not_analyzed_due_to_budget).toBeDefined();
    expect(a.not_analyzed_due_to_budget?.files_not_analyzed).toBe(3);
    expect(a.not_analyzed_due_to_budget?.budget_ms).toBe(100);
    expect(frag.warnings.some((w) => /budget/i.test(w) && /NOT analyzed/i.test(w))).toBe(true);
  });

  it("a budget-stopped run is NEVER defensible, even with high resolution", () => {
    const frag = analyzeRepo(repoWith(5), { readContent: true, maxAnalyzeMs: 100, now: clockStoppingAfter(2) });
    // resolver_gate may be absent (partial TS set); when present it must be non-defensible.
    if (frag.analysis.resolver_gate) expect(frag.analysis.resolver_gate.defensible).toBe(false);
  });

  it("no budget set → full scan, no budget block, no budget warning", () => {
    const frag = analyzeRepo(repoWith(5), { readContent: true });
    expect(frag.analysis.files_scanned).toBe(5);
    expect(frag.analysis.not_analyzed_due_to_budget).toBeUndefined();
    expect(frag.warnings.some((w) => /budget/i.test(w))).toBe(false);
  });

  it("a budget that is never reached → full scan, no block", () => {
    const frag = analyzeRepo(repoWith(5), { readContent: true, maxAnalyzeMs: 1_000_000, now: () => 0 });
    expect(frag.analysis.files_scanned).toBe(5);
    expect(frag.analysis.not_analyzed_due_to_budget).toBeUndefined();
  });

  it("COVERAGE_REPORT.md surfaces the partial-scan caveat and the non-defensible headline", () => {
    const graph = {
      schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
      workspace: { name: "w", root: "/w", root_hash: "h", source_upload_policy: "metadata_only" },
      created_at: "t",
      updated_at: "t",
      sources: [],
      nodes: [],
      edges: [],
      candidate_edges: [],
      generation_runs: [],
      generated_tests: [],
      analysis: {
        test_files: 1,
        inferred_flows: 0,
        flows_truncated: 0,
        max_inferred_flows: 50000,
        symbol_cap_hit: false,
        files_scanned: 2,
        not_analyzed_due_to_budget: { files_not_analyzed: 3, elapsed_ms: 120, budget_ms: 100 },
        resolver_gate: { axis: "test_to_source", threshold_pct: 80, pct: 100, defensible: false }
      }
    } as unknown as LocalGraph;
    const md = renderCoverageReport(graph);
    expect(md).toContain("PARTIAL SCAN");
    expect(md).toContain("3 file(s) NOT analyzed");
    expect(md).toContain("not defensible");
  });

  const budgetGraph = (): LocalGraph =>
    ({
      schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
      workspace: { name: "w", root: "/w", root_hash: "h", source_upload_policy: "metadata_only" },
      created_at: "t",
      updated_at: "t",
      sources: [],
      nodes: [],
      edges: [],
      candidate_edges: [],
      generation_runs: [],
      generated_tests: [],
      analysis: {
        test_files: 1,
        inferred_flows: 0,
        flows_truncated: 0,
        max_inferred_flows: 50000,
        symbol_cap_hit: false,
        files_scanned: 2,
        not_analyzed_due_to_budget: { files_not_analyzed: 3, elapsed_ms: 9, budget_ms: 5 }
      }
    }) as unknown as LocalGraph;

  it("graph.html renders a partial-scan banner near the headline (Codex round-1 finding 1)", () => {
    const html = renderVizHtml(buildVizPayload(budgetGraph(), scoreGraph(budgetGraph())));
    expect(html).toContain("PARTIAL SCAN");
    expect(html).toContain("NOT analyzed");
    expect(html).toContain("ORANGEPRO_MAX_ANALYZE_MS");
    expect(html).toContain('id="partial-banner"');
  });

  it("exported pack summary discloses the budget-stop partial (Codex round-1 finding 2)", () => {
    const pack = {
      schema_version: "orangepro.evidence_pack.v1",
      created_at: "t",
      workspace: { name: "w", root: "/w", root_hash: "h", source_upload_policy: "metadata_only" },
      sources: [],
      entities: [],
      relationships: [],
      generation_runs: [],
      quality_score: { overall: 50, band: "usable", breakdown: {}, missing_evidence: [] }
    } as unknown as Parameters<typeof packToMarkdown>[0];
    const analysis = budgetGraph().analysis as AnalysisMeta;
    const md = packToMarkdown(pack, analysis);
    expect(md).toContain("PARTIAL SCAN");
    expect(md).toContain("NOT analyzed");
    expect(md).toContain("ORANGEPRO_MAX_ANALYZE_MS");
  });
});

describe("confirmer file budget", () => {
  it("runs a risk-ranked subset instead of skipping all proof on large candidate sets", () => {
    const root = mkdtempSync(join(tmpdir(), "opro-confirm-budget-"));
    dirs.push(root);
    mkdirSync(join(root, "src", "api"), { recursive: true });
    writeFileSync(join(root, "src", "api", "handler.ts"), `export function handleLogin(): string { return "ok"; }\n`);
    writeFileSync(
      join(root, "handler.test.ts"),
      `import { handleLogin } from "./src/api/handler";\ntest("handles login", () => { expect(handleLogin()).toBe("ok"); });\n`
    );
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(root, `low${i}.ts`), `export function behavior${i}(): string { return "low${i}"; }\n`);
      writeFileSync(join(root, `low${i}.test.ts`), `import { behavior${i} } from "./low${i}";\ntest("low ${i}", () => { expect(behavior${i}()).toBe("low${i}"); });\n`);
    }
    const prevBudget = process.env.ORANGEPRO_MAX_CONFIRM_FILES;
    const prevRisk = process.env.ORANGEPRO_CONFIRM_RISK_SYMBOLS;
    process.env.ORANGEPRO_MAX_CONFIRM_FILES = "2";
    process.env.ORANGEPRO_CONFIRM_RISK_SYMBOLS = "3";
    try {
      const frag = analyzeRepo(root, { readContent: true });
      expect(frag.analysis.confirmed_coverage?.skipped_files_budget).toBeGreaterThan(2);
      expect(frag.analysis.confirmed_coverage?.attempted).toBeGreaterThan(0);
      expect(frag.analysis.confirmed_coverage?.scoped_by_risk?.candidate_pairs).toBeGreaterThan(0);
      expect(frag.edges.some((e) => e.relationship_type === "COVERS" && e.to_external_id === "sym:src/api/handler.ts#handleLogin")).toBe(true);
      expect(frag.warnings.join("\n")).toContain("Static confirmation scoped");
    } finally {
      if (prevBudget === undefined) delete process.env.ORANGEPRO_MAX_CONFIRM_FILES;
      else process.env.ORANGEPRO_MAX_CONFIRM_FILES = prevBudget;
      if (prevRisk === undefined) delete process.env.ORANGEPRO_CONFIRM_RISK_SYMBOLS;
      else process.env.ORANGEPRO_CONFIRM_RISK_SYMBOLS = prevRisk;
    }
  });
});
