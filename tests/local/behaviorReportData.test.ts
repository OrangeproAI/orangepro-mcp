import { describe, expect, it } from "vitest";

import { buildBehaviorReportData, dominantBlockReason, type DynamicProofReportInput } from "../../src/local/viz/behaviorReportData.js";
import { makeCandidateEdge, makeEdge, makeNode } from "../../src/local/graph/factories.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, type LocalGraph } from "../../src/local/graph/ontology.js";
import { LEDGER_SCHEMA_VERSION, targetFingerprint, type Ledger } from "../../src/local/ledger.js";

const EMPTY_LEDGER: Ledger = { schema_version: LEDGER_SCHEMA_VERSION, records: [] };
const provenance = { source_scope_id: "repo", source_ref: "src/orders.controller.ts", detector: "test" };

function codeSymbol(id: string, title: string, file: string) {
  return makeNode({
    kind: "CodeSymbol",
    external_id: id,
    title,
    properties: { file, symbol_kind: "method" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { ...provenance, source_ref: file },
    behavior_source: "code_export",
    denominator_eligible: true
  });
}

function graph(): LocalGraph {
  const endpoint = makeNode({
    kind: "Endpoint",
    external_id: "endpoint:post-orders",
    title: "POST /orders",
    properties: { method: "POST", path: "/orders" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance,
    behavior_source: "contract_entrypoint",
    denominator_eligible: false
  });
  const handler = codeSymbol("sym:src/orders.controller.ts#OrdersController.create", "OrdersController.create", "src/orders.controller.ts");
  handler.properties.description = "Accepts an order request and delegates creation.";
  const service = codeSymbol("sym:src/orders.service.ts#OrdersService.create", "OrdersService.create", "src/orders.service.ts");
  service.properties.description = "Creates a persisted order.";
  const generated = makeNode({
    kind: "CodeSymbol",
    external_id: "sym:generated#OrderModuleService.createOrders",
    title: "OrderModuleService.createOrders",
    properties: { file: "src/orders.service.ts", origin: "framework-derived" },
    evidence_strength: "framework-derived",
    review_status: "auto_detected",
    confidence: 1,
    provenance,
    denominator_eligible: false
  });
  const test = makeNode({
    kind: "TestCase",
    external_id: "test:src/orders.controller.spec.ts",
    title: "orders.controller.spec.ts",
    properties: { file: "src/orders.controller.spec.ts", test_layer: "integration", test_names: ["creates an order"] },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { ...provenance, source_ref: "src/orders.controller.spec.ts" }
  });
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "orders-api", root: "/tmp/orders-api", root_hash: "sha256:x", source_upload_policy: "metadata_only" },
    created_at: "2026-06-30T10:00:00Z",
    updated_at: "2026-06-30T12:00:00Z",
    sources: [],
    nodes: [endpoint, handler, service, generated, test],
    edges: [
      makeEdge({
        from_external_id: "endpoint:post-orders",
        to_external_id: "sym:src/orders.controller.ts#OrdersController.create",
        relationship_type: "IMPLEMENTED_IN",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance
      }),
      makeEdge({
        from_external_id: "sym:src/orders.controller.ts#OrdersController.create",
        to_external_id: "sym:src/orders.service.ts#OrdersService.create",
        relationship_type: "CALLS",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance,
        properties: { call_via: "injected", resolution: "injected" }
      }),
      makeEdge({
        from_external_id: "sym:src/orders.service.ts#OrdersService.create",
        to_external_id: "sym:generated#OrderModuleService.createOrders",
        relationship_type: "CALLS",
        evidence_strength: "framework-derived",
        review_status: "auto_detected",
        confidence: 1,
        provenance,
        properties: { resolution: "medusa-generated" }
      }),
      makeEdge({
        from_external_id: "test:src/orders.controller.spec.ts",
        to_external_id: "sym:src/orders.controller.ts#OrdersController.create",
        relationship_type: "COVERS",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance
      })
    ],
    candidate_edges: [
      makeCandidateEdge({
        from_external_id: "test:src/orders.controller.spec.ts",
        to_external_id: "sym:src/orders.service.ts#OrdersService.create",
        relationship_type: "MAY_RELATE_TO",
        evidence_strength: "candidate",
        review_status: "inferred",
        reason: "same behavior area",
        confidence: 0.6,
        provenance
      })
    ],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "2026-06-30T12:00:00Z", git: null, files: { "src/orders.controller.ts": { hash: "sha256:orders-v1", size: 64, kind: "code" } } },
    analysis: {
      test_files: 1,
      inferred_flows: 0,
      flows_truncated: 0,
      max_inferred_flows: 50000,
      symbol_cap_hit: false,
      denominator: {
        total: 2,
        code_export: 2,
        requirement_template: 0,
        markdown_requirement: 0,
        excluded_test_inferred: 0,
        excluded_boilerplate: 0,
        excluded_infra: 3,
        excluded_generated: 0,
        code_symbols_total: 5,
        unattributed: 0
      },
      confirmed_coverage: { confirmed_pairs: 1, attempted: 1, capped_downgrades: 0, skipped_files_budget: 0 },
      behavior_contracts: { total: 1, by_framework: { express: 1 }, by_kind: { http_endpoint: 1 }, handler_edges: 1 },
      flows: {
        method: "static_calls_weakest_link",
        total_flows: 1,
        by_tier: { "hard: reachable": 0, "framework-derived: reachable": 1 },
        truncated_flows: 0,
        dropped: { max_depth: 0, max_flows_per_entry: 0, global_cap: 0 },
        options: { max_depth: 8, max_flows_per_entry: 20, global_cap: 500 },
        flows: [
          {
            id: "flow:orders",
            entry_point: { external_id: "endpoint:post-orders", kind: "Endpoint", title: "POST /orders" },
            hops: [
              {
                from: "sym:src/orders.controller.ts#OrdersController.create",
                to: "sym:src/orders.service.ts#OrdersService.create",
                evidence_strength: "hard",
                resolution: "injected"
              },
              {
                from: "sym:src/orders.service.ts#OrdersService.create",
                to: "sym:generated#OrderModuleService.createOrders",
                evidence_strength: "framework-derived",
                resolution: "medusa-generated"
              }
            ],
            terminal: "sym:generated#OrderModuleService.createOrders",
            depth: 2,
            flow_tier: "framework-derived: reachable"
          }
        ]
      }
    }
  };
}

function dynamicLedger(target_symbol = "sym:src/orders.controller.ts#OrdersController.create", g: LocalGraph = graph()): Ledger {
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
          sentinel: "return-json",
          runner: "vitest",
          test_path: "src/orders.controller.spec.ts"
        },
        ts: "2026-06-30T12:00:00Z",
        pre_edge_count: 0
      }
    ]
  };
}

describe("buildBehaviorReportData", () => {
  it("keeps static-only hard test edges associated in the public report", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/medusa" });

    expect(data.repo).toBe("medusa");
    expect(data.scanned).toBe("2026-06-30");
    expect(data.analysisKind).toBe("static");
    expect(data.summary).toEqual({ total: 2, proven: 0, associated: 1, candidate: 1, none: 0, reachableUntested: 0, noSignal: 0 });
    expect(data.proofGuidance).toMatchObject({
      state: "not_started",
      title: "0 Dynamically Proven means no dynamic proof has run yet"
    });
    // 0-Dynamically-Proven → the verbatim explainer is populated (display copy; no classification change).
    expect(data.zeroProofExplainer?.title).toBe("Why dynamic proof is 0");
    expect(data.zeroProofExplainer?.body.join(" ")).toContain("Dynamic proof requires executing tests in a sandbox");
    expect(data.proofGuidance.body).toContain("analysis pass");
    expect(data.proofGuidance.action).toContain("orangepro_prove_loop");
    expect(data.summary.proven + data.summary.associated + data.summary.candidate + data.summary.none).toBe(data.summary.total);
    expect(Object.fromEntries(data.pipeline.map((s) => [s.key, s.on]))).toMatchObject({
      behaviors: "1",
      endpoints: "1",
      calls: "1",
      fw: "1",
      flows: "1",
      proof: "0"
    });
    expect(data.scan.tests).toEqual({ total: 1, integration: 1, unit: 0 });
    expect(data.behaviorGroups).toEqual([{ key: "src", count: 2 }]);
    expect(data.behaviors.map((b) => [b.sig, b.tier])).toEqual([
      ["OrdersController.create", "assoc"],
      ["OrdersService.create", "candidate"]
    ]);
  });

  it("builds public Proven only from dynamic targeted proof records", () => {
    const data = buildBehaviorReportData(graph(), dynamicLedger(), { repoRoot: "/tmp/medusa" });

    expect(data.analysisKind).toBe("static+dynamic");
    expect(data.summary).toEqual({ total: 2, proven: 1, associated: 0, candidate: 1, none: 0, reachableUntested: 0, noSignal: 0 });
    expect(data.proofGuidance).toMatchObject({ state: "proven", title: "Dynamically Proven is active" });
    // Nonzero Dynamically Proven → no zero-proof explainer.
    expect(data.zeroProofExplainer).toBeNull();
    expect(Object.fromEntries(data.pipeline.map((s) => [s.key, s.on]))).toMatchObject({ proof: "1" });
    // Proven-first display ordering (v6): the proven row leads the grid.
    expect(data.behaviors.map((b) => [b.sig, b.tier])).toEqual([
      ["OrdersController.create", "proven"],
      ["OrdersService.create", "candidate"]
    ]);
  });

  it("does not mark the dynamic-proof pipeline partial for static-only unproven records", () => {
    const data = buildBehaviorReportData(
      graph(),
      {
        schema_version: LEDGER_SCHEMA_VERSION,
        records: [
          {
            run_id: "run:static-unproven",
            target_symbol: "sym:src/orders.controller.ts#OrdersController.create",
            pre_edges: [],
            new_edges: [],
            closed: false,
            status: "unproven",
            ts: "2026-06-30T12:00:00Z",
            pre_edge_count: 0
          }
        ]
      },
      { repoRoot: "/tmp/medusa" }
    );

    expect(Object.fromEntries(data.pipeline.map((s) => [s.key, s.on]))).toMatchObject({ proof: "0" });
    expect(data.proofGuidance.state).toBe("not_started");
  });

  it("explains dynamic attempts that did not close before public Proven", () => {
    const data = buildBehaviorReportData(
      graph(),
      {
        schema_version: LEDGER_SCHEMA_VERSION,
        records: [
          {
            run_id: "run:dynamic-open",
            target_symbol: "sym:src/orders.controller.ts#OrdersController.create",
            pre_edges: [],
            new_edges: [],
            closed: false,
            status: "unproven",
            dynamic_proof: {
              proof_kind: "dynamic_targeted",
              baseline_green: true,
              mutant_failed_assertion: false,
              target_not_mocked: false,
              sentinel: "return-json",
              runner: "vitest",
              test_path: "src/orders.controller.spec.ts"
            },
            ts: "2026-06-30T12:00:00Z",
            pre_edge_count: 0
          }
        ]
      },
      { repoRoot: "/tmp/medusa" }
    );

    expect(data.summary.proven).toBe(0);
    expect(Object.fromEntries(data.pipeline.map((s) => [s.key, s.on]))).toMatchObject({ proof: "partial" });
    expect(data.proofGuidance).toMatchObject({
      state: "attempted",
      title: "0 Dynamically Proven — dynamic proof ran, none closed yet"
    });
  });

  it("passes flow tiering and hop evidence through without minting proof", () => {
    const data = buildBehaviorReportData(graph(), dynamicLedger());

    expect(data.flows).toHaveLength(1);
    expect(data.flows[0]).toMatchObject({
      title: "POST /orders",
      trigger: { verb: "POST", path: "/orders" },
      proof: "proven",
      flow_tier: "framework-derived: reachable"
    });
    expect(data.flows[0].steps.map((s) => [s.sig, s.edge, s.tier])).toEqual([
      ["OrdersController.create", null, "hard"],
      ["OrdersService.create", "hard", "hard"],
      ["OrderModuleService.createOrders", "framework-derived", "framework-derived"]
    ]);
    expect(data.flows[0].steps.map((s) => s.desc)).toEqual([
      "Accepts an order request and delegates creation.",
      "Creates a persisted order.",
      "OrderModuleService.createOrders"
    ]);
    expect(data.flows[0].why).toContain("Reachability is static");
  });
});

// ── "Static map first, dynamically prove top 5": UX + dominant-block copy ──
describe("buildBehaviorReportData — static breadth is never gated on the dynamic budget", () => {
  it("reports all mapped behaviors even though the dynamic pass only attempted 5", () => {
    // 20 mapped behaviors; the dynamic budget attempted only 5 of them this run.
    const g = graph();
    for (let i = 0; i < 18; i++) {
      g.nodes.push(codeSymbol(`sym:src/mod${i}.ts#Svc.op${i}`, `Svc.op${i}`, `src/mod${i}.ts`));
    }
    const dyn: DynamicProofReportInput = { attempted: 5, proven: 0, needsSetup: [] };
    const withBudget = buildBehaviorReportData(g, EMPTY_LEDGER, { repoRoot: "/tmp/orders-api", dynamicProof: dyn });
    const withoutBudget = buildBehaviorReportData(g, EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });

    expect(withBudget.summary.total).toBe(20); // all 20 behaviors mapped, not just the 5 attempted
    expect(withBudget.behaviors).toHaveLength(20);
    // Static breadth is byte-identical with or without the dynamic budget — only proof guidance differs.
    expect(withBudget.summary).toEqual(withoutBudget.summary);
    expect(withBudget.behaviors).toEqual(withoutBudget.behaviors);
    expect(withBudget.flows).toEqual(withoutBudget.flows);
    expect(withBudget.risks).toEqual(withoutBudget.risks);
  });
});

describe("buildBehaviorReportData — 0-Dynamically-Proven guidance names the dominant block reason", () => {
  it("attempted, 0 closed, mixed reasons → names the most common one with a count", () => {
    const dyn: DynamicProofReportInput = {
      attempted: 5,
      proven: 0,
      needsSetup: [{ category: "module_not_found" }, { category: "module_not_found" }, { category: "engine_mismatch" }]
    };
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api", dynamicProof: dyn });

    expect(data.summary.proven).toBe(0);
    expect(data.summary.associated).toBe(1); // hard static link preserved
    expect(data.summary.candidate).toBe(1); // lexical candidate stays its own tier
    expect(data.proofGuidance.state).toBe("attempted");
    expect(data.proofGuidance.title).toContain("top 5");
    expect(data.proofGuidance.body).toContain("attempted the top 5");
    expect(data.proofGuidance.body).toContain("Blocked because: a missing module or dependency in the sandbox (2/3)");
    expect(data.proofGuidance.body).toContain("Static test signals stay Statically Linked");
    // Must NOT imply the static tests failed or the report is broken.
    expect(data.proofGuidance.body).not.toMatch(/static tests? failed|report is broken/i);
  });

  it("all attempts setup-blocked → 'all were blocked by …' copy", () => {
    const dyn: DynamicProofReportInput = {
      attempted: 3,
      proven: 0,
      needsSetup: [{ category: "db_or_external" }, { category: "db_or_external" }, { category: "db_or_external" }]
    };
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api", dynamicProof: dyn });

    expect(data.proofGuidance.title).toContain("all setup-blocked");
    expect(data.proofGuidance.body).toContain("all were blocked by a database or external service the sandbox lacks (3/3)");
    expect(data.proofGuidance.body).toContain("not a static-test failure");
    // G1: the action names the dominant category's smallest next step, not just the generic handoff.
    expect(data.proofGuidance.action).toContain("Next:");
    expect(data.proofGuidance.action).toContain("orangepro_prove_loop");
  });

  it("G1: tsconfig-dominant block → action carries the monorepo-root next step", () => {
    const dyn: DynamicProofReportInput = {
      attempted: 2,
      proven: 0,
      needsSetup: [{ category: "tsconfig_missing" }, { category: "tsconfig_missing" }]
    };
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api", dynamicProof: dyn });
    expect(data.proofGuidance.action).toContain("Next:");
    expect(data.proofGuidance.action).toContain("monorepo root");
    // Display copy only — proven stays the RTM count, never inflated by guidance.
    expect(data.summary.proven).toBe(0);
  });

  it("none attempted → 'not attempted' copy, static signals still available", () => {
    const dyn: DynamicProofReportInput = { attempted: 0, proven: 0, needsSetup: [] };
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api", dynamicProof: dyn });

    expect(data.proofGuidance.state).toBe("not_started");
    expect(data.proofGuidance.body).toContain("Dynamic proof was not attempted in this run");
    expect(data.summary.associated).toBe(1);
    expect(data.summary.candidate).toBe(1);
  });

  it("dominantBlockReason tallies the most common category", () => {
    expect(dominantBlockReason([{ category: "module_not_found" }, { category: "engine_mismatch" }, { category: "module_not_found" }])).toEqual({
      label: "a missing module or dependency in the sandbox",
      count: 2,
      total: 3,
      category: "module_not_found"
    });
    expect(dominantBlockReason([])).toBeNull();
  });
});

// ── DISPLAY-ONLY tier split: "Reachable Untested" vs "No Signal" (derived from flow membership) ──
describe("buildBehaviorReportData — Reachable Untested is a display split of the none bucket", () => {
  it("a none-tier behavior whose symbol appears in a static flow is Reachable Untested; the split is exact", () => {
    const g = graph();
    // Remove every test signal so the flow's symbols land in the untested (none) tier, still reachable.
    g.nodes = g.nodes.filter((n) => n.kind !== "TestCase");
    g.edges = g.edges.filter((e) => e.relationship_type !== "COVERS");
    g.candidate_edges = [];
    const data = buildBehaviorReportData(g, EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });

    // Classification unchanged: both eligible behaviors are none (no test signal).
    expect(data.summary.none).toBe(2);
    // Display split: both none symbols are flow hops → Reachable Untested; no bare No-Signal rows.
    expect(data.summary.reachableUntested).toBe(2);
    expect(data.summary.noSignal).toBe(0);
    expect(data.summary.reachableUntested + data.summary.noSignal).toBe(data.summary.none);
    // Per-behavior display flag reflects flow membership without changing tier.
    expect(data.behaviors.every((b) => b.tier === "none" && b.reachable)).toBe(true);
  });
});

describe("buildBehaviorReportData — report trust metadata", () => {
  it("marks rankings provisional when Git history is unavailable", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/definitely/not/a/git/repo" });

    expect(data.provenance).toMatchObject({ history: "unavailable", churn: "unavailable" });
    expect(data.provenance.inputFingerprint).toMatch(/^[0-9a-f]{16}$/);
    expect(data.risks.every((risk) => risk.tags.some(([label]) => label === "provisional rank"))).toBe(true);
    expect(data.risks.every((risk) => !risk.tags.some(([label]) => /^(critical|high|medium) risk$/.test(label)))).toBe(true);
  });

  it("does not invent payment or credential advice for CapturePanic", () => {
    const g = graph();
    g.nodes = [codeSymbol("sym:internal/common/panic.go#CapturePanic", "CapturePanic", "internal/common/panic.go")];
    g.edges = [];
    g.candidate_edges = [];

    const data = buildBehaviorReportData(g, EMPTY_LEDGER, { repoRoot: "/definitely/not/a/git/repo" });
    expect(data.risks[0]?.todo).not.toMatch(/payment|credential/i);
  });

  it("labels fractional import attribution as weighted references", () => {
    const g = graph();
    g.nodes = [
      codeSymbol("sym:src/shared.ts#alpha", "alpha", "src/shared.ts"),
      codeSymbol("sym:src/shared.ts#beta", "beta", "src/shared.ts")
    ];
    g.edges = [
      makeEdge({
        from_external_id: "src/consumer.ts",
        to_external_id: "src/shared.ts",
        relationship_type: "IMPORTS",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance
      })
    ];
    g.candidate_edges = [];

    const data = buildBehaviorReportData(g, EMPTY_LEDGER, { repoRoot: "/definitely/not/a/git/repo" });
    expect(data.risks.some((risk) => (risk.context ?? "").includes("0.5 weighted incoming references"))).toBe(true);
    expect(data.risks.every((risk) => !(risk.context ?? "").includes("callers"))).toBe(true);
  });
});
