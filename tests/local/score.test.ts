import { describe, expect, it } from "vitest";
import { scoreGraph } from "../../src/local/score/score.js";
import { doctorGraph } from "../../src/local/score/doctor.js";
import { makeNode, makeEdge } from "../../src/local/graph/factories.js";
import {
  LOCAL_GRAPH_SCHEMA_VERSION,
  LocalGraph,
  GraphNode,
  GraphEdge,
  Provenance
} from "../../src/local/graph/ontology.js";

const SCOPE = "scope-1";

function provenance(ref?: string): Provenance {
  return { source_scope_id: SCOPE, source_ref: ref };
}

/** Minimal LocalGraph literal with empty arrays + a stub manifest. */
function emptyGraph(): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: {
      name: "fixture",
      root: "/tmp/fixture",
      root_hash: "roothash",
      source_upload_policy: "metadata_only"
    },
    created_at: "",
    updated_at: "",
    sources: [],
    nodes: [],
    edges: [],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "", git: null, files: {} }
  };
}

function graphWith(nodes: GraphNode[], edges: GraphEdge[] = []): LocalGraph {
  return { ...emptyGraph(), nodes, edges };
}

/** A code-only graph: one File node, no behaviors, no acceptance, no tests. */
function codeOnlyGraph(): LocalGraph {
  return graphWith([
    makeNode({
      kind: "File",
      external_id: "src/payments/card.ts",
      title: "card.ts",
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/payments/card.ts")
    })
  ]);
}

/** A richer graph: Requirement + AcceptanceCriterion + TestCase, fully wired. */
function richGraph(): LocalGraph {
  const nodes: GraphNode[] = [
    makeNode({
      kind: "Requirement",
      external_id: "REQ-001",
      title: "Charge a card",
      evidence_strength: "hard",
      review_status: "local_reviewed",
      confidence: 1,
      provenance: provenance("payments-template.csv#row=2")
    }),
    makeNode({
      kind: "AcceptanceCriterion",
      external_id: "AC-001",
      title: "Declined cards return a 402",
      evidence_strength: "hard",
      review_status: "local_reviewed",
      confidence: 1,
      provenance: provenance("payments-template.csv#row=2")
    }),
    makeNode({
      kind: "TestCase",
      external_id: "TC-001",
      title: "charges a valid card",
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("tests/payments.test.ts")
    })
  ];
  const edges: GraphEdge[] = [
    makeEdge({
      from_external_id: "REQ-001",
      to_external_id: "AC-001",
      relationship_type: "HAS_ACCEPTANCE_CRITERION",
      evidence_strength: "hard",
      review_status: "local_reviewed",
      provenance: provenance("payments-template.csv#row=2")
    }),
    makeEdge({
      from_external_id: "REQ-001",
      to_external_id: "TC-001",
      relationship_type: "TESTED_BY",
      evidence_strength: "hard",
      review_status: "auto_detected",
      provenance: provenance("tests/payments.test.ts")
    })
  ];
  return graphWith(nodes, edges);
}

describe("scoreGraph", () => {
  it("scores an empty graph low with non-empty missing_evidence", () => {
    const result = scoreGraph(emptyGraph());
    expect(result.overall).toBeLessThan(40);
    expect(["thin", "usable"]).toContain(result.band);
    expect(result.missing_evidence.length).toBeGreaterThan(0);
  });

  it("scores a code-only graph low (thin or usable)", () => {
    const result = scoreGraph(codeOnlyGraph());
    expect(["thin", "usable"]).toContain(result.band);
    expect(result.missing_evidence.length).toBeGreaterThan(0);
  });

  it("scores a requirement+AC+test graph higher than the empty one", () => {
    const empty = scoreGraph(emptyGraph());
    const rich = scoreGraph(richGraph());
    expect(rich.overall).toBeGreaterThan(empty.overall);
  });

  it("keeps every breakdown dimension within 0..1 and overall within 0..100", () => {
    for (const graph of [emptyGraph(), codeOnlyGraph(), richGraph()]) {
      const result = scoreGraph(graph);
      expect(result.overall).toBeGreaterThanOrEqual(0);
      expect(result.overall).toBeLessThanOrEqual(100);
      for (const value of Object.values(result.breakdown)) {
        expect(value).toBeGreaterThanOrEqual(0);
        expect(value).toBeLessThanOrEqual(1);
      }
    }
  });

  it("reports high provenance when every node carries a source_ref", () => {
    const result = scoreGraph(richGraph());
    // All three nodes in richGraph carry provenance.source_ref → provenance == 1.
    expect(result.breakdown.provenance).toBe(1);
  });

  it("reports low provenance when nodes lack a source_ref", () => {
    const node = makeNode({
      kind: "Requirement",
      external_id: "REQ-NO-REF",
      title: "No source ref",
      evidence_strength: "hard",
      review_status: "inferred",
      confidence: 0.5,
      provenance: provenance() // no source_ref
    });
    const result = scoreGraph(graphWith([node]));
    expect(result.breakdown.provenance).toBe(0);
  });

  it("raises acceptance_criteria and validation_evidence in the rich graph", () => {
    const empty = scoreGraph(emptyGraph());
    const rich = scoreGraph(richGraph());
    expect(rich.breakdown.acceptance_criteria).toBeGreaterThan(empty.breakdown.acceptance_criteria);
    expect(rich.breakdown.validation_evidence).toBeGreaterThan(empty.breakdown.validation_evidence);
  });
});

describe("doctorGraph", () => {
  it("returns prioritized recommendations for a thin graph", () => {
    const score = scoreGraph(emptyGraph());
    const result = doctorGraph(emptyGraph(), score);
    expect(result.recommendations.length).toBeGreaterThan(0);
    // Priorities are 1-based and sequential after ranking.
    const priorities = result.recommendations.map((r) => r.priority);
    expect(priorities).toEqual(priorities.map((_, i) => i + 1));
    for (const rec of result.recommendations) {
      expect(rec.action.length).toBeGreaterThan(0);
      expect(rec.why.length).toBeGreaterThan(0);
      expect(rec.expected_score_impact.length).toBeGreaterThan(0);
    }
  });

  it("blocks continue-without-recommendations when overall < 40", () => {
    const score = scoreGraph(emptyGraph());
    expect(score.overall).toBeLessThan(40);
    const result = doctorGraph(emptyGraph(), score);
    expect(result.can_continue_without_recommendations).toBe(false);
    expect(result.can_continue_without_recommendations).toBe(score.overall >= 40);
    expect(result.status).toBe(score.band);
  });

  it("mirrors overall >= 40 in can_continue_without_recommendations", () => {
    const graph = richGraph();
    const score = scoreGraph(graph);
    const result = doctorGraph(graph, score);
    expect(result.can_continue_without_recommendations).toBe(score.overall >= 40);
  });

  it("caps recommendations at four", () => {
    const score = scoreGraph(emptyGraph());
    const result = doctorGraph(emptyGraph(), score);
    expect(result.recommendations.length).toBeLessThanOrEqual(4);
  });
});
