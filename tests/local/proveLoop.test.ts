import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

import { opAnalyze, opDynamicProof, opInit, opProveLoop, opRtm } from "../../src/local/operations.js";
import type { DynamicProofResult, ProveLoopResult } from "../../src/local/operations.js";
import { loadLedger, type LedgerRecord } from "../../src/local/ledger.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
import { treeSitterLanguages } from "../../src/local/analyze/treeSitter/languages.js";

// Deterministic + offline: fixed clock and empty env (no provider keys → no LLM/network).
const deps = { clock: () => "2026-07-02T00:00:00Z", env: {} as NodeJS.ProcessEnv };
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

const TARGET = "sym:service.ts#createOrder";

const tempDirs: string[] = [];

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
  const dir = mkdtempSync(join(tmpdir(), "oploop-"));
  tempDirs.push(dir);
  return dir;
}

/** Minimal analyzable TS fixture (fake-oracle tests never spawn a real runner). */
function writeFixture(dir: string): void {
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "prove-loop-fixture", version: "1.0.0" }, null, 2), "utf8");
  writeFileSync(
    join(dir, "service.ts"),
    ["export function createOrder(id: string): string {", "  return `order-${id}`;", "}", ""].join("\n"),
    "utf8"
  );
}

/** Runnable TS fixture for the REAL oracle: ESM + node_modules symlink so vitest can run. */
function writeRunnableFixture(dir: string): void {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify({ name: "prove-loop-fixture", version: "1.0.0", type: "module" }, null, 2),
    "utf8"
  );
  symlinkSync(join(repoRoot, "node_modules"), join(dir, "node_modules"), "dir");
  writeFileSync(
    join(dir, "service.ts"),
    ["export function createOrder(id: string): string {", "  return `order-${id}`;", "}", ""].join("\n"),
    "utf8"
  );
}

function writeGoFixture(dir: string): void {
  writeFileSync(join(dir, "go.mod"), "module example.com/app\n\ngo 1.22\n", "utf8");
  mkdirSync(join(dir, "svc"), { recursive: true });
  writeFileSync(join(dir, "svc", "math.go"), ["package svc", "func Add(a, b int) int { return a + b }", ""].join("\n"), "utf8");
}

// Killing test that DEPENDS on a setup-generated artifact (./expected): if setup's
// output never reaches the oracle's isolated copy, the baseline import fails → not proven.
const KILLING_TEST = [
  "import { describe, expect, it } from 'vitest';",
  "import { createOrder } from './service';",
  "import { EXPECTED } from './expected';",
  "describe('createOrder', () => {",
  "  it('returns the observable order id', () => {",
  "    expect(createOrder('42')).toBe(EXPECTED);",
  "  });",
  "});",
  ""
].join("\n");

function fakeOracleStdout(over: Record<string, unknown> = {}): string {
  return JSON.stringify({
    status: "proven",
    proven: true,
    reason: "baseline passed and mutant failed at an assertion",
    runner: "vitest",
    replacementMode: "return-json",
    test: "service.test.ts",
    target: "service.ts",
    method: "createOrder",
    baseline: { exitCode: 0, timedOut: false, failureSummary: null },
    mutant: { exitCode: 1, timedOut: false, assertionFailure: true, failureSummary: "AssertionError" },
    medianProofMs: 11,
    ...over
  });
}

const provenRunner = () => ({ exitCode: 0, stderr: "", stdout: fakeOracleStdout() });
const survivedRunner = () => ({
  exitCode: 0,
  stderr: "",
  stdout: fakeOracleStdout({
    status: "associated_survived",
    proven: false,
    reason: "mutated target did not change the test outcome",
    mutant: { exitCode: 0, timedOut: false, assertionFailure: false }
  })
});

/** Analyze `source` into workspace `ws` (mirrors the CLI ws/source split). */
function analyzed(): { ws: string; source: string } {
  const ws = makeTempDir();
  const source = makeTempDir();
  writeFixture(source);
  opInit(ws, deps);
  opAnalyze(ws, { source }, deps);
  return { ws, source };
}

function asProof(res: ProveLoopResult): DynamicProofResult & { behavior_coverage_path?: string } {
  if ("status" in res) throw new Error(`expected a proof result, got unrunnable: ${res.reason}`);
  return res;
}

describe("opProveLoop", () => {
  it("bar1: setup failure → unrunnable, oracle never called, ledger untouched (no record)", () => {
    const { ws, source } = analyzed();
    const runner = vi.fn(provenRunner);
    const res = opProveLoop(
      ws,
      {
        target_symbol: TARGET,
        source,
        test_path: "service.test.ts",
        replacement: "return null;",
        setup_commands: [{ command: process.execPath, args: ["-e", "process.exit(3)"] }],
        run_id: "run:setup-fail"
      },
      { ...deps, dynamicProofRunner: runner }
    );

    if (!("status" in res)) throw new Error("expected unrunnable");
    expect(res.status).toBe("unrunnable");
    expect(res.reason).toContain("setup command failed");
    expect(res.reason).toContain("exit 3");
    expect(runner).not.toHaveBeenCalled();
    // Fix 1: no ledger record is appended for a setup that never ran.
    expect(loadLedger(ws).records.length).toBe(0);
    expect(opRtm(ws, { format: "json" }).summary.proven).toBe(0);
  });

  it("bar2 + fix6: setup output reaches the isolated copy → Proven via the REAL oracle", () => {
    const ws = makeTempDir();
    const source = makeTempDir();
    writeRunnableFixture(source);
    writeFileSync(join(source, "service.test.ts"), KILLING_TEST, "utf8");
    opInit(ws, deps);
    opAnalyze(ws, { source }, deps);

    // The killing test imports ./expected, which ONLY this setup command creates. The
    // proof can close only if setup ran AND its output was copied into the oracle's
    // isolated baseline/mutant dirs (pins "setup output reaches the copy").
    const artifact = join(source, "expected.ts");
    const writeArtifact = `require('fs').writeFileSync(${JSON.stringify(artifact)}, ${JSON.stringify('export const EXPECTED = "order-42";\n')})`;
    const res = opProveLoop(
      ws,
      {
        target_symbol: TARGET,
        source,
        test_path: "service.test.ts",
        replacement: "return null;",
        runner: "vitest",
        link_node_modules: true,
        setup_commands: [{ command: process.execPath, args: ["-e", writeArtifact] }],
        run_id: "run:real-proven"
      },
      deps // NO fake runner → the real dynamic-proof oracle runs
    );

    const proof = asProof(res);
    expect(proof.record.status).toBe("reproven");
    expect(proof.record.closed).toBe(true);
    expect(proof.record.dynamic_proof?.proof_kind).toBe("dynamic_targeted");
    expect(proof.record.dynamic_proof?.target_not_mocked).toBe(true);
    expect(existsSync(artifact)).toBe(true);
    expect(opRtm(ws, { format: "json" }).summary.proven).toBe(1);
  }, 60000);

  it("bar3: equivalent mutation survives → associated_survived, never Proven", () => {
    const { ws, source } = analyzed();
    const res = opProveLoop(
      ws,
      {
        target_symbol: TARGET,
        source,
        test_path: "service.test.ts",
        replacement: 'return "order-123";',
        run_id: "run:survived"
      },
      { ...deps, dynamicProofRunner: survivedRunner }
    );

    const proof = asProof(res);
    expect(proof.oracle.status).toBe("associated_survived");
    expect(proof.record.status).toBe("unproven");
    expect(proof.record.closed).toBe(false);
    expect(proof.record.dynamic_proof?.target_not_mocked).toBe(false);
    expect(opRtm(ws, { format: "json" }).summary.proven).toBe(0);
  });

  it("bar4: report refresh reflects the newly-Proven target", () => {
    const { ws, source } = analyzed();
    const res = opProveLoop(
      ws,
      {
        target_symbol: TARGET,
        source,
        test_path: "service.test.ts",
        replacement: "return null;",
        run_id: "run:refresh"
      },
      { ...deps, dynamicProofRunner: provenRunner }
    );

    const proof = asProof(res);
    expect(proof.behavior_coverage_path).toBeDefined();
    const html = readFileSync(proof.behavior_coverage_path as string, "utf8");
    // The embedded report data flips to static+dynamic with a proven tally once the cert closes.
    expect(html).toContain('"analysisKind":"static+dynamic"');
    expect(html).toContain('"proven":1');
  });

  it("bar5: cert shape identical to a direct opDynamicProof call (no setup)", () => {
    const direct = analyzed();
    const directRes = opDynamicProof(
      direct.ws,
      { target_symbol: TARGET, source: direct.source, test_path: "service.test.ts", replacement: "return null;", run_id: "run:same" },
      { ...deps, dynamicProofRunner: provenRunner }
    );

    const loop = analyzed();
    const loopRes = asProof(
      opProveLoop(
        loop.ws,
        { target_symbol: TARGET, source: loop.source, test_path: "service.test.ts", replacement: "return null;", run_id: "run:same" },
        { ...deps, dynamicProofRunner: provenRunner }
      )
    );

    // The certificate is byte-identical.
    expect(loopRes.record.dynamic_proof).toEqual(directRes.record.dynamic_proof);
    // The whole ledger record is structurally identical (ignore only run_id/timestamps).
    const strip = (r: LedgerRecord) => {
      const { run_id, ts, ...rest } = r;
      return rest;
    };
    expect(strip(loopRes.record)).toEqual(strip(directRes.record));
  });

  it("fix1: a setup flake does NOT erase a prior proof (RTM proven stays 1)", () => {
    const { ws, source } = analyzed();
    // Genuinely prove the symbol first.
    opProveLoop(
      ws,
      { target_symbol: TARGET, source, test_path: "service.test.ts", replacement: "return null;", run_id: "run:proven" },
      { ...deps, dynamicProofRunner: provenRunner }
    );
    expect(opRtm(ws, { format: "json" }).summary.proven).toBe(1);
    const recordsAfterProof = loadLedger(ws).records.length;

    // Re-prove the SAME symbol with a failing setup (env flake) — must not append a
    // superseding record that clobbers the closed cert via RTM latest-wins.
    const flake = opProveLoop(
      ws,
      {
        target_symbol: TARGET,
        source,
        test_path: "service.test.ts",
        replacement: "return null;",
        setup_commands: [{ command: process.execPath, args: ["-e", "process.exit(1)"] }],
        run_id: "run:flake"
      },
      { ...deps, dynamicProofRunner: provenRunner }
    );

    expect("status" in flake && flake.status).toBe("unrunnable");
    expect(loadLedger(ws).records.length).toBe(recordsAfterProof); // no new record
    expect(opRtm(ws, { format: "json" }).summary.proven).toBe(1); // proof survives
  });

  it("fix2: a verbose setup (>1 MiB stdout, exit 0) is treated as success", () => {
    const { ws, source } = analyzed();
    const runner = vi.fn(provenRunner);
    const res = opProveLoop(
      ws,
      {
        target_symbol: TARGET,
        source,
        test_path: "service.test.ts",
        replacement: "return null;",
        // 2 MiB of stdout would ENOBUFS-kill the child under the 1 MiB spawnSync default.
        setup_commands: [{ command: process.execPath, args: ["-e", 'process.stdout.write("x".repeat(2*1024*1024)); process.exit(0)'] }],
        run_id: "run:verbose"
      },
      { ...deps, dynamicProofRunner: runner }
    );

    expect("status" in res).toBe(false); // proof proceeded (not a false unrunnable)
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it("fix3: a missing setup command surfaces ENOENT, not a fabricated exit 1", () => {
    const { ws, source } = analyzed();
    const runner = vi.fn(provenRunner);
    const res = opProveLoop(
      ws,
      {
        target_symbol: TARGET,
        source,
        test_path: "service.test.ts",
        replacement: "return null;",
        setup_commands: [{ command: "opro-nonexistent-cmd-zzz", args: [] }],
        run_id: "run:enoent"
      },
      { ...deps, dynamicProofRunner: runner }
    );

    if (!("status" in res)) throw new Error("expected unrunnable");
    expect(res.reason).toContain("ENOENT");
    expect(res.reason).not.toContain("exit 1");
    expect(runner).not.toHaveBeenCalled();
    expect(loadLedger(ws).records.length).toBe(0);
  });

  it("fix4: a Go target without --test-run throws (before setup runs the oracle), minting no record", () => {
    const ws = makeTempDir();
    const source = makeTempDir();
    writeGoFixture(source);
    opInit(ws, deps);
    opAnalyze(ws, { source }, deps);

    const runner = vi.fn(provenRunner);
    expect(() =>
      opProveLoop(
        ws,
        {
          target_symbol: "sym:svc/math.go#Add",
          source,
          // Go is now a supported language, but it requires --test-run (not --test/--replacement);
          // the missing input throws inside the oracle before any mint.
          replacement: "return null;",
          setup_commands: [{ command: process.execPath, args: ["-e", "process.exit(0)"] }],
          run_id: "run:go"
        },
        { ...deps, dynamicProofRunner: runner }
      )
    ).toThrow(/--test-run/);
    expect(runner).not.toHaveBeenCalled();
    expect(loadLedger(ws).records.length).toBe(0);
  });
});
