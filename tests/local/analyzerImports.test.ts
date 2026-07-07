import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { isTestSupportPath } from "../../src/local/analyze/classify.js";
import { changedImpact } from "../../src/local/freshness/changed.js";
import { buildPack } from "../../src/local/pack/exporter.js";
import { scoreGraph } from "../../src/local/score/score.js";
import { makeCandidateEdge, makeNode } from "../../src/local/graph/factories.js";
import {
  LOCAL_GRAPH_SCHEMA_VERSION,
  type CandidateEdge,
  type GraphNode,
  type LocalGraph
} from "../../src/local/graph/ontology.js";

/** Wrap an analyze fragment as a minimal LocalGraph for consumer-contract tests. */
function toGraph(fragment: ReturnType<typeof analyzeRepo>): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "fixture", root: "/tmp/x", root_hash: "h", source_upload_policy: "metadata_only" },
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    sources: fragment.sources,
    nodes: fragment.nodes,
    edges: fragment.edges,
    candidate_edges: fragment.candidate_edges,
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "2026-01-01T00:00:00.000Z", git: null, files: fragment.file_entries },
    analysis: fragment.analysis
  } as LocalGraph;
}

/**
 * Phase 2 integration: the import graph wired into analyzeRepo —
 * File->IMPORTS->File hard edges, resolved test->source MAY_RELATE_TO as the
 * PRIMARY linkage (stem heuristic demoted to secondary), test-support target
 * exclusions, and persisted resolver gate metrics.
 */
describe("analyzeRepo — import graph integration", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opimports-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext" } })
    );
    // Source modules. `widget.ts` shares its stem with the test below but is NOT imported by it.
    writeFileSync(join(dir, "src", "feature.ts"), "export function doThing(): number {\n  return 1;\n}\n");
    writeFileSync(join(dir, "src", "widget.ts"), "export function widget(): number {\n  return 2;\n}\n");
    writeFileSync(
      join(dir, "src", "other.ts"),
      'import { doThing } from "./feature.js";\nexport const x = doThing();\n'
    );
    // The test imports feature (runtime) — NOT its stem-sibling widget.
    writeFileSync(
      join(dir, "tests", "widget.test.ts"),
      [
        'import { doThing } from "../src/feature.js";',
        'describe("widget", () => {',
        '  it("does the thing", () => { doThing(); });',
        "});"
      ].join("\n")
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits hard File->IMPORTS->File edges for resolved internal imports", () => {
    const fragment = analyzeRepo(dir);
    const imports = fragment.edges.filter((e) => e.relationship_type === "IMPORTS");
    const keys = new Set(imports.map((e) => `${e.from_external_id}|${e.to_external_id}`));
    expect(keys.has("tests/widget.test.ts|src/feature.ts")).toBe(true);
    expect(keys.has("src/other.ts|src/feature.ts")).toBe(true);
    for (const e of imports) expect(e.evidence_strength).toBe("hard");
  });

  it("links a test to its RESOLVED import target (candidate, with the specifier as reason)", () => {
    const fragment = analyzeRepo(dir);
    const rel = fragment.candidate_edges.find(
      (e) => e.relationship_type === "MAY_RELATE_TO" && e.from_external_id === "tests/widget.test.ts"
    );
    expect(rel).toBeDefined();
    expect(rel!.to_external_id).toBe("src/feature.ts");
    expect(rel!.evidence_strength).toBe("candidate");
    expect(rel!.confidence).toBe(0.75);
    expect(rel!.reason).toContain("../src/feature.js");
  });

  it("does NOT stem-link an import-linked test to a same-stem different module", () => {
    const fragment = analyzeRepo(dir);
    const stemLink = fragment.candidate_edges.find(
      (e) =>
        e.relationship_type === "MAY_RELATE_TO" &&
        e.from_external_id === "tests/widget.test.ts" &&
        e.to_external_id === "src/widget.ts"
    );
    expect(stemLink).toBeUndefined();
  });

  it("dedupes IMPORTS per module pair but still links a runtime import after a type-only one", () => {
    writeFileSync(
      join(dir, "tests", "dual.test.ts"),
      [
        'import type { doThing as T } from "../src/feature.js";',
        'import { doThing } from "../src/feature.js";',
        'it("x", () => { doThing(); });'
      ].join("\n")
    );
    const fragment = analyzeRepo(dir);
    const importEdges = fragment.edges.filter(
      (e) => e.relationship_type === "IMPORTS" && e.from_external_id === "tests/dual.test.ts"
    );
    expect(importEdges).toHaveLength(1); // deduped
    const link = fragment.candidate_edges.find(
      (e) => e.relationship_type === "MAY_RELATE_TO" && e.from_external_id === "tests/dual.test.ts"
    );
    expect(link).toBeDefined(); // the runtime import still links
  });

  it("never links test-support targets (mocks/fixtures/helpers/test-*) — but keeps IMPORTS", () => {
    writeFileSync(join(dir, "src", "saveUser.fixture.ts"), "export function saveUser(): void {}\n");
    writeFileSync(join(dir, "src", "dom-helpers.ts"), "export function mount(): void {}\n");
    writeFileSync(join(dir, "src", "test-utils.ts"), "export function setup(): void {}\n");
    writeFileSync(
      join(dir, "tests", "support.test.ts"),
      [
        'import { saveUser } from "../src/saveUser.fixture.js";',
        'import { mount } from "../src/dom-helpers.js";',
        'import { setup } from "../src/test-utils.js";',
        'it("uses helpers", () => { saveUser(); mount(); setup(); });'
      ].join("\n")
    );
    const fragment = analyzeRepo(dir);
    const links = fragment.candidate_edges.filter(
      (e) => e.relationship_type === "MAY_RELATE_TO" && e.from_external_id === "tests/support.test.ts"
    );
    expect(links).toHaveLength(0);
    const imports = fragment.edges.filter(
      (e) => e.relationship_type === "IMPORTS" && e.from_external_id === "tests/support.test.ts"
    );
    expect(imports).toHaveLength(3); // structural fact stays
  });

  it("never links a *.mock.* target (Codex P2 construct) — but keeps IMPORTS", () => {
    writeFileSync(join(dir, "src", "payment.mock.ts"), "export function fakeGateway(): void {}\n");
    writeFileSync(
      join(dir, "tests", "payment.test.ts"),
      'import { fakeGateway } from "../src/payment.mock.js";\nit("x", () => { fakeGateway(); });'
    );
    const fragment = analyzeRepo(dir);
    const links = fragment.candidate_edges.filter(
      (e) => e.relationship_type === "MAY_RELATE_TO" && e.from_external_id === "tests/payment.test.ts"
    );
    expect(links).toHaveLength(0); // a mock-only change must not look like behavior impact
    const imports = fragment.edges.filter(
      (e) => e.relationship_type === "IMPORTS" && e.from_external_id === "tests/payment.test.ts"
    );
    expect(imports.map((e) => e.to_external_id)).toEqual(["src/payment.mock.ts"]);
  });

  it("never links a test->test import", () => {
    writeFileSync(join(dir, "tests", "shared.ts"), "export function sharedSetup(): void {}\n"); // role test (tests/ dir)
    writeFileSync(
      join(dir, "tests", "uses-shared.test.ts"),
      'import { sharedSetup } from "./shared.js";\nit("x", () => { sharedSetup(); });'
    );
    const fragment = analyzeRepo(dir);
    const link = fragment.candidate_edges.find(
      (e) => e.relationship_type === "MAY_RELATE_TO" && e.from_external_id === "tests/uses-shared.test.ts"
    );
    expect(link).toBeUndefined();
  });

  it("keeps the stem heuristic as SECONDARY for non-TS languages", () => {
    writeFileSync(join(dir, "src", "card.py"), "def charge(amount):\n    return amount > 0\n");
    writeFileSync(join(dir, "tests", "test_card.py"), "def test_charge():\n    assert True\n");
    const fragment = analyzeRepo(dir);
    const rel = fragment.candidate_edges.find(
      (e) => e.relationship_type === "MAY_RELATE_TO" && e.from_external_id === "tests/test_card.py"
    );
    expect(rel).toBeDefined();
    expect(rel!.to_external_id).toBe("src/card.py");
    expect(rel!.evidence_strength).toBe("weak"); // name heuristic stays weak
  });

  it("persists resolver gate metrics with raw counts and a defensible verdict", () => {
    const fragment = analyzeRepo(dir);
    const metrics = fragment.analysis.resolver_metrics;
    expect(metrics).toBeDefined();
    // Exact raw counts pinned: widget.test->feature (test) + other->feature (source).
    // A duplicate resolver feed (denominator drift) breaks these.
    expect(metrics!.test_to_source).toEqual({ n: 1, resolved: 1, pct: 100 });
    expect(metrics!.all_internal).toEqual({ n: 2, resolved: 2, pct: 100 });
    expect(metrics!.source_to_source).toEqual({ n: 1, resolved: 1, pct: 100 });
    const gate = fragment.analysis.resolver_gate;
    expect(gate).toEqual({ axis: "test_to_source", threshold_pct: 80, pct: 100, defensible: true });
    expect(fragment.warnings.join("\n")).not.toContain("not defensible");
  });

  it("never declares the gate defensible on a files-cap-truncated scan", () => {
    const fragment = analyzeRepo(dir, { maxFiles: 3 }); // below the fixture's file count
    expect(fragment.analysis.files_cap_hit).toBe(true);
    expect(fragment.analysis.resolver_gate?.defensible ?? false).toBe(false);
  });

  it("warns and marks the gate non-defensible when test->source resolution is below 80%", () => {
    // Two more runtime test imports that CANNOT resolve -> 1/3 resolved (33.3%).
    writeFileSync(
      join(dir, "tests", "broken.test.ts"),
      [
        'import { gone } from "../src/missing.js";',
        'import { alsoGone } from "../src/also-missing.js";',
        'it("x", () => { gone(); alsoGone(); });'
      ].join("\n")
    );
    const fragment = analyzeRepo(dir);
    expect(fragment.analysis.resolver_gate?.defensible).toBe(false);
    expect(fragment.warnings.join("\n")).toContain("not defensible");
  });

  it("skips the import pass entirely when readContent is false", () => {
    const fragment = analyzeRepo(dir, { readContent: false });
    expect(fragment.edges.filter((e) => e.relationship_type === "IMPORTS")).toHaveLength(0);
    expect(fragment.analysis.resolver_metrics).toBeUndefined();
    expect(fragment.analysis.resolver_gate).toBeUndefined();
  });

  it("NEVER emits hard TESTED_BY/COVERS edges from analysis (the Phase-4 confirmer's job)", () => {
    const fragment = analyzeRepo(dir);
    const forbidden = fragment.edges.filter(
      (e) => e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS"
    );
    expect(forbidden).toHaveLength(0);
    // The resolved test->source linkage is a CandidateEdge — candidate strength, never proof.
    for (const e of fragment.candidate_edges) {
      expect(["candidate", "weak"]).toContain(e.evidence_strength);
    }
  });

  it("does not link a test whose ONLY source import is type-only", () => {
    writeFileSync(
      join(dir, "tests", "typeonly.test.ts"),
      'import type { doThing } from "../src/feature.js";\nit("x", () => {});'
    );
    const fragment = analyzeRepo(dir);
    const link = fragment.candidate_edges.find(
      (e) => e.relationship_type === "MAY_RELATE_TO" && e.from_external_id === "tests/typeonly.test.ts"
    );
    expect(link).toBeUndefined();
  });

  it("suppresses the stem fallback for a test whose import links were all support-filtered", () => {
    // helper.test.ts resolved-imports ONLY a helper. Its stem matches src/helper.ts,
    // a module it never imports — the resolver understood the file, so no stem guess.
    writeFileSync(join(dir, "src", "helper.ts"), "export function realHelperModule(): number { return 3; }\n");
    writeFileSync(join(dir, "src", "dom-helpers.ts"), "export function mount(): void {}\n");
    writeFileSync(
      join(dir, "tests", "helper.test.ts"),
      'import { mount } from "../src/dom-helpers.js";\nit("x", () => { mount(); });'
    );
    const fragment = analyzeRepo(dir);
    const links = fragment.candidate_edges.filter(
      (e) => e.relationship_type === "MAY_RELATE_TO" && e.from_external_id === "tests/helper.test.ts"
    );
    expect(links).toHaveLength(0);
  });

  it("secondary stem fallback never links a test-support target", () => {
    // Python (no resolver coverage) so the stem path runs; the only stem match is
    // a test-support-named file -> no link.
    writeFileSync(join(dir, "src", "test-card.py"), "def charge(amount):\n    return amount > 0\n");
    writeFileSync(join(dir, "tests", "test-card_test.py"), "def test_charge():\n    assert True\n");
    const fragment = analyzeRepo(dir);
    const link = fragment.candidate_edges.find(
      (e) => e.relationship_type === "MAY_RELATE_TO" && e.from_external_id === "tests/test-card_test.py"
    );
    expect(link).toBeUndefined();
  });

  it("picks up a tsconfig ADDED between runs of the same process (caches reset per run)", () => {
    const dir2 = mkdtempSync(join(tmpdir(), "opimports2-"));
    try {
      mkdirSync(join(dir2, "src", "app"), { recursive: true });
      mkdirSync(join(dir2, "tests"), { recursive: true });
      writeFileSync(join(dir2, "src", "app", "foo.ts"), "export function foo(): number { return 1; }\n");
      writeFileSync(
        join(dir2, "tests", "alias.test.ts"),
        'import { foo } from "@app/foo";\nit("x", () => { foo(); });'
      );
      // Run 1: no tsconfig -> the alias cannot resolve.
      const before = analyzeRepo(dir2);
      expect(before.edges.filter((e) => e.relationship_type === "IMPORTS")).toHaveLength(0);
      // Add the tsconfig that defines the alias; a stale nearest-tsconfig memo
      // from run 1 would still miss it without the run-start cache reset.
      writeFileSync(
        join(dir2, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: { moduleResolution: "bundler", baseUrl: ".", paths: { "@app/*": ["src/app/*"] } }
        })
      );
      const after = analyzeRepo(dir2);
      const imports = after.edges.filter((e) => e.relationship_type === "IMPORTS");
      expect(imports.map((e) => `${e.from_external_id}|${e.to_external_id}`)).toContain(
        "tests/alias.test.ts|src/app/foo.ts"
      );
    } finally {
      rmSync(dir2, { recursive: true, force: true });
    }
  });
});

describe("analyzeRepo — downstream consumer contracts", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "opconsumer-"));
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "tests"), { recursive: true });
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { module: "nodenext", moduleResolution: "nodenext" } })
    );
    writeFileSync(join(dir, "src", "feature.ts"), "export function doThing(): number {\n  return 1;\n}\n");
    writeFileSync(join(dir, "src", "unrelated.ts"), "export function nope(): number {\n  return 0;\n}\n");
    writeFileSync(
      join(dir, "tests", "feature.test.ts"),
      [
        'import { doThing } from "../src/feature.js";',
        'describe("feature", () => { it("works", () => { doThing(); }); });'
      ].join("\n")
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("changedImpact maps a changed source file to the tests that IMPORT it (import-precise)", () => {
    const fragment = analyzeRepo(dir);
    const graph = toGraph(fragment);
    const flow = fragment.nodes.find(
      (n) => n.kind === "UserFlow" && n.provenance.source_ref === "tests/feature.test.ts"
    );
    expect(flow).toBeDefined();

    const result = changedImpact(graph, ["src/feature.ts"], "main");
    expect(result.affected_behaviors).toContain(flow!.external_id);
    // Precisely-linked: exactly the importing test's behavior, no area re-expansion.
    expect(result.affected_behaviors).toHaveLength(1);
    expect(result.recommended_actions.join("\n")).not.toContain("directory area");
  });

  it("changedImpact damps hub fan-in: shared plumbing never floods PR targeting", () => {
    // 30 test files all resolved-import src/constants.ts (the hub); ONE test
    // imports src/feature.ts. Changing both must target only the feature flow,
    // with the hub surfaced as an explanatory action.
    const prov = { source_scope_id: "repo:fix" };
    const nodes: GraphNode[] = [];
    const candidate_edges: CandidateEdge[] = [];
    const addTestAndFlow = (tf: string, flowId: string, target: string): void => {
      nodes.push(
        makeNode({
          kind: "TestCase",
          external_id: `test:${tf}`,
          title: tf,
          properties: { file: tf, test_layer: "unit", test_names: ["x"] },
          evidence_strength: "hard",
          review_status: "auto_detected",
          confidence: 1,
          provenance: prov
        }),
        makeNode({
          kind: "UserFlow",
          external_id: flowId,
          title: flowId,
          properties: { area: "tests" },
          evidence_strength: "weak",
          review_status: "inferred",
          confidence: 0.35,
          provenance: prov
        })
      );
      candidate_edges.push(
        makeCandidateEdge({
          from_external_id: tf,
          to_external_id: target,
          relationship_type: "MAY_RELATE_TO",
          evidence_strength: "candidate",
          reason: `Test resolved-imports this module ("${target}")`,
          confidence: 0.75
        }),
        makeCandidateEdge({
          from_external_id: flowId,
          to_external_id: `test:${tf}`,
          relationship_type: "MAY_BE_TESTED_BY",
          evidence_strength: "weak",
          reason: "anchor",
          confidence: 0.35
        })
      );
    };
    for (let i = 0; i < 30; i++) addTestAndFlow(`tests/hub${i}.test.ts`, `flow:hub${i}`, "src/constants.ts");
    addTestAndFlow("tests/feat.test.ts", "flow:feat", "src/feature.ts");
    const graph = { nodes, edges: [], candidate_edges } as unknown as LocalGraph;

    const r = changedImpact(graph, ["src/constants.ts", "src/feature.ts"], "main");
    expect(r.affected_behaviors).toEqual(["flow:feat"]); // 31 tests in graph -> threshold 20; 30 > 20 = hub
    const actions = r.recommended_actions.join("\n");
    expect(actions).toContain("src/constants.ts is linked to 30 test files (hub import");
    expect(actions).not.toContain("src/feature.ts is linked");
  });

  it("changedImpact: a HUB-ONLY change never floods back in via the area fallback (Codex P2)", () => {
    // Hub path and flows share the SAME area ("webapp") — without the hub-aware
    // fallback skip, the area match would re-add every webapp flow.
    const prov = { source_scope_id: "repo:fix" };
    const nodes: GraphNode[] = [];
    const candidate_edges: CandidateEdge[] = [];
    for (let i = 0; i < 30; i++) {
      const tf = `webapp/t${i}.test.ts`;
      nodes.push(
        makeNode({
          kind: "TestCase",
          external_id: `test:${tf}`,
          title: tf,
          properties: { file: tf, test_layer: "unit", test_names: ["x"] },
          evidence_strength: "hard",
          review_status: "auto_detected",
          confidence: 1,
          provenance: prov
        }),
        makeNode({
          kind: "UserFlow",
          external_id: `flow:webapp-t${i}`,
          title: `t${i}`,
          properties: { area: "webapp" },
          evidence_strength: "weak",
          review_status: "inferred",
          confidence: 0.35,
          provenance: prov
        })
      );
      candidate_edges.push(
        makeCandidateEdge({
          from_external_id: tf,
          to_external_id: "webapp/constants.ts",
          relationship_type: "MAY_RELATE_TO",
          evidence_strength: "candidate",
          reason: 'Test resolved-imports this module ("../constants")',
          confidence: 0.75
        }),
        makeCandidateEdge({
          from_external_id: `flow:webapp-t${i}`,
          to_external_id: `test:${tf}`,
          relationship_type: "MAY_BE_TESTED_BY",
          evidence_strength: "weak",
          reason: "anchor",
          confidence: 0.35
        })
      );
    }
    const graph = { nodes, edges: [], candidate_edges } as unknown as LocalGraph;

    const r = changedImpact(graph, ["webapp/constants.ts"], "main");
    expect(r.affected_behaviors).toEqual([]); // not precise-expanded AND not area-re-expanded
    const actions = r.recommended_actions.join("\n");
    expect(actions).toContain("webapp/constants.ts is linked to 30 test files (hub import");
    expect(actions).not.toContain("directory area");
  });

  it("changedImpact never flags a changed TEST file as a hub (source endpoints don't count)", () => {
    const prov = { source_scope_id: "repo:fix" };
    const tf = "tests/wide.test.ts";
    const nodes: GraphNode[] = [
      makeNode({
        kind: "TestCase",
        external_id: `test:${tf}`,
        title: tf,
        properties: { file: tf, test_layer: "unit", test_names: ["x"] },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: prov
      }),
      makeNode({
        kind: "UserFlow",
        external_id: "flow:wide",
        title: "wide",
        properties: { area: "tests" },
        evidence_strength: "weak",
        review_status: "inferred",
        confidence: 0.35,
        provenance: prov
      })
    ];
    const candidate_edges: CandidateEdge[] = [
      makeCandidateEdge({
        from_external_id: "flow:wide",
        to_external_id: `test:${tf}`,
        relationship_type: "MAY_BE_TESTED_BY",
        evidence_strength: "weak",
        reason: "anchor",
        confidence: 0.35
      })
    ];
    for (let i = 0; i < 25; i++) {
      candidate_edges.push(
        makeCandidateEdge({
          from_external_id: tf,
          to_external_id: `src/mod${i}.ts`,
          relationship_type: "MAY_RELATE_TO",
          evidence_strength: "candidate",
          reason: `Test resolved-imports this module ("./mod${i}.js")`,
          confidence: 0.75
        })
      );
    }
    const graph = { nodes, edges: [], candidate_edges } as unknown as LocalGraph;

    const r = changedImpact(graph, [tf], "main");
    expect(r.affected_behaviors).toEqual(["flow:wide"]); // its own flow, via the changed TestCase
    expect(r.recommended_actions.join("\n")).not.toContain("hub import");
  });

  it("evidence pack excludes IMPORTS edges but keeps the resolved candidate linkage (reason intact)", () => {
    const fragment = analyzeRepo(dir);
    const graph = toGraph(fragment);
    // The graph itself DOES hold IMPORTS edges (local substrate)...
    expect(graph.edges.some((e) => e.relationship_type === "IMPORTS")).toBe(true);
    const pack = buildPack(graph, scoreGraph(graph));
    // ...but the promotion boundary exports none of them.
    expect(pack.relationships.some((r) => r.relationship_type === "IMPORTS")).toBe(false);
    expect(pack.relationships.length).toBeGreaterThan(0); // DEFINED_IN etc. still exported
    const link = pack.candidate_relationships.find((r) => r.relationship_type === "MAY_RELATE_TO");
    expect(link).toBeDefined();
    expect(link!.reason).toContain("../src/feature.js"); // specifier survives redaction (path metadata)
  });
});

describe("isTestSupportPath", () => {
  it("matches the test-support patterns and rejects production files", () => {
    expect(isTestSupportPath("src/__mocks__/api.ts")).toBe(true);
    expect(isTestSupportPath("src/__fixtures__/user.ts")).toBe(true);
    expect(isTestSupportPath("src/saveUser.fixture.ts")).toBe(true);
    expect(isTestSupportPath("src/data.fixtures.json")).toBe(true);
    expect(isTestSupportPath("src/dom-helpers.ts")).toBe(true);
    expect(isTestSupportPath("src/render-helper.ts")).toBe(true);
    expect(isTestSupportPath("src/test-utils.ts")).toBe(true);
    expect(isTestSupportPath("src/test_utils.py")).toBe(true);
    expect(isTestSupportPath("src/testUtils.ts")).toBe(true); // basename comparison is lowercased
    expect(isTestSupportPath("src/mocks/api.ts")).toBe(true);
    expect(isTestSupportPath("src/mock/api.ts")).toBe(true);
    expect(isTestSupportPath("src/fixtures/user.ts")).toBe(true);
    expect(isTestSupportPath("src/fixture/user.ts")).toBe(true);
    expect(isTestSupportPath("src/api.mock.ts")).toBe(true);
    expect(isTestSupportPath("src/payment.mocks.ts")).toBe(true);
    expect(isTestSupportPath("src/saveUser.ts")).toBe(false);
    expect(isTestSupportPath("src/mockingbird.ts")).toBe(false); // "mock" only as a word prefix
    expect(isTestSupportPath("src/helpers/format.ts")).toBe(false); // helpers DIR is not *-helpers file
    expect(isTestSupportPath("src/contest-rules.ts")).toBe(false); // contains "test-" only mid-word
  });
});
