import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { enrichFromContent } from "../../src/local/enrich/index.js";
import { explainTest } from "../../src/local/explain/explain.js";
import { makeNode } from "../../src/local/graph/factories.js";
import { GraphNode, LocalGraph, LOCAL_GRAPH_SCHEMA_VERSION } from "../../src/local/graph/ontology.js";
import { opAnalyze, opInit, opScore, opStatus } from "../../src/local/operations.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "oplocal-triage-"));
  dirs.push(d);
  return d;
}
function frameworkTitles(nodes: GraphNode[]): string[] {
  return nodes.filter((n) => n.kind === "Framework").map((n) => n.title || "");
}

describe("Fix 2 + Fix 5: polyglot framework detection + feature-derived titles", () => {
  it("detects both pytest (backend) and vitest (frontend); titles come from file names", () => {
    const root = temp();
    mkdirSync(join(root, "tests"), { recursive: true });
    mkdirSync(join(root, "frontend"), { recursive: true });
    writeFileSync(join(root, "pyproject.toml"), '[tool.pytest.ini_options]\ntestpaths = ["tests"]\n');
    writeFileSync(join(root, "conftest.py"), "import pytest\n");
    writeFileSync(join(root, "tests", "test_recipes.py"), "def test_scaling():\n    assert True\n");
    writeFileSync(join(root, "frontend", "package.json"), JSON.stringify({ name: "fe", devDependencies: { vitest: "^3" } }));
    writeFileSync(
      join(root, "frontend", "use-scaled-amount.test.ts"),
      'import { describe, it, expect } from "vitest";\ndescribe("scaled", () => { it("scales fractional amount", () => { expect(1).toBe(1); }); });\n'
    );

    const frag = analyzeRepo(root, { readContent: true });
    const fws = frameworkTitles(frag.nodes);
    expect(fws).toContain("pytest");
    expect(fws).toContain("vitest");

    const flow = frag.nodes.find((n) => n.kind === "UserFlow");
    expect(flow?.title).toContain("Use scaled amount");
    expect(flow?.properties.feature).toBe("use scaled amount");
  });
});

describe("Fix 3: inferred-flow cap is configurable and truncation is reported", () => {
  it("reports truncation in analysis, status, and score", () => {
    const root = temp();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
    for (const name of ["a", "b", "c"]) {
      writeFileSync(join(root, `${name}.test.ts`), `import { it, expect } from "vitest";\nit("${name}", () => expect(1).toBe(1));\n`);
    }
    const frag = analyzeRepo(root, { readContent: true, maxInferredFlows: 1 });
    expect(frag.analysis.max_inferred_flows).toBe(1);
    expect(frag.analysis.inferred_flows).toBe(1);
    expect(frag.analysis.flows_truncated).toBeGreaterThanOrEqual(2);

    // Surfaced end-to-end via env ORANGEPRO_MAX_FLOWS.
    const deps = { clock: () => "2026-06-07T00:00:00Z", env: { ORANGEPRO_MAX_FLOWS: "1" } as NodeJS.ProcessEnv };
    opInit(root, deps);
    opAnalyze(root, { source: root }, deps);
    const status = opStatus(root, { clock: deps.clock, env: {} });
    expect(status.analysis?.flows_truncated).toBeGreaterThanOrEqual(2);
    const score = opScore(root);
    expect(score.missing_evidence.some((m) => /cap/i.test(m))).toBe(true);
  });
});

describe("Exclude suggestions: de-noise big-repo analysis", () => {
  it("suggests directories whose files carry no graph evidence", () => {
    const root = temp();
    mkdirSync(join(root, "assets"), { recursive: true });
    for (let i = 0; i < 30; i++) writeFileSync(join(root, "assets", `data${i}.json`), '{"x":1}');
    writeFileSync(join(root, "app.ts"), "export const x = 1;\n");
    const frag = analyzeRepo(root, { readContent: true });
    const sug = frag.analysis.exclude_suggestions ?? [];
    expect(sug.some((s) => s.path === "assets" && s.files >= 25)).toBe(true);
    // A dir containing code is never suggested.
    expect(sug.some((s) => s.path === "(root)")).toBe(false);
  });
});

describe("Fix 4: junk sources that yield zero anchors are not registered", () => {
  it("drops the SourceScope for a non-template CSV", () => {
    const frag = enrichFromContent("tests/data/export.csv", "id,name,qty\n1,sugar,2\n2,flour,3\n");
    expect(frag).not.toBeNull();
    expect(frag?.nodes.length).toBe(0);
    expect(frag?.sources.length).toBe(0);
  });
  it("keeps the source for a real template CSV", () => {
    const frag = enrichFromContent(
      "payments.csv",
      "behavior_name,acceptance_criteria,priority_or_risk\nSave card,Card is validated,high\n"
    );
    expect((frag?.nodes.length ?? 0)).toBeGreaterThan(0);
    expect(frag?.sources.length).toBe(1);
  });
});

describe("Fix 6: explain renders weak relationships as from -[relation]-> to", () => {
  it("labels inferred anchors and candidate edges with a relation", () => {
    const flow = makeNode({
      kind: "UserFlow",
      external_id: "flow:x",
      title: "X",
      properties: {},
      evidence_strength: "weak",
      review_status: "inferred",
      confidence: 0.35,
      provenance: { source_scope_id: "repo:d", source_ref: "x.test.ts" }
    });
    const graph: LocalGraph = {
      schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
      workspace: { name: "d", root: "/tmp/d", root_hash: "sha256:x", source_upload_policy: "metadata_only" },
      created_at: "",
      updated_at: "",
      sources: [],
      nodes: [flow],
      edges: [],
      candidate_edges: [],
      generation_runs: [],
      generated_tests: [
        {
          id: "t1",
          run_id: "r1",
          title: "X",
          test_type: "unit",
          framework_hint: "vitest",
          body: "...",
          grounding: {
            entity_ids: ["flow:x"],
            source_refs: [],
            weak_relationships_used: ["inferred_anchor:flow:x", "MAY_BE_TESTED_BY:flow:x->test:x.test.ts"]
          },
          weak_evidence_used: true
        }
      ],
      manifest: { generated_at: "", git: null, files: {} }
    };
    const explained = explainTest(graph, "t1");
    expect(explained.weak_relationships[0].relation).toBe("INFERRED_ANCHOR");
    expect(explained.weak_relationships[0].to).toBe("(this behavior)");
    expect(explained.weak_relationships[1].relation).toBe("MAY_BE_TESTED_BY");
    expect(explained.weak_relationships[1].from).toBe("flow:x");
    expect(explained.weak_relationships[1].to).toBe("test:x.test.ts");
  });
});
