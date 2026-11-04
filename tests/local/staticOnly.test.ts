import { afterEach, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { spawnSync } from "node:child_process";
import { generateTests } from "../../src/local/generate/generator.js";
import { classifyGeneratedDraftBlocker, generatedDraftRemediation } from "../../src/local/generate/draftGuidance.js";
import { autoProve } from "../../src/local/autoProve.js";
import { dockerExecutor } from "../../src/local/boundary.js";
import { prepareRuntimeCoverage } from "../../src/local/analyze/coverageArtifacts.js";
import { defaultDynamicProofRunner } from "../../src/local/operations.js";
import { isStaticOnly, NOT_COMPILE_CHECKED, STATIC_ONLY_ENV, STATIC_ONLY_REFUSAL } from "../../src/local/staticOnly.js";
import { makeEdge, makeNode } from "../../src/local/graph/factories.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, type LocalGraph } from "../../src/local/graph/ontology.js";
import type { ModelProvider } from "../../src/local/types.js";

// Item 34: a free report runs OrangePro on a stranger's public repository. Static-only mode
// drafts tests there without running any of the repository's code.

const CLOCK = () => "2026-11-04T00:00:00Z";
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function withEnv(name: string, value: string | undefined): void {
  const before = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  cleanups.push(() => {
    if (before === undefined) delete process.env[name];
    else process.env[name] = before;
  });
}

function provenance(ref: string) {
  return { source_scope_id: "scope-1", source_ref: ref, detector: "test-fixture" };
}

function graphFor(root: string, nodes: LocalGraph["nodes"], edges: LocalGraph["edges"] = []): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "fixture", root, root_hash: "roothash", source_upload_policy: "metadata_only" },
    created_at: CLOCK(),
    updated_at: CLOCK(),
    sources: [],
    nodes,
    edges,
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: CLOCK(), git: null, files: {} }
  };
}

/** A Go package plus a fake `go` on PATH that leaves a marker whenever it is started. */
function goFixture(): { root: string; marker: string; graph: LocalGraph; behaviorId: string; provider: ModelProvider } {
  const root = tempDir("opro-static-go-");
  const marker = join(root, "go-was-run");
  const bin = join(root, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "go"), `#!/usr/bin/env sh\ntouch '${marker}'\nexit 0\n`);
  chmodSync(join(bin, "go"), 0o755);
  withEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
  writeFileSync(join(root, "go.mod"), "module example.com/calc\n\ngo 1.22\n");
  writeFileSync(join(root, "calc.go"), "package calc\n\nfunc Add(a, b int) int { return a + b }\n");
  const behavior = makeNode({
    kind: "UserFlow",
    external_id: "flow:calc-add",
    title: "Add sums two numbers",
    properties: { area: "calc", example_behaviors: ["add sums"] },
    evidence_strength: "candidate",
    review_status: "auto_detected",
    confidence: 0.6,
    provenance: provenance("calc_test.go")
  });
  const file = makeNode({
    kind: "File",
    external_id: "calc.go",
    title: "calc.go",
    properties: { role: "code", language: "go", file: "calc.go" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: provenance("calc.go")
  });
  const edge = makeEdge({
    from_external_id: behavior.external_id,
    to_external_id: file.external_id,
    relationship_type: "IMPLEMENTED_IN",
    evidence_strength: "hard",
    review_status: "auto_detected",
    provenance: provenance("calc.go")
  });
  const provider: ModelProvider = {
    providerName: "fake",
    modelName: "go-add",
    complete: async () => ["package calc", "", 'import "testing"', "", "func TestAdd(t *testing.T) {", "  if Add(1, 2) != 3 {", '    t.Errorf("want 3")', "  }", "}"].join("\n")
  };
  return { root, marker, graph: graphFor(root, [behavior, file], [edge]), behaviorId: behavior.external_id, provider };
}

describe("static-only switch", () => {
  it("reads 1, true and yes as on, anything else as off", () => {
    expect(isStaticOnly({ [STATIC_ONLY_ENV]: "1" })).toBe(true);
    expect(isStaticOnly({ [STATIC_ONLY_ENV]: "TRUE" })).toBe(true);
    expect(isStaticOnly({ [STATIC_ONLY_ENV]: "yes" })).toBe(true);
    expect(isStaticOnly({ [STATIC_ONLY_ENV]: "0" })).toBe(false);
    expect(isStaticOnly({})).toBe(false);
  });
});

describe("Go draft check", () => {
  it("starts go to compile-check a Go draft in a normal run (the risk static-only removes)", async () => {
    const fx = goFixture();
    const result = await generateTests(fx.graph, { target_ids: [fx.behaviorId], limit: 1 }, fx.provider, (rel) => (rel === "calc.go" ? readFileSync(join(fx.root, rel), "utf8") : null), CLOCK);
    expect(result.generated_tests).toHaveLength(1);
    expect(existsSync(fx.marker)).toBe(true);
  });

  it("never starts go in static-only mode, and says the draft was not compile-checked", async () => {
    const fx = goFixture();
    const result = await generateTests(
      fx.graph,
      { target_ids: [fx.behaviorId], limit: 1, static_only: true },
      fx.provider,
      (rel) => (rel === "calc.go" ? readFileSync(join(fx.root, rel), "utf8") : null),
      CLOCK
    );
    const test = result.generated_tests[0];
    expect(existsSync(fx.marker)).toBe(false);
    expect(test.body).toContain("func TestAdd");
    expect(test.runnable).toBe(false);
    expect(test.unresolved_reason).toBe(NOT_COMPILE_CHECKED);
    expect(classifyGeneratedDraftBlocker(test.unresolved_reason)).toBe("not_compile_checked");
    expect(generatedDraftRemediation(test.unresolved_reason)).toContain("static-only");
  });
});

describe("Python draft check", () => {
  const hasPython = spawnSync("python3", ["--version"]).status === 0;
  it.skipIf(!hasPython)("does not import a repository's ast.py or py_compile.py from the working directory", async () => {
    const repo = tempDir("opro-static-py-");
    const marker = join(repo, "repo-python-ran");
    for (const name of ["ast.py", "py_compile.py"]) {
      writeFileSync(join(repo, name), `open(${JSON.stringify(marker)}, "a").write(${JSON.stringify(name)})\n`);
    }
    const before = process.cwd();
    process.chdir(repo);
    cleanups.push(() => process.chdir(before));
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/service.py#process_payment",
      title: "process_payment",
      properties: { file: "src/service.py", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/service.py"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/service.py",
      title: "service.py",
      properties: { role: "code", language: "python", file: "src/service.py" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/service.py")
    });
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "good-python",
      complete: async () => "def test_process_payment():\n    assert process_payment() is True\n"
    };
    const result = await generateTests(
      graphFor(repo, [symbol, file]),
      { target_ids: [symbol.external_id], limit: 1 },
      provider,
      (rel) => (rel === "src/service.py" ? "def process_payment():\n    return True\n" : null),
      CLOCK
    );
    expect(existsSync(marker)).toBe(false);
    expect(result.generated_tests[0].runnable).toBe(true);
  });
});

describe("proof budget and static-only in auto-prove", () => {
  const neverCalled = {
    clock: CLOCK,
    proveLoop: () => {
      throw new Error("proveLoop must not run");
    },
    generate: () => {
      throw new Error("generate must not run");
    }
  };

  it("makes no attempt when the proof budget is 0", async () => {
    const res = await autoProve("/nonexistent", { autoLimit: 0 }, { ...neverCalled, env: {} } as never);
    expect(res.status).toBe("disabled");
    expect(res.attempted).toBe(0);
    expect(res.reason).toContain("--proof-limit 0");
  });

  it("makes no attempt in static-only mode, whatever the budget", async () => {
    const res = await autoProve("/nonexistent", { autoLimit: 5 }, { ...neverCalled, env: { [STATIC_ONLY_ENV]: "1" } } as never);
    expect(res.status).toBe("disabled");
    expect(res.attempted).toBe(0);
    expect(res.reason).toContain("static-only");
  });
});

describe("backstops: what starts repository code refuses in static-only mode", () => {
  it("the container executor returns the refusal without starting docker", () => {
    const dir = tempDir("opro-static-docker-");
    const marker = join(dir, "docker-was-run");
    const docker = join(dir, "docker");
    writeFileSync(docker, `#!/usr/bin/env sh\ntouch '${marker}'\nexit 0\n`);
    chmodSync(docker, 0o755);
    withEnv(STATIC_ONLY_ENV, "1");
    const res = dockerExecutor(docker)({ shape: { image: "i", platform: "p", memory: "1g", cpus: "1", processes: 64, deadlineSeconds: 10 }, mounts: [], env: {}, workdir: "/work/repo", command: ["npm", "test"], deadlineMs: 1000 });
    expect(res.stderr).toBe(STATIC_ONLY_REFUSAL);
    expect(res.exitCode).toBeNull();
    expect(existsSync(marker)).toBe(false);
  });

  it("a coverage run is refused", () => {
    const root = tempDir("opro-static-cov-");
    writeFileSync(join(root, "go.mod"), "module example.com/cov\n\ngo 1.22\n");
    writeFileSync(join(root, "a.go"), "package cov\n\nfunc A() int { return 1 }\n");
    writeFileSync(join(root, "a_test.go"), 'package cov\n\nimport "testing"\n\nfunc TestA(t *testing.T) { if A() != 1 { t.Fatal() } }\n');
    withEnv(STATIC_ONLY_ENV, "1");
    const res = prepareRuntimeCoverage(root, { generate: true, timeoutMs: 1000 });
    expect(JSON.stringify(res)).toContain("Static-only mode");
  });

  it("the dynamic proof runner throws", () => {
    withEnv(STATIC_ONLY_ENV, "1");
    expect(() => defaultDynamicProofRunner(["--help"])).toThrow(/Static-only mode/);
  });
});
