import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

import { opAnalyze, opDynamicProof, opInit, opProveLoop, opRtm } from "../../src/local/operations.js";
import type { DynamicProofResult, ProveLoopResult } from "../../src/local/operations.js";
import { loadLedger } from "../../src/local/ledger.js";
import { __mapGoOracleForTest } from "../../src/local/operations.js";
import { loadGraph, saveGraph, workspacePaths } from "../../src/local/workspace.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
import { treeSitterLanguages } from "../../src/local/analyze/treeSitter/languages.js";

// Deterministic + offline: fixed clock, empty env (no provider keys → no LLM/network).
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
  const dir = mkdtempSync(join(tmpdir(), "gointeg-"));
  tempDirs.push(dir);
  return dir;
}

/** Copy a go-proof fixture into a fresh source dir and analyze it into a workspace. */
function analyzedGo(fixture: string): { ws: string; source: string } {
  const ws = makeTempDir();
  const source = makeTempDir();
  cpSync(join(fixturesRoot, fixture), source, { recursive: true });
  opInit(ws, deps);
  opAnalyze(ws, { source }, deps);
  return { ws, source };
}

/**
 * Mark a Go CodeSymbol denominator-eligible so RTM builds a row for it. A real
 * entry-point-adjacent Go function is eligible; the isolated single-function fixture
 * leaf is `not_entry_point_adjacent`. This flips ONLY the RTM denominator surface — it
 * does not affect the fingerprint (which hashes file content, not eligibility), so the
 * mint-time and RTM-time fingerprints still match and the proof stays trust-valid.
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

describe("Go dynamic-proof mint mapping (unit, no toolchain needed)", () => {
  it("maps a proven Go verdict onto assertionFailure=true (close)", () => {
    const oracle = __mapGoOracleForTest({
      status: "proven",
      proven: true,
      reason: "ok",
      testRun: "^TestCompute$",
      target: "compute.go",
      func: "Compute",
      baseline: { exitCode: 0, timedOut: false, failureSummary: null },
      mutant: { exitCode: 1, timedOut: false, trustedAssertion: true, failureSummary: "compute_test.go:9" },
      medianProofMs: 12
    });
    expect(oracle.runner).toBe("go");
    expect(oracle.method).toBe("Compute");
    expect(oracle.test).toBe("^TestCompute$");
    expect(oracle.replacementMode).toBe("go-zero-return");
    expect(oracle.mutant?.assertionFailure).toBe(true);
    expect(oracle.mutant?.exitCode).toBe(1);
  });

  it("maps associated_survived (trustedAssertion=false) onto assertionFailure=false (non-close)", () => {
    const oracle = __mapGoOracleForTest({
      status: "associated_survived",
      proven: false,
      testRun: "^TestOrigin$",
      target: "compute.go",
      func: "Origin",
      baseline: { exitCode: 0, timedOut: false },
      mutant: { exitCode: 0, timedOut: false, trustedAssertion: false }
    });
    expect(oracle.mutant?.assertionFailure).toBe(false);
  });

  it("maps a skipped/refused mutation onto assertionFailure=false (non-close)", () => {
    const oracle = __mapGoOracleForTest({
      status: "unrunnable",
      proven: false,
      testRun: "^TestCompute$",
      target: "compute.go",
      func: "Compute",
      baseline: { exitCode: 0, timedOut: false },
      mutant: { skipped: true, reason: "target function is a method" }
    });
    expect(oracle.mutant?.assertionFailure).toBe(false);
    // A skipped mutation must never look like a close.
    expect(oracle.mutant?.exitCode).toBeUndefined();
  });

  it("trustedAssertion=true but MISSING exitCode ⇒ assertionFailure=false (no false-close)", () => {
    // The shared gate asserts `exitCode !== 0`, and `undefined !== 0` is truthy — so a mapper
    // that trusted the assertion signal alone would false-close on an absent exit code.
    const oracle = __mapGoOracleForTest({
      status: "proven",
      proven: true,
      testRun: "^TestCompute$",
      target: "compute.go",
      func: "Compute",
      baseline: { exitCode: 0, timedOut: false },
      mutant: { timedOut: false, trustedAssertion: true }
    });
    expect(oracle.mutant?.assertionFailure).toBe(false);
    expect(oracle.mutant?.exitCode).toBeUndefined();
  });

  it("trustedAssertion=true but exitCode=0 ⇒ assertionFailure=false (no false-close)", () => {
    const oracle = __mapGoOracleForTest({
      status: "proven",
      proven: true,
      testRun: "^TestCompute$",
      target: "compute.go",
      func: "Compute",
      baseline: { exitCode: 0, timedOut: false },
      mutant: { exitCode: 0, timedOut: false, trustedAssertion: true }
    });
    expect(oracle.mutant?.assertionFailure).toBe(false);
  });
});

describe.skipIf(!GO)("Go dynamic-proof mint path (real toolchain)", () => {
  it("positive: a free-function Go target mints a Dynamically Proven certificate", () => {
    const { ws, source } = analyzedGo("proven");
    markEligible(ws, "sym:compute.go#Compute");
    const res = opDynamicProof(
      ws,
      {
        target_symbol: "sym:compute.go#Compute",
        source,
        test_run: "^TestCompute$",
        run_id: "run:go-proven"
      },
      deps // NO fake runner → the real Go spike runs
    );

    expect(res.record.status).toBe("reproven");
    expect(res.record.closed).toBe(true);
    expect(res.record.language).toBe("go");
    const cert = res.record.dynamic_proof;
    expect(cert?.proof_kind).toBe("dynamic_targeted");
    expect(cert?.baseline_green).toBe(true);
    expect(cert?.mutant_failed_assertion).toBe(true);
    expect(cert?.target_not_mocked).toBe(true);
    expect(cert?.runner).toBe("go");
    expect(cert?.sentinel).toBe("go-zero-return");

    // RTM counts it as Dynamically Proven.
    const rtm = opRtm(ws, { format: "json" });
    expect(rtm.summary.proven).toBe(1);
    const row = rtm.rows.find((r) => r.code_symbol === "sym:compute.go#Compute");
    expect(row?.evidence_tier).toBe("proven");
  }, 60000);

  it("no-false-Proven: an equivalent (sentinel-survives) Go target stays unproven", () => {
    const { ws, source } = analyzedGo("sentinel-survives");
    // Make the symbol an RTM denominator row so we can prove it is present but NOT proven.
    markEligible(ws, "sym:compute.go#Origin");
    const res = opDynamicProof(
      ws,
      {
        target_symbol: "sym:compute.go#Origin",
        source,
        test_run: "^TestOrigin$",
        run_id: "run:go-survives"
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
    const row = rtm.rows.find((r) => r.code_symbol === "sym:compute.go#Origin");
    expect(row).toBeDefined();
    expect(row?.evidence_tier).not.toBe("proven");
  }, 60000);

  it("mints the same Proven cert through opProveLoop (no setup)", () => {
    const { ws, source } = analyzedGo("proven");
    markEligible(ws, "sym:compute.go#Compute");
    const res = asProof(
      opProveLoop(
        ws,
        { target_symbol: "sym:compute.go#Compute", source, test_run: "^TestCompute$", run_id: "run:go-loop" },
        deps
      )
    );
    expect(res.record.closed).toBe(true);
    expect(res.record.dynamic_proof?.runner).toBe("go");
    expect(opRtm(ws, { format: "json" }).summary.proven).toBe(1);
  }, 60000);
});

describe("Go prove input validation (no toolchain needed)", () => {
  it("rejects a Go target with a missing test_run before spawning", () => {
    const { ws, source } = analyzedGo("proven");
    expect(() =>
      opDynamicProof(ws, { target_symbol: "sym:compute.go#Compute", source, run_id: "run:go-notest" }, deps)
    ).toThrow(/--test-run/);
    expect(loadLedger(ws).records.length).toBe(0);
  });

  it("rejects an unanchored test_run for a Go target", () => {
    const { ws, source } = analyzedGo("proven");
    expect(() =>
      opDynamicProof(
        ws,
        { target_symbol: "sym:compute.go#Compute", source, test_run: "TestCompute", run_id: "run:go-unanchored" },
        deps
      )
    ).toThrow(/fully-anchored/);
    expect(loadLedger(ws).records.length).toBe(0);
  });
});
