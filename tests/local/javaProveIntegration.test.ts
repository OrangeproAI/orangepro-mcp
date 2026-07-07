import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { opAnalyze, opDynamicProof, opInit, opProveLoop, opRtm } from "../../src/local/operations.js";
import type { DynamicProofResult, ProveLoopResult } from "../../src/local/operations.js";
import { loadLedger } from "../../src/local/ledger.js";
import { __mapJavaOracleForTest } from "../../src/local/operations.js";
import { loadGraph, saveGraph, workspacePaths } from "../../src/local/workspace.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
import { treeSitterLanguages } from "../../src/local/analyze/treeSitter/languages.js";

// Deterministic + offline: fixed clock, empty env (no provider keys → no LLM/network).
const deps = { clock: () => "2026-07-04T00:00:00Z", env: {} as NodeJS.ProcessEnv };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const fixturesRoot = join(repoRoot, "tests", "local", "__fixtures__", "java-proof");

const CALCULATOR_SYMBOL = "sym:src/main/java/ai/orangepro/fixture/Calculator.java#add";
const CONSTANT_SYMBOL = "sym:src/main/java/ai/orangepro/fixture/Constant.java#value";

const tempDirs: string[] = [];

// The Java mint path needs BOTH `java` and `mvn`. CI has neither, so the real-toolchain
// cases skip (staying green) and RUN locally where both are present.
function hasJavaMaven(): boolean {
  try {
    const java = spawnSync("java", ["-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (java.status !== 0) return false;
    const mvn = spawnSync("mvn", ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return mvn.status === 0 && /Apache Maven/.test(mvn.stdout ?? "");
  } catch {
    return false;
  }
}
const JAVA = hasJavaMaven();

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
  const dir = mkdtempSync(join(tmpdir(), "javainteg-"));
  tempDirs.push(dir);
  return dir;
}

/** Copy a java-proof fixture into a fresh source dir and analyze it into a workspace. */
function analyzedJava(fixture: string): { ws: string; source: string } {
  const ws = makeTempDir();
  const source = makeTempDir();
  cpSync(join(fixturesRoot, fixture), source, { recursive: true });
  opInit(ws, deps);
  opAnalyze(ws, { source }, deps);
  return { ws, source };
}

/**
 * Mark a Java CodeSymbol denominator-eligible so RTM builds a row for it. The isolated
 * single-method fixture leaf is `not_entry_point_adjacent`; this flips ONLY the RTM
 * denominator surface — it does not affect the fingerprint (which hashes file content,
 * not eligibility), so the mint-time and RTM-time fingerprints still match and the proof
 * stays trust-valid.
 */
function markEligible(ws: string, symbol: string): void {
  const gp = workspacePaths(ws).graphPath;
  const g = loadGraph(gp);
  const node = g.nodes.find((n) => n.external_id === symbol);
  if (!node) throw new Error(`symbol not in graph: ${symbol}`);
  node.denominator_eligible = true;
  saveGraph(gp, g);
}

function asProof(res: ProveLoopResult): DynamicProofResult & { behavior_coverage_path?: string } {
  if ("status" in res) throw new Error(`expected a proof result, got unrunnable: ${res.reason}`);
  return res;
}

describe("Java dynamic-proof mint mapping (unit, no toolchain needed)", () => {
  it("maps a proven Java verdict onto assertionFailure=true (close)", () => {
    const oracle = __mapJavaOracleForTest({
      status: "proven",
      proven: true,
      reason: "ok",
      mode: "sentinel",
      testClass: "ai.orangepro.fixture.CalculatorTest",
      testMethod: "addsTwoNumbers",
      target: "src/main/java/ai/orangepro/fixture/Calculator.java",
      method: "add",
      baseline: { exitCode: 0, timedOut: false, compileFailed: false, targetTestPassed: true, failureSummary: null },
      mutant: {
        exitCode: 1,
        timedOut: false,
        compileFailed: false,
        targetTestFailed: true,
        isAssertion: true,
        failureType: "org.opentest4j.AssertionFailedError",
        failureSummary: "org.opentest4j.AssertionFailedError: expected: <5>"
      },
      medianProofMs: 4000
    });
    expect(oracle.runner).toBe("junit");
    expect(oracle.method).toBe("add");
    expect(oracle.test).toBe("ai.orangepro.fixture.CalculatorTest#addsTwoNumbers");
    expect(oracle.replacementMode).toBe("java-typed-sentinel");
    expect(oracle.mutant?.assertionFailure).toBe(true);
    expect(oracle.mutant?.exitCode).toBe(1);
  });

  it("maps associated_survived (targetTestFailed=false) onto assertionFailure=false (non-close)", () => {
    const oracle = __mapJavaOracleForTest({
      status: "associated_survived",
      proven: false,
      testClass: "ai.orangepro.fixture.ConstantTest",
      testMethod: "returnsConstant",
      target: "src/main/java/ai/orangepro/fixture/Constant.java",
      method: "value",
      baseline: { exitCode: 0, timedOut: false, compileFailed: false, targetTestPassed: true },
      mutant: { exitCode: 0, timedOut: false, compileFailed: false, targetTestFailed: false, isAssertion: false, failureType: null }
    });
    expect(oracle.mutant?.assertionFailure).toBe(false);
  });

  it("maps a compile failure onto assertionFailure=false (non-close)", () => {
    const oracle = __mapJavaOracleForTest({
      status: "unrunnable",
      proven: false,
      testClass: "ai.orangepro.fixture.CalculatorTest",
      testMethod: "addsTwoNumbers",
      target: "src/main/java/ai/orangepro/fixture/Calculator.java",
      method: "add",
      baseline: { exitCode: 0, timedOut: false, compileFailed: false, targetTestPassed: true },
      // A mutant that fails to compile still yields a summarized run, but never a close.
      mutant: { exitCode: 1, timedOut: false, compileFailed: true, targetTestFailed: false, isAssertion: false, failureType: null }
    });
    expect(oracle.mutant?.assertionFailure).toBe(false);
  });

  it("maps a NON-assertion error (targetTestFailed but isAssertion=false) onto assertionFailure=false", () => {
    const oracle = __mapJavaOracleForTest({
      status: "unrunnable",
      proven: false,
      testClass: "ai.orangepro.fixture.CalculatorTest",
      testMethod: "addsTwoNumbers",
      target: "src/main/java/ai/orangepro/fixture/Calculator.java",
      method: "add",
      baseline: { exitCode: 0, timedOut: false, compileFailed: false, targetTestPassed: true },
      // Mutant test FAILED, but with an NPE — NOT a trusted assertion. Must not close.
      mutant: { exitCode: 1, timedOut: false, compileFailed: false, targetTestFailed: true, isAssertion: false, failureType: "java.lang.NullPointerException" }
    });
    expect(oracle.mutant?.assertionFailure).toBe(false);
  });

  it("maps a skipped/refused mutation onto assertionFailure=false (non-close)", () => {
    const oracle = __mapJavaOracleForTest({
      status: "unrunnable",
      proven: false,
      testClass: "ai.orangepro.fixture.CalculatorTest",
      testMethod: "addsTwoNumbers",
      target: "src/main/java/ai/orangepro/fixture/Calculator.java",
      method: "add",
      baseline: { exitCode: 0, timedOut: false, compileFailed: false, targetTestPassed: true },
      mutant: { skipped: true, reason: "target method name is ambiguous (more than one overload)" }
    });
    expect(oracle.mutant?.assertionFailure).toBe(false);
    // A skipped mutation must never look like a close.
    expect(oracle.mutant?.exitCode).toBeUndefined();
  });

  it("trusted assertion but MISSING exitCode ⇒ assertionFailure=false (no false-close)", () => {
    // The shared gate asserts `exitCode !== 0`, and `undefined !== 0` is truthy — so a mapper
    // that trusted the assertion signal alone would false-close on an absent exit code.
    const oracle = __mapJavaOracleForTest({
      status: "proven",
      proven: true,
      testClass: "ai.orangepro.fixture.CalculatorTest",
      testMethod: "addsTwoNumbers",
      target: "src/main/java/ai/orangepro/fixture/Calculator.java",
      method: "add",
      baseline: { exitCode: 0, timedOut: false, compileFailed: false, targetTestPassed: true },
      mutant: { timedOut: false, compileFailed: false, targetTestFailed: true, isAssertion: true, failureType: null }
    });
    expect(oracle.mutant?.assertionFailure).toBe(false);
    expect(oracle.mutant?.exitCode).toBeUndefined();
  });

  it("trusted assertion but exitCode=0 ⇒ assertionFailure=false (no false-close)", () => {
    const oracle = __mapJavaOracleForTest({
      status: "proven",
      proven: true,
      testClass: "ai.orangepro.fixture.CalculatorTest",
      testMethod: "addsTwoNumbers",
      target: "src/main/java/ai/orangepro/fixture/Calculator.java",
      method: "add",
      baseline: { exitCode: 0, timedOut: false, compileFailed: false, targetTestPassed: true },
      mutant: { exitCode: 0, timedOut: false, compileFailed: false, targetTestFailed: true, isAssertion: true, failureType: null }
    });
    expect(oracle.mutant?.assertionFailure).toBe(false);
  });
});

describe.skipIf(!JAVA)("Java dynamic-proof mint path (real toolchain)", () => {
  it("positive: a single-return Java method target mints a Dynamically Proven certificate", () => {
    const { ws, source } = analyzedJava("proven");
    markEligible(ws, CALCULATOR_SYMBOL);
    const res = opDynamicProof(
      ws,
      {
        target_symbol: CALCULATOR_SYMBOL,
        source,
        test_run: "ai.orangepro.fixture.CalculatorTest#addsTwoNumbers",
        run_id: "run:java-proven"
      },
      deps // NO fake runner → the real Java spike runs
    );

    expect(res.record.status).toBe("reproven");
    expect(res.record.closed).toBe(true);
    expect(res.record.language).toBe("java");
    const cert = res.record.dynamic_proof;
    expect(cert?.proof_kind).toBe("dynamic_targeted");
    expect(cert?.baseline_green).toBe(true);
    expect(cert?.mutant_failed_assertion).toBe(true);
    expect(cert?.target_not_mocked).toBe(true);
    expect(cert?.runner).toBe("junit");
    expect(cert?.sentinel).toBe("java-typed-sentinel");

    // RTM counts it as Dynamically Proven.
    const rtm = opRtm(ws, { format: "json" });
    expect(rtm.summary.proven).toBe(1);
    const row = rtm.rows.find((r) => r.code_symbol === CALCULATOR_SYMBOL);
    expect(row?.evidence_tier).toBe("proven");
  }, 300000);

  it("no-false-Proven: an equivalent (sentinel-survives) Java target stays unproven", () => {
    const { ws, source } = analyzedJava("sentinel-survives");
    markEligible(ws, CONSTANT_SYMBOL);
    const res = opDynamicProof(
      ws,
      {
        target_symbol: CONSTANT_SYMBOL,
        source,
        test_run: "ai.orangepro.fixture.ConstantTest#returnsConstant",
        run_id: "run:java-survives"
      },
      deps
    );

    expect(res.oracle.status).toBe("associated_survived");
    expect(res.record.status).toBe("unproven");
    expect(res.record.closed).toBe(false);
    expect(res.record.dynamic_proof?.target_not_mocked).toBe(false);
    const rtm = opRtm(ws, { format: "json" });
    expect(rtm.summary.proven).toBe(0);
    // The row exists (denominator) but is not Proven — no false Proven from a survive.
    const row = rtm.rows.find((r) => r.code_symbol === CONSTANT_SYMBOL);
    expect(row).toBeDefined();
    expect(row?.evidence_tier).not.toBe("proven");
  }, 300000);

  it("mints the same Proven cert through opProveLoop (no setup)", () => {
    const { ws, source } = analyzedJava("proven");
    markEligible(ws, CALCULATOR_SYMBOL);
    const res = asProof(
      opProveLoop(
        ws,
        { target_symbol: CALCULATOR_SYMBOL, source, test_run: "ai.orangepro.fixture.CalculatorTest#addsTwoNumbers", run_id: "run:java-loop" },
        deps
      )
    );
    expect(res.record.closed).toBe(true);
    expect(res.record.dynamic_proof?.runner).toBe("junit");
    expect(opRtm(ws, { format: "json" }).summary.proven).toBe(1);
  }, 300000);
});

describe("Java prove input validation (no toolchain needed)", () => {
  it("rejects a Java target with a missing test_run before spawning", () => {
    const { ws, source } = analyzedJava("proven");
    expect(() =>
      opDynamicProof(ws, { target_symbol: CALCULATOR_SYMBOL, source, run_id: "run:java-notest" }, deps)
    ).toThrow(/--test-run/);
    expect(loadLedger(ws).records.length).toBe(0);
  });

  it("rejects a Java test_run without a Class#method separator", () => {
    const { ws, source } = analyzedJava("proven");
    expect(() =>
      opDynamicProof(
        ws,
        { target_symbol: CALCULATOR_SYMBOL, source, test_run: "addsTwoNumbers", run_id: "run:java-nohash" },
        deps
      )
    ).toThrow(/TestClass#testMethod/);
    expect(loadLedger(ws).records.length).toBe(0);
  });
});
