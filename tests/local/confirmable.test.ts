import { describe, it, expect } from "vitest";
import { structurallyUnconfirmable } from "../../src/local/graph/confirmable.js";
import { findGaps } from "../../src/local/gaps/gaps.js";
import { makeNode, makeEdge, makeCandidateEdge } from "../../src/local/graph/factories.js";
import { GraphNode, LocalGraph, GraphEdge, CandidateEdge, LOCAL_GRAPH_SCHEMA_VERSION } from "../../src/local/graph/ontology.js";

function graphOf(nodes: GraphNode[], edges: GraphEdge[], candidate_edges: CandidateEdge[]): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "t", root: "/tmp/t", root_hash: "sha256:x", source_upload_policy: "metadata_only" },
    created_at: "",
    updated_at: "",
    sources: [],
    nodes,
    edges,
    candidate_edges,
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "", git: null, files: {} }
  };
}

const prov = { source_scope_id: "t" };

function flow(id: string, area: string): GraphNode {
  return makeNode({
    kind: "UserFlow",
    external_id: id,
    title: id,
    properties: { area, example_behaviors: ["b"], priority: "high" },
    evidence_strength: "weak",
    review_status: "inferred",
    confidence: 0.35,
    provenance: prov
  });
}

function testCase(id: string, layer: string): GraphNode {
  return makeNode({
    kind: "TestCase",
    external_id: id,
    title: id,
    properties: { test_layer: layer, file: id.replace(/^test:/, ""), test_names: ["x"] },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: prov
  });
}

function mayBeTestedBy(flowId: string, testId: string): CandidateEdge {
  return makeCandidateEdge({
    from_external_id: flowId,
    to_external_id: testId,
    relationship_type: "MAY_BE_TESTED_BY",
    evidence_strength: "weak",
    reason: "inferred",
    confidence: 0.35,
    provenance: prov
  });
}

/**
 * Four flows exercising the precedence (hard > nsc > inferred > none):
 *  - e2eFlow      -> linked ONLY to an e2e test, no hard edge  => nsc (layer_e2e)
 *  - apiFlow      -> linked ONLY to an api test, no hard edge  => nsc (layer_api)
 *  - unitFlow     -> linked to a unit test, no hard edge       => inferred (NOT nsc)
 *  - confirmedFlow-> linked to an e2e test AND a hard TESTED_BY => confirmed (precedence)
 *  - lonelyFlow   -> no linked test                            => none (NOT nsc)
 */
function fixture(): LocalGraph {
  const nodes = [
    flow("flow:e2e", "checkout"),
    flow("flow:api", "users"),
    flow("flow:unit", "math"),
    flow("flow:confirmed", "auth"),
    flow("flow:lonely", "misc"),
    testCase("test:e2e/checkout.spec.ts", "e2e"),
    testCase("test:api/users.test.ts", "api"),
    testCase("test:unit/math.test.ts", "unit"),
    testCase("test:auth/login.spec.ts", "e2e")
  ];
  const edges = [
    makeEdge({
      from_external_id: "flow:confirmed",
      to_external_id: "test:auth/login.spec.ts",
      relationship_type: "TESTED_BY",
      evidence_strength: "hard",
      review_status: "auto_detected",
      provenance: prov
    })
  ];
  const candidate_edges = [
    mayBeTestedBy("flow:e2e", "test:e2e/checkout.spec.ts"),
    mayBeTestedBy("flow:api", "test:api/users.test.ts"),
    mayBeTestedBy("flow:unit", "test:unit/math.test.ts"),
    mayBeTestedBy("flow:confirmed", "test:auth/login.spec.ts")
  ];
  return graphOf(nodes, edges, candidate_edges);
}

describe("structurallyUnconfirmable — e2e/api deferral (Phase 4.5)", () => {
  it("defers a flow whose only tests are e2e -> layer_e2e", () => {
    const nsc = structurallyUnconfirmable(fixture());
    expect(nsc.get("flow:e2e")).toBe("layer_e2e");
  });

  it("defers a flow whose only tests are api -> layer_api", () => {
    const nsc = structurallyUnconfirmable(fixture());
    expect(nsc.get("flow:api")).toBe("layer_api");
  });

  it("does NOT defer a unit-linked flow (it is inferred, a real candidate)", () => {
    const nsc = structurallyUnconfirmable(fixture());
    expect(nsc.has("flow:unit")).toBe(false);
  });

  it("hard coverage takes precedence over deferral (confirmed, never nsc)", () => {
    const nsc = structurallyUnconfirmable(fixture());
    expect(nsc.has("flow:confirmed")).toBe(false);
  });

  it("does NOT defer a flow with no linked test (it is a genuine 'none' gap)", () => {
    const nsc = structurallyUnconfirmable(fixture());
    expect(nsc.has("flow:lonely")).toBe(false);
  });
});

describe("findGaps — nsc behaviors are filtered out of the gap list (Phase 4.5)", () => {
  it("excludes e2e/api-only behaviors from gaps and reports the count", () => {
    const res = findGaps(fixture(), { limit: 50 });
    const gapIds = res.gaps.map((g) => g.external_id);
    expect(gapIds).not.toContain("flow:e2e");
    expect(gapIds).not.toContain("flow:api");
    // unit-linked + lonely flows remain real gaps
    expect(gapIds).toContain("flow:unit");
    expect(gapIds).toContain("flow:lonely");
    expect(res.not_structurally_confirmable).toBe(2);
    // every emitted GapItem stays 3-state (nsc never leaks into the gap API)
    for (const g of res.gaps) expect(["none", "weak", "covered"]).toContain(g.test_evidence);
  });
});
