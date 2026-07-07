import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { autoProve, goAssertionLineForTarget, goTestRunForTarget, isEligibleProvableTarget } from "../../src/local/autoProve.js";
import { opAnalyze, opInit, opProveLoop, opRtm } from "../../src/local/operations.js";
import { loadGraph, workspacePaths } from "../../src/local/workspace.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
import { treeSitterLanguages } from "../../src/local/analyze/treeSitter/languages.js";
import type { GraphNode, LocalGraph } from "../../src/local/graph/ontology.js";

const deps = { clock: () => "2026-07-04T00:00:00Z", env: {} as NodeJS.ProcessEnv };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturesRoot = join(repoRoot, "tests", "local", "__fixtures__", "go-proof");

const tempDirs: string[] = [];

function hasGo(): boolean {
  const r = spawnSync(process.env.OPRO_GO_BIN || "go", ["version"], { encoding: "utf8" });
  return r.status === 0 && /go version/.test(r.stdout ?? "");
}
const GO = hasGo();

beforeAll(async () => {
  await preloadTreeSitter(treeSitterLanguages());
});

afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "autoprove-go-"));
  tempDirs.push(dir);
  return dir;
}

function analyzedGo(fixture: string): { ws: string; source: string } {
  const ws = makeTempDir();
  const source = makeTempDir();
  cpSync(join(fixturesRoot, fixture), source, { recursive: true });
  opInit(ws, deps);
  opAnalyze(ws, { source }, deps);
  return { ws, source };
}

// ── goTestRunForTarget unit tests — no toolchain needed (pure graph resolution). ──

/** Minimal graph shell: only the fields goTestRunForTarget reads. */
function graphWith(nodes: GraphNode[], edges: LocalGraph["edges"]): LocalGraph {
  return { nodes, edges, candidate_edges: [] } as unknown as LocalGraph;
}

function symNode(id: string): GraphNode {
  return { external_id: id, kind: "CodeSymbol", properties: { file: id.slice(4).split("#")[0] } } as unknown as GraphNode;
}

function testNode(id: string, testNames: string[]): GraphNode {
  return { external_id: id, kind: "TestCase", properties: { test_names: testNames } } as unknown as GraphNode;
}

function testedByEdge(symId: string, testId: string, testName?: string, assertionLine?: number): LocalGraph["edges"][number] {
  const properties: Record<string, unknown> = {};
  if (testName) properties.test_name = testName;
  if (assertionLine !== undefined) properties.assertion_line = assertionLine;
  return {
    from_external_id: symId,
    to_external_id: testId,
    relationship_type: "TESTED_BY",
    ...(Object.keys(properties).length ? { properties } : {})
  } as unknown as LocalGraph["edges"][number];
}

describe("goTestRunForTarget", () => {
  it("resolves the exact ^TestName$ from the edge's test_name (multi-test file)", () => {
    const sym = symNode("sym:handler.go#CreateTotal");
    const tc = testNode("test:handler_test.go", ["TestCreateTotal", "TestLoadZero", "TestOther"]);
    const graph = graphWith([sym, tc], [testedByEdge(sym.external_id, tc.external_id, "TestCreateTotal")]);
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
    expect(goTestRunForTarget(nodeById, graph, sym.external_id)).toBe("^TestCreateTotal$");
  });

  it("falls back to a single-test file when the edge carries no test_name (older graph)", () => {
    const sym = symNode("sym:handler.go#CreateTotal");
    const tc = testNode("test:handler_test.go", ["TestCreateTotal"]);
    const graph = graphWith([sym, tc], [testedByEdge(sym.external_id, tc.external_id)]);
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
    expect(goTestRunForTarget(nodeById, graph, sym.external_id)).toBe("^TestCreateTotal$");
  });

  it("returns null (skip) when the edge has no test_name and the file has many tests (ambiguous)", () => {
    const sym = symNode("sym:handler.go#CreateTotal");
    const tc = testNode("test:handler_test.go", ["TestCreateTotal", "TestLoadZero"]);
    const graph = graphWith([sym, tc], [testedByEdge(sym.external_id, tc.external_id)]);
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
    expect(goTestRunForTarget(nodeById, graph, sym.external_id)).toBeNull();
  });

  it("returns null (skip) when the target has no associated test at all", () => {
    const sym = symNode("sym:handler.go#CreateTotal");
    const graph = graphWith([sym], []);
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
    expect(goTestRunForTarget(nodeById, graph, sym.external_id)).toBeNull();
  });

  it("returns null (skip) when two edges name two different tests (cannot pick one)", () => {
    const sym = symNode("sym:handler.go#CreateTotal");
    const a = testNode("test:a_test.go", ["TestA"]);
    const b = testNode("test:b_test.go", ["TestB"]);
    const graph = graphWith(
      [sym, a, b],
      [testedByEdge(sym.external_id, a.external_id, "TestA"), testedByEdge(sym.external_id, b.external_id, "TestB")]
    );
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
    expect(goTestRunForTarget(nodeById, graph, sym.external_id)).toBeNull();
  });

  it("anchors a literal-named subtest into a fully-anchored ^TestX$/^sub$ pattern", () => {
    const sym = symNode("sym:add.go#Add");
    const tc = testNode("test:add_test.go", ["TestAdd"]);
    const graph = graphWith([sym, tc], [testedByEdge(sym.external_id, tc.external_id, "TestAdd/basic")]);
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
    // Every segment anchored — the oracle's `targetTestName` binds this to exactly one
    // subtest, so a sibling subtest's failure can never be credited to this target.
    expect(goTestRunForTarget(nodeById, graph, sym.external_id)).toBe("^TestAdd$/^basic$");
  });

  it("never derives a bare parent pattern that could credit a sibling subtest", () => {
    const sym = symNode("sym:add.go#Add");
    const tc = testNode("test:add_test.go", ["TestAdd"]);
    const graph = graphWith([sym, tc], [testedByEdge(sym.external_id, tc.external_id, "TestAdd/basic")]);
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
    const run = goTestRunForTarget(nodeById, graph, sym.external_id);
    // A bare `^TestAdd$` would run (and credit) every sibling subtest — the derivation
    // must stay pinned to the exact subtest the assertion witnessed.
    expect(run).not.toBe("^TestAdd$");
    expect(run).toBe("^TestAdd$/^basic$");
  });
});

describe("goAssertionLineForTarget (Slice 2)", () => {
  it("returns the assertion_line for the edge whose test_name anchors to the derived -run", () => {
    const sym = symNode("sym:endpoint.go#FindEndpointForURL");
    const tc = testNode("test:endpoint_test.go", ["TestFindEndpointForURL"]);
    const graph = graphWith([sym, tc], [testedByEdge(sym.external_id, tc.external_id, "TestFindEndpointForURL", 60)]);
    expect(goAssertionLineForTarget(graph, sym.external_id, "^TestFindEndpointForURL$")).toBe(60);
  });

  it("returns undefined when the edge carries no assertion_line (older graph)", () => {
    const sym = symNode("sym:add.go#Add");
    const tc = testNode("test:add_test.go", ["TestAdd"]);
    const graph = graphWith([sym, tc], [testedByEdge(sym.external_id, tc.external_id, "TestAdd")]);
    expect(goAssertionLineForTarget(graph, sym.external_id, "^TestAdd$")).toBeUndefined();
  });

  it("returns undefined when two edges disagree on the line (ambiguous, fail closed)", () => {
    const sym = symNode("sym:add.go#Add");
    const a = testNode("test:a_test.go", ["TestAdd"]);
    const b = testNode("test:b_test.go", ["TestAdd"]);
    const graph = graphWith(
      [sym, a, b],
      [testedByEdge(sym.external_id, a.external_id, "TestAdd", 7), testedByEdge(sym.external_id, b.external_id, "TestAdd", 9)]
    );
    // Both anchor to ^TestAdd$ but name two lines → not unique → undefined (spike keeps exact-name).
    expect(goAssertionLineForTarget(graph, sym.external_id, "^TestAdd$")).toBeUndefined();
  });
});

describe("isEligibleProvableTarget — Go free-functions only", () => {
  it("admits an eligible entry-point-adjacent Go free function", () => {
    const { ws } = analyzedGo("auto-drive");
    const g = loadGraph(workspacePaths(ws).graphPath);
    const fn = g.nodes.find((n) => n.external_id === "sym:handler.go#CreateTotal");
    expect(isEligibleProvableTarget(fn)).toBe(true);
  });

  it("excludes a Go METHOD target (out of scope for the Go oracle)", () => {
    const { ws } = analyzedGo("auto-drive");
    const g = loadGraph(workspacePaths(ws).graphPath);
    const method = g.nodes.find((n) => n.external_id === "sym:handler.go#ProcessCart");
    expect(method?.properties.symbol_kind).toBe("method");
    expect(isEligibleProvableTarget(method)).toBe(false);
  });
});

// ── auto-drive integration — needs the Go toolchain. ──

const SLOW_GO_AUTO = process.env.OPRO_SLOW_GO_AUTO === "1";

describe.skipIf(!GO || !SLOW_GO_AUTO)("autoProve auto-drives Go to Dynamically Proven", () => {
  it("mints DP≥1 for a Go free-fn automatically (no key, no explicit test_run) and does NOT prove a method or an equivalent survivor", async () => {
    const { ws } = analyzedGo("auto-drive");
    expect(opRtm(ws, { format: "json" }).summary.proven).toBe(0);

    // NO provider key (env empty) → the existing-tests lane alone drives Go.
    const res = await autoProve(ws, { autoLimit: 5 }, { ...deps, proveLoop: opProveLoop });

    expect(res.ran).toBe(true);
    expect(res.proven).toBeGreaterThanOrEqual(1);
    expect(res.generated_files).toEqual([]); // existing-tests lane writes nothing

    const proven = res.attempts.filter((a) => a.classification === "proven").map((a) => a.target_symbol);
    expect(proven).toContain("sym:handler.go#CreateTotal");
    // The derived anchored test name was used (not a path).
    const createTotal = res.attempts.find((a) => a.target_symbol === "sym:handler.go#CreateTotal");
    expect(createTotal?.test_path).toBe("^TestCreateTotal$");

    // No false Proven: an equivalent (zero-value-survives) free fn stays unproven.
    const loadZero = res.attempts.find((a) => a.target_symbol === "sym:handler.go#LoadZero");
    expect(loadZero?.classification).not.toBe("proven");
    // A Go METHOD target is never even attempted (excluded at selection).
    expect(res.attempts.some((a) => a.target_symbol === "sym:handler.go#ProcessCart")).toBe(false);

    // RTM reflects exactly the one Go proof.
    const rtm = opRtm(ws, { format: "json" });
    expect(rtm.summary.proven).toBe(1);
    expect(rtm.rows.find((r) => r.code_symbol === "sym:handler.go#CreateTotal")?.evidence_tier).toBe("proven");
    expect(rtm.rows.find((r) => r.code_symbol === "sym:handler.go#LoadZero")?.evidence_tier).not.toBe("proven");
    expect(rtm.rows.find((r) => r.code_symbol === "sym:handler.go#ProcessCart")?.evidence_tier).not.toBe("proven");
  }, 90000);
});
