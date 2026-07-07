import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildVizPayload } from "../../src/local/viz/payload.js";
import { renderVizHtml } from "../../src/local/viz/html.js";
import { renderCoverageReport } from "../../src/local/pack/coverageReport.js";
import { scoreGraph } from "../../src/local/score/score.js";
import { makeNode, makeEdge, makeCandidateEdge } from "../../src/local/graph/factories.js";
import { GraphNode, LocalGraph, LOCAL_GRAPH_SCHEMA_VERSION } from "../../src/local/graph/ontology.js";
import { opInit, opAnalyze, opGraphHtml } from "../../src/local/operations.js";
import { LEDGER_SCHEMA_VERSION, targetFingerprint, type Ledger } from "../../src/local/ledger.js";

const UNIQUE_SOURCE_TOKEN = "uniqueProprietaryToken_doNotEmbed_42";

function emptyGraph(nodes: GraphNode[], extras: Partial<LocalGraph> = {}): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "demo", root: "/tmp/demo", root_hash: "sha256:x", source_upload_policy: "metadata_only" },
    created_at: "",
    updated_at: "",
    sources: [],
    nodes,
    edges: [],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "", git: null, files: {} },
    ...extras
  };
}

/**
 * Three UserFlows exercising the 3-state coverage model + a TestCase, across areas:
 *  - flow:auth-login  → CONFIRMED  (hard TESTED_BY edge to the test)
 *  - flow:profile-edit → INFERRED  (only a weak MAY_BE_TESTED_BY candidate edge)
 *  - flow:billing-invoice → NONE   (no coverage edge at all)
 */
function gapFixtureGraph(): LocalGraph {
  const coveredFlow = makeNode({
    kind: "UserFlow",
    external_id: "flow:auth-login",
    title: "Login (inferred from tests)",
    properties: { area: "auth", example_behaviors: ["logs in with valid creds", "rejects bad password", "locks after retries"] },
    evidence_strength: "weak",
    review_status: "inferred",
    confidence: 0.8,
    provenance: { source_scope_id: "t", source_ref: "e2e-tests/auth/login_spec.ts" }
  });
  const inferredFlow = makeNode({
    kind: "UserFlow",
    external_id: "flow:profile-edit",
    title: "Edit profile (inferred from tests)",
    properties: { area: "profile", example_behaviors: ["updates the display name"] },
    evidence_strength: "weak",
    review_status: "inferred",
    confidence: 0.35,
    provenance: { source_scope_id: "t", source_ref: "e2e-tests/profile/edit_spec.ts" }
  });
  const gapFlow = makeNode({
    kind: "UserFlow",
    external_id: "flow:billing-invoice",
    title: "Invoice (inferred from tests)",
    properties: { area: "billing", example_behaviors: ["generates an invoice"] },
    evidence_strength: "weak",
    review_status: "inferred",
    confidence: 0.4,
    provenance: { source_scope_id: "t", source_ref: "server/billing/invoice_spec.ts" }
  });
  const testCase = makeNode({
    kind: "TestCase",
    external_id: "test:e2e-tests/auth/login_spec.ts",
    title: "login_spec.ts",
    properties: { test_layer: "e2e", file: "e2e-tests/auth/login_spec.ts", test_names: ["logs in with valid creds", "rejects bad password"] },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "t", source_ref: "e2e-tests/auth/login_spec.ts" }
  });
  const inferredTestCase = makeNode({
    kind: "TestCase",
    external_id: "test:e2e-tests/profile/edit_spec.ts",
    title: "edit_spec.ts",
    properties: { test_layer: "e2e", file: "e2e-tests/profile/edit_spec.ts", test_names: ["updates the display name"] },
    evidence_strength: "weak",
    review_status: "inferred",
    confidence: 0.35,
    provenance: { source_scope_id: "t", source_ref: "e2e-tests/profile/edit_spec.ts" }
  });
  return emptyGraph([coveredFlow, inferredFlow, gapFlow, testCase, inferredTestCase], {
    edges: [
      makeEdge({
        from_external_id: "flow:auth-login",
        to_external_id: "test:e2e-tests/auth/login_spec.ts",
        relationship_type: "TESTED_BY",
        evidence_strength: "hard",
        review_status: "auto_detected",
        provenance: { source_scope_id: "t", source_ref: "e2e-tests/auth/login_spec.ts" }
      })
    ],
    candidate_edges: [
      makeCandidateEdge({
        from_external_id: "flow:profile-edit",
        to_external_id: "test:e2e-tests/profile/edit_spec.ts",
        relationship_type: "MAY_BE_TESTED_BY",
        evidence_strength: "weak",
        reason: "Behavior anchor inferred from test names in this file",
        confidence: 0.35,
        provenance: { source_scope_id: "t", source_ref: "e2e-tests/profile/edit_spec.ts" }
      })
    ]
  });
}

function symbolProofFixtureGraph(): LocalGraph {
  const flow = makeNode({
    kind: "UserFlow",
    external_id: "flow:admin-about",
    title: "Admin about screen",
    properties: { area: "frontend", example_behaviors: ["shows build information"] },
    evidence_strength: "weak",
    review_status: "inferred",
    confidence: 0.4,
    provenance: { source_scope_id: "t", source_ref: "frontend/tests/admin-about.test.ts" }
  });
  const symbol = makeNode({
    kind: "CodeSymbol",
    external_id: "sym:frontend/api/admin-about.ts#AdminAboutAPI.about",
    title: "AdminAboutAPI.about",
    properties: { file: "frontend/api/admin-about.ts", symbol_kind: "method" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "t", source_ref: "frontend/api/admin-about.ts" },
    denominator_eligible: true,
    denominator_reason: "Exported method — countable behavior surface."
  });
  const testCase = makeNode({
    kind: "TestCase",
    external_id: "test:frontend/tests/admin-about.test.ts",
    title: "admin-about.test.ts",
    properties: { test_layer: "unit", file: "frontend/tests/admin-about.test.ts", test_names: ["loads admin about data"] },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "t", source_ref: "frontend/tests/admin-about.test.ts" }
  });
  return emptyGraph([flow, symbol, testCase], {
    edges: [
      makeEdge({
        from_external_id: "test:frontend/tests/admin-about.test.ts",
        to_external_id: "sym:frontend/api/admin-about.ts#AdminAboutAPI.about",
        relationship_type: "COVERS",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        last_verified: 123456,
        provenance: { source_scope_id: "t", source_ref: "frontend/tests/admin-about.test.ts" }
      })
    ],
    candidate_edges: [
      makeCandidateEdge({
        from_external_id: "flow:admin-about",
        to_external_id: "test:frontend/tests/admin-about.test.ts",
        relationship_type: "MAY_BE_TESTED_BY",
        evidence_strength: "weak",
        reason: "Behavior anchor inferred from test names in this file",
        confidence: 0.35,
        provenance: { source_scope_id: "t", source_ref: "frontend/tests/admin-about.test.ts" }
      })
    ]
  });
}

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("viz payload (gap-first model)", () => {
  it("computes 4-state coverage stats (confirmed/nsc/inferred/none)", () => {
    const graph = gapFixtureGraph();
    const { gap } = buildVizPayload(graph, scoreGraph(graph));
    expect(gap.workspace).toBe("demo");
    expect(gap.stats.userflows).toBe(3);
    expect(gap.stats.confirmed).toBe(1);
    // flow:profile-edit's only test is e2e-layer -> not_structurally_confirmable
    // (Phase 4.5), NOT inferred, and it is excluded from the confirmed_pct denominator.
    expect(gap.stats.inferred).toBe(0);
    expect(gap.stats.not_structurally_confirmable).toBe(1);
    expect(gap.stats.none).toBe(1);
    expect(gap.stats.confirmable_total).toBe(2); // confirmed + inferred + none (nsc excluded)
    expect(gap.stats.confirmed_pct).toBeCloseTo((1 / 2) * 100, 5);
    // coverage_pct is kept as a back-compat alias of confirmed_pct.
    expect(gap.stats.coverage_pct).toBe(gap.stats.confirmed_pct);
    expect(gap.stats.testcases).toBe(2);
  });

  it("assigns confirmed / inferred / none per flow, with test_ids on the candidate-linked one", () => {
    const graph = gapFixtureGraph();
    const { gap } = buildVizPayload(graph, scoreGraph(graph));
    const confirmed = gap.all_userflows.find((f) => f.id === "flow:auth-login");
    const deferred = gap.all_userflows.find((f) => f.id === "flow:profile-edit");
    const none = gap.all_userflows.find((f) => f.id === "flow:billing-invoice");
    expect(confirmed?.coverage).toBe("confirmed");
    expect(confirmed?.has_test).toBe(true);
    expect(confirmed?.test_links).toEqual([
      {
        from: "flow:auth-login",
        to: "test:e2e-tests/auth/login_spec.ts",
        status: "confirmed",
        label: "Static test link",
        confidence: 1
      }
    ]);
    // e2e-only -> not_structurally_confirmable with a defer_reason (Phase 4.5)
    expect(deferred?.coverage).toBe("not_structurally_confirmable");
    expect(deferred?.has_test).toBe(false);
    expect(deferred?.defer_reason).toBe("layer_e2e");
    // the weak candidate edge still surfaces its TestCase id (capped at 2)
    expect(deferred?.test_ids).toEqual(["test:e2e-tests/profile/edit_spec.ts"]);
    expect(deferred?.test_links).toEqual([
      {
        from: "flow:profile-edit",
        to: "test:e2e-tests/profile/edit_spec.ts",
        status: "possible",
        label: "Possible test link",
        confidence: 0.35
      }
    ]);
    expect(none?.coverage).toBe("none");
    expect(none?.has_test).toBe(false);
    expect(none?.test_ids).toEqual([]);
    // behaviors truncated to 3
    expect(confirmed?.behaviors).toEqual(["logs in with valid creds", "rejects bad password", "locks after retries"]);
  });

  it("surfaces CodeSymbol hard proof links separately from UserFlow possible links", () => {
    const graph = symbolProofFixtureGraph();
    const { gap } = buildVizPayload(graph, scoreGraph(graph));
    expect(gap.all_userflows[0].coverage).toBe("inferred");
    expect(gap.all_userflows[0].test_links).toEqual([
      {
        from: "flow:admin-about",
        to: "test:frontend/tests/admin-about.test.ts",
        status: "possible",
        label: "Possible test link",
        confidence: 0.35
      }
    ]);
    expect(gap.symbol_test_links).toEqual([
      {
        from: "sym:frontend/api/admin-about.ts#AdminAboutAPI.about",
        to: "test:frontend/tests/admin-about.test.ts",
        symbol_label: "AdminAboutAPI.about",
        test_label: "admin-about.test.ts",
        area: "frontend",
        confidence: 1,
        last_verified: 123456
      }
    ]);
    expect(gap.services.map((s) => s.id)).toContain("area:frontend");
  });

  it("builds denominator-backed language tiers without blending proof and association", () => {
    const tsProven = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/web/login.ts#login",
      title: "login",
      properties: { file: "src/web/login.ts", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: "src/web/login.ts" },
      denominator_eligible: true
    });
    const tsRuntime = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/web/logout.ts#logout",
      title: "logout",
      properties: { file: "src/web/logout.ts", symbol_kind: "function", runtime_covered: true, runtime_coverage_formats: ["lcov"] },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: "src/web/logout.ts" },
      denominator_eligible: true
    });
    const pyAssociated = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:app/users.py#load_user",
      title: "load_user",
      properties: { file: "app/users.py", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: "app/users.py" },
      denominator_eligible: true
    });
    const requirement = makeNode({
      kind: "Requirement",
      external_id: "req:documented-sla",
      title: "Documented SLA",
      evidence_strength: "reviewed",
      review_status: "local_reviewed",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: "docs/sla.md" }
    });
    const testCase = makeNode({
      kind: "TestCase",
      external_id: "test:src/web/login.test.ts",
      title: "login.test.ts",
      properties: { test_layer: "unit", file: "src/web/login.test.ts" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: "src/web/login.test.ts" }
    });
    const graph = emptyGraph([tsProven, tsRuntime, pyAssociated, requirement, testCase], {
      edges: [
        makeEdge({
          from_external_id: "sym:src/web/login.ts#login",
          to_external_id: "test:src/web/login.test.ts",
          relationship_type: "TESTED_BY",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: { source_scope_id: "s", source_ref: "src/web/login.test.ts" }
        })
      ],
      candidate_edges: [
        makeCandidateEdge({
          from_external_id: "tests/test_users.py",
          to_external_id: "app/users.py",
          relationship_type: "MAY_RELATE_TO",
          evidence_strength: "weak",
          confidence: 0.5,
          reason: "Python convention sibling",
          provenance: { source_scope_id: "s", source_ref: "tests/test_users.py" }
        })
      ]
    });

    graph.manifest.files["src/web/login.ts"] = { hash: "sha256:login-v1", size: 32, kind: "code" };
    const { gap } = buildVizPayload(graph, scoreGraph(graph), {
      schema_version: LEDGER_SCHEMA_VERSION,
      records: [
        {
          run_id: "run:dynamic-login-language",
          target_symbol: "sym:src/web/login.ts#login",
          target_fingerprint: targetFingerprint(graph, "sym:src/web/login.ts#login"),
          pre_edges: [],
          new_edges: [],
          closed: true,
          status: "reproven",
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
    });
    expect(gap.stats.behavior_total).toBe(4);
    expect(gap.code_behaviors).toEqual([
      {
        id: "sym:app/users.py#load_user",
        title: "load_user",
        file: "app/users.py",
        area: "app",
        language: "Python",
        evidence: "associated"
      },
      {
        id: "sym:src/web/logout.ts#logout",
        title: "logout",
        file: "src/web/logout.ts",
        area: "src/web",
        language: "TypeScript/JavaScript",
        evidence: "runtime"
      },
      {
        id: "sym:src/web/login.ts#login",
        title: "login",
        file: "src/web/login.ts",
        area: "src/web",
        language: "TypeScript/JavaScript",
        evidence: "proven"
      }
    ]);
    expect(gap.language_tiers).toEqual([
      {
        language: "TypeScript/JavaScript",
        total: 2,
        proven: 1,
        runtime_covered: 1,
        associated: 0,
        unlinked: 0,
        proven_pct: 50,
        runtime_pct: 50,
        associated_pct: 0
      },
      {
        language: "Python",
        total: 1,
        proven: 0,
        runtime_covered: 0,
        associated: 1,
        unlinked: 0,
        proven_pct: 0,
        runtime_pct: 0,
        associated_pct: 100
      }
    ]);
  });

  it("propagates package-entry associations through deterministic imports without proof", () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/vanilla.ts#proxy",
      title: "proxy",
      properties: { file: "src/vanilla.ts", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: "src/vanilla.ts" },
      denominator_eligible: true
    });
    const graph = emptyGraph([symbol], {
      edges: [
        makeEdge({
          from_external_id: "src/index.ts",
          to_external_id: "src/vanilla.ts",
          relationship_type: "IMPORTS",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: { source_scope_id: "s", source_ref: "src/index.ts" }
        })
      ],
      candidate_edges: [
        makeCandidateEdge({
          from_external_id: "tests/basic.test.tsx",
          to_external_id: "src/index.ts",
          relationship_type: "MAY_RELATE_TO",
          evidence_strength: "weak",
          confidence: 0.5,
          reason: "package self-import resolves to local entrypoint",
          provenance: { source_scope_id: "s", source_ref: "tests/basic.test.tsx" }
        })
      ]
    });

    const { gap } = buildVizPayload(graph, scoreGraph(graph));
    expect(gap.code_behaviors).toEqual([
      {
        id: "sym:src/vanilla.ts#proxy",
        title: "proxy",
        file: "src/vanilla.ts",
        area: "src",
        language: "TypeScript/JavaScript",
        evidence: "associated"
      }
    ]);
    expect(gap.language_tiers).toEqual([
      {
        language: "TypeScript/JavaScript",
        total: 1,
        proven: 0,
        runtime_covered: 0,
        associated: 1,
        unlinked: 0,
        proven_pct: 0,
        runtime_pct: 0,
        associated_pct: 100
      }
    ]);
  });

  it("uses CodeSymbols, not test-inferred UserFlows, for the searchable no-link table", () => {
    const weakFlowA = makeNode({
      kind: "UserFlow",
      external_id: "flow:checkout",
      title: "Checkout (inferred from tests)",
      properties: { area: "checkout", example_behaviors: ["checks out"] },
      evidence_strength: "weak",
      review_status: "inferred",
      confidence: 0.4,
      provenance: { source_scope_id: "t", source_ref: "tests/checkout.test.ts" }
    });
    const weakFlowB = makeNode({
      kind: "UserFlow",
      external_id: "flow:profile",
      title: "Profile (inferred from tests)",
      properties: { area: "profile", example_behaviors: ["updates profile"] },
      evidence_strength: "weak",
      review_status: "inferred",
      confidence: 0.4,
      provenance: { source_scope_id: "t", source_ref: "tests/profile.test.ts" }
    });
    const orphanCode = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/billing/invoice.ts#createInvoice",
      title: "createInvoice",
      properties: { file: "src/billing/invoice.ts", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: "src/billing/invoice.ts" },
      denominator_eligible: true
    });
    const associatedCode = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/checkout/cart.ts#checkout",
      title: "checkout",
      properties: { file: "src/checkout/cart.ts", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: "src/checkout/cart.ts" },
      denominator_eligible: true
    });
    const testCase = makeNode({
      kind: "TestCase",
      external_id: "test:tests/checkout.test.ts",
      title: "checkout.test.ts",
      properties: { test_layer: "unit", file: "tests/checkout.test.ts" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "t", source_ref: "tests/checkout.test.ts" }
    });
    const graph = emptyGraph([weakFlowA, weakFlowB, orphanCode, associatedCode, testCase], {
      candidate_edges: [
        makeCandidateEdge({
          from_external_id: "flow:checkout",
          to_external_id: "test:tests/checkout.test.ts",
          relationship_type: "MAY_BE_TESTED_BY",
          evidence_strength: "weak",
          confidence: 0.4,
          reason: "test-name signal",
          provenance: { source_scope_id: "t", source_ref: "tests/checkout.test.ts" }
        }),
        makeCandidateEdge({
          from_external_id: "flow:profile",
          to_external_id: "test:tests/checkout.test.ts",
          relationship_type: "MAY_BE_TESTED_BY",
          evidence_strength: "weak",
          confidence: 0.4,
          reason: "test-name signal",
          provenance: { source_scope_id: "t", source_ref: "tests/profile.test.ts" }
        }),
        makeCandidateEdge({
          from_external_id: "tests/checkout.test.ts",
          to_external_id: "src/checkout/cart.ts",
          relationship_type: "MAY_RELATE_TO",
          evidence_strength: "weak",
          confidence: 0.5,
          reason: "path convention",
          provenance: { source_scope_id: "t", source_ref: "tests/checkout.test.ts" }
        })
      ]
    });

    const payload = buildVizPayload(graph, scoreGraph(graph));
    expect(payload.gap.all_userflows.filter((f) => f.coverage === "none")).toHaveLength(0);
    expect(payload.gap.code_behaviors.filter((f) => f.evidence === "none")).toEqual([
      {
        id: "sym:src/billing/invoice.ts#createInvoice",
        title: "createInvoice",
        file: "src/billing/invoice.ts",
        area: "src/billing",
        language: "TypeScript/JavaScript",
        evidence: "none"
      }
    ]);

    const html = renderVizHtml(payload);
    // Code behaviors surface by EVIDENCE tier (proven/runtime/associated/none),
    // keyed on the code symbol — never by userflow coverage state.
    expect(html).toContain('data-tier="none"');
    expect(html).toContain("state.tiers[dt.tier]");
    expect(html).not.toContain("f.coverage !== status");
  });

  it("derives area from the first path segment of the provenance ref", () => {
    const graph = gapFixtureGraph();
    const { gap } = buildVizPayload(graph, scoreGraph(graph));
    const covered = gap.all_userflows.find((f) => f.id === "flow:auth-login");
    const miss = gap.all_userflows.find((f) => f.id === "flow:billing-invoice");
    // source_ref "e2e-tests/..." -> "e2e-tests" (NOT the properties.area "auth")
    expect(covered?.area).toBe("e2e-tests");
    expect(miss?.area).toBe("server");
  });

  it("builds denominator-backed code area summary, services, and a testcase sample", () => {
    const graph = gapFixtureGraph();
    const provenSymbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/auth.ts#login",
      title: "login",
      properties: { file: "src/auth.ts", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: "src/auth.ts" },
      denominator_eligible: true
    });
    const associatedSymbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/profile.ts#editProfile",
      title: "editProfile",
      properties: { file: "src/profile.ts", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: "src/profile.ts" },
      denominator_eligible: true
    });
    const noLinkSymbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:server/billing.ts#invoice",
      title: "invoice",
      properties: { file: "server/billing.ts", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: "server/billing.ts" },
      denominator_eligible: true
    });
    graph.nodes.push(provenSymbol, associatedSymbol, noLinkSymbol);
    graph.edges.push(
      makeEdge({
        from_external_id: "sym:src/auth.ts#login",
        to_external_id: "test:e2e-tests/auth/login_spec.ts",
        relationship_type: "TESTED_BY",
        evidence_strength: "hard",
        review_status: "auto_detected",
        provenance: { source_scope_id: "s", source_ref: "src/auth.ts" }
      })
    );
    graph.candidate_edges.push(
      makeCandidateEdge({
        from_external_id: "src/profile.ts",
        to_external_id: "test:e2e-tests/profile/edit_spec.ts",
        relationship_type: "MAY_RELATE_TO",
        evidence_strength: "weak",
        confidence: 0.5,
        reason: "candidate file link",
        provenance: { source_scope_id: "s", source_ref: "src/profile.ts" }
      })
    );
    graph.manifest.files["src/auth.ts"] = { hash: "sha256:auth-v1", size: 32, kind: "code" };
    const { gap } = buildVizPayload(graph, scoreGraph(graph), {
      schema_version: LEDGER_SCHEMA_VERSION,
      records: [
        {
          run_id: "run:dynamic-auth-area",
          target_symbol: "sym:src/auth.ts#login",
          target_fingerprint: targetFingerprint(graph, "sym:src/auth.ts#login"),
          pre_edges: [],
          new_edges: [],
          closed: true,
          status: "reproven",
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
    });
    expect(gap.area_summary.map((a) => a.area).sort()).toEqual(["server", "src"]);
    const src = gap.area_summary.find((a) => a.area === "src");
    const server = gap.area_summary.find((a) => a.area === "server");
    expect(src?.total).toBe(2);
    expect(src?.confirmed).toBe(1);
    expect(src?.inferred).toBe(1);
    expect(src?.not_structurally_confirmable).toBe(0);
    expect(src?.none).toBe(0);
    expect(src?.confirmed_pct).toBe(50);
    expect(src?.sample_gaps).toEqual([{ title: "editProfile", file: "src/profile.ts", status: "associated" }]);
    expect(server?.total).toBe(1);
    expect(server?.confirmed).toBe(0);
    expect(server?.inferred).toBe(0);
    expect(server?.none).toBe(1);
    expect(server?.confirmed_pct).toBe(0);
    expect(server?.sample_gaps).toEqual([{ title: "invoice", file: "server/billing.ts", status: "none" }]);
    // services = distinct flow areas plus hard symbol-proof areas as hubs
    expect(gap.services.map((s) => s.id).sort()).toEqual(["area:e2e-tests", "area:server", "area:src"]);
    // testcase sample carries names + layer
    const loginTc = gap.testcases_sample.find((t) => t.id === "test:e2e-tests/auth/login_spec.ts");
    expect(loginTc?.test_names).toEqual(["logs in with valid creds", "rejects bad password"]);
    expect(loginTc?.test_layer).toBe("e2e");
  });

  it("reports 0 coverage when there are no userflows", () => {
    const graph = emptyGraph([]);
    const { gap } = buildVizPayload(graph, scoreGraph(graph));
    expect(gap.stats.userflows).toBe(0);
    expect(gap.stats.confirmed).toBe(0);
    expect(gap.stats.inferred).toBe(0);
    expect(gap.stats.none).toBe(0);
    expect(gap.stats.confirmed_pct).toBe(0);
    expect(gap.stats.coverage_pct).toBe(0);
    expect(gap.area_summary).toEqual([]);
  });

  it("surfaces when hard proof was skipped by the confirmer budget", () => {
    const graph = emptyGraph([], {
      analysis: {
        confirmed_coverage: { confirmed_pairs: 0, attempted: 0, capped_downgrades: 0, skipped_files_budget: 2154 }
      } as LocalGraph["analysis"]
    });
    const { gap } = buildVizPayload(graph, scoreGraph(graph));
    expect(gap.proof_limited).toEqual({ skipped_files_budget: 2154 });
  });

  it("keeps the back-compat metadata payload (nodes/edges/meta) intact", () => {
    const req = makeNode({
      kind: "Requirement",
      external_id: "REQ-1",
      title: "Save a card",
      properties: { description: UNIQUE_SOURCE_TOKEN, acceptance_criteria: ["validated"] },
      evidence_strength: "hard",
      review_status: "local_reviewed",
      confidence: 0.9,
      provenance: { source_scope_id: "t", source_ref: "PAY-1" }
    });
    const graph = emptyGraph([req]);
    const payload = buildVizPayload(graph, scoreGraph(graph));
    const node = payload.nodes.find((n) => n.id === "REQ-1");
    expect(node).toBeDefined();
    // metadata-only node — no raw description token anywhere
    expect(JSON.stringify(payload.nodes)).not.toContain(UNIQUE_SOURCE_TOKEN);
    expect(payload.defaultKinds).toContain("UserFlow");
    expect(payload.meta.workspace).toBe("demo");
  });
});

describe("viz HTML (v4 gap-first port, self-contained + offline)", () => {
  it("contains no network/CDN references (offline, self-contained)", () => {
    const graph = gapFixtureGraph();
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    // No external assets are fetched (D3 is vendored inline; its unused d3-fetch
    // helpers are inert library code, not a render-time network call).
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    // The only URLs present are inert: W3C XML namespaces + the vendored-D3 copyright line.
    const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
    for (const u of urls) {
      expect(u.startsWith("http://www.w3.org/") || u.startsWith("https://d3js.org")).toBe(true);
    }
  });

  it("renders the three tab labels, a DATA assignment, and vendored D3", () => {
    const graph = gapFixtureGraph();
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    expect(html).toContain("Gap Zones");
    expect(html).toContain("Overview");
    expect(html).toContain("Matrix");
    expect(html).toContain("const DATA=");
    // D3 v7 is present (offline).
    expect(html).toContain("forceSimulation");
    // logic that reads DATA is embedded.
    expect(html).toContain("function initViz(");
    expect(html).toContain("function drawGraph(");
  });

  it("renders the per-language coverage tier section in plain language", () => {
    const graph = symbolProofFixtureGraph();
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    expect(html).toContain("Code behavior evidence by language");
    expect(html).toContain("Proven = dynamic targeted mutation proof recorded in the local ledger");
    expect(html).toContain("Runtime-covered = executed by a repo coverage report");
    expect(html).toContain("Associated signal = name/path/import/structural matching only, not semantic proof");
    expect(html).toContain("No link = no direct static or runtime signal found");
    expect(html).toContain("Broad e2e or integration coverage may still exist");
    expect(html).toContain("language_tiers");
  });

  it("warns when hard proof is limited because the confirmer budget was exceeded", () => {
    const graph = emptyGraph([], {
      analysis: {
        confirmed_coverage: { confirmed_pairs: 0, attempted: 0, capped_downgrades: 0, skipped_files_budget: 2154 }
      } as LocalGraph["analysis"]
    });
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    expect(html).toContain("proof-banner");
    expect(html).toContain("HARD PROOF SKIPPED");
    expect(html).toContain("Proven coverage is a conservative lower bound because that proof pass did not run");
    expect(html).toContain("ORANGEPRO_MAX_CONFIRM_FILES");
  });

  it("warns differently when hard proof ran on a risk-ranked subset", () => {
    const graph = emptyGraph([], {
      analysis: {
        confirmed_coverage: {
          confirmed_pairs: 1,
          attempted: 2,
          capped_downgrades: 0,
          skipped_files_budget: 2154,
          scoped_by_risk: { candidate_pairs: 2, involved_files: 2, risk_symbols: 1, risk_symbol_limit: 500, file_budget: 2 }
        }
      } as LocalGraph["analysis"]
    });
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    expect(html).toContain("HARD PROOF SCOPED");
    expect(html).toContain("risk-ranked subset");
    expect(html).toContain("candidate pair(s)");
  });

  it("embeds the gap DATA as valid, parseable JSON", () => {
    const graph = gapFixtureGraph();
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    const m = html.match(/const DATA=(\{[\s\S]*?\});\n/);
    expect(m).toBeTruthy();
    const data = JSON.parse(m![1].replace(/\\u003c/g, "<"));
    expect(data.workspace).toBe("demo");
    expect(data.stats.userflows).toBe(3);
    expect(data.all_userflows.length).toBe(3);
    expect(Array.isArray(data.code_behaviors)).toBe(true);
    expect(data.all_userflows.find((f: { id: string }) => f.id === "flow:auth-login").test_links[0]).toMatchObject({
      from: "flow:auth-login",
      to: "test:e2e-tests/auth/login_spec.ts",
      status: "confirmed",
      label: "Static test link"
    });
    expect(data.all_userflows.find((f: { id: string }) => f.id === "flow:profile-edit").test_links[0]).toMatchObject({
      from: "flow:profile-edit",
      to: "test:e2e-tests/profile/edit_spec.ts",
      status: "possible",
      label: "Possible test link"
    });
    // 4-state coverage rides along on every flow (the e2e-only flow is nsc, Phase 4.5).
    expect(data.all_userflows.map((f: { coverage: string }) => f.coverage).sort()).toEqual([
      "confirmed",
      "none",
      "not_structurally_confirmable"
    ]);
  });

  it("labels the gap zones honestly (no misleading gap/connected/untested text)", () => {
    const graph = gapFixtureGraph();
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    // The old binary / alarmist zone labels are gone.
    expect(html).not.toContain("GAP ZONE — NO TEST COVERAGE");
    expect(html).not.toContain("CONNECTED — TESTS EXIST");
    // The gap zone is framed as "no test link" (unproven), never "untested".
    expect(html).toContain("GAP ZONE · NO TEST LINK");
    expect(html).toContain("ASSOCIATED");
    // Honest tier language is present.
    expect(html).toContain("associated test link, not counted as proven");
    expect(html).toContain("name/path/import/structural matching only");
    // Jargon / old surfaces are gone.
    expect(html).not.toContain("Inferred only");
    expect(html).not.toContain("Coverage states");
    expect(html).not.toContain("test's name matches this behavior");
    expect(html).not.toContain("<th>Strength</th>");
    expect(html).not.toContain("conf-dots");
  });

  it("renders the four disjoint tier filter chips and a distinct runtime tier", () => {
    const graph = gapFixtureGraph();
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    expect(html).toContain('data-tier="proven"');
    expect(html).toContain('data-tier="runtime"');
    expect(html).toContain('data-tier="associated"');
    expect(html).toContain('data-tier="none"');
    // Runtime is a first-class tier with its own colour token, never folded into associated.
    expect(html).toContain("--runtime:");
    expect(html).not.toContain("INFERRED coverage");
  });

  it("embeds CodeSymbol-level hard proof links in the gap DATA (proven tier)", () => {
    const graph = symbolProofFixtureGraph();
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    const m = html.match(/const DATA=(\{[\s\S]*?\});\n/);
    expect(m).toBeTruthy();
    const data = JSON.parse(m![1].replace(/\\u003c/g, "<"));
    expect(data.symbol_test_links[0]).toMatchObject({
      from: "sym:frontend/api/admin-about.ts#AdminAboutAPI.about",
      to: "test:frontend/tests/admin-about.test.ts",
      symbol_label: "AdminAboutAPI.about",
      test_label: "admin-about.test.ts",
      area: "frontend",
      last_verified: 123456
    });
    expect(data.all_userflows[0].test_links[0]).toMatchObject({
      from: "flow:admin-about",
      status: "possible",
      label: "Possible test link"
    });
    // The proof links still ride in the embedded DATA (rendered via the proven
    // tier — matrix/treemap/KPI — rather than as directed arrows).
    expect(html).toContain("symbol_test_links");
    expect(html).toContain('id="kpi-proven"');
  });

  it("gap zones graph is a settled D3 force layout with tier zones and bounded zoom", () => {
    const graph = gapFixtureGraph();
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    // The simulation is pre-ticked so the graph paints already settled (no drift).
    expect(html).toContain("sim.tick()");
    expect(html).toContain("forceSimulation");
    expect(html).toContain("forceCollide");
    // Per-area hubs in the centre lane; sampled symbols pulled into tier zones.
    expect(html).toContain("zonesLayer");
    expect(html).toContain('id="forceSvg"');
    // Pan/zoom is pinned to the viewBox; the reset button recovers framing.
    expect(html).toContain("translateExtent");
    expect(html).toContain('id="zoom-reset"');
    expect(html).toContain('id="sample-note"');
    // The old hardcoded two-column / cluster layout and its internals are gone.
    expect(html).not.toContain("W * 0.55");
    expect(html).not.toContain("kindBBox");
    expect(html).not.toContain("clusterCenters");
  });

  it("does not let test names break out of the host <script> tag", () => {
    const flow = makeNode({
      kind: "UserFlow",
      external_id: "flow:x-y",
      title: "Tricky </script><b>break</b>",
      properties: { area: "x", example_behaviors: ["closes </script> tag"] },
      evidence_strength: "weak",
      review_status: "inferred",
      confidence: 0.3,
      provenance: { source_scope_id: "t", source_ref: "x/y_spec.ts" }
    });
    const graph = emptyGraph([flow]);
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    // No literal closing script tag from the data — it is escaped as <.
    expect(html).not.toContain("</script><b>break</b>");
  });

  it("does not embed node properties beyond the curated gap view (no raw source/secrets)", () => {
    const SECRET = "sk-LEAK-must-not-appear-9000";
    const SRC_BODY = "function topSecretImpl(){ return 42 }";
    const req = makeNode({
      kind: "Requirement",
      external_id: "REQ-9",
      title: "Save a card",
      properties: { description: SRC_BODY, api_key: SECRET, raw_source: SRC_BODY },
      evidence_strength: "hard",
      review_status: "local_reviewed",
      confidence: 0.9,
      provenance: { source_scope_id: "t", source_ref: "PAY-1" }
    });
    const graph = emptyGraph([req], {
      generated_tests: [
        {
          id: "g1",
          run_id: "r1",
          title: "saves card",
          test_type: "unit",
          framework_hint: "vitest",
          body: `${SRC_BODY} ${SECRET}`,
          grounding: { entity_ids: ["REQ-9"], source_refs: ["PAY-1"], weak_relationships_used: [] },
          weak_evidence_used: false
        }
      ]
    });
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("topSecretImpl");
    expect(html).not.toContain("raw_source");
    expect(html).not.toMatch(/\bapi_key\b/);
  });
});

describe("opGraphHtml end-to-end", () => {
  it("writes a self-contained gap-first HTML with the three tabs and parseable DATA", () => {
    const root = mkdtempSync(join(tmpdir(), "oplocal-viz-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "tests"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
    writeFileSync(join(root, "src", "card.ts"), `export function saveCard() { return "${UNIQUE_SOURCE_TOKEN}"; }\n`);
    writeFileSync(
      join(root, "tests", "card.test.ts"),
      `import { describe, it } from "vitest";\ndescribe("card", () => { it("saves a card", () => {}); it("rejects invalid card", () => {}); });\n`
    );
    const deps = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };
    opInit(root, deps);
    opAnalyze(root, { source: root }, deps);
    const { graph_html_path } = opGraphHtml(root, "graph.html");
    expect(existsSync(graph_html_path)).toBe(true);
    const html = readFileSync(graph_html_path, "utf8");
    // No raw source from the code file.
    expect(html).not.toContain(UNIQUE_SOURCE_TOKEN);
    // Self-contained: no fetched assets (inert W3C/D3-copyright URLs aside).
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    expect(html).toContain("Gap Zones");
    expect(html).toContain("Overview");
    expect(html).toContain("Matrix");
    expect(html).toContain("forceSimulation");
    const m = html.match(/const DATA=(\{[\s\S]*?\});\n/);
    expect(m).toBeTruthy();
    expect(() => JSON.parse(m![1].replace(/\\u003c/g, "<"))).not.toThrow();
  });
});

describe("renderVizHtml — $-pattern injection regression (blank Connectivity Graph)", () => {
  // String.replace with a STRING replacement interprets $&, $`, $', $$ inside the
  // inserted text. D3's minified source contains literal $` sequences, which used
  // to splatter the template head into the middle of D3 — d3 never parsed and the
  // Connectivity Graph rendered blank. Function replacements are inert.
  it("every embedded script block parses as valid JS (browser-accurate tokenization)", () => {
    const graph = gapFixtureGraph();
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    let pos = 0;
    let blocks = 0;
    for (;;) {
      const open = html.indexOf("<script", pos);
      if (open === -1) break;
      const tagEnd = html.indexOf(">", open);
      const close = html.indexOf("</script", tagEnd);
      const body = html.slice(tagEnd + 1, close === -1 ? html.length : close);
      // new Function compiles (does not execute): throws ONLY on a syntax error.
      expect(() => new Function(body)).not.toThrow();
      blocks++;
      pos = close === -1 ? html.length : close + "</script>".length;
    }
    expect(blocks).toBeGreaterThanOrEqual(2); // vendored D3 + app logic
  });

  it("$-replacement patterns in the workspace name and flow titles survive verbatim", () => {
    const graph = gapFixtureGraph();
    graph.workspace.name = "repo-$&-name";
    const flow = graph.nodes.find((n) => n.external_id === "flow:profile-edit");
    if (flow) flow.title = "Edit $' profile $` (inferred from tests)";
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    const m = html.match(/const DATA=(\{[\s\S]*?\});\n/);
    expect(m).toBeTruthy();
    const data = JSON.parse(m![1].replace(/\\u003c/g, "<"));
    expect(data.workspace).toBe("repo-$&-name");
    const titles = data.all_userflows.map((f: { title: string }) => f.title);
    expect(titles).toContain("Edit $' profile $` (inferred from tests)");
    // A string replacement would have expanded $& into the matched placeholder.
    expect(html).not.toContain("repo-__TITLE__-name");
  });
});

describe("viz HTML — not_structurally_confirmable rendering (Phase 4.5 review)", () => {
  it("keeps the nsc (live-test-only) signal in the embedded DATA without mixing it into the code-behavior tiers", () => {
    const graph = gapFixtureGraph();
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    // The embedded DATA carries the nsc flow (profile-edit is e2e-only).
    expect(html).toContain("not_structurally_confirmable");
    // The 4 code-behavior tiers are proven/runtime/associated/none — the nsc
    // userflow state is never promoted into a behavior tier or the gap count.
    expect(html).toContain('data-tier="none"');
    expect(html).not.toContain('id="s-nsc"');
    // Behaviour tiers derive from code symbols (language tiers), not userflow coverage.
    expect(html).toContain("language_tiers");
  });
});

describe("graph.html headline is the denominator confirmed-% (Codex finding 1)", () => {
  // One confirmed CodeSymbol, zero UserFlows: the OLD UserFlow flow stat reads 0%,
  // but the headline must match COVERAGE_REPORT.md (100%).
  const symNode = makeNode({
    external_id: "sym:src/x.ts#doThing",
    kind: "CodeSymbol",
    title: "doThing",
    properties: { file: "src/x.ts" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "s", source_ref: "src/x.ts" },
    behavior_source: "code_export",
    denominator_eligible: true
  });
  const testCase = makeNode({
    external_id: "test:x",
    kind: "TestCase",
    title: "x.test.ts",
    properties: { test_layer: "unit" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "s", source_ref: "src/x.test.ts" }
  });
  const hardEdge = makeEdge({
    from_external_id: "sym:src/x.ts#doThing",
    to_external_id: "test:x",
    relationship_type: "TESTED_BY",
    evidence_strength: "hard",
    review_status: "auto_detected",
    provenance: { source_scope_id: "s", source_ref: "src/x.test.ts" }
  });
  const graph = emptyGraph([symNode, testCase], { edges: [hardEdge] });
  graph.manifest.files["src/x.ts"] = { hash: "sha256:x-v1", size: 16, kind: "code" };

  const dynamicLedger: Ledger = {
    schema_version: LEDGER_SCHEMA_VERSION,
    records: [
      {
        run_id: "run:dynamic",
        target_symbol: "sym:src/x.ts#doThing",
        target_fingerprint: targetFingerprint(graph, "sym:src/x.ts#doThing"),
        pre_edges: [],
        new_edges: [],
        closed: true,
        status: "reproven",
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

  it("payload.gap.stats exposes the dynamic-proof denominator headline, not static hard edges or UserFlow 0%", () => {
    const gap = buildVizPayload(graph, scoreGraph(graph)).gap;
    const stats = gap.stats;
    expect(stats.behavior_total).toBe(1);
    expect(stats.behavior_confirmed).toBe(0);
    expect(stats.behavior_confirmed_pct).toBe(0);
    expect(gap.language_tiers).toMatchObject([{ proven: 0, associated: 1 }]);
    expect(gap.code_behaviors).toMatchObject([{ evidence: "associated" }]);
    // The UserFlow flow-view is still 0 (no UserFlows) — but it is NOT the headline.
    expect(stats.confirmed_pct).toBe(0);
  });

  it("payload.gap.stats counts dynamic targeted-proof ledger records as Proven", () => {
    const stats = buildVizPayload(graph, scoreGraph(graph), dynamicLedger).gap.stats;
    expect(stats.behavior_total).toBe(1);
    expect(stats.behavior_confirmed).toBe(1);
    expect(stats.behavior_confirmed_pct).toBe(100);
  });

  it("the rendered ring/headline uses behavior_confirmed_pct", () => {
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    expect(html).toContain("stats.behavior_confirmed_pct");
    expect(html).not.toMatch(/h-pct'\)\.textContent = Math\.round\(stats\.confirmed_pct\)/);
  });

  it("the headline + KPIs use the behavior denominator, not UserFlow counts", () => {
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    // The headline denominator is the code-behavior total.
    expect(html).toContain("D.stats.behavior_total");
    expect(html).toContain('id="hl-denom"');
    // Proven headline % is the behavior-confirmed metric, not the userflow flow-view.
    expect(html).toContain("behavior_confirmed_pct");
    // The headline never pulls the userflow test-name signal cards into the top numbers.
    expect(html).not.toContain("Test-name signals");
    expect(html).not.toContain("separate from the code behavior denominator");
  });
});

describe("COVERAGE_REPORT.md and graph.html agree even on a STALE cache (Codex round-2)", () => {
  const symN = (id: string, ref: string) =>
    makeNode({
      external_id: id,
      kind: "CodeSymbol",
      title: id,
      properties: { file: ref },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: ref },
      behavior_source: "code_export",
      denominator_eligible: true
    });
  const tc = (id: string) =>
    makeNode({
      external_id: id,
      kind: "TestCase",
      title: id,
      properties: { test_layer: "unit" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "s", source_ref: `${id}.ts` }
    });
  const edge = (strength: "hard" | "reviewed") =>
    makeEdge({
      from_external_id: "sym:a",
      to_external_id: "test:a",
      relationship_type: "TESTED_BY",
      evidence_strength: strength,
      review_status: "auto_detected",
      provenance: { source_scope_id: "s", source_ref: "test:a.ts" }
    });
  // A deliberately WRONG persisted metric (claims 1/1 = 100%).
  const staleAnalysis = {
    test_files: 1,
    inferred_flows: 0,
    flows_truncated: 0,
    max_inferred_flows: 50000,
    symbol_cap_hit: false,
      denominator: {
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
      },
    confirmed_by_layer: {
      total_behaviors: 1,
      confirmed: 1,
      confirmed_pct: 100,
      by_layer: { unit: 1, component: 0, integration: 0, api: 0, e2e: 0, manual: 0, unknown: 0 },
      unknown_count: 0,
      unknown_pct: 0
    }
  } as unknown as LocalGraph["analysis"];

  it("two eligible symbols, one static hard edge, stale cache says 1/1 → public Proven stays 0 of 2", () => {
    const g = emptyGraph([symN("sym:a", "a.ts"), symN("sym:b", "b.ts"), tc("test:a")], {
      edges: [edge("hard")],
      analysis: staleAnalysis
    });
    const md = renderCoverageReport(g);
    const stats = buildVizPayload(g, scoreGraph(g)).gap.stats;
    expect(md).toContain("0 of 2 behaviors Proven (0%)");
    expect(stats.behavior_total).toBe(2);
    expect(stats.behavior_confirmed).toBe(0);
    expect(stats.behavior_confirmed_pct).toBe(0);
  });

  it("reviewed edge + stale cache claiming 100% → both recompute to 0 public Proven", () => {
    const g = emptyGraph([symN("sym:a", "a.ts"), tc("test:a")], {
      edges: [edge("reviewed")],
      analysis: staleAnalysis
    });
    const md = renderCoverageReport(g);
    const stats = buildVizPayload(g, scoreGraph(g)).gap.stats;
    expect(md).toContain("0 of 1 behaviors Proven (0%)");
    expect(stats.behavior_confirmed).toBe(0);
    expect(stats.behavior_confirmed_pct).toBe(0);
  });
});
