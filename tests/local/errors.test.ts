import { describe, it, expect } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { opAnalyze, opScore, opGenerate } from "../../src/local/operations.js";
import { findGaps } from "../../src/local/gaps/gaps.js";
import { makeNode } from "../../src/local/graph/factories.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, LocalGraph } from "../../src/local/graph/ontology.js";

const ws = () => mkdtempSync(join(tmpdir(), "op-err-"));

function graphNoBehaviors(): LocalGraph {
  const file = makeNode({
    kind: "File",
    external_id: "src/x.ts",
    title: "x.ts",
    properties: { role: "code", file: "src/x.ts" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "scope-1" }
  });
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "f", root: "/tmp/f", root_hash: "h", source_upload_policy: "metadata_only" },
    created_at: "",
    updated_at: "",
    sources: [],
    nodes: [file],
    edges: [],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "", git: null, files: {} }
  };
}

describe("error handling — external-tester traps", () => {
  it("analyze throws a clear error on a path that does not exist (no silent empty graph)", () => {
    const root = ws();
    expect(() => opAnalyze(root, { source: join(root, "does-not-exist") })).toThrow(/Path not found/);
  });

  it("score throws a clear 'No graph found' before analyze", () => {
    expect(() => opScore(ws())).toThrow(/No graph found/);
  });

  it("generate rejects with 'No graph found' before analyze", async () => {
    await expect(opGenerate(ws(), {})).rejects.toThrow(/No graph found/);
  });

  it("gaps returns actionable guidance when there are no behavior anchors", () => {
    const res = findGaps(graphNoBehaviors());
    expect(res.total_behaviors).toBe(0);
    expect(res.gaps).toHaveLength(0);
    expect(res.guidance).toMatch(/No behavior anchors/i);
  });

  it("gaps omits the no-behaviors guidance when behaviors exist", () => {
    const base = graphNoBehaviors();
    const req = makeNode({
      kind: "Requirement",
      external_id: "REQ-1",
      title: "A requirement",
      properties: {},
      evidence_strength: "hard",
      review_status: "local_reviewed",
      confidence: 1,
      provenance: { source_scope_id: "scope-1" }
    });
    const res = findGaps({ ...base, nodes: [...base.nodes, req] });
    expect(res.total_behaviors).toBe(1);
    expect(res.guidance).toBeUndefined();
  });
});
