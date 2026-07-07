import { describe, it, expect } from "vitest";
import { selectTargets } from "../../src/local/generate/generator.js";
import { makeNode, makeCandidateEdge } from "../../src/local/graph/factories.js";
import { GraphNode, LocalGraph, CandidateEdge, LOCAL_GRAPH_SCHEMA_VERSION } from "../../src/local/graph/ontology.js";

const prov = { source_scope_id: "t" };

function graphOf(nodes: GraphNode[], candidate_edges: CandidateEdge[]): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "t", root: "/tmp/t", root_hash: "sha256:x", source_upload_policy: "metadata_only" },
    created_at: "",
    updated_at: "",
    sources: [],
    nodes,
    edges: [],
    candidate_edges,
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "", git: null, files: {} }
  };
}

function flow(id: string, priority: string): GraphNode {
  return makeNode({
    kind: "UserFlow",
    external_id: id,
    title: id,
    properties: { area: "a", example_behaviors: ["b"], priority },
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

describe("selectTargets — nsc ranking + labeling (Phase 4.7)", () => {
  // A CRITICAL-priority nsc behavior (only e2e tests) vs a LOW-priority
  // structurally-confirmable gap (a unit test). The confirmable gap must rank
  // ABOVE the nsc behavior despite the lower priority.
  function fixture(): LocalGraph {
    return graphOf(
      [
        flow("flow:e2e-critical", "critical"),
        flow("flow:unit-low", "low"),
        testCase("test:e2e/checkout.spec.ts", "e2e"),
        testCase("test:unit/math.test.ts", "unit")
      ],
      [
        mayBeTestedBy("flow:e2e-critical", "test:e2e/checkout.spec.ts"),
        mayBeTestedBy("flow:unit-low", "test:unit/math.test.ts")
      ]
    );
  }

  it("a confirmable gap ranks ABOVE an nsc behavior even when the nsc one has higher priority", () => {
    const { targets } = selectTargets(fixture(), {});
    const ids = targets.map((t) => t.external_id);
    expect(ids.indexOf("flow:unit-low")).toBeLessThan(ids.indexOf("flow:e2e-critical"));
  });

  it("still OFFERS the nsc behavior as a target (not dropped), but labels it via nsc_ids", () => {
    const out = selectTargets(fixture(), {});
    expect(out.targets.map((t) => t.external_id)).toContain("flow:e2e-critical");
    expect(out.nsc_ids).toContain("flow:e2e-critical");
    expect(out.nsc_ids).not.toContain("flow:unit-low");
    expect(out.warnings.join(" ")).toMatch(/not structurally confirmable/i);
  });

  it("explicit target_ids still labels nsc selections", () => {
    const out = selectTargets(fixture(), { target_ids: ["flow:e2e-critical", "flow:unit-low"] });
    expect(out.nsc_ids).toEqual(["flow:e2e-critical"]);
  });
});
