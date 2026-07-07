import { describe, it, expect } from "vitest";

import { buildPack } from "../../src/local/pack/exporter.js";
import { validatePack } from "../../src/local/pack/validate.js";
import { scoreGraph } from "../../src/local/score/score.js";
import { buildVizPayload } from "../../src/local/viz/payload.js";
import { renderVizHtml } from "../../src/local/viz/html.js";
import { makeNode } from "../../src/local/graph/factories.js";
import {
  LOCAL_GRAPH_SCHEMA_VERSION,
  LocalGraph,
  GeneratedTest,
  GenerationRun
} from "../../src/local/graph/ontology.js";

/**
 * Export privacy gate (CI).
 *
 * The shareable artifacts — the evidence pack and the offline graph HTML — must
 * never carry: secrets, raw source, model-prompt text, or internal scoring
 * weights. The one free-text field that could carry such content is a generated
 * test `body` (model output), so we seed a body with all four and assert the
 * default export strips them. (The end-to-end `scripts/smoke-local.mjs` guards
 * the analyzer/enricher path — node properties are intentionally included as
 * secret-redacted reviewed metadata.)
 */
const SECRET = "sk-PRIVACYGATE-must-not-ship-7777";
// A real OpenAI-key-shaped secret placed directly in a node PROPERTY (the one
// field that survives into the pack) — the export boundary must scrub it.
const PROP_SECRET = "sk-AAAA1111BBBB2222CCCC3333DDDD";
const SOURCE = "function proprietaryAlgo(x){ return x * 1.337 }";
const PROMPT = "You are OrangePro's local test-generation assistant";
// Internal identifiers that must never appear in a shipped artifact.
const INTERNALS = ["buildGroundedUserPrompt", "buildSystemPrompt", "buildRawUserPrompt", "sanitizeGeneratedBody", "WEIGHTS"];

function graphWithSensitiveBody(): LocalGraph {
  const requirement = makeNode({
    kind: "Requirement",
    external_id: "REQ-1",
    title: "Charge a card",
    properties: {
      priority: "high",
      acceptance_criteria: ["A valid card succeeds"],
      internal_note: `deploy creds ${PROP_SECRET}`
    },
    evidence_strength: "hard",
    review_status: "local_reviewed",
    confidence: 0.9,
    provenance: { source_scope_id: "scope-1", source_ref: "REQ-1" }
  });
  const run: GenerationRun = {
    run_id: "run-1",
    model_provider: "openai",
    model_name: "gpt-4.1-mini",
    input_mode: "graph_grounded",
    prompt_version: "orangepro.local.testgen.v0", // allowed metadata label
    created_at: "2026-06-07T00:00:00Z",
    generated_test_ids: ["t1"]
  };
  const test: GeneratedTest = {
    id: "t1",
    run_id: "run-1",
    title: "charges a valid card",
    test_type: "unit",
    framework_hint: "vitest",
    body: `${SOURCE}\n// leaked secret ${SECRET}\n// ${PROMPT}`,
    grounding: { entity_ids: ["REQ-1"], source_refs: ["REQ-1"], weak_relationships_used: [] },
    weak_evidence_used: false
  };
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "demo", root: "/tmp/demo", root_hash: "h", source_upload_policy: "metadata_only" },
    created_at: "",
    updated_at: "",
    sources: [],
    nodes: [requirement],
    edges: [],
    candidate_edges: [],
    generation_runs: [run],
    generated_tests: [test],
    manifest: { generated_at: "", git: null, files: {} }
  };
}

describe("export privacy gate", () => {
  it("default evidence pack leaks no source, secret, prompt, or weights", () => {
    const graph = graphWithSensitiveBody();
    const pack = buildPack(graph, scoreGraph(graph));
    const json = JSON.stringify(pack);

    expect(json).not.toContain(SECRET);
    expect(json).not.toContain("proprietaryAlgo");
    expect(json).not.toContain(PROMPT);
    expect(json).not.toContain('"weights"');
    for (const marker of INTERNALS) expect(json).not.toContain(marker);
    // A secret placed directly in a node property is scrubbed at the boundary,
    // while non-secret reviewed metadata (acceptance criteria) is preserved.
    expect(json).not.toContain(PROP_SECRET);
    expect(json).toContain("A valid card succeeds");
    // The body itself is gated out of the default export.
    expect(pack.generation_runs[0].generated_tests[0].body).not.toContain("proprietaryAlgo");
    expect(validatePack(pack).valid).toBe(true);
  });

  it("offline graph HTML leaks no source, secret, prompt, weights, or network", () => {
    const graph = graphWithSensitiveBody();
    const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph)));

    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("proprietaryAlgo");
    expect(html).not.toContain(PROMPT);
    for (const marker of INTERNALS) expect(html).not.toContain(marker);
    // Offline + self-contained: no fetched assets. (D3 v7 is vendored inline; the
    // only URLs present are inert W3C XML namespaces it needs for SVG createElementNS
    // plus the d3js.org copyright line — never a network call.)
    expect(html).not.toMatch(/<script[^>]+\bsrc=/i);
    expect(html).not.toMatch(/<link[^>]+href=/i);
    for (const u of [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0])) {
      expect(u.startsWith("http://www.w3.org/") || u.startsWith("https://d3js.org")).toBe(true);
    }
  });

  it("a generated body crosses the export boundary ONLY with explicit opt-in", () => {
    const graph = graphWithSensitiveBody();
    expect(JSON.stringify(buildPack(graph, scoreGraph(graph)))).not.toContain("proprietaryAlgo");
    const optedIn = buildPack(graph, scoreGraph(graph), { include_generated_bodies: true });
    expect(optedIn.generation_runs[0].generated_tests[0].body).toContain("proprietaryAlgo");
  });
});
