import { describe, it, expect } from "vitest";
import {
  buildCitationIndex,
  validateEvidence,
  summarizeTestEvidence
} from "../../src/local/graph/citations.js";
import { makeNode } from "../../src/local/graph/factories.js";
import {
  LOCAL_GRAPH_SCHEMA_VERSION,
  LocalGraph,
  GraphNode,
  GeneratedTest,
  TestGrounding
} from "../../src/local/graph/ontology.js";

function provenance(sourceRef?: string) {
  return { source_scope_id: "scope-1", source_ref: sourceRef, detector: "test-fixture" };
}

function makeGraph(nodes: GraphNode[]): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "fixture", root: "/tmp/fixture", root_hash: "h", source_upload_policy: "metadata_only" },
    created_at: "2026-06-09T00:00:00Z",
    updated_at: "2026-06-09T00:00:00Z",
    sources: [],
    nodes,
    edges: [],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "2026-06-09T00:00:00Z", git: null, files: {} }
  };
}

const REQUIREMENT = makeNode({
  kind: "Requirement",
  external_id: "REQ-001",
  title: "Card payment is captured on confirm",
  properties: { priority: "high" },
  evidence_strength: "hard",
  review_status: "local_reviewed",
  confidence: 1,
  provenance: provenance("payments-template.csv#row=2")
});
const FILE = makeNode({
  kind: "File",
  external_id: "src/payments/card.ts",
  title: "card.ts",
  properties: { role: "code", file: "src/payments/card.ts" },
  evidence_strength: "hard",
  review_status: "auto_detected",
  confidence: 1,
  provenance: provenance("src/payments/card.ts")
});
const WEAK_FLOW = makeNode({
  kind: "UserFlow",
  external_id: "flow:refunds-refund",
  title: "Refund flow",
  properties: {},
  evidence_strength: "weak",
  review_status: "inferred",
  confidence: 0.35,
  provenance: provenance("src/refunds/refund.test.ts")
});

function grounding(entity_ids: string[]): TestGrounding {
  return { entity_ids, source_refs: [], weak_relationships_used: [] };
}

describe("validateEvidence", () => {
  it("resolves a real cited id with kind, strength, and source_ref", () => {
    const index = buildCitationIndex(makeGraph([REQUIREMENT, FILE]));
    const v = validateEvidence(index, grounding(["REQ-001"]));
    expect(v.evidence).toHaveLength(1);
    const cited = v.evidence[0];
    expect(cited.validated).toBe(true);
    expect(cited.kind).toBe("Requirement");
    expect(cited.evidence_strength).toBe("hard");
    expect(cited.source_ref).toBe("payments-template.csv#row=2");
    expect(v.validated_count).toBe(1);
    expect(v.invalid_count).toBe(0);
    expect(v.proof_count).toBe(1);
    expect(v.has_proof).toBe(true);
  });

  it("flags a cited id that does not resolve to any graph node", () => {
    const index = buildCitationIndex(makeGraph([REQUIREMENT]));
    const v = validateEvidence(index, grounding(["REQ-001", "GHOST-999"]));
    expect(v.validated_count).toBe(1);
    expect(v.invalid_count).toBe(1);
    const ghost = v.evidence.find((e) => e.evidence_id === "GHOST-999")!;
    expect(ghost.validated).toBe(false);
    expect(ghost.kind).toBe("unknown");
    expect(ghost.evidence_strength).toBe("unknown");
    expect(ghost.source_ref).toBeUndefined();
  });

  it("counts weak-only citations as validated but NOT proof", () => {
    const index = buildCitationIndex(makeGraph([WEAK_FLOW]));
    const v = validateEvidence(index, grounding(["flow:refunds-refund"]));
    expect(v.validated_count).toBe(1);
    expect(v.proof_count).toBe(0);
    expect(v.has_proof).toBe(false);
    expect(v.evidence[0].evidence_strength).toBe("weak");
  });

  it("treats a weak anchor + a hard file as proof (at least one hard/reviewed)", () => {
    const index = buildCitationIndex(makeGraph([WEAK_FLOW, FILE]));
    const v = validateEvidence(index, grounding(["flow:refunds-refund", "src/payments/card.ts"]));
    expect(v.validated_count).toBe(2);
    expect(v.proof_count).toBe(1);
    expect(v.has_proof).toBe(true);
  });

  it("returns all-zero, no-proof for empty grounding", () => {
    const index = buildCitationIndex(makeGraph([REQUIREMENT]));
    const v = validateEvidence(index, grounding([]));
    expect(v.evidence).toHaveLength(0);
    expect(v.validated_count).toBe(0);
    expect(v.invalid_count).toBe(0);
    expect(v.has_proof).toBe(false);
  });
});

describe("buildCitationIndex", () => {
  it("resolves first-match on duplicate external_ids (mirrors findNode)", () => {
    const dupeA = { ...REQUIREMENT, title: "first" };
    const dupeB = { ...REQUIREMENT, title: "second" };
    const index = buildCitationIndex(makeGraph([dupeA, dupeB]));
    const v = validateEvidence(index, grounding(["REQ-001"]));
    expect(v.evidence[0].title).toBe("first");
  });
});

describe("summarizeTestEvidence", () => {
  function genTest(id: string, entity_ids: string[]): GeneratedTest {
    return {
      id,
      run_id: "run-1",
      title: `test ${id}`,
      test_type: "unit",
      framework_hint: "vitest",
      body: "// test",
      grounding: grounding(entity_ids),
      weak_evidence_used: false
    };
  }

  it("rolls up per-test validation into a summary", () => {
    const graph = makeGraph([REQUIREMENT, FILE, WEAK_FLOW]);
    const tests = [
      genTest("t1", ["REQ-001", "src/payments/card.ts"]), // proof
      genTest("t2", ["flow:refunds-refund"]), // validated, no proof
      genTest("t3", ["GHOST-1"]), // no validated evidence at all
      genTest("t4", []) // empty
    ];
    const { per_test, summary } = summarizeTestEvidence(graph, tests);
    expect(per_test).toHaveLength(4);
    expect(summary.tests).toBe(4);
    expect(summary.tests_with_proof).toBe(1);
    // t3 (ghost only) and t4 (empty) have zero validated citations.
    expect(summary.tests_without_validated_evidence).toBe(2);
    expect(summary.invalid_citations).toBe(1); // only GHOST-1
  });
});
