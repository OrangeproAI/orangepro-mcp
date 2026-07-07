import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { autoProve, isEligibleProvableTarget, javaTestForTarget } from "../../src/local/autoProve.js";
import { opAnalyze, opInit, opProveLoop, opRtm } from "../../src/local/operations.js";
import { loadGraph, workspacePaths } from "../../src/local/workspace.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
import { treeSitterLanguages } from "../../src/local/analyze/treeSitter/languages.js";
import type { GraphNode, LocalGraph } from "../../src/local/graph/ontology.js";

const deps = { clock: () => "2026-07-04T00:00:00Z", env: {} as NodeJS.ProcessEnv };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturesRoot = join(repoRoot, "tests", "local", "__fixtures__", "java-proof");

const TARGET = "sym:src/main/java/com/example/checkout/CheckoutService.java";

const tempDirs: string[] = [];

function hasMaven(): boolean {
  const r = spawnSync(process.env.OPRO_MVN_BIN || "mvn", ["-v"], { encoding: "utf8" });
  return r.status === 0 && /Apache Maven/.test(r.stdout ?? "");
}
const MAVEN = hasMaven();

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
  const dir = mkdtempSync(join(tmpdir(), "autoprove-java-"));
  tempDirs.push(dir);
  return dir;
}

function analyzedJava(fixture: string): { ws: string; source: string } {
  const ws = makeTempDir();
  const source = makeTempDir();
  cpSync(join(fixturesRoot, fixture), source, { recursive: true });
  opInit(ws, deps);
  opAnalyze(ws, { source }, deps);
  return { ws, source };
}

// ── javaTestForTarget unit tests — no toolchain needed (pure graph resolution). ──

/** Minimal graph shell: only the fields javaTestForTarget reads. */
function graphWith(nodes: GraphNode[], edges: LocalGraph["edges"]): LocalGraph {
  return { nodes, edges, candidate_edges: [] } as unknown as LocalGraph;
}

function symNode(id: string): GraphNode {
  return { external_id: id, kind: "CodeSymbol", properties: { file: id.slice(4).split("#")[0] } } as unknown as GraphNode;
}

function testNode(id: string, testNames: string[]): GraphNode {
  return { external_id: id, kind: "TestCase", properties: { test_names: testNames } } as unknown as GraphNode;
}

function testedByEdge(symId: string, testId: string, testName?: string): LocalGraph["edges"][number] {
  return {
    from_external_id: symId,
    to_external_id: testId,
    relationship_type: "TESTED_BY",
    ...(testName ? { properties: { test_name: testName } } : {})
  } as unknown as LocalGraph["edges"][number];
}

describe("javaTestForTarget", () => {
  it("resolves the exact Class#method from the edge's test_name (multi-test class)", () => {
    const sym = symNode("sym:src/main/java/com/example/CheckoutService.java#createTotal");
    const tc = testNode("test:src/test/java/com/example/CheckoutServiceTest.java", ["createsTotal", "loadsEqual", "other"]);
    const graph = graphWith([sym, tc], [testedByEdge(sym.external_id, tc.external_id, "createsTotal")]);
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
    expect(javaTestForTarget(nodeById, graph, sym.external_id)).toBe("CheckoutServiceTest#createsTotal");
  });

  it("falls back to a single-test class when the edge carries no test_name (older graph)", () => {
    const sym = symNode("sym:src/main/java/com/example/CheckoutService.java#createTotal");
    const tc = testNode("test:src/test/java/com/example/CheckoutServiceTest.java", ["createsTotal"]);
    const graph = graphWith([sym, tc], [testedByEdge(sym.external_id, tc.external_id)]);
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
    expect(javaTestForTarget(nodeById, graph, sym.external_id)).toBe("CheckoutServiceTest#createsTotal");
  });

  it("returns null (skip) when the edge has no test_name and the class has many tests (ambiguous)", () => {
    const sym = symNode("sym:src/main/java/com/example/CheckoutService.java#createTotal");
    const tc = testNode("test:src/test/java/com/example/CheckoutServiceTest.java", ["createsTotal", "loadsEqual"]);
    const graph = graphWith([sym, tc], [testedByEdge(sym.external_id, tc.external_id)]);
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
    expect(javaTestForTarget(nodeById, graph, sym.external_id)).toBeNull();
  });

  it("returns null (skip) when the target has no associated test at all", () => {
    const sym = symNode("sym:src/main/java/com/example/CheckoutService.java#createTotal");
    const graph = graphWith([sym], []);
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
    expect(javaTestForTarget(nodeById, graph, sym.external_id)).toBeNull();
  });

  it("returns null (skip) when two edges name two different Class#method (cannot pick one)", () => {
    const sym = symNode("sym:src/main/java/com/example/CheckoutService.java#createTotal");
    const a = testNode("test:src/test/java/com/example/AlphaTest.java", ["a"]);
    const b = testNode("test:src/test/java/com/example/BetaTest.java", ["b"]);
    const graph = graphWith(
      [sym, a, b],
      [testedByEdge(sym.external_id, a.external_id, "a"), testedByEdge(sym.external_id, b.external_id, "b")]
    );
    const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
    expect(javaTestForTarget(nodeById, graph, sym.external_id)).toBeNull();
  });
});

describe("isEligibleProvableTarget — Java methods only", () => {
  it("admits an eligible entry-point-adjacent Java method", () => {
    const { ws } = analyzedJava("auto-drive");
    const g = loadGraph(workspacePaths(ws).graphPath);
    const method = g.nodes.find((n) => n.external_id === `${TARGET}#createTotal`);
    expect(method?.properties.symbol_kind).toBe("method");
    expect(isEligibleProvableTarget(method)).toBe(true);
  });

  it("excludes the Java class container (not a method → out of J-1 scope)", () => {
    const { ws } = analyzedJava("auto-drive");
    const g = loadGraph(workspacePaths(ws).graphPath);
    const cls = g.nodes.find((n) => n.external_id === `${TARGET}#CheckoutService`);
    expect(cls?.properties.symbol_kind).toBe("class");
    expect(isEligibleProvableTarget(cls)).toBe(false);
  });
});

// ── auto-drive integration — needs Java + Maven. ──

describe.skipIf(!MAVEN)("autoProve auto-drives Java to Dynamically Proven", () => {
  it("mints DP≥1 for a Java single-return method automatically (no key, no explicit test_run) and does NOT prove an equivalent survivor or a refused shape", async () => {
    const { ws } = analyzedJava("auto-drive");
    expect(opRtm(ws, { format: "json" }).summary.proven).toBe(0);

    // NO provider key (env empty) → the existing-tests lane alone drives Java.
    const res = await autoProve(ws, { autoLimit: 5 }, { ...deps, proveLoop: opProveLoop });

    expect(res.ran).toBe(true);
    expect(res.proven).toBeGreaterThanOrEqual(1);
    expect(res.generated_files).toEqual([]); // existing-tests lane writes nothing

    const proven = res.attempts.filter((a) => a.classification === "proven").map((a) => a.target_symbol);
    expect(proven).toContain(`${TARGET}#createTotal`);
    // The derived Class#method selector was used (not a path).
    const createTotal = res.attempts.find((a) => a.target_symbol === `${TARGET}#createTotal`);
    expect(createTotal?.test_path).toBe("CheckoutServiceTest#createsTotal");

    // No false Proven: an equivalent (sentinel-value-survives) method stays unproven.
    const loadEqual = res.attempts.find((a) => a.target_symbol === `${TARGET}#loadEqual`);
    expect(loadEqual?.classification).not.toBe("proven");
    // No false Proven: a refused-shape method (two top-level returns) stays unproven.
    const createChoice = res.attempts.find((a) => a.target_symbol === `${TARGET}#createChoice`);
    expect(createChoice?.classification).not.toBe("proven");

    // RTM reflects exactly the one Java proof.
    const rtm = opRtm(ws, { format: "json" });
    expect(rtm.summary.proven).toBe(1);
    expect(rtm.rows.find((r) => r.code_symbol === `${TARGET}#createTotal`)?.evidence_tier).toBe("proven");
    expect(rtm.rows.find((r) => r.code_symbol === `${TARGET}#loadEqual`)?.evidence_tier).not.toBe("proven");
    expect(rtm.rows.find((r) => r.code_symbol === `${TARGET}#createChoice`)?.evidence_tier).not.toBe("proven");
  }, 400000);
});
