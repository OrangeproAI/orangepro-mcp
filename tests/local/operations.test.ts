import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  opAnalyze,
  opDynamicProof,
  opExport,
  opInit,
  opRecordRun,
  opRtm,
  opScore,
  opStats,
  opStart,
  opStatus,
  autoProveChangedScope,
  isInstallArtifact
} from "../../src/local/operations.js";
import { makeNode } from "../../src/local/graph/factories.js";
import type { LocalGraph } from "../../src/local/graph/ontology.js";
import type { ChangedResult } from "../../src/local/types.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
import { runHintsFor } from "../../src/local/generate/runHints.js";
import type { GeneratedTest } from "../../src/local/graph/ontology.js";
import type { ModelCompletionRequest, ModelProvider } from "../../src/local/types.js";
import { loadGraph, workspacePaths } from "../../src/local/workspace.js";
import { setProgressReporter } from "../../src/local/util/progress.js";

// Deterministic + offline: fixed clock and an EMPTY env so no provider keys
// exist (forces the offline DeterministicProvider; no network/LLM calls).
const deps = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };

// Track temp dirs so each test cleans up only what it created.
const tempDirs: string[] = [];

beforeAll(async () => {
  await preloadTreeSitter(["go", "python"]);
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "oplocal-"));
  tempDirs.push(dir);
  return dir;
}

/** Write a tiny but analyzable fixture (code with extractable symbols + a manifest). */
function writeFixture(dir: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "fixture-app", version: "1.0.0" }, null, 2),
    "utf8"
  );
  writeFileSync(
    join(dir, "service.ts"),
    [
      "export function createOrder(id: string): string {",
      "  return `order-${id}`;",
      "}",
      "",
      "export class OrderService {",
      "  place(orderId: string): boolean {",
      "    return Boolean(orderId);",
      "  }",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
}

function writeStartFixture(dir: string): void {
  writeFixture(dir);
  writeFileSync(
    join(dir, "requirements.md"),
    [
      "# Feature discount flow",
      "",
      "## Acceptance Criteria",
      "",
      "- Discount is applied over the threshold.",
      ""
    ].join("\n"),
    "utf8"
  );
}

class PromptLinkProvider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-linker";
  calls = 0;

  async complete(req: ModelCompletionRequest): Promise<string> {
    this.calls++;
    const behaviorId = /"id":\s*"(REQ[^"]+)"/.exec(req.user)?.[1] ?? "missing-behavior";
    const symbolId = /"id":\s*"(sym:[^"]+)"/.exec(req.user)?.[1] ?? "missing-symbol";
    return JSON.stringify({
      links: [{ behavior_id: behaviorId, symbol_id: symbolId, confidence: 0.7, rationale: "closed-set fixture link" }]
    });
  }
}

class HybridAiProvider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-hybrid";
  calls: string[] = [];

  async complete(req: ModelCompletionRequest): Promise<string> {
    if (req.user.includes("BEHAVIOR_CANDIDATES:")) {
      this.calls.push("links");
      const behaviorId = /"id":\s*"([^"]+)"/.exec(req.user)?.[1] ?? "missing-behavior";
      const symbolId = /"id":\s*"(sym:[^"]+)"/.exec(req.user)?.[1] ?? "missing-symbol";
      return JSON.stringify({ links: [{ behavior_id: behaviorId, symbol_id: symbolId, confidence: 0.7, rationale: "closed-set fixture link" }] });
    }

    this.calls.push("flows");
    const entries = JSON.parse(req.user.split("ENTRY_POINTS:\n")[1].split("\n\nSYMBOLS:\n")[0]);
    const symbols = JSON.parse(req.user.split("SYMBOLS:\n")[1]);
    const entry = entries[0];
    const hop = symbols.find((s: { id: string }) => s.id !== entry.start)?.id ?? symbols[0]?.id;
    return JSON.stringify({ flows: [{ entry_id: entry.id, hop_ids: [hop], title: "Candidate service chain", rationale: "closed-set fixture flow", confidence: 0.7 }] });
  }
}

afterEach(() => {
  setProgressReporter(null);
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("operations round trip", () => {
  it("init → analyze → status → score → export produces a valid pack", () => {
    const W = makeTempDir();
    writeFixture(W);

    const init = opInit(W, deps);
    expect(existsSync(init.config_path)).toBe(true);

    // Analyze the workspace itself as the source.
    const analyze = opAnalyze(W, { source: W }, deps);
    expect(analyze.entities_count).toBeGreaterThan(0);
    expect(existsSync(analyze.graph_path)).toBe(true);

    const status = opStatus(W, deps);
    expect(status.workspace_initialized).toBe(true);
    expect(status.local_only).toBe(true);

    const score = opScore(W);
    expect(typeof score.overall).toBe("number");

    const exported = opExport(W, "pack.json", {}, deps);
    expect(exported.validation.valid).toBe(true);
    expect(exported.validation.errors).toEqual([]);
    expect(existsSync(exported.pack_path)).toBe(true);
    expect(existsSync(join(W, "pack.json"))).toBe(true);
  });
});

describe("start orchestration", () => {
  it("runs the deterministic one-command flow and skips AI when no provider is configured", async () => {
    const W = makeTempDir();
    writeStartFixture(W);

    const res = await opStart(W, { source: W }, deps);

    expect(existsSync(res.behavior_coverage_path ?? "")).toBe(true);
    expect(existsSync(res.rtm.rtm_path)).toBe(true);
    expect(existsSync(join(W, ".orangepro", "COVERAGE_REPORT.md"))).toBe(true);
    expect(res.ai_links).toMatchObject({ status: "skipped" });
    expect(res.ai_flows).toMatchObject({ status: "skipped" });
    expect(res.rtm.summary.proven).toBe(0);
    expect(res.next_actions.join("\n")).toContain("Dynamically Proven is 0 because no dynamic proof has closed yet");
    expect(res.next_actions.join("\n")).toContain("orangepro_generate_tests");
    expect(res.next_actions.join("\n")).toContain("prove_run");
    expect(res.rtm.summary.total).toBeGreaterThan(0);
  });

  it("writes a static behavior report and RTM immediately after deterministic analysis", async () => {
    const W = makeTempDir();
    writeStartFixture(W);
    const messages: string[] = [];
    setProgressReporter((msg) => messages.push(msg));

    const res = await opStart(W, { source: W }, deps);

    const graphReady = messages.indexOf("start: deterministic graph is ready");
    const staticHtml = messages.indexOf("artifacts: writing static behavior view (proof still running)");
    const staticRtm = messages.indexOf("artifacts: writing static RTM (proof still running)");
    const autoProve = messages.indexOf("auto-prove: driving generate → prove on the top provable targets");
    const finalHtml = messages.indexOf("artifacts: writing behavior coverage view");
    expect(graphReady).toBeGreaterThanOrEqual(0);
    expect(staticHtml).toBeGreaterThan(graphReady);
    expect(staticRtm).toBeGreaterThan(staticHtml);
    expect(autoProve).toBeGreaterThan(staticRtm);
    expect(finalHtml).toBeGreaterThan(autoProve);
    expect(existsSync(res.behavior_coverage_path ?? "")).toBe(true);
    expect(existsSync(res.rtm.rtm_path)).toBe(true);
  });

  it("compares the final report with the previous completed start run", async () => {
    const W = makeTempDir();
    writeStartFixture(W);
    await opStart(W, { source: W, ai: false, noAuto: true }, deps);

    const baselinePath = join(W, ".orangepro", "report-baseline.json");
    const first = JSON.parse(readFileSync(baselinePath, "utf8")) as { summary: { total: number } };
    const servicePath = join(W, "service.ts");
    writeFileSync(
      servicePath,
      `${readFileSync(servicePath, "utf8")}\nexport function refundOrder(id: string): boolean {\n  return Boolean(id);\n}\n`,
      "utf8"
    );

    const second = await opStart(W, { source: W, ai: false, noAuto: true }, deps);
    const html = readFileSync(second.behavior_coverage_path ?? "", "utf8");
    const finalBaseline = JSON.parse(readFileSync(baselinePath, "utf8")) as { summary: { total: number } };

    expect(finalBaseline.summary.total).toBe(first.summary.total + 1);
    expect(html).toContain('"changed":true');
    expect(html).toContain('"totalDelta":1');
  });

  it("auto-applies AI candidate links when a provider is configured without changing deterministic RTM status", async () => {
    const W = makeTempDir();
    writeStartFixture(W);
    const provider = new PromptLinkProvider();

    const res = await opStart(W, { source: W, aiFlows: false, noAuto: true }, { ...deps, aiProvider: provider });
    const graph = loadGraph(workspacePaths(W).graphPath);

    expect(provider.calls).toBe(1);
    expect(res.ai_links.status).toBe("applied");
    expect(res.ai_linked.links).toBeGreaterThan(0);
    expect(res.ai_linked.behaviors).toBeGreaterThan(0);
    expect(res.ai_linked.symbols).toBeGreaterThan(0);
    expect(res.analyze.ai_linked).toEqual(res.ai_linked);
    expect(res.analyze.candidate_relationships_count).toBe(graph.candidate_edges.length);
    expect(graph.candidate_edges.some((e) => e.review_status === "ai_suggested")).toBe(true);
    expect(res.rtm.rows.some((r) => r.status === "Associated signal")).toBe(false);
    expect(res.rtm.rows.some((r) => r.status === "No integration signal")).toBe(true);
  });

  it("auto-applies AI candidate flows during start when a provider is configured without changing Proven", async () => {
    const W = makeTempDir();
    writeFileSync(join(W, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0" }), "utf8");
    writeFileSync(
      join(W, "service.ts"),
      [
        "export function createOrder(id: string): string {",
        "  return persistOrder(id);",
        "}",
        "",
        "export function persistOrder(id: string): string {",
        "  return `order-${id}`;",
        "}",
        ""
      ].join("\n"),
      "utf8"
    );
    const provider = new HybridAiProvider();

    const res = await opStart(W, { source: W, noAuto: true }, { ...deps, aiProvider: provider });
    const graph = loadGraph(workspacePaths(W).graphPath);

    expect(provider.calls).toEqual(["flows"]);
    expect(res.ai_flows.status).toBe("applied");
    expect(graph.analysis?.candidate_flows?.flows.length).toBeGreaterThan(0);
    expect(res.analyze.analysis.candidate_flows?.flows.length).toBeGreaterThan(0);
    expect(existsSync(res.behavior_coverage_path ?? "")).toBe(true);
    expect(readFileSync(res.behavior_coverage_path ?? "", "utf8")).toContain("AI-suggested flows");
    expect(res.rtm.summary.proven).toBe(0);
    expect(res.next_actions.join("\n")).toContain("AI-suggested flows");
  });

  it("runs coverage before analyze and calls AI only after the runtime-covered graph is saved", async () => {
    const W = makeTempDir();
    const events: string[] = [];
    writeFileSync(join(W, "go.mod"), "module example.com/app\n\ngo 1.22\n", "utf8");
    mkdirSync(join(W, "svc"), { recursive: true });
    writeFileSync(
      join(W, "svc", "math.go"),
      ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n"),
      "utf8"
    );
    writeFileSync(
      join(W, "requirements.md"),
      ["# Calculator behavior", "", "## Acceptance Criteria", "", "- Add returns a sum.", ""].join("\n"),
      "utf8"
    );

    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "fake-linker",
      async complete(req) {
        events.push("ai");
        const savedGraph = loadGraph(workspacePaths(W).graphPath);
        events.push(savedGraph.analysis?.runtime_coverage?.covered_symbols === 1 ? "ai-saw-runtime-graph" : "ai-missed-runtime-graph");
        const body = JSON.parse(req.user.split("BEHAVIOR_CANDIDATES:\n")[1]);
        const first = body[0];
        return JSON.stringify({
          links: [{
            behavior_id: first.behavior.id,
            symbol_id: first.code_symbols[0].id,
            confidence: 0.7,
            rationale: "fixture closed-set link"
          }]
        });
      }
    };

    const res = await opStart(
      W,
      { source: W, generateCoverage: true, aiFlows: false, noAuto: true },
      {
        ...deps,
        aiProvider: provider,
        coverageRunner: (_cwd, _command, args) => {
          events.push("coverage");
          const coverArg = args.find((a) => a.startsWith("-coverprofile="));
          if (coverArg) writeFileSync(coverArg.slice("-coverprofile=".length), ["mode: set", "svc/math.go:2.24,4.2 1 1"].join("\n"), "utf8");
          return { status: 0, stdout: "", stderr: "" };
        }
      }
    );

    expect(events).toEqual(["coverage", "ai", "ai-saw-runtime-graph"]);
    expect(res.ai_links.status).toBe("applied");
    expect(res.ai_linked.links).toBeGreaterThan(0);
    expect(res.analyze.analysis.runtime_coverage).toMatchObject({ covered_symbols: 1, covered_pct: 100 });
    expect(res.rtm.summary).toMatchObject({ proven: 0, runtime_covered: 1 });
  });

  it("writes a capped RTM from start while explicit rtm remains full", async () => {
    const W = makeTempDir();
    writeFileSync(join(W, "go.mod"), "module example.com/app\n\ngo 1.22\n", "utf8");
    mkdirSync(join(W, "svc"), { recursive: true });
    writeFileSync(
      join(W, "svc", "many.go"),
      [
        "package svc",
        "func Add(a, b int) int { return a + b }",
        "func RuntimeOnly() int {",
        "  return 42",
        "}",
        ...Array.from({ length: 520 }, (_, i) => `func Behavior${i}() int { return ${i} }`)
      ].join("\n"),
      "utf8"
    );
    writeFileSync(
      join(W, "svc", "many_test.go"),
      [
        "package svc",
        "import \"testing\"",
        "func TestAdd(t *testing.T) {",
        "  if got := Add(1, 2); got != 3 { t.Fatalf(\"got %d\", got) }",
        "}"
      ].join("\n"),
      "utf8"
    );

    const started = await opStart(
      W,
      { source: W, ai: false, generateCoverage: true },
      {
        ...deps,
        // This test exercises RTM capping, not proving. Since auto-drive now attempts Go
        // free-function targets (Add/TestAdd here), stub the prove runner so it stays fast and
        // toolchain-independent instead of spawning a real `go test`.
        dynamicProofRunner: () => ({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ status: "associated_survived", proven: false, reason: "stubbed for RTM-capping test" })
        }),
        coverageRunner: (_cwd, _command, args) => {
          const coverArg = args.find((a) => a.startsWith("-coverprofile="));
          if (coverArg) writeFileSync(coverArg.slice("-coverprofile=".length), ["mode: set", "svc/many.go:3.24,5.2 1 1"].join("\n"), "utf8");
          return { status: 0, stdout: "", stderr: "" };
        }
      }
    );
    const full = opRtm(W, { format: "json" });
    const rtmMd = readFileSync(started.rtm.rtm_path, "utf8");

    expect(started.rtm.summary.total).toBeGreaterThan(500);
    expect(started.rtm.rows).toHaveLength(500);
    expect(full.rows).toHaveLength(started.rtm.summary.total);
    expect(started.rtm.summary).toEqual(full.summary);
    expect(started.rtm.summary.proven).toBe(0);
    expect(started.rtm.summary.runtime_covered).toBe(1);
    expect(rtmMd).toContain("Showing 500 row(s)");
    expect(started.next_actions.some((action) => action.includes("rtm-full.json"))).toBe(true);
  });
});

describe("runtime coverage generation", () => {
  it("can generate a local Go coverprofile before analyze and ingest it as runtime coverage", () => {
    const W = makeTempDir();
    writeFileSync(join(W, "go.mod"), "module example.com/app\n\ngo 1.22\n", "utf8");
    mkdirSync(join(W, "svc"), { recursive: true });
    writeFileSync(join(W, "svc", "math.go"), ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n"), "utf8");

    opInit(W, deps);
    const analyze = opAnalyze(
      W,
      { source: W, generateCoverage: true },
      {
        ...deps,
        coverageRunner: (_cwd, _command, args) => {
          const coverArg = args.find((a) => a.startsWith("-coverprofile="));
          if (coverArg) writeFileSync(coverArg.slice("-coverprofile=".length), ["mode: set", "svc/math.go:2.24,4.2 1 1"].join("\n"), "utf8");
          return { status: 0, stdout: "", stderr: "" };
        }
      }
    );

    expect(analyze.analysis.runtime_coverage).toMatchObject({
      artifacts: [{ path: ".orangepro/coverage/go-root.coverprofile", format: "go-coverprofile", files: 1, covered_ranges: 1 }],
      covered_symbols: 1,
      covered_pct: 100
    });
    expect(analyze.warnings).toContain("coverage artifact generated for go module .: .orangepro/coverage/go-root.coverprofile");
  });

  it("runs coverage generation before creating workspace ignore files on fresh analyze", () => {
    const W = makeTempDir();
    writeFileSync(join(W, "go.mod"), "module example.com/app\n\ngo 1.22\n", "utf8");
    mkdirSync(join(W, "svc"), { recursive: true });
    writeFileSync(join(W, "svc", "math.go"), ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n"), "utf8");
    let ignoreExistedDuringCoverage = true;

    opAnalyze(
      W,
      { source: W, generateCoverage: true },
      {
        ...deps,
        coverageRunner: (_cwd, _command, args) => {
          ignoreExistedDuringCoverage = existsSync(join(W, ".orangeproignore"));
          const coverArg = args.find((a) => a.startsWith("-coverprofile="));
          if (coverArg) writeFileSync(coverArg.slice("-coverprofile=".length), ["mode: set", "svc/math.go:2.24,4.2 1 1"].join("\n"), "utf8");
          return { status: 0, stdout: "", stderr: "" };
        }
      }
    );

    expect(ignoreExistedDuringCoverage).toBe(false);
    expect(existsSync(join(W, ".orangeproignore"))).toBe(true);
  });

  it("creates product-denominator ignore defaults that exclude example app code", () => {
    const W = makeTempDir();
    mkdirSync(join(W, "src"), { recursive: true });
    mkdirSync(join(W, "examples"), { recursive: true });
    writeFileSync(join(W, "src", "store.ts"), "export function createStore() { return new Map(); }\n", "utf8");
    writeFileSync(join(W, "examples", "demo.ts"), "export function demoOnly() { return createStore(); }\n", "utf8");

    const res = opAnalyze(W, { source: W }, deps);
    const ignore = readFileSync(join(W, ".orangeproignore"), "utf8");
    const graph = loadGraph(res.graph_path);
    const files = graph.nodes.filter((n) => n.kind === "CodeSymbol").map((n) => String(n.properties.file ?? ""));

    expect(ignore).toContain("examples/");
    expect(files).toContain("src/store.ts");
    expect(files.some((f) => f.startsWith("examples/"))).toBe(false);
  });
});

describe("gap-fill ledger", () => {
  it("records static reprove diagnostics and keeps vacuous attempts open", () => {
    const W = makeTempDir();
    writeFileSync(join(W, "go.mod"), "module example.com/app\n\ngo 1.22\n", "utf8");
    mkdirSync(join(W, "svc"), { recursive: true });
    writeFileSync(
      join(W, "svc", "math.go"),
      [
        "package svc",
        "func Add(a, b int) int { return a + b }",
        "func Sub(a, b int) int { return a - b }"
      ].join("\n"),
      "utf8"
    );

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    writeFileSync(
      join(W, "svc", "math_test.go"),
      [
        "package svc",
        "import \"testing\"",
        "func TestAdd(t *testing.T) {",
        "  if got := Add(1, 2); got != 3 { t.Fatalf(\"got %d\", got) }",
        "}"
      ].join("\n"),
      "utf8"
    );

    const add = opRecordRun(W, {
      target_symbol: "sym:svc/math.go#Add",
      source: W,
      test_path: "svc/math_test.go",
      agent_pass: true,
      evidence_ids: ["gt-1"],
      provider: "deterministic",
      model: "fixture",
      prompt_version: "test"
    }, deps);
    expect(add.record).toMatchObject({
      run_id: "run:000001",
      status: "unproven",
      reprove_mode: "full",
      closed: false,
      pre_edge_count: 0,
      new_edges: ["test:svc/math_test.go->sym:svc/math.go#Add"]
    });

    writeFileSync(
      join(W, "svc", "sub_test.go"),
      [
        "package svc",
        "import \"testing\"",
        "func TestSubSmoke(t *testing.T) {",
        "  t.Log(\"smoke\")",
        "}"
      ].join("\n"),
      "utf8"
    );

    const sub = opRecordRun(W, {
      target_symbol: "sym:svc/math.go#Sub",
      source: W,
      agent_pass: true,
      vacuous: true,
      evidence_ids: ["gt-2"]
    }, deps);
    expect(sub.record).toMatchObject({
      run_id: "run:000002",
      status: "unproven",
      closed: false,
      vacuous: true,
      pre_edge_count: 0,
      new_edges: []
    });

    const stats = opStats(W);
    expect(stats).toMatchObject({
      records: 2,
      attempted: 2,
      reproven: 0,
      unproven: 2,
      generated_unverifiable: 0,
      quality_adjusted_kept_rate: 0
    });

    const ledgerText = readFileSync(add.ledger_path, "utf8");
    expect(ledgerText).not.toContain("return a + b");
    expect(ledgerText).not.toContain("Add(1, 2)");
    expect(ledgerText).toContain("sym:svc/math.go#Add");

    const exported = opExport(W, "pack.json", {}, deps);
    const packText = readFileSync(exported.pack_path, "utf8");
    expect(packText).not.toContain("ledger");
    expect(packText).not.toContain("gt-1");
    expect(packText).not.toContain("run:000001");
  });

  it("uses scoped deterministic re-prove for an explicit TS/JS test path and patches the current graph", () => {
    const W = makeTempDir();
    writeFixture(W);

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    writeFileSync(
      join(W, "service.test.ts"),
      [
        "import { describe, expect, it } from 'vitest';",
        "import { createOrder } from './service';",
        "",
        "describe('createOrder', () => {",
        "  it('returns the order id', () => {",
        "    expect(createOrder('123')).toBe('order-123');",
        "  });",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );

    const analyzeSpy = vi.fn(opAnalyze);
    const result = opRecordRun(W, {
      target_symbol: "sym:service.ts#createOrder",
      source: W,
      test_path: "service.test.ts",
      agent_pass: true
    }, { ...deps, analyze: analyzeSpy });

    expect(result.record).toMatchObject({
      status: "unproven",
      reprove_mode: "scoped",
      closed: false,
      new_edges: ["test:service.test.ts->sym:service.ts#createOrder"]
    });
    expect(result.record.reprove_reason).toContain("Scoped confirmer");
    expect(analyzeSpy).not.toHaveBeenCalled();

    const graph = JSON.parse(readFileSync(join(W, ".orangepro", "graph.json"), "utf8"));
    expect(graph.nodes.some((n: { external_id: string; kind: string }) => n.external_id === "test:service.test.ts" && n.kind === "TestCase")).toBe(true);
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from_external_id: "test:service.test.ts",
          to_external_id: "sym:service.ts#createOrder",
          relationship_type: "COVERS",
          evidence_strength: "hard"
        }),
        expect.objectContaining({
          from_external_id: "sym:service.ts#createOrder",
          to_external_id: "test:service.test.ts",
          relationship_type: "TESTED_BY",
          evidence_strength: "hard"
        })
      ])
    );

    const rtm = opRtm(W, { format: "json" });
    const row = rtm.rows.find((r) => r.behavior_id === "sym:service.ts#createOrder");
    expect(row?.status).toBe("Associated signal");
    expect(row?.test_signal).toContain("static candidate:");
  });

  it("mints public Proven only from a closed dynamic targeted proof certificate", () => {
    const W = makeTempDir();
    writeFixture(W);

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    let capturedArgs: string[] = [];
    const result = opDynamicProof(W, {
      target_symbol: "sym:service.ts#createOrder",
      source: W,
      test_path: "service.test.ts",
      target_path: "service.ts",
      method: "createOrder",
      replacement: "return null;",
      runner: "vitest",
      run_id: "run:dynamic-1"
    }, {
      ...deps,
      dynamicProofRunner: (args) => {
        capturedArgs = args;
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            status: "proven",
            proven: true,
            reason: "baseline passed and mutant failed at an assertion",
            runner: "vitest",
            replacementMode: "return-json",
            test: "service.test.ts",
            target: "service.ts",
            method: "createOrder",
            baseline: { exitCode: 0, timedOut: false, failureSummary: null },
            mutant: {
              exitCode: 1,
              timedOut: false,
              assertionFailure: true,
              failureSummary: "AssertionError: secret should not be persisted"
            },
            medianProofMs: 12
          })
        };
      }
    });

    expect(capturedArgs).toEqual(expect.arrayContaining(["--json", "--runner", "vitest", "--replacement", "return null;"]));
    expect(result.record).toMatchObject({
      run_id: "run:dynamic-1",
      target_symbol: "sym:service.ts#createOrder",
      status: "reproven",
      closed: true,
      new_edges: [],
      dynamic_proof: {
        proof_kind: "dynamic_targeted",
        baseline_green: true,
        mutant_failed_assertion: true,
        target_not_mocked: true,
        sentinel: "return-json",
        runner: "vitest",
        test_path: "service.test.ts",
        mutant_status: "proven"
      }
    });
    expect(result.oracle.mutant).toEqual({ exitCode: 1, timedOut: false, assertionFailure: true });
    expect(JSON.stringify(result)).not.toContain("secret should not be persisted");

    const ledgerText = readFileSync(result.ledger_path, "utf8");
    expect(ledgerText).toContain("\"dynamic_proof\"");
    expect(ledgerText).not.toContain("secret should not be persisted");

    const rtm = opRtm(W, { format: "json" });
    expect(rtm.summary.proven).toBe(1);
    const row = rtm.rows.find((r) => r.behavior_id === "sym:service.ts#createOrder");
    expect(row?.evidence_tier).toBe("proven");
    expect(row?.status).toBe("Reproven (this run)");
  });

  it("records dynamic attempts without minting Proven when the mutant survives", () => {
    const W = makeTempDir();
    writeFixture(W);

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    const result = opDynamicProof(W, {
      target_symbol: "sym:service.ts#createOrder",
      source: W,
      test_path: "service.test.ts",
      target_path: "service.ts",
      method: "createOrder",
      replacement: "return \"order-123\";",
      run_id: "run:dynamic-survived"
    }, {
      ...deps,
      dynamicProofRunner: () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          status: "associated_survived",
          proven: false,
          reason: "mutated target did not change the test outcome",
          runner: "vitest",
          replacementMode: "return-json",
          test: "service.test.ts",
          target: "service.ts",
          method: "createOrder",
          baseline: { exitCode: 0, timedOut: false },
          mutant: { exitCode: 0, timedOut: false, assertionFailure: false },
          medianProofMs: 9
        })
      })
    });

    expect(result.record).toMatchObject({
      run_id: "run:dynamic-survived",
      status: "unproven",
      closed: false,
      dynamic_proof: {
        proof_kind: "dynamic_targeted",
        baseline_green: true,
        mutant_failed_assertion: false,
        target_not_mocked: false,
        mutant_status: "associated_survived"
      }
    });

    const rtm = opRtm(W, { format: "json" });
    expect(rtm.summary.proven).toBe(0);
    const row = rtm.rows.find((r) => r.behavior_id === "sym:service.ts#createOrder");
    expect(row?.evidence_tier).not.toBe("proven");
  });

  it("rejects dynamic proof target mismatches before running the oracle", () => {
    const W = makeTempDir();
    writeFixture(W);

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    const runner = vi.fn(() => ({ exitCode: 0, stderr: "", stdout: "{}" }));
    expect(() =>
      opDynamicProof(W, {
        target_symbol: "sym:service.ts#OrderService.place",
        source: W,
        test_path: "service.test.ts",
        target_path: "service.ts",
        method: "createOrder",
        replacement: "return false;"
      }, { ...deps, dynamicProofRunner: runner })
    ).toThrow("does not match resolved symbol member place");
    expect(runner).not.toHaveBeenCalled();

    expect(() =>
      opDynamicProof(W, {
        target_symbol: "sym:service.ts#createOrder",
        source: W,
        test_path: "service.test.ts",
        target_path: "other.ts",
        method: "createOrder",
        replacement: "return null;"
      }, { ...deps, dynamicProofRunner: runner })
    ).toThrow("does not match resolved symbol file service.ts");
    expect(runner).not.toHaveBeenCalled();
  });

  it("rejects dynamic proof source roots that do not match the analyzed graph root", () => {
    const W = makeTempDir();
    const other = makeTempDir();
    writeFixture(W);
    writeFixture(other);
    writeFileSync(
      join(other, "service.test.ts"),
      "import { expect, it } from 'vitest';\nimport { createOrder } from './service';\nit('other checkout', () => expect(createOrder('x')).toBe('order-x'));\n",
      "utf8"
    );

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);
    const runner = vi.fn();

    expect(() =>
      opDynamicProof(W, {
        target_symbol: "sym:service.ts#createOrder",
        source: other,
        test_path: "service.test.ts",
        replacement: "return null;"
      }, { ...deps, dynamicProofRunner: runner })
    ).toThrow("prove source mismatch");
    expect(runner).not.toHaveBeenCalled();
  });

  it("derives the mutation file and method from the credited target symbol", () => {
    const W = makeTempDir();
    writeFixture(W);

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    let capturedArgs: string[] = [];
    opDynamicProof(W, {
      target_symbol: "sym:service.ts#OrderService.place",
      source: W,
      test_path: "service.test.ts",
      replacement: "return false;"
    }, {
      ...deps,
      dynamicProofRunner: (args) => {
        capturedArgs = args;
        return {
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({
            status: "associated_survived",
            proven: false,
            runner: "vitest",
            replacementMode: "return-json",
            test: "service.test.ts",
            target: "service.ts",
            method: "place",
            baseline: { exitCode: 0, timedOut: false },
            mutant: { exitCode: 0, timedOut: false, assertionFailure: false }
          })
        };
      }
    });

    expect(capturedArgs).toEqual(expect.arrayContaining(["--target", "service.ts", "--method", "place"]));
  });

  it("keeps baseline failures and non-assertion mutant failures unproven", () => {
    const W = makeTempDir();
    writeFixture(W);

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    const baselineFailed = opDynamicProof(W, {
      target_symbol: "sym:service.ts#createOrder",
      source: W,
      test_path: "service.test.ts",
      replacement: "return null;",
      run_id: "run:baseline-failed"
    }, {
      ...deps,
      dynamicProofRunner: () => ({
        exitCode: 2,
        stderr: "",
        stdout: JSON.stringify({
          status: "unrunnable",
          proven: false,
          reason: "baseline test did not pass",
          runner: "vitest",
          replacementMode: "return-json",
          baseline: { exitCode: 1, timedOut: false },
          mutant: { exitCode: 1, timedOut: false, assertionFailure: false }
        })
      })
    });
    expect(baselineFailed.record).toMatchObject({
      status: "unproven",
      closed: false,
      dynamic_proof: {
        baseline_green: false,
        mutant_failed_assertion: false,
        target_not_mocked: false,
        mutant_status: "unrunnable"
      }
    });

    const runtimeFailed = opDynamicProof(W, {
      target_symbol: "sym:service.ts#createOrder",
      source: W,
      test_path: "service.test.ts",
      replacement: "return null;",
      run_id: "run:runtime-failed"
    }, {
      ...deps,
      dynamicProofRunner: () => ({
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          status: "associated_non_assertion_failure",
          proven: false,
          reason: "mutant failed, but not with a trusted assertion failure",
          runner: "vitest",
          replacementMode: "return-json",
          baseline: { exitCode: 0, timedOut: false },
          mutant: { exitCode: 1, timedOut: false, assertionFailure: false }
        })
      })
    });
    expect(runtimeFailed.record).toMatchObject({
      status: "unproven",
      closed: false,
      dynamic_proof: {
        baseline_green: true,
        mutant_failed_assertion: false,
        target_not_mocked: false,
        mutant_status: "associated_non_assertion_failure"
      }
    });

    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);
  });

  it("rejects malformed dynamic proof output without leaking secrets", () => {
    const W = makeTempDir();
    writeFixture(W);

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    expect(() =>
      opDynamicProof(W, {
        target_symbol: "sym:service.ts#createOrder",
        source: W,
        test_path: "service.test.ts",
        replacement: "return null;"
      }, {
        ...deps,
        dynamicProofRunner: () => ({
          exitCode: 1,
          stdout: "not json",
          stderr: "api_key=super-secret-value"
        })
      })
    ).toThrow(/<redacted:credential>/);
    expect(() =>
      opDynamicProof(W, {
        target_symbol: "sym:service.ts#createOrder",
        source: W,
        test_path: "../service.test.ts",
        replacement: "return null;"
      }, { ...deps, dynamicProofRunner: vi.fn() })
    ).toThrow("--test path must stay inside the workspace");
    expect(() =>
      opDynamicProof(W, {
        target_symbol: "sym:service.ts#createOrder",
        source: W,
        test_path: "service.test.ts",
        vitest_config: "../vitest.config.ts",
        replacement: "return null;"
      }, { ...deps, dynamicProofRunner: vi.fn() })
    ).toThrow("--test path must stay inside the workspace");
  });

  it("record_run handoff args from a run hint are executable against opRecordRun", () => {
    const W = makeTempDir();
    writeFixture(W);

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    const generated: GeneratedTest = {
      id: "gt-1",
      run_id: "run-1",
      title: "Create order handoff",
      test_type: "unit",
      framework_hint: "vitest",
      body: "test('x', () => {});",
      grounding: { entity_ids: ["sym:service.ts#createOrder"], source_refs: ["service.ts"], weak_relationships_used: [] },
      weak_evidence_used: false,
      target_symbol_external_id: "sym:service.ts#createOrder"
    };
    const hint = runHintsFor([generated])[0];
    expect(hint.record_run).toBeDefined();

    mkdirSync(join(W, "orangepro_generated"), { recursive: true });
    writeFileSync(
      join(W, hint.record_run!.args.test_path),
      [
        "import { expect, it } from 'vitest';",
        "import { createOrder } from '../service';",
        "",
        "it('closes the generated handoff target', () => {",
        "  expect(createOrder('handoff')).toBe('order-handoff');",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = opRecordRun(W, {
      ...hint.record_run!.args,
      source: W,
      agent_pass: true
    }, deps);

    expect(result.record).toMatchObject({
      status: "unproven",
      closed: false,
      new_edges: [`test:${hint.record_run!.args.test_path}->sym:service.ts#createOrder`]
    });
  });

  it("falls back to full re-analysis for scoped negatives and non-test paths", () => {
    const W = makeTempDir();
    writeFixture(W);

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    writeFileSync(join(W, "service.test.ts"), "import { expect, it } from 'vitest';\nit('smoke', () => expect(true).toBe(true));\n", "utf8");
    const negative = opRecordRun(W, {
      target_symbol: "sym:service.ts#createOrder",
      source: W,
      test_path: "service.test.ts",
      agent_pass: true
    }, deps);
    expect(negative.record).toMatchObject({ status: "unproven", closed: false, reprove_mode: "full", new_edges: [] });

    writeFileSync(join(W, "helper.ts"), "export const helper = true;\n", "utf8");
    const nonTest = opRecordRun(W, {
      target_symbol: "sym:service.ts#OrderService",
      source: W,
      test_path: "helper.ts",
      agent_pass: true
    }, deps);
    expect(nonTest.record).toMatchObject({ status: "unproven", closed: false, reprove_mode: "full", new_edges: [] });
  });

  it("does not credit full-path proof from a different test than the provided test_path", () => {
    const W = makeTempDir();
    writeFixture(W);

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    writeFileSync(
      join(W, "attempt.test.ts"),
      "import { expect, it } from 'vitest';\nit('smoke', () => expect(true).toBe(true));\n",
      "utf8"
    );
    writeFileSync(
      join(W, "sibling.test.ts"),
      [
        "import { expect, it } from 'vitest';",
        "import { createOrder } from './service';",
        "",
        "it('covers createOrder from a different test file', () => {",
        "  expect(createOrder('456')).toBe('order-456');",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = opRecordRun(W, {
      target_symbol: "sym:service.ts#createOrder",
      source: W,
      test_path: "attempt.test.ts",
      agent_pass: true
    }, deps);

    expect(result.record).toMatchObject({
      status: "unproven",
      closed: false,
      reprove_mode: "full",
      new_edges: []
    });
    expect(result.record.reprove_reason).toContain("none came from the provided test (attempt.test.ts)");
  });

  it("records legacy full-path static edges as diagnostics when no test_path is provided", () => {
    const W = makeTempDir();
    writeFixture(W);

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    writeFileSync(
      join(W, "legacy.test.ts"),
      [
        "import { expect, it } from 'vitest';",
        "import { createOrder } from './service';",
        "",
        "it('covers createOrder without artifact tying', () => {",
        "  expect(createOrder('789')).toBe('order-789');",
        "});",
        ""
      ].join("\n"),
      "utf8"
    );

    const result = opRecordRun(W, {
      target_symbol: "sym:service.ts#createOrder",
      source: W,
      agent_pass: true
    }, deps);

    expect(result.record).toMatchObject({
      status: "unproven",
      closed: false,
      reprove_mode: "full",
      new_edges: ["test:legacy.test.ts->sym:service.ts#createOrder"]
    });
  });

  it("rejects scoped test paths outside the workspace", () => {
    const W = makeTempDir();
    writeFixture(W);

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    expect(() =>
      opRecordRun(W, {
        target_symbol: "sym:service.ts#createOrder",
        source: W,
        test_path: "../service.test.ts",
        agent_pass: true
      }, deps)
    ).toThrow("--test path must stay inside the workspace");
  });

  it("records Python static diagnostics as unproven until dynamic proof closes", () => {
    const W = makeTempDir();
    writeFileSync(join(W, "app.py"), "def answer():\n    return 42\n", "utf8");

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    const result = opRecordRun(W, {
      target_symbol: "sym:app.py#answer",
      source: W,
      agent_pass: true
    }, deps);

    expect(result.record.status).toBe("unproven");
    expect(result.record.closed).toBe(false);
    expect(opStats(W)).toMatchObject({
      records: 1,
      attempted: 1,
      reproven: 0,
      generated_unverifiable: 0,
      quality_adjusted_kept_rate: 0
    });
  });

  it("rejects target symbols that are not present in the current graph", () => {
    const W = makeTempDir();
    writeFileSync(join(W, "go.mod"), "module example.com/app\n\ngo 1.22\n", "utf8");
    mkdirSync(join(W, "svc"), { recursive: true });
    writeFileSync(join(W, "svc", "math.go"), "package svc\nfunc Add(a, b int) int { return a + b }\n", "utf8");

    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    expect(() => opRecordRun(W, { target_symbol: "sym:svc/math.go#Missing", source: W }, deps)).toThrow(
      "record requires --target-symbol"
    );
  });
});

describe("workspace/source separation (non-pollution)", () => {
  it("analyzing an external source never writes into it; outputs live under the workspace", () => {
    // Separate source (the external checkout) and workspace dirs.
    const S = makeTempDir();
    const W = makeTempDir();
    writeFixture(S);

    opInit(W, deps);
    const analyze = opAnalyze(W, { source: S }, deps);

    // The external source must NOT be polluted with a .orangepro dir.
    expect(existsSync(join(S, ".orangepro"))).toBe(false);

    // Graph + pack live under the workspace, not the source.
    expect(analyze.entities_count).toBeGreaterThan(0);
    expect(existsSync(join(W, ".orangepro"))).toBe(true);
    expect(analyze.graph_path.startsWith(W)).toBe(true);
    expect(existsSync(analyze.graph_path)).toBe(true);

    const exported = opExport(W, "pack.json", {}, deps);
    expect(exported.validation.valid).toBe(true);
    expect(exported.pack_path.startsWith(W)).toBe(true);
    // Still no pollution of the source after export.
    expect(existsSync(join(S, ".orangepro"))).toBe(false);
    expect(existsSync(join(S, "pack.json"))).toBe(false);
  });
});

describe("status on a never-initialized workspace", () => {
  it("reports workspace_initialized:false and freshness:'missing'", () => {
    const W = makeTempDir();

    const status = opStatus(W, deps);
    expect(status.workspace_initialized).toBe(false);
    expect(status.freshness).toBe("missing");
    expect(status.quality_score).toBeNull();
    expect(status.can_generate_tests).toBe(false);
  });
});

describe("autoProveChangedScope — default start must not skip existing-tests-first on install-artifact-only diffs", () => {
  const eligible = makeNode({
    kind: "CodeSymbol",
    external_id: "sym:src/order.service.ts#OrderService.create",
    title: "OrderService.create",
    properties: { file: "src/order.service.ts", symbol_kind: "method", behavior_surface: "entrypoint_adjacent" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "repo", source_ref: "src/order.service.ts", detector: "test" },
    behavior_source: "code_export",
    denominator_eligible: true
  });
  const graph = { nodes: [eligible], edges: [] } as unknown as LocalGraph;
  const changed = (files: string[]): ChangedResult =>
    ({ status: "ok", base_ref: "HEAD", changed_files: files, affected_behaviors: [] } as unknown as ChangedResult);

  it("install-artifact-only diff (package-lock bump) → GLOBAL (undefined), not scoped-to-nothing", () => {
    // Regression: a package-lock.json-only diff scoped auto-prove to 0 behaviors and skipped the lane.
    expect(autoProveChangedScope(graph, changed(["package-lock.json"]), undefined)).toBeUndefined();
    // Language-agnostic: Rust/Go/Python/Ruby/PHP lockfiles + installed-dep dirs also count as install-only.
    expect(autoProveChangedScope(graph, changed(["Cargo.lock", "go.sum", "poetry.lock", "node_modules/x/i.js"]), undefined)).toBeUndefined();
  });

  it("a changed ELIGIBLE provable target → scoped to the diff (install artifacts stripped)", () => {
    expect(autoProveChangedScope(graph, changed(["src/order.service.ts", "package-lock.json"]), undefined)).toEqual(["src/order.service.ts"]);
  });

  it("changed files with NO eligible provable target → GLOBAL (undefined)", () => {
    expect(autoProveChangedScope(graph, changed(["README.md", "docs/x.md"]), undefined)).toBeUndefined();
  });

  it("explicit --base (PR/diff mode) stays scoped verbatim — the fix is default-start only", () => {
    expect(autoProveChangedScope(graph, changed(["package-lock.json"]), "origin/main")).toEqual(["package-lock.json"]);
  });

  it("isInstallArtifact recognizes lockfiles across ecosystems (not JS-only)", () => {
    for (const f of ["package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lockb", "Cargo.lock", "go.sum",
      "poetry.lock", "Pipfile.lock", "Gemfile.lock", "composer.lock", "gradle.lockfile",
      "packages/api/node_modules/dep/index.js"]) {
      expect(isInstallArtifact(f)).toBe(true);
    }
    expect(isInstallArtifact("src/order.service.ts")).toBe(false);
    expect(isInstallArtifact("src/lockmanager.ts")).toBe(false); // not a lockfile despite the name
  });
});
