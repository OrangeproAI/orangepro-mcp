import { describe, it, expect } from "vitest";

import { buildPack } from "../../src/local/pack/exporter.js";
import { validatePack, validatePackJson } from "../../src/local/pack/validate.js";
import { evidencePackSchema } from "../../src/local/pack/schema.js";
import { scoreGraph } from "../../src/local/score/score.js";
import { makeNode, makeEdge } from "../../src/local/graph/factories.js";
import {
  LOCAL_GRAPH_SCHEMA_VERSION,
  LocalGraph,
  Provenance,
  SourceScope,
  GenerationRun,
  GeneratedTest
} from "../../src/local/graph/ontology.js";

const FIXED_CLOCK = () => "2026-06-07T00:00:00Z";

const PROV: Provenance = {
  source_scope_id: "scope-1",
  source_ref: "payments-template.csv#row=2",
  detector: "template_detector"
};

const SOURCE: SourceScope = {
  source_scope_id: "scope-1",
  source_system: "manual_template",
  source_type: "customer_supplied",
  display_name: "Payments template",
  content_hash: "deadbeef",
  metadata: { rows: 2 }
};

/**
 * Build a small synthetic graph: a Requirement + AcceptanceCriterion + an edge
 * between them, plus one generation_run holding one generated_test.
 */
function buildSyntheticGraph(): LocalGraph {
  const requirement = makeNode({
    kind: "Requirement",
    external_id: "REQ-001",
    title: "Charge a card",
    properties: { priority: "high" },
    evidence_strength: "hard",
    review_status: "local_reviewed",
    confidence: 0.9,
    provenance: PROV
  });

  const ac = makeNode({
    kind: "AcceptanceCriterion",
    external_id: "AC-001",
    title: "Given a valid card, the charge succeeds",
    evidence_strength: "hard",
    review_status: "local_reviewed",
    confidence: 0.85,
    provenance: PROV
  });

  const edge = makeEdge({
    from_external_id: "REQ-001",
    to_external_id: "AC-001",
    relationship_type: "HAS_ACCEPTANCE_CRITERION",
    evidence_strength: "hard",
    review_status: "local_reviewed",
    provenance: PROV
  });

  const run: GenerationRun = {
    run_id: "run-1",
    model_provider: "deterministic",
    model_name: "offline-v0",
    input_mode: "graph_grounded",
    prompt_version: "v0",
    created_at: "2026-06-07T00:00:00Z",
    generated_test_ids: ["test-1"]
  };

  const test: GeneratedTest = {
    id: "test-1",
    run_id: "run-1",
    title: "charges a valid card",
    test_type: "integration",
    framework_hint: "vitest",
    body: "// test body",
    grounding: {
      entity_ids: ["REQ-001", "AC-001"],
      source_refs: ["payments-template.csv#row=2"],
      weak_relationships_used: []
    },
    weak_evidence_used: false
  };

  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: {
      name: "demo-workspace",
      root: "/tmp/demo",
      root_hash: "roothash123",
      source_upload_policy: "metadata_only"
    },
    created_at: "2026-06-07T00:00:00Z",
    updated_at: "2026-06-07T00:00:00Z",
    sources: [SOURCE],
    nodes: [requirement, ac],
    edges: [edge],
    candidate_edges: [],
    generation_runs: [run],
    generated_tests: [test],
    manifest: {
      generated_at: "2026-06-07T00:00:00Z",
      git: null,
      files: {}
    }
  };
}

describe("buildPack + validatePack", () => {
  it("produces a valid evidence pack from a synthetic graph", () => {
    const graph = buildSyntheticGraph();
    const pack = buildPack(graph, scoreGraph(graph), undefined, FIXED_CLOCK);

    const result = validatePack(pack);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("carries through the synthetic graph shape (sources/entities/relationships/runs)", () => {
    const graph = buildSyntheticGraph();
    const pack = buildPack(graph, scoreGraph(graph), undefined, FIXED_CLOCK);

    expect(pack.schema_version).toBe("orangepro.local_evidence_pack.v0");
    expect(pack.created_at).toBe("2026-06-07T00:00:00Z");
    expect(pack.sources).toHaveLength(1);
    expect(pack.entities).toHaveLength(2);
    expect(pack.relationships).toHaveLength(1);
    expect(pack.generation_runs).toHaveLength(1);
    expect(pack.generation_runs[0].generated_tests).toHaveLength(1);
    expect(pack.generation_runs[0].generated_tests[0].title).toBe("charges a valid card");
  });

  it("maps node kinds to snake_case entity_type (Requirement -> requirement, AcceptanceCriterion -> acceptance_criterion)", () => {
    const graph = buildSyntheticGraph();
    const pack = buildPack(graph, scoreGraph(graph), undefined, FIXED_CLOCK);

    const byExternalId = new Map(pack.entities.map((e) => [e.external_id, e]));
    expect(byExternalId.get("REQ-001")?.entity_type).toBe("requirement");
    expect(byExternalId.get("AC-001")?.entity_type).toBe("acceptance_criterion");
  });
});

describe("metadata-only export (generated test body is local-only by default)", () => {
  it("omits the generated test body unless include_generated_bodies is set", () => {
    const graph = buildSyntheticGraph();
    // A body can paraphrase fed test source — it must not cross the export boundary by default.
    graph.generated_tests[0].body = "function chargeCard(){ return secretAlgo(input) }";

    const off = buildPack(graph, scoreGraph(graph), undefined, FIXED_CLOCK);
    expect(off.generation_runs[0].generated_tests[0].body).not.toContain("secretAlgo");
    expect(JSON.stringify(off)).not.toContain("secretAlgo");
    expect(validatePack(off).valid).toBe(true);

    const on = buildPack(graph, scoreGraph(graph), { include_generated_bodies: true }, FIXED_CLOCK);
    expect(on.generation_runs[0].generated_tests[0].body).toContain("secretAlgo");
    expect(validatePack(on).valid).toBe(true);
  });
});

describe("IP boundary (strict schema rejects unknown keys)", () => {
  it("rejects an extra top-level key (e.g. internal scoring weights)", () => {
    const graph = buildSyntheticGraph();
    const pack = buildPack(graph, scoreGraph(graph), undefined, FIXED_CLOCK);

    // Inject something that would leak internal scoring weights — the IP boundary.
    const leaked = {
      ...pack,
      weights: { behavior_anchors: 0.22, acceptance_criteria: 0.2 }
    };

    const result = validatePack(leaked);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a banned key injected into a generation_run", () => {
    const graph = buildSyntheticGraph();
    const pack = buildPack(graph, scoreGraph(graph), undefined, FIXED_CLOCK);

    // Inject prompt text into a run — a banned key that must never cross the boundary.
    const tampered = {
      ...pack,
      generation_runs: pack.generation_runs.map((run, idx) =>
        idx === 0 ? { ...run, prompt_text: "SYSTEM: secret prompt template" } : run
      )
    };

    const result = validatePack(tampered);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("rejects a banned key injected into a generated_test", () => {
    const graph = buildSyntheticGraph();
    const pack = buildPack(graph, scoreGraph(graph), undefined, FIXED_CLOCK);

    const tampered = {
      ...pack,
      generation_runs: pack.generation_runs.map((run, idx) =>
        idx === 0
          ? {
              ...run,
              generated_tests: run.generated_tests.map((t, ti) =>
                ti === 0 ? { ...t, raw_source: "function charge() {}" } : t
              )
            }
          : run
      )
    };

    const result = validatePack(tampered);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("the strict schema directly rejects unknown keys (sanity check on evidencePackSchema)", () => {
    const graph = buildSyntheticGraph();
    const pack = buildPack(graph, scoreGraph(graph), undefined, FIXED_CLOCK);

    expect(evidencePackSchema.safeParse(pack).success).toBe(true);
    expect(evidencePackSchema.safeParse({ ...pack, extra: 1 }).success).toBe(false);
  });
});

describe("validatePackJson", () => {
  it("validates JSON.stringify(pack) as valid", () => {
    const graph = buildSyntheticGraph();
    const pack = buildPack(graph, scoreGraph(graph), undefined, FIXED_CLOCK);

    const result = validatePackJson(JSON.stringify(pack));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("rejects an unrelated JSON object with errors", () => {
    const result = validatePackJson('{"bad":true}');
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it("reports a JSON parse error on malformed input", () => {
    const result = validatePackJson("{not valid json");
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors[0]).toContain("invalid JSON");
  });
});
