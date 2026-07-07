import { describe, it, expect } from "vitest";
import { renderCoverageReport } from "../../src/local/pack/coverageReport.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, LocalGraph } from "../../src/local/graph/ontology.js";
import { makeEdge, makeNode } from "../../src/local/graph/factories.js";
import { BOILERPLATE_REASON } from "../../src/local/analyze/boilerplate.js";
import { GENERATED_CODE_REASON } from "../../src/local/analyze/classify.js";
import { LEDGER_SCHEMA_VERSION, targetFingerprint, type Ledger } from "../../src/local/ledger.js";

function makeGraph(): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "w", root: "/w", root_hash: "h", source_upload_policy: "metadata_only" },
    created_at: "2026-06-13T00:00:00Z",
    updated_at: "2026-06-13T01:00:00Z",
    sources: [],
    nodes: [],
    edges: [],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    analysis: {
      test_files: 10,
      inferred_flows: 5,
      flows_truncated: 0,
      max_inferred_flows: 50000,
      symbol_cap_hit: false,
      files_scanned: 100,
      confirmed_by_layer: {
        total_behaviors: 50,
        confirmed: 20,
        confirmed_pct: 40,
        by_layer: { unit: 15, component: 3, integration: 0, api: 0, e2e: 2, manual: 0, unknown: 0 },
        unknown_count: 0,
        unknown_pct: 0
      },
      denominator: {
        total: 50,
        code_export: 42,
        requirement_template: 6,
        markdown_requirement: 2,
        excluded_test_inferred: 5,
        excluded_boilerplate: 0,
        excluded_infra: 0,
        excluded_generated: 0,
        code_symbols_total: 42,
        unattributed: 0
      },
      resolver_metrics: {
        all_internal: { n: 100, resolved: 99, pct: 99 },
        test_file: { n: 50, resolved: 40, pct: 80 },
        test_internal: { n: 40, resolved: 40, pct: 100 },
        test_to_test: { n: 10, resolved: 10, pct: 100 },
        test_to_source: { n: 30, resolved: 27, pct: 90 },
        test_unresolved_internal: { n: 0, resolved: 0, pct: 0 },
        source_to_source: { n: 60, resolved: 60, pct: 100 },
        barrel_terminal: { n: 5, resolved: 5, pct: 100 },
        workspace_package: { n: 20, resolved: 20, pct: 100 }
      },
      resolver_gate: { axis: "test_to_source", threshold_pct: 80, pct: 90, defensible: true }
    }
  } as unknown as LocalGraph;
}

// A small graph with REAL nodes/edges so the recomputed confirmed-% + composition are
// exercised: 3 code_export (a unit-confirmed, b e2e-confirmed, c unconfirmed) + 2
// requirements => total 5, confirmed 2 (40%), unit 1, e2e 1.
function realGraph(): LocalGraph {
  const codeSym = (id: string) =>
    ({
      external_id: id,
      kind: "CodeSymbol",
      title: id,
      confidence: 1,
      evidence_strength: "hard",
      review_status: "auto_detected",
      behavior_source: "code_export",
      denominator_eligible: true,
      properties: {},
      provenance: { source_ref: `${id}.ts` }
    }) as unknown as LocalGraph["nodes"][number];
  const reqNode = (id: string) =>
    ({
      external_id: id,
      kind: "Requirement",
      title: id,
      confidence: 1,
      evidence_strength: "reviewed",
      review_status: "auto_detected",
      behavior_source: "requirement_template",
      denominator_eligible: true,
      properties: {},
      provenance: { source_ref: `${id}.csv` }
    }) as unknown as LocalGraph["nodes"][number];
  const test = (id: string, layer: string) =>
    ({
      external_id: id,
      kind: "TestCase",
      title: id,
      confidence: 1,
      evidence_strength: "hard",
      review_status: "auto_detected",
      properties: { test_layer: layer },
      provenance: { source_ref: `${id}.ts` }
    }) as unknown as LocalGraph["nodes"][number];
  const hard = (from: string, to: string) =>
    ({
      external_id: `e:${from}:${to}`,
      from_external_id: from,
      to_external_id: to,
      relationship_type: "TESTED_BY",
      evidence_strength: "hard",
      review_status: "auto_detected",
      properties: {}
    }) as unknown as LocalGraph["edges"][number];
  const g = makeGraph();
  g.nodes = [codeSym("sym:a.ts#a"), codeSym("sym:b"), codeSym("sym:c"), reqNode("req:1"), reqNode("req:2"), test("test:u", "unit"), test("test:e", "e2e")];
  g.edges = [hard("sym:a.ts#a", "test:u"), hard("sym:b", "test:e")];
  g.manifest = { generated_at: "", git: null, files: { "a.ts": { hash: "sha256:a-v1", size: 8, kind: "code" } } };
  return g;
}

function dynamicLedger(target_symbol: string, g: LocalGraph = realGraph()): Ledger {
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    records: [
      {
        run_id: "run:dynamic",
        target_symbol,
        pre_edges: [],
        new_edges: [],
        closed: true,
        status: "reproven",
        target_fingerprint: targetFingerprint(g, target_symbol),
        dynamic_proof: {
          proof_kind: "dynamic_targeted",
          baseline_green: true,
          mutant_failed_assertion: true,
          target_not_mocked: true,
          sentinel: "return-json"
        },
        ts: "2026-06-30T00:00:00Z",
        pre_edge_count: 0
      }
    ]
  };
}

describe("renderCoverageReport (Phase 5.2)", () => {
  const md = renderCoverageReport(makeGraph());

  it("states the graph schema version", () => {
    expect(md).toContain(`Graph schema: ${LOCAL_GRAPH_SCHEMA_VERSION}`);
  });

  it("reports dynamic Proven over the denominator and keeps static layer counts diagnostic", () => {
    // Static layer candidates are recomputed from nodes/edges, NOT the persisted
    // analysis literal, but they do not move public Proven.
    const realMd = renderCoverageReport(realGraph());
    expect(realMd).toContain("0 of 5 behaviors Proven (0%)");
    expect(realMd).toContain("Static assertion candidates by test layer");
    expect(realMd).toMatch(/\| unit \| 1 \|/);
    expect(realMd).toMatch(/\| e2e \| 1 \|/);
  });

  it("counts a dynamic targeted-proof ledger record as public Proven", () => {
    const realMd = renderCoverageReport(realGraph(), dynamicLedger("sym:a.ts#a"));
    expect(realMd).toContain("1 of 5 behaviors Proven (20%)");
  });

  it("prints the denominator composition line (code_export + requirement)", () => {
    expect(renderCoverageReport(realGraph())).toContain("5 behaviors: 3 code_export, 2 requirement.");
  });

  it("lists the resolver axes with resolved% and unresolved%", () => {
    expect(md).toContain("test → source (gate axis)");
    expect(md).toMatch(/27 \/ 30 \| 90% \| 10%/);
  });

  it("falls back to recomputing when analysis is absent (does not throw)", () => {
    const g = makeGraph();
    (g as { analysis?: unknown }).analysis = undefined;
    expect(() => renderCoverageReport(g)).not.toThrow();
    expect(renderCoverageReport(g)).toContain("0 of 0 behaviors Proven");
  });

  it("renders runtime coverage separately from confirmed proof", () => {
    const g = makeGraph();
    g.analysis!.runtime_coverage = {
      artifacts: [{ path: ".orangepro/coverage/go-root.coverprofile", format: "go-coverprofile", files: 1, covered_ranges: 2 }],
      total_eligible_symbols: 10,
      symbols_with_spans: 10,
      covered_symbols: 7,
      covered_pct: 70,
      by_language: { go: { eligible: 10, symbols_with_spans: 10, covered: 7, covered_pct: 70 } }
    };
    const md = renderCoverageReport(g);
    expect(md).toContain("## Runtime coverage");
    expect(md).toContain("7 of 10 eligible symbols runtime-covered (70%)");
    expect(md).toContain("measured from local coverage-tool output, not name matching and not assertion-level proof");
    expect(md).toContain("| .orangepro/coverage/go-root.coverprofile | go-coverprofile | 1 | 2 |");
  });

  it("states that actual runtime coverage is unavailable when no artifact was ingested", () => {
    const md = renderCoverageReport(makeGraph());
    expect(md).toContain("No runtime coverage report was ingested.");
    expect(md).toContain("does not claim actual executed coverage");
  });
});

describe("renderCoverageReport — coverage + denominator are one atomic pair (Codex finding 2)", () => {
  const sym = (id: string) =>
    ({
      external_id: id,
      kind: "CodeSymbol",
      title: id,
      confidence: 1,
      evidence_strength: "hard",
      review_status: "auto_detected",
      behavior_source: "code_export",
      denominator_eligible: true,
      properties: {},
      provenance: { source_ref: `${id}.ts` }
    }) as unknown as LocalGraph["nodes"][number];
  const testNode = (id: string) =>
    ({
      external_id: id,
      kind: "TestCase",
      title: id,
      confidence: 1,
      evidence_strength: "hard",
      review_status: "auto_detected",
      properties: { test_layer: "unit" },
      provenance: { source_ref: `${id}.ts` }
    }) as unknown as LocalGraph["nodes"][number];

  it("recomputes BOTH from the graph when the persisted denominator is stale/mismatched", () => {
    const g = makeGraph();
    g.nodes = [sym("sym:a"), sym("sym:b"), testNode("test:a")];
    g.edges = [
      {
        external_id: "e0",
        from_external_id: "sym:a",
        to_external_id: "test:a",
        relationship_type: "TESTED_BY",
        evidence_strength: "hard",
        review_status: "auto_detected",
        properties: {}
      } as unknown as LocalGraph["edges"][number]
    ];
    // Stale persisted analysis: denominator.total=1 but no confirmed_by_layer.
    g.analysis!.denominator = {
      total: 1,
      code_export: 1,
      requirement_template: 0,
      markdown_requirement: 0,
      excluded_test_inferred: 0,
      excluded_boilerplate: 0,
      excluded_infra: 0,
      excluded_generated: 0,
      code_symbols_total: 1,
      unattributed: 0
    };
    delete (g.analysis as { confirmed_by_layer?: unknown }).confirmed_by_layer;

    const md = renderCoverageReport(g);
    // Recomputed atomically over the real graph: 0 dynamic Proven of 2, denominator 2 — they AGREE.
    expect(md).toContain("0 of 2 behaviors Proven (0%)");
    expect(md).toContain("2 behaviors: 2 code_export, 0 requirement.");
    // The stale "1" total must NOT appear as the denominator headline.
    expect(md).not.toContain("1 of 1 behaviors Proven");
  });

  it("discloses boilerplate from NODES, never from a stale analysis.excluded_boilerplate (Codex #58 HIGH)", () => {
    const boiler = (id: string) =>
      ({ ...sym(id), denominator_eligible: false, denominator_reason: BOILERPLATE_REASON }) as unknown as LocalGraph["nodes"][number];
    const g = makeGraph();
    g.nodes = [sym("sym:validate"), boiler("sym:getName"), boiler("sym:setName"), boiler("sym:toString")];
    g.edges = [];
    // Deliberately WRONG persisted counter — must not drive the disclosure.
    g.analysis!.excluded_boilerplate = 99;
    const md = renderCoverageReport(g);
    expect(md).toContain("3 excluded as trivial accessors"); // node-derived (3)
    expect(md).not.toContain("99 excluded");
    expect(md).not.toContain("102 code symbols found"); // would be 3 + 99 if it trusted analysis
  });

  it("the 'code symbols found' total is COMPLETE — counts every excluded class, not a partial sum (Codex #58 round-3)", () => {
    const excluded = (id: string, reason: string) =>
      ({ ...sym(id), denominator_eligible: false, denominator_reason: reason }) as unknown as LocalGraph["nodes"][number];
    const g = makeGraph();
    // Codex repro: 1 eligible export, 1 boilerplate, 1 generated file, 1 non-callable const, 1 .d.ts.
    g.nodes = [
      sym("sym:run"),
      excluded("sym:getName", BOILERPLATE_REASON),
      excluded("sym:generated", GENERATED_CODE_REASON),
      excluded("sym:VALUE", "Exported const (not provably callable) — excluded from the denominator in v1."),
      excluded("sym:typeOnly", "Type declaration (.d.ts/.d.mts/.d.cts) — no runtime behavior to test.")
    ];
    g.edges = [];
    const md = renderCoverageReport(g);
    // 5 found = 1 counted + 1 boilerplate + 1 generated + 2 other — the total is never a partial sum.
    expect(md).toContain("5 code symbols found: 1 counted as behaviors, 1 excluded as trivial accessors");
    expect(md).toContain("1 excluded as generated code");
    expect(md).toContain("2 excluded as non-behavioral");
    expect(md).not.toContain("2 code symbols found"); // the old partial sum (code_export + boilerplate)
  });
});

describe("renderCoverageReport — risk-ranked gaps", () => {
  it("prints a plain-language prioritization table without changing coverage proof", () => {
    const g = makeGraph();
    g.nodes = [
      makeNode({
        kind: "CodeSymbol",
        external_id: "sym:src/api/orders.ts#handleOrder",
        title: "handle|Order",
        properties: { file: "src/api/orders.ts" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: { source_scope_id: "src", source_ref: "src/api/orders.ts" },
        denominator_eligible: true,
        denominator_reason: "Exported symbol — countable behavior surface."
      }),
      makeNode({
        kind: "CodeSymbol",
        external_id: "sym:src/core/caller.ts#caller",
        title: "caller",
        properties: { file: "src/core/caller.ts" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: { source_scope_id: "src", source_ref: "src/core/caller.ts" },
        denominator_eligible: true,
        denominator_reason: "Exported symbol — countable behavior surface."
      })
    ];
    g.edges = [
      makeEdge({
        from_external_id: "sym:src/core/caller.ts#caller",
        to_external_id: "sym:src/api/orders.ts#handleOrder",
        relationship_type: "CALLS",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: { source_scope_id: "src", source_ref: "src/core/caller.ts" }
      })
    ];

    const md = renderCoverageReport(g);
    expect(md).toContain("## Top gaps by risk");
    expect(md).toContain("This is a prioritization list, not coverage proof.");
    expect(md).toContain("Probability(1-10) \u00d7 Impact(1-10) \u00d7 DetectionDifficulty(1|5|10)");
    expect(md).toContain("handle\\|Order");
    expect(md).toContain("src/api/orders.ts");
    expect(md).toContain("near an API/route/handler entry point");
    expect(md).toContain("0 of 2 behaviors Proven (0%)");
  });
});
