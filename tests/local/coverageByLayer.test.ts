import { describe, it, expect } from "vitest";
import { confirmedCoverageByLayer } from "../../src/local/score/coverage.js";
import { GraphEdge, GraphNode, LocalGraph } from "../../src/local/graph/ontology.js";

// Minimal node/edge builders for a synthetic graph (only the fields the metric reads).
let seq = 0;
function sym(id: string): GraphNode {
  return {
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
  } as unknown as GraphNode;
}
function req(id: string): GraphNode {
  return {
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
  } as unknown as GraphNode;
}
function testNode(id: string, layer?: string): GraphNode {
  return {
    external_id: id,
    kind: "TestCase",
    title: id,
    confidence: 1,
    evidence_strength: "hard",
    review_status: "auto_detected",
    properties: layer ? { test_layer: layer } : {},
    provenance: { source_ref: `${id}.ts` }
  } as unknown as GraphNode;
}
function tested(behavior: string, test: string): GraphEdge {
  return {
    external_id: `e${seq++}`,
    from_external_id: behavior,
    to_external_id: test,
    relationship_type: "TESTED_BY",
    evidence_strength: "hard",
    review_status: "auto_detected",
    properties: {}
  } as unknown as GraphEdge;
}
const graph = (nodes: GraphNode[], edges: GraphEdge[]): Pick<LocalGraph, "nodes" | "edges"> => ({ nodes, edges });

describe("confirmedCoverageByLayer (Phase 5.1)", () => {
  it("computes confirmed over the denominator (CodeSymbols + Requirements), not UserFlows", () => {
    const nodes = [sym("sym:a"), sym("sym:b"), req("req:c"), testNode("test:a", "unit")];
    const edges = [tested("sym:a", "test:a")];
    const r = confirmedCoverageByLayer(graph(nodes, edges));
    expect(r.total_behaviors).toBe(3); // 2 symbols + 1 requirement
    expect(r.confirmed).toBe(1); // only sym:a has a hard edge
    expect(r.confirmed_pct).toBeCloseTo(33.3, 1);
    expect(r.by_layer.unit).toBe(1);
  });

  it("splits confirmed by layer and keeps e2e/api separate from unit", () => {
    const nodes = [
      sym("sym:u"),
      sym("sym:e"),
      sym("sym:a"),
      testNode("test:u", "unit"),
      testNode("test:e", "e2e"),
      testNode("test:api", "api")
    ];
    const edges = [tested("sym:u", "test:u"), tested("sym:e", "test:e"), tested("sym:a", "test:api")];
    const r = confirmedCoverageByLayer(graph(nodes, edges));
    expect(r.confirmed).toBe(3);
    expect(r.by_layer.unit).toBe(1);
    expect(r.by_layer.e2e).toBe(1);
    expect(r.by_layer.api).toBe(1);
    // by_layer partitions confirmed (sums to it)
    expect(Object.values(r.by_layer).reduce((a, b) => a + b, 0)).toBe(r.confirmed);
  });

  it("picks the most-specific structural layer when a behavior is confirmed at multiple layers", () => {
    const nodes = [sym("sym:x"), testNode("test:u", "unit"), testNode("test:e", "e2e")];
    const edges = [tested("sym:x", "test:u"), tested("sym:x", "test:e")];
    const r = confirmedCoverageByLayer(graph(nodes, edges));
    expect(r.confirmed).toBe(1); // counted once
    expect(r.by_layer.unit).toBe(1); // unit beats e2e
    expect(r.by_layer.e2e).toBe(0);
  });

  it("buckets a confirmed behavior with no resolvable test layer as unknown", () => {
    const nodes = [sym("sym:x"), testNode("test:n")]; // test has no test_layer
    const edges = [tested("sym:x", "test:n")];
    const r = confirmedCoverageByLayer(graph(nodes, edges));
    expect(r.confirmed).toBe(1);
    expect(r.unknown_count).toBe(1);
    expect(r.unknown_pct).toBeCloseTo(100, 1);
  });

  it("returns zeros for an empty denominator without dividing by zero", () => {
    const r = confirmedCoverageByLayer(graph([testNode("test:u", "unit")], []));
    expect(r.total_behaviors).toBe(0);
    expect(r.confirmed).toBe(0);
    expect(r.confirmed_pct).toBe(0);
    expect(r.unknown_pct).toBe(0);
  });

  it("counts ONLY hard edges — a reviewed/weak TESTED_BY does not confirm (Codex finding 3)", () => {
    const nodes = [sym("sym:x"), testNode("test:x", "unit")];
    const reviewedEdge = {
      external_id: "er",
      from_external_id: "sym:x",
      to_external_id: "test:x",
      relationship_type: "TESTED_BY",
      evidence_strength: "reviewed",
      review_status: "auto_detected",
      properties: {}
    } as unknown as GraphEdge;
    const r = confirmedCoverageByLayer(graph(nodes, [reviewedEdge]));
    expect(r.confirmed).toBe(0);
    expect(r.by_layer.unit).toBe(0);
  });
});
