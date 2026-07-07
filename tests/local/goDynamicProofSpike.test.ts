import { cpSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { spawn, spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// Each `go test` pass blocks for several seconds. Using spawnSync would freeze the
// vitest worker thread and starve its onTaskUpdate RPC heartbeat, so we spawn
// ASYNC and await the result — the worker event loop stays responsive.
function spawnAsync(
  file: string,
  args: string[],
  opts: { cwd: string; env?: NodeJS.ProcessEnv }
): Promise<{ status: number; stdout: string; stderr: string }> {
  return new Promise(resolve => {
    const child = spawn(file, args, {
      cwd: opts.cwd,
      env: opts.env ?? process.env,
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", d => (stdout += d));
    child.stderr.on("data", d => (stderr += d));
    child.on("close", code => resolve({ status: code ?? 1, stdout, stderr }));
    child.on("error", () => resolve({ status: 1, stdout, stderr }));
  });
}

// The Go dynamic-proof spike (G-1) needs the `go` toolchain. CI has no Go, so the
// whole suite skips when `go` is absent (staying green) and RUNS locally where Go
// is present. This is its OWN file so it does not affect the TS/JS spike split.
function goAvailable(): boolean {
  try {
    const r = spawnSync("go", ["version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return r.status === 0 && /go version/.test(r.stdout ?? "");
  } catch {
    return false;
  }
}

const HAS_GO = goAvailable();
// Each case spawns the spike, which runs two `go test` passes plus a `go run` of
// the mutator (cold compile). That comfortably exceeds vitest's 5s default, so
// every case gets a generous timeout.
const TEST_TIMEOUT = 90_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const spike = path.join(root, "scripts/spikes/go-dynamic-proof-spike.mjs");
const fixtures = path.join(root, "tests/local/__fixtures__/go-proof");

type Verdict = {
  status: "proven" | "associated_survived" | "unrunnable";
  proven: boolean;
  reason: string;
  mode: string;
  baseline: { exitCode: number; buildFailure: boolean; targetTestPassed: boolean; failureSummary: string | null };
  mutant:
    | { skipped: true; reason: string | null }
    | {
        exitCode: number;
        buildFailure: boolean;
        targetTestFailed: boolean;
        panicked: boolean;
        trustedAssertion: boolean;
        failureSummary: string | null;
      };
};

async function runSpike(
  rootDir: string,
  {
    mode,
    testRun,
    target,
    func,
    goAssertionLine
  }: { mode?: "sentinel" | "equivalent"; testRun?: string; target?: string; func?: string; goAssertionLine?: number } = {}
): Promise<{ verdict: Verdict; status: number; stdout: string; stderr: string }> {
  const args = [
    spike,
    "--root",
    rootDir,
    "--test-run",
    testRun ?? "^TestCompute$",
    "--target",
    target ?? "compute.go",
    "--func",
    func ?? "Compute",
    "--json"
  ];
  if (mode) {
    args.push("--mode", mode);
  }
  if (goAssertionLine !== undefined) {
    args.push("--go-assertion-line", String(goAssertionLine));
  }
  const result = await spawnAsync(process.execPath, args, { cwd: root });
  return {
    verdict: JSON.parse(result.stdout) as Verdict,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

describe.skipIf(!HAS_GO)("go dynamic proof spike (G-1)", () => {
  it("proves a free function 0->1 when the sentinel kills a value assertion", async () => {
    const { verdict, status } = await runSpike(path.join(fixtures, "proven"));

    expect(verdict.status).toBe("proven");
    expect(verdict.proven).toBe(true);
    expect(verdict.baseline.targetTestPassed).toBe(true);
    expect("targetTestFailed" in verdict.mutant && verdict.mutant.targetTestFailed).toBe(true);
    expect("panicked" in verdict.mutant && verdict.mutant.panicked).toBe(false);
    // FIX 2: Proven now requires a TRUSTED value assertion caught the mutant.
    expect("trustedAssertion" in verdict.mutant && verdict.mutant.trustedAssertion).toBe(true);
    expect(status).toBe(0);
  }, TEST_TIMEOUT);

  it("keeps an equivalent-value mutation associated_survived (no false Proven)", async () => {
    const { verdict } = await runSpike(path.join(fixtures, "proven"), { mode: "equivalent" });

    expect(verdict.status).toBe("associated_survived");
    expect(verdict.proven).toBe(false);
    expect(verdict.baseline.targetTestPassed).toBe(true);
    expect("targetTestFailed" in verdict.mutant && verdict.mutant.targetTestFailed).toBe(false);
  }, TEST_TIMEOUT);

  it("refuses an ambiguous function name instead of mutating a decoy", async () => {
    const { verdict, status } = await runSpike(path.join(fixtures, "ambiguous"));

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.reason).toMatch(/ambiguous/i);
    // The mutant is never run when the mutation is refused.
    expect("skipped" in verdict.mutant && verdict.mutant.skipped).toBe(true);
    expect(status).toBe(2);
  }, TEST_TIMEOUT);

  it("rejects a mutant build error as unrunnable, never proven", async () => {
    const { verdict } = await runSpike(path.join(fixtures, "build-break"));

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.baseline.targetTestPassed).toBe(true); // real code compiled + passed
    expect("buildFailure" in verdict.mutant && verdict.mutant.buildFailure).toBe(true);
  }, TEST_TIMEOUT);

  it("rejects a mutant panic as unrunnable, never proven", async () => {
    const { verdict } = await runSpike(path.join(fixtures, "panic-after-sentinel"));

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.baseline.targetTestPassed).toBe(true);
    // The panic produces a per-test fail event, but the panic guard rejects it.
    expect("panicked" in verdict.mutant && verdict.mutant.panicked).toBe(true);
  }, TEST_TIMEOUT);

  it("rejects a setup precondition (t.Fatal before the target) as unrunnable", async () => {
    const { verdict } = await runSpike(path.join(fixtures, "setup-fatal"));

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    // The precondition fails the baseline itself, independent of any mutant.
    expect(verdict.baseline.targetTestPassed).toBe(false);
    expect(verdict.reason).toMatch(/baseline/i);
  }, TEST_TIMEOUT);

  it("FIX 1: refuses a broad --test-run and never proves off an unrelated failing test", async () => {
    // `Test` (unanchored) matches BOTH TestCompute (passes under the mutant) and
    // TestUnrelated (always fails). The old match-any predicate could read the
    // unrelated failure as the proof; the exact-single-target guard rejects it.
    const { verdict, status } = await runSpike(path.join(fixtures, "broad-run"), { testRun: "Test" });

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.reason).toMatch(/ambiguous or broad --test-run/i);
    expect(status).toBe(2);
  }, TEST_TIMEOUT);

  it("FIX 1: an exact single target that survives the mutant stays associated_survived, not proven", async () => {
    // Same fixture, but anchored to exactly TestCompute — whose assertion tolerates
    // the sentinel (return 0). The correct verdict is survive, never proven.
    const { verdict } = await runSpike(path.join(fixtures, "broad-run"), { testRun: "^TestCompute$" });

    expect(verdict.status).toBe("associated_survived");
    expect(verdict.proven).toBe(false);
  }, TEST_TIMEOUT);

  it("FIX 2a: rejects a mutant-only t.Fatal precondition as unrunnable, never proven", async () => {
    // Baseline passes; the sentinel makes Compute return 0, tripping a t.Fatal
    // precondition that aborts BEFORE the value-assertion. Not a trusted assertion.
    const { verdict } = await runSpike(path.join(fixtures, "mutant-fatal"));

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.baseline.targetTestPassed).toBe(true);
    expect("targetTestFailed" in verdict.mutant && verdict.mutant.targetTestFailed).toBe(true);
    expect("trustedAssertion" in verdict.mutant && verdict.mutant.trustedAssertion).toBe(false);
    expect(verdict.reason).toMatch(/trusted value assertion/i);
  }, TEST_TIMEOUT);

  it("FIX 2b: rejects a setup/helper failure as unrunnable, never proven", async () => {
    // The sentinel trips a t.Helper()+t.Fatal setup helper before the value-
    // assertion. A helper/setup failure is not a trusted value assertion.
    const { verdict } = await runSpike(path.join(fixtures, "setup-helper-fail"));

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.baseline.targetTestPassed).toBe(true);
    expect("targetTestFailed" in verdict.mutant && verdict.mutant.targetTestFailed).toBe(true);
    expect("trustedAssertion" in verdict.mutant && verdict.mutant.trustedAssertion).toBe(false);
    expect(verdict.reason).toMatch(/trusted value assertion/i);
  }, TEST_TIMEOUT);

  it("FIX 2c: rejects a t.Fatalf('got .. want') precondition as unrunnable, never proven", async () => {
    // Acceptance bar for the source-line-binding fix. The sentinel makes Compute
    // return 0, tripping a t.Fatalf precondition whose free text contains
    // "got .. want". The OLD text heuristic read that text as a trusted assertion
    // (Codex-reproduced false Proven). Source-line binding reads the failing line
    // back in the test source, sees a t.Fatalf hard-stop, and refuses it.
    const { verdict } = await runSpike(path.join(fixtures, "mutant-fatalf-gotwant"));

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.baseline.targetTestPassed).toBe(true);
    expect("targetTestFailed" in verdict.mutant && verdict.mutant.targetTestFailed).toBe(true);
    expect("trustedAssertion" in verdict.mutant && verdict.mutant.trustedAssertion).toBe(false);
    expect(verdict.reason).toMatch(/trusted value assertion/i);
  }, TEST_TIMEOUT);

  it("PART A: never credits a same-named test in ANOTHER package (cross-package false Proven)", async () => {
    // Two packages under ONE module. pkga has the target Foo + TestName whose
    // assertion SURVIVES the sentinel (Foo() >= 0 stays true when Foo -> 0). pkgb
    // imports pkga and has a SAME-NAMED TestName (same file basename foo_test.go,
    // same t.Errorf line) that FAILS under the sentinel (Bar() == 5 -> 0). Under
    // the old `go test ./...` + name-only `-run '^TestName$'`, pkgb's failure was
    // miscredited to pkga's Foo and MINTED A FALSE PROVEN. Target-package scoping
    // restricts the run to pkga, so pkgb never executes: the correct verdict is
    // associated_survived (pkga's own loose test tolerates the mutation), NEVER
    // proven.
    const { verdict } = await runSpike(path.join(fixtures, "cross-package"), {
      testRun: "^TestName$",
      target: "pkga/foo.go",
      func: "Foo"
    });

    expect(verdict.proven).toBe(false);
    expect(verdict.status).not.toBe("proven");
    expect(verdict.status).toBe("associated_survived");
    expect(verdict.baseline.targetTestPassed).toBe(true);
    expect("targetTestFailed" in verdict.mutant && verdict.mutant.targetTestFailed).toBe(false);
  }, TEST_TIMEOUT);

  // ── Slice 2: --go-assertion-line binds a RUNTIME-named subtest failure to the exact
  // assertion line. The subtest-runtime fixture has the target (Compute) asserted at
  // test line 22 inside `t.Run(tc.name, ...)` and a DECOY (Other) at line 35. ──

  it("Slice 2c: proves a runtime-named subtest when the mutant fails at the exact assertion line", async () => {
    const { verdict, status } = await runSpike(path.join(fixtures, "subtest-runtime"), { goAssertionLine: 22 });

    expect(verdict.status).toBe("proven");
    expect(verdict.proven).toBe(true);
    expect(verdict.baseline.targetTestPassed).toBe(true);
    expect("targetTestFailed" in verdict.mutant && verdict.mutant.targetTestFailed).toBe(true);
    expect("trustedAssertion" in verdict.mutant && verdict.mutant.trustedAssertion).toBe(true);
    expect(status).toBe(0);
  }, TEST_TIMEOUT);

  it("Slice 2a (LOAD-BEARING): a sibling subtest asserting at a DIFFERENT line is never credited", async () => {
    // Point the gate at the DECOY's assertion line (35). Mutating Compute fails the
    // Compute subtest at line 22, NOT line 35 — no frame matches the recorded line, so
    // the failure is refused. A naive `TestX/*` widening WITHOUT the exact-line gate would
    // have credited the sibling and minted a false Proven; the line gate forbids it.
    const { verdict } = await runSpike(path.join(fixtures, "subtest-runtime"), { goAssertionLine: 35 });

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect("trustedAssertion" in verdict.mutant && verdict.mutant.trustedAssertion).toBe(false);
  }, TEST_TIMEOUT);

  it("Slice 2b: an equivalent mutation survives every subtest (associated_survived, no false Proven)", async () => {
    const { verdict } = await runSpike(path.join(fixtures, "subtest-runtime"), { goAssertionLine: 22, mode: "equivalent" });

    expect(verdict.status).toBe("associated_survived");
    expect(verdict.proven).toBe(false);
  }, TEST_TIMEOUT);

  it("Slice 2d: WITHOUT --go-assertion-line the runtime subtest stays unrunnable (backward compat)", async () => {
    // No line ⇒ exact `e.Test === name` collection ⇒ the runtime child's frame is dropped,
    // exactly as before Slice 2. Proves the flag is purely additive.
    const { verdict } = await runSpike(path.join(fixtures, "subtest-runtime"));

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
  }, TEST_TIMEOUT);

  it("does not forward ambient secrets into go test", async () => {
    // A probe test in a temp copy records whether OPENAI_API_KEY reaches go test.
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-go-env-"));
    const repo = path.join(tmp, "module");
    cpSync(path.join(fixtures, "proven"), repo, { recursive: true });
    const probe = path.join(tmp, "seen.txt");
    writeFileSync(
      path.join(repo, "env_test.go"),
      [
        "package proven",
        "",
        "import (",
        '\t"os"',
        '\t"testing"',
        ")",
        "",
        "func TestEnvProbe(t *testing.T) {",
        `\tos.WriteFile(${JSON.stringify(probe)}, []byte("OPENAI_API_KEY="+os.Getenv("OPENAI_API_KEY")), 0o644)`,
        "}",
        ""
      ].join("\n")
    );

    // Run only the probe test so it definitely executes.
    const result = await spawnAsync(process.execPath, [
      spike,
      "--root",
      repo,
      "--test-run",
      "^TestEnvProbe$",
      "--target",
      "compute.go",
      "--func",
      "Compute",
      "--json"
    ], {
      cwd: root,
      env: { ...process.env, OPENAI_API_KEY: "sk-test-secret-value" }
    });

    // The verdict is not the point here; the probe file is.
    expect(result.stdout).not.toContain("sk-test-secret-value");
    const seen = readFileSync(probe, "utf8");
    expect(seen).toBe("OPENAI_API_KEY="); // ambient secret was stripped
    expect(seen).not.toContain("sk-test-secret-value");
  }, TEST_TIMEOUT);

  it("does not preserve source-repo symlinks into the sandbox copy", async () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-go-symlink-"));
    const repo = path.join(tmp, "module");
    const outside = path.join(tmp, "outside");
    cpSync(path.join(fixtures, "proven"), repo, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, path.join(repo, "leak"), "dir");

    const { verdict } = await runSpike(repo);

    // The proof still works and the outside dir is never written through the link.
    expect(verdict.status).toBe("proven");
    expect(verdict.proven).toBe(true);
  }, TEST_TIMEOUT);
});
