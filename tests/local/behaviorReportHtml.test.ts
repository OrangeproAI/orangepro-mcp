import { describe, expect, it } from "vitest";

import { renderBehaviorReport } from "../../src/local/viz/behaviorReportHtml.js";
import { buildBehaviorReportData, type DynamicProofReportInput } from "../../src/local/viz/behaviorReportData.js";
import { makeEdge, makeNode } from "../../src/local/graph/factories.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, type LocalGraph } from "../../src/local/graph/ontology.js";
import { LEDGER_SCHEMA_VERSION, targetFingerprint, type Ledger } from "../../src/local/ledger.js";

const EMPTY_LEDGER: Ledger = { schema_version: LEDGER_SCHEMA_VERSION, records: [] };
const provenance = { source_scope_id: "repo", source_ref: "src/orders.controller.ts", detector: "test" };

function codeSymbol(id: string, title: string, file: string): ReturnType<typeof makeNode> {
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

/** A small but complete graph with an endpoint, an injected hard hop, and a
 *  framework-derived hop — enough to exercise summary/pipeline/flows/risks. */
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
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "orders-api", root: "/tmp/orders-api", root_hash: "sha256:x", source_upload_policy: "metadata_only" },
    created_at: "2026-06-30T10:00:00Z",
    updated_at: "2026-06-30T12:00:00Z",
    sources: [],
    nodes: [endpoint, handler, service, generated],
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
      })
    ],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "2026-06-30T12:00:00Z", git: null, files: {} },
    analysis: {
      test_files: 0,
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
        code_symbols_total: 4,
        unattributed: 0
      },
      confirmed_coverage: { confirmed_pairs: 0, attempted: 0, capped_downgrades: 0, skipped_files_budget: 0 },
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
              { from: "sym:src/orders.controller.ts#OrdersController.create", to: "sym:src/orders.service.ts#OrdersService.create", evidence_strength: "hard", resolution: "injected" },
              { from: "sym:src/orders.service.ts#OrdersService.create", to: "sym:generated#OrderModuleService.createOrders", evidence_strength: "framework-derived", resolution: "medusa-generated" }
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

describe("renderBehaviorReport", () => {
  it("renders the DATA-backed report and replaces the placeholder", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);

    // Placeholder fully substituted, DATA embedded.
    expect(html).not.toContain("__ORANGEPRO_DATA__");
    expect(html).toContain("window.DATA");
    expect(html).toContain(JSON.stringify(data.repo));

    // Report structure (codebase / behaviors / flows / risks) is present (v6 panels).
    expect(html).toContain('id="panel-codebase"');
    expect(html).toContain('id="panel-behaviors"');
    expect(html).toContain('id="panel-flows"');
    expect(html).toContain('id="panel-risks"');
    expect(html).toContain("<!DOCTYPE html>");
  });

  it("carries the computed pipeline and flow tiers through to the embedded DATA", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);

    // The flow walker produced one framework-derived flow; it must reach the page verbatim.
    expect(data.flows.some((f) => f.flow_tier === "framework-derived: reachable")).toBe(true);
    expect(html).toContain("framework-derived: reachable");
    // Pipeline stage keys computed from the graph are embedded.
    expect(data.pipeline.find((p) => p.key === "flows")?.on).toBe("1");
    expect(html).toContain("Flow walker");
  });

  it("renders a risk badge for every risk bucket, including medium", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    // riskBucket() emits "medium" for scores in (0,200); the flow card must still show a badge.
    data.flows[0].risk = "medium";
    const html = renderBehaviorReport(data);
    expect(html).toContain("medium risk");
  });

  it("renders the four honest tier labels and the dynamic-only Proven sub", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);

    // v6 KPI vocabulary: five tiles whose one-line subs keep the tiers honest — the
    // static tier is explicitly "no proof" and only the dynamic tier is called Proven.
    for (const label of ["Methods found", "Dynamically Proven", "Test signal", "Reachable", "No signal"]) {
      expect(html).toContain(`lbl:"${label}"`);
    }
    expect(html).toContain("test breaks if you change it"); // Proven = dynamic-only definition
    expect(html).toContain("test touches it, no proof"); // static signal can never read as proof
    expect(html).toContain("called but untested");
    // The tier-badge vocabulary is wired for the behavior grid (distinct class per tier).
    for (const cls of ["b-proven", "b-signal", "b-reach", "b-nosig"]) {
      expect(html).toContain(cls);
    }
    // Trust guards: static evidence never reads as proven; the assoc tier label is "Test signal".
    expect(html.toLowerCase()).not.toContain("statically proven");
    expect(html).toContain('label:"Test signal"');
  });

  it("renders the flows section and carries every flow step into the embedded DATA", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);

    // Flow section scaffolding + bridge copy that explains hard vs framework-derived hops.
    expect(html).toContain('id="flow-list"');
    expect(html).toContain("Solid lines = hard-coded calls");
    expect(html).toContain("framework-derived");
    // The one composed flow and each of its hops reach the page via the embedded DATA.
    expect(data.flows).toHaveLength(1);
    expect(html).toContain(JSON.stringify(data.flows[0].title));
    for (const step of data.flows[0].steps) {
      expect(html).toContain(JSON.stringify(step.sig));
    }
  });

  it("keeps the computed pipeline stages in the embedded DATA (v6 drops the rendered strip)", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);

    // v6 has no pipeline section — but the stages stay in DATA for tooling/consumers.
    expect(html).not.toContain('id="pipeline"');
    expect(data.pipeline).toHaveLength(6);
    for (const stage of data.pipeline) {
      expect(html).toContain(JSON.stringify(stage.label));
    }
    // The proof stage is off (no dynamic proof in this graph) — the data reflects state honestly.
    expect(data.pipeline.find((p) => p.key === "proof")?.on).toBe("0");
  });

  it("renders zero-Proven guidance so analyze-only reports are self-explanatory", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);

    expect(data.summary.proven).toBe(0);
    expect(data.proofGuidance.state).toBe("not_started");
    expect(html).toContain("0 Dynamically Proven means no dynamic proof has run yet");
    expect(html).toContain("orangepro_prove_loop");
    expect(html).toContain("analysis pass");
  });

  it("renders the gap sections: unproven behavior rows and priority-risk to-dos", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);

    // Gap behaviors: rows with no signal are the coverage gaps and reach the page.
    expect(data.behaviors.some((b) => b.tier === "none")).toBe(true);
    const gap = data.behaviors.find((b) => b.tier === "none")!;
    expect(html).toContain(JSON.stringify(gap.sig));

    // Risk gap cards: rank + endpoint + the per-risk to-do box.
    expect(html).toContain('id="risk-list"');
    expect(html).toContain("risk-card");
    expect(html).toContain("risk-rank");
    expect(data.risks.length).toBeGreaterThan(0);
    expect(html).toContain(JSON.stringify(data.risks[0].path));
    expect(html).toContain(JSON.stringify(data.risks[0].todo));
  });

  it("renders the behavior-detail modal with an accessible dialog and open/close hooks", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);

    // Modal container: an accessible dialog (aria) with a close button and a content slot.
    expect(html).toContain('id="drill"');
    expect(html).toContain("drill-overlay");
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('id="drill-close"');
    expect(html).toContain('id="drill-content"');

    // Each behavior card opens the drill for that behavior (v6 showDrill wiring).
    expect(html).toContain("showDrill");
    expect(html).toContain("c.onclick=()=>showDrill(");

    // The drill fills the documented sections (evidence badge, file, action box).
    expect(html).toContain("<h4>Evidence</h4>");
    expect(html).toContain("<h4>File</h4>");
    expect(html).toContain("<h4>What to do</h4>");

    // Close paths: × button, backdrop click, and Escape; body-scroll lock while open.
    expect(html).toContain('e.key==="Escape"');
    expect(html).toContain('document.body.style.overflow="hidden"');
  });

  it("escapes </script> and JS line separators in the embedded DATA (inline JSON safety)", () => {
    const LS = String.fromCharCode(0x2028); // line separator
    const PS = String.fromCharCode(0x2029); // paragraph separator
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    // Inject a hostile string into a rendered field: script breakout + JS line separators.
    data.repo = "</script><script>alert(1)</script>" + LS + PS + "x";
    const html = renderBehaviorReport(data);

    // No raw breakout: the injected inner script tag must not appear unescaped.
    expect(html).not.toContain("<script>alert(1)");
    // The `<` is neutralized to its unicode escape inside the inline JSON.
    expect(html).toContain("\\u003cscript>alert(1)");
    // Raw U+2028 / U+2029 (valid in JSON, illegal in a JS string literal) must not survive.
    expect(html).not.toContain(LS);
    expect(html).not.toContain(PS);
    expect(html).toContain("\\u2028");
    expect(html).toContain("\\u2029");
  });

  it("foregrounds Dynamically Proven vs Static Associated and explains a 0-proof run", () => {
    const dyn: DynamicProofReportInput = {
      attempted: 5,
      proven: 0,
      needsSetup: [{ category: "module_not_found" }, { category: "module_not_found" }, { category: "engine_mismatch" }]
    };
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api", dynamicProof: dyn });
    const html = renderBehaviorReport(data);

    // KPI headline visually separates the tiny dynamic Proven from the static breadth.
    expect(html).toContain("Dynamically Proven");
    expect(html).toContain("Statically Linked");
    // The Associated-signals count is embedded in the report DATA next to the dynamic number.
    expect(html).toContain(`"associated":${data.summary.associated}`);
    // A 0-proof run renders an explanatory PANEL (not a bare red 0) naming the dominant block reason.
    expect(data.summary.proven).toBe(0);
    expect(html).toContain("attempted the top 5");
    expect(html).toContain("Blocked because: a missing module or dependency in the sandbox (2/3)");
    expect(html).toContain("Static test signals stay Statically Linked");
  });

  it("renders the five KPI tier definitions verbatim (v6 one-line subs)", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);

    for (const sub of [
      "public, with observable outcome",
      "test breaks if you change it",
      "test touches it, no proof",
      "called but untested",
      "nothing touches it"
    ]) {
      expect(html).toContain(sub);
    }
  });

  it("shows the 'Why dynamic proof is 0' block only when Dynamically Proven is 0", () => {
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    expect(data.summary.proven).toBe(0);

    // 0 Dynamically Proven → the verbatim explainer block is present.
    const zeroHtml = renderBehaviorReport(data);
    expect(zeroHtml).toContain("Why dynamic proof is 0");
    expect(zeroHtml).toContain("Dynamic proof requires executing tests in a sandbox");

    // Nonzero Dynamically Proven (explainer nulled by the builder) → the block is absent.
    const nonzeroHtml = renderBehaviorReport({ ...data, zeroProofExplainer: null });
    expect(nonzeroHtml).not.toContain("Why dynamic proof is 0");
  });

  it("labels untested-but-reachable behaviors 'Reachable Untested' (display split of none)", () => {
    // graph() has no test edges, so its two eligible behaviors are none-tier AND flow hops.
    const data = buildBehaviorReportData(graph(), EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    expect(data.summary.reachableUntested).toBeGreaterThan(0);
    expect(data.behaviors.some((b) => b.tier === "none" && b.reachable)).toBe(true);
    const html = renderBehaviorReport(data);
    // v6 badges the none+reachable split as its own tier ("Reachable", blue), distinct from No signal.
    expect(html).toContain('label:"Reachable"');
    expect(html).toContain("b-reach");
  });
});

// ── v6 redesign: DISPLAY-ONLY. Behaviors as tier-colored cards, flows as
//    proof-colored call-chain cards. Every datum comes from BehaviorReportData verbatim. ──
describe("renderBehaviorReport — v6 behavior-report redesign (display-only)", () => {
  /** Ledger that dynamically proves the endpoint handler, so a proven tier + proven flow exist.
   *  Requires the target file to be fingerprintable, so seed its manifest hash on the graph first. */
  function provenLedger(g: LocalGraph): Ledger {
    const target = "sym:src/orders.controller.ts#OrdersController.create";
    g.manifest.files["src/orders.controller.ts"] = { hash: "sha256:orders-v1", size: 64, kind: "code" };
    return {
      schema_version: LEDGER_SCHEMA_VERSION,
      records: [
        {
          run_id: "run:dynamic",
          target_symbol: target,
          pre_edges: [],
          new_edges: [],
          closed: true,
          status: "reproven",
          target_fingerprint: targetFingerprint(g, target),
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

  it("renders behaviors as a tier-colored card grid (green/amber/blue/red), not a flat list", () => {
    const g = graph();
    const data = buildBehaviorReportData(g, provenLedger(g), { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);

    // v6 behavior grid scaffolding: a grid container of tier-colored cards.
    expect(html).toContain("beh-grid");
    expect(html).toContain("beh-card");
    // Cards carry the honest per-tier data attribute the CSS colors from (proven→green … none→red).
    expect(html).toContain("c.dataset.t=t.cls");
    expect(html).toContain('[data-t="proven"]');
    // A proven behavior exists and its signature reaches the grid via the embedded DATA.
    expect(data.behaviors.some((b) => b.tier === "proven")).toBe(true);
    const proven = data.behaviors.find((b) => b.tier === "proven")!;
    expect(html).toContain(JSON.stringify(proven.sig));
  });

  it("renders flows as call-chain cards colored by proof (proven→green, none→neutral)", () => {
    const g = graph();
    const data = buildBehaviorReportData(g, provenLedger(g), { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);

    // v6 flow chain scaffolding: entry box + step boxes connected by edge lines.
    expect(html).toContain("flow-chain");
    expect(html).toContain("fn-box");
    expect(html).toContain("fe-line");
    // Proven hops get the green node class; assoc hops amber — driven by step proof data.
    expect(data.flows.some((f) => f.proof === "proven")).toBe(true);
    expect(html).toContain("fnb-proven");
    expect(html).toContain("fnb-assoc");
    // Hop edge style is honest: framework-derived hops render a dashed rail class.
    expect(data.flows[0].steps.some((s) => s.edge === "framework-derived")).toBe(true);
    expect(html).toContain("fel-fw");
  });

  it("keeps the risk cards data-honest — generated-test sections render ONLY from real graph data", () => {
    const g = graph();
    const data = buildBehaviorReportData(g, provenLedger(g), { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);

    // Risk cards render the real risk fields.
    expect(data.risks.length).toBeGreaterThan(0);
    expect(html).toContain(JSON.stringify(data.risks[0].path));
    // No generated tests in this graph ⇒ every risk row carries empty arrays and the
    // CTA band count is 0 (the template hides both sections when the data is empty).
    for (const r of data.risks) {
      expect(r.generatedTests).toEqual([]);
      expect(r.applicableCategories).toEqual([]);
    }
    expect(data.generatedTotal).toBe(0);
    expect(data.shownCount).toBe(0);
    expect(html).toContain('"generatedTotal":0');
    // And none of the v6 demo's fabricated snippets survive the DATA swap.
    expect(html).not.toContain("expired token rejects at TokenService boundary");
    expect(html).not.toContain("TokenService.verify throws");
  });

  it("links REAL generated tests to their risk row verbatim (name, type, body)", () => {
    const g = graph();
    const data0 = buildBehaviorReportData(g, provenLedger(g), { repoRoot: "/tmp/orders-api" });
    const targetId = data0.risks[0] ? undefined : undefined; // placeholder, resolved below
    // Attach one real generated test to the graph, targeting the first risk's symbol.
    const riskGap = data0.risks[0];
    expect(riskGap).toBeTruthy();
    // Find the gap's symbol id from the graph (riskRows derives from rankRiskGaps whose id is the symbol).
    const sym = g.nodes.find((n) => n.kind === "CodeSymbol" && (n.title || "").length > 0);
    expect(sym).toBeTruthy();
    g.generated_tests = [
      {
        id: "gen:1",
        run_id: "run:g",
        title: "orders flow: rejects invalid order at boundary",
        test_type: "integration",
        framework_hint: "vitest",
        body: "import { it } from 'vitest';\nit('rejects invalid order', () => {});",
        grounding: { entity_ids: [sym!.external_id], source_refs: [], weak_relationships_used: [] },
        weak_evidence_used: false,
        target_symbol_external_id: sym!.external_id
      }
    ];
    const data = buildBehaviorReportData(g, provenLedger(g), { repoRoot: "/tmp/orders-api" });
    const html = renderBehaviorReport(data);
    const withTests = data.risks.find((r) => r.generatedTests.length > 0);
    expect(withTests).toBeTruthy();
    // Verbatim, honest metadata: title, layer as the concern chip, framework as the summary, body as code.
    expect(withTests!.generatedTests[0].name).toBe("orders flow: rejects invalid order at boundary");
    expect(withTests!.generatedTests[0].concern).toBe("integration");
    expect(withTests!.generatedTests[0].code).toContain("rejects invalid order");
    expect(data.generatedTotal).toBe(1);
    expect(data.shownCount).toBe(1);
    expect(html).toContain("Generated tests");
    expect(html).toContain("No generated tests");
    expect(html).toContain("remainingRiskFlows} high-risk flows left");
    expect(html).toContain("Generate remaining tests on Platform");
    expect(html).not.toContain("0 more tests generated");
    // Category strip shows only the real attached concerns — nothing locked/fabricated.
    expect(withTests!.applicableCategories).toEqual(["integration"]);
  });

  it("attaches a same-file generated test to exactly ONE deterministic row, labeled 'same-file target'", () => {
    const g = graph();
    // Two risk rows in one file + a generated test targeting a THIRD (unlisted) symbol in that file.
    g.nodes.push(codeSymbol("sym:src/pay.ts#PayService.charge", "PayService.charge", "src/pay.ts"));
    g.nodes.push(codeSymbol("sym:src/pay.ts#PayService.refund", "PayService.refund", "src/pay.ts"));
    g.generated_tests = [
      {
        id: "gen:sf",
        run_id: "run:sf",
        title: "pay helper: normalizes amounts at the boundary",
        test_type: "integration",
        framework_hint: "vitest",
        body: "import { it } from 'vitest';",
        grounding: { entity_ids: [], source_refs: [], weak_relationships_used: [] },
        weak_evidence_used: false,
        target_symbol_external_id: "sym:src/pay.ts#normalizeAmount"
      }
    ];
    const data = buildBehaviorReportData(g, EMPTY_LEDGER, { repoRoot: "/tmp/orders-api" });
    const payRows = data.risks.filter((r) => r.path === "src/pay.ts");
    expect(payRows.length).toBeGreaterThanOrEqual(2);
    // The fallback attaches to exactly one row across the whole risk list…
    const withTest = data.risks.filter((r) => r.generatedTests.length > 0);
    expect(withTest).toHaveLength(1);
    // …and that row is the file's FIRST (highest-ranked) row, clearly labeled.
    expect(withTest[0]).toBe(payRows[0]);
    expect(withTest[0].generatedTests[0].assertion).toContain("same-file target");
  });

  it("orders behaviors Proven-first and ships the evidence-tier filter", () => {
    const g = graph();
    const data = buildBehaviorReportData(g, provenLedger(g), { repoRoot: "/tmp/orders-api" });
    // Proven rows lead the grid; the none tier trails.
    const tiers = data.behaviors.map((b) => (b.tier === "proven" ? 0 : b.tier === "assoc" ? 1 : b.reachable ? 2 : 3));
    expect([...tiers].sort((a, b) => a - b)).toEqual(tiers);
    expect(data.behaviors[0].tier).toBe("proven");
    const html = renderBehaviorReport(data);
    // The tier filter UI is present with one button per tier, wired to re-render the grid.
    expect(html).toContain('id="tier-filter"');
    expect(html).toContain("activeTier");
    expect(html).toContain('["proven","Dynamically Proven"]');
    // The report also ships a text search over behavior signature + file.
    expect(html).toContain('id="beh-search"');
    expect(html).toContain("searchQ");
    // Copy guard: no broken CTA command in the shipped report.
    expect(html).not.toContain("npx orangepro prove");
  });
});
