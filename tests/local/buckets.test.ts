import { describe, it, expect } from "vitest";

import { selectLocalBuckets, deriveBucketSignals, BucketSignals } from "../../src/local/generate/buckets.js";
import { generateTests } from "../../src/local/generate/generator.js";
import { DeterministicProvider } from "../../src/local/generate/providers.js";
import { buildPack } from "../../src/local/pack/exporter.js";
import { validatePack } from "../../src/local/pack/validate.js";
import { packToMarkdown } from "../../src/local/pack/summary.js";
import { scoreGraph } from "../../src/local/score/score.js";
import { buildVizPayload } from "../../src/local/viz/payload.js";
import { renderVizHtml } from "../../src/local/viz/html.js";
import { makeNode, makeEdge } from "../../src/local/graph/factories.js";
import {
  LOCAL_GRAPH_SCHEMA_VERSION,
  LocalGraph,
  GraphNode,
  GraphEdge,
  GeneratedTest,
  GenerationRun
} from "../../src/local/graph/ontology.js";

const CLOCK = () => "2026-06-07T00:00:00Z";
const prov = (ref: string) => ({ source_scope_id: "scope-1", source_ref: ref, detector: "test-fixture" });

const ALL_TRUE: BucketSignals = {
  hasExpectedBehavior: true,
  hasValidationEvidence: true,
  hasEdgeEvidence: true,
  hasIntegrationEvidence: true,
  hasSecurityEvidence: true,
  hasRegressionEvidence: true
};
const only = (over: Partial<BucketSignals>): BucketSignals => ({
  hasExpectedBehavior: false,
  hasValidationEvidence: false,
  hasEdgeEvidence: false,
  hasIntegrationEvidence: false,
  hasSecurityEvidence: false,
  hasRegressionEvidence: false,
  ...over
});

// ── selectLocalBuckets (pure) ──────────────────────────────────────────
describe("selectLocalBuckets", () => {
  it("default run (limit 3) selects up to 3 local buckets", () => {
    const buckets = selectLocalBuckets(ALL_TRUE, 3);
    expect(buckets).toHaveLength(3);
    expect(buckets[0]).toBe("happy_path");
    // 3-run prefers breadth: happy + (validation|edge) + (integration|regression).
    expect(buckets).toEqual(["happy_path", "validation_error", "integration_flow"]);
    expect(new Set(buckets).size).toBe(3); // no duplicates
  });

  it("limit 5 selects up to 5 local buckets", () => {
    const buckets = selectLocalBuckets(ALL_TRUE, 5);
    expect(buckets).toHaveLength(5);
    expect(buckets).toEqual([
      "happy_path",
      "validation_error",
      "edge_case",
      "integration_flow",
      "security_privacy"
    ]);
  });

  it("security evidence selects security_privacy", () => {
    const buckets = selectLocalBuckets(only({ hasExpectedBehavior: true, hasSecurityEvidence: true }), 5);
    expect(buckets).toContain("security_privacy");
  });

  it("validation/error evidence selects validation_error", () => {
    const buckets = selectLocalBuckets(only({ hasExpectedBehavior: true, hasValidationEvidence: true }), 3);
    expect(buckets).toContain("validation_error");
  });

  it("route/API/workflow evidence selects integration_flow", () => {
    const buckets = selectLocalBuckets(only({ hasExpectedBehavior: true, hasIntegrationEvidence: true }), 3);
    expect(buckets).toContain("integration_flow");
  });

  it("does not pad: unjustified buckets are skipped, never filled", () => {
    expect(selectLocalBuckets(only({ hasExpectedBehavior: true }), 5)).toEqual(["happy_path"]);
    // No evidence at all -> nothing (caller treats this as too-thin).
    expect(selectLocalBuckets(only({}), 5)).toEqual([]);
  });

  it("clamps the limit to 1..5", () => {
    expect(selectLocalBuckets(ALL_TRUE, 99)).toHaveLength(5);
    expect(selectLocalBuckets(ALL_TRUE, 0)).toEqual(["happy_path"]);
  });
});

// ── deriveBucketSignals (keyword + structural heuristics) ───────────────
describe("deriveBucketSignals", () => {
  const ev = (corpus: string, over: Partial<Parameters<typeof deriveBucketSignals>[0]> = {}) =>
    deriveBucketSignals({
      corpus,
      relatedFiles: 0,
      workflowSteps: 0,
      testNames: 0,
      hasTestableAnchor: true,
      inferredFromTests: false,
      ...over
    });

  it("flags security from auth/token/permission language", () => {
    expect(ev("requires an authenticated session token").hasSecurityEvidence).toBe(true);
    expect(ev("checks user roles and access control").hasSecurityEvidence).toBe(true);
    expect(ev("computes a sum").hasSecurityEvidence).toBe(false);
  });

  it("flags validation from invalid/reject/required language", () => {
    expect(ev("rejects invalid card numbers").hasValidationEvidence).toBe(true);
    expect(ev("required fields must be present").hasValidationEvidence).toBe(true);
  });

  it("flags integration from routes/endpoints/services or multiple files", () => {
    expect(ev("POST /api/checkout endpoint").hasIntegrationEvidence).toBe(true);
    expect(ev("just a pure function", { relatedFiles: 2 }).hasIntegrationEvidence).toBe(true);
    expect(ev("just a pure function", { workflowSteps: 3 }).hasIntegrationEvidence).toBe(true);
  });

  it("flags edge cases from empty/null/boundary/timeout language", () => {
    expect(ev("handles an empty cart and null values").hasEdgeEvidence).toBe(true);
  });

  it("flags regression from existing test names or inferred-from-tests anchors", () => {
    expect(ev("no keywords", { testNames: 2 }).hasRegressionEvidence).toBe(true);
    expect(ev("no keywords", { inferredFromTests: true }).hasRegressionEvidence).toBe(true);
    expect(ev("no keywords").hasRegressionEvidence).toBe(false);
  });
});

// ── generation integration ─────────────────────────────────────────────
interface GraphParts {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  generation_runs?: GenerationRun[];
  generated_tests?: GeneratedTest[];
}
function makeGraph(parts: GraphParts): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "fixture", root: "/tmp/fixture", root_hash: "h", source_upload_policy: "metadata_only" },
    created_at: "2026-06-07T00:00:00Z",
    updated_at: "2026-06-07T00:00:00Z",
    sources: [],
    nodes: parts.nodes ?? [],
    edges: parts.edges ?? [],
    candidate_edges: [],
    generation_runs: parts.generation_runs ?? [],
    generated_tests: parts.generated_tests ?? [],
    manifest: { generated_at: "2026-06-07T00:00:00Z", git: null, files: {} }
  };
}

/** A behavior whose acceptance criteria justify several buckets. */
function richGraph(acTexts: string[]): LocalGraph {
  const req = makeNode({
    kind: "Requirement",
    external_id: "REQ-RICH",
    title: "Checkout a cart",
    properties: { priority: "high", area: "checkout" },
    evidence_strength: "hard",
    review_status: "local_reviewed",
    confidence: 1,
    provenance: prov("template.csv#row=1")
  });
  const nodes: GraphNode[] = [req];
  const edges: GraphEdge[] = [];
  acTexts.forEach((text, i) => {
    const acId = `AC-${i}`;
    nodes.push(
      makeNode({
        kind: "AcceptanceCriterion",
        external_id: acId,
        title: text,
        properties: { text },
        evidence_strength: "hard",
        review_status: "local_reviewed",
        confidence: 1,
        provenance: prov(`template.csv#row=1`)
      })
    );
    edges.push(
      makeEdge({
        from_external_id: "REQ-RICH",
        to_external_id: acId,
        relationship_type: "HAS_ACCEPTANCE_CRITERION",
        evidence_strength: "hard",
        review_status: "local_reviewed",
        provenance: prov("template.csv#row=1")
      })
    );
  });
  const file = makeNode({
    kind: "File",
    external_id: "src/checkout/checkout.ts",
    title: "checkout.ts",
    properties: { role: "code", file: "src/checkout/checkout.ts" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: prov("src/checkout/checkout.ts")
  });
  nodes.push(file);
  edges.push(
    makeEdge({
      from_external_id: "REQ-RICH",
      to_external_id: "src/checkout/checkout.ts",
      relationship_type: "IMPLEMENTED_IN",
      evidence_strength: "hard",
      review_status: "auto_detected",
      provenance: prov("src/checkout/checkout.ts")
    })
  );
  return makeGraph({ nodes, edges });
}

describe("generateTests — local bucket diversity", () => {
  it("produces bucket-diverse, labeled tests for one target (limit 5)", async () => {
    const graph = richGraph([
      "A valid card is charged and returns a transaction id",
      "Invalid card numbers are rejected with a validation error",
      "An empty cart cannot be checked out",
      "POST /api/checkout endpoint integrates the payment service",
      "Requires an authenticated session token"
    ]);
    const result = await generateTests(graph, { limit: 5 }, new DeterministicProvider(), () => null, CLOCK);

    expect(result.generated_tests.length).toBeGreaterThanOrEqual(4);
    expect(result.generated_tests.length).toBeLessThanOrEqual(5);
    // Every test carries a bucket label, and they are distinct (no padding/dupes).
    const buckets = result.generated_tests.map((t) => t.bucket);
    expect(buckets.every(Boolean)).toBe(true);
    expect(new Set(buckets).size).toBe(buckets.length);
    expect(buckets).toContain("happy_path");
    expect(buckets).toContain("security_privacy");
    // Titles surface the bucket; all tests stay grounded on the one target.
    for (const t of result.generated_tests) {
      expect(t.title).toContain("—");
      expect(t.grounding.entity_ids).toContain("REQ-RICH");
    }
  });

  it("default limit (omitted) caps at 3 bucket-diverse tests, happy_path first", async () => {
    const graph = richGraph([
      "A valid card is charged and returns a transaction id",
      "Invalid card numbers are rejected with a validation error",
      "An empty cart cannot be checked out",
      "POST /api/checkout endpoint integrates the payment service",
      "Requires an authenticated session token"
    ]);
    const result = await generateTests(graph, {}, new DeterministicProvider(), () => null, CLOCK);
    expect(result.generated_tests.length).toBeGreaterThanOrEqual(1);
    expect(result.generated_tests.length).toBeLessThanOrEqual(3);
    expect(result.generated_tests[0].bucket).toBe("happy_path");
  });

  it("does not pad: a behavior with only happy-path evidence yields a single test", async () => {
    const graph = richGraph(["A successful run returns a result"]);
    const result = await generateTests(graph, { limit: 5 }, new DeterministicProvider(), () => null, CLOCK);
    expect(result.generated_tests).toHaveLength(1);
    expect(result.generated_tests[0].bucket).toBe("happy_path");
  });

  it("splits the budget across multiple explicit targets (each gets >=1 test)", async () => {
    // Two rich targets; budget 4 should cover both, with extra slots diversified.
    const base = richGraph(["A valid card is charged and returns a transaction id", "Invalid input is rejected"]);
    const req2 = makeNode({
      kind: "Requirement",
      external_id: "REQ-TWO",
      title: "Refund a charge",
      properties: { priority: "high", area: "refunds" },
      evidence_strength: "hard",
      review_status: "local_reviewed",
      confidence: 1,
      provenance: prov("template.csv#row=2")
    });
    const ac2 = makeNode({
      kind: "AcceptanceCriterion",
      external_id: "AC-TWO",
      title: "A refund returns the money for a valid charge",
      properties: { text: "A refund returns the money for a valid charge" },
      evidence_strength: "hard",
      review_status: "local_reviewed",
      confidence: 1,
      provenance: prov("template.csv#row=2")
    });
    const graph = makeGraph({
      nodes: [...base.nodes, req2, ac2],
      edges: [
        ...base.edges,
        makeEdge({
          from_external_id: "REQ-TWO",
          to_external_id: "AC-TWO",
          relationship_type: "HAS_ACCEPTANCE_CRITERION",
          evidence_strength: "hard",
          review_status: "local_reviewed",
          provenance: prov("template.csv#row=2")
        })
      ]
    });
    const result = await generateTests(
      graph,
      { target_ids: ["REQ-RICH", "REQ-TWO"], limit: 4 },
      new DeterministicProvider(),
      () => null,
      CLOCK
    );
    const targets = new Set(result.generated_tests.flatMap((t) => t.grounding.entity_ids).filter((id) => id.startsWith("REQ-")));
    expect(targets.has("REQ-RICH")).toBe(true);
    expect(targets.has("REQ-TWO")).toBe(true);
    expect(result.generated_tests.length).toBeLessThanOrEqual(4);
  });
});

// ── export: metadata-only + safe bucket labels + backward compatibility ──
function bucketedGraph(withBucket: boolean): LocalGraph {
  const req = makeNode({
    kind: "Requirement",
    external_id: "REQ-EXP",
    title: "Charge a card",
    properties: { priority: "high", acceptance_criteria: ["A valid card succeeds"] },
    evidence_strength: "hard",
    review_status: "local_reviewed",
    confidence: 0.9,
    provenance: prov("REQ-EXP")
  });
  const run: GenerationRun = {
    run_id: "run-1",
    model_provider: "deterministic",
    model_name: "orangepro-local-deterministic-v0",
    input_mode: "graph_grounded",
    prompt_version: "orangepro.local.testgen.v0",
    created_at: "2026-06-07T00:00:00Z",
    generated_test_ids: ["t1"]
  };
  const test: GeneratedTest = {
    id: "t1",
    run_id: "run-1",
    title: "charges a valid card — happy path",
    test_type: "unit",
    framework_hint: "vitest",
    body: "it('charges', () => { expect(charge()).toBeTruthy() })",
    grounding: { entity_ids: ["REQ-EXP"], source_refs: ["REQ-EXP"], weak_relationships_used: [] },
    weak_evidence_used: false,
    ...(withBucket ? { bucket: "happy_path" as const } : {})
  };
  return makeGraph({ nodes: [req], generation_runs: [run], generated_tests: [test] });
}

describe("bucket export — metadata-only + backward compatible", () => {
  it("evidence pack includes the safe bucket label and still validates", () => {
    const graph = bucketedGraph(true);
    const pack = buildPack(graph, scoreGraph(graph));
    const packTest = pack.generation_runs[0].generated_tests[0];
    expect(packTest.bucket).toBe("happy_path");
    // Default export stays metadata-only: the body is omitted.
    expect(packTest.body).not.toContain("expect(charge()");
    expect(validatePack(pack).valid).toBe(true);
    // Markdown summary surfaces the bucket label.
    expect(packToMarkdown(pack)).toContain("Local bucket: happy_path");
    // Graph HTML carries the bucket tally, no raw source.
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));
    expect(html).toContain("happy_path");
    expect(html).not.toContain("expect(charge()");
  });

  it("packs/graphs WITHOUT bucket metadata still validate and render", () => {
    const graph = bucketedGraph(false);
    const pack = buildPack(graph, scoreGraph(graph));
    expect(pack.generation_runs[0].generated_tests[0].bucket).toBeUndefined();
    expect(validatePack(pack).valid).toBe(true);
    expect(() => packToMarkdown(pack)).not.toThrow();
    const payload = buildVizPayload(graph, scoreGraph(graph));
    expect(payload.meta.generated.byBucket).toEqual([]);
    expect(() => renderVizHtml(payload)).not.toThrow();
  });
});
