import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import path from "node:path";

const root = path.resolve(__dirname, "../..");
const spike = path.join(root, "scripts/spikes/python-dynamic-proof-spike.mjs");
const fixtures = path.join(root, "tests/local/__fixtures__/python-proof");
const TEST_TIMEOUT = 40_000;

const HAS_PYTEST = (() => {
  const py = spawnSync("python3", ["-m", "pytest", "--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return py.status === 0 && /pytest/i.test(`${py.stdout}\n${py.stderr}`);
})();

function runSpike(fixture: string, args: { test?: string; target?: string; func?: string; mode?: "sentinel" | "equivalent" }) {
  const result = spawnSync(
    process.execPath,
    [
      spike,
      "--root",
      fixture,
      "--test",
      args.test ?? "tests/test_app.py::test_adds_two_numbers",
      "--target",
      args.target ?? "app.py",
      "--func",
      args.func ?? "add",
      "--mode",
      args.mode ?? "sentinel",
      "--json"
    ],
    { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: TEST_TIMEOUT }
  );
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout);
}

describe.skipIf(!HAS_PYTEST)("python dynamic proof spike (P-1)", () => {
  it("proves a simplest-shape function 0->1 when the sentinel kills a pytest assertion", () => {
    const verdict = runSpike(path.join(fixtures, "proven"), {});
    expect(verdict.status).toBe("proven");
    expect(verdict.proven).toBe(true);
    expect(verdict.baseline.exitCode).toBe(0);
    expect(verdict.mutant.assertionFailure).toBe(true);
  }, TEST_TIMEOUT);

  // RED regression: a CONFIRMED false-Proven. The `return 0` sentinel makes divisor() return 0, so
  // `assert 100 / divisor() == 5` raises ZeroDivisionError while EVALUATING the assert expression — not an
  // AssertionError. classifyPytest's `nonAssertionException` denylist omits ZeroDivisionError, and `assertionLike`
  // matches the `> assert ...` source line in the --tb=short traceback, so it is wrongly classified proven.
  // The fix must POSITIVELY identify the failure exception as AssertionError, not text-match the assert line.
  it("does NOT prove a non-assertion exception raised inside an assert (ZeroDivisionError)", () => {
    const verdict = runSpike(path.join(fixtures, "zerodiv-repro"), {
      test: "tests/test_app.py::test_divide",
      target: "app.py",
      func: "divisor"
    });
    expect(verdict.proven).toBe(false);
    expect(verdict.status).not.toBe("proven");
  }, TEST_TIMEOUT);

  // RED regression: a CONFIRMED false-Proven from missing exact-test binding. test_credited (isinstance) SURVIVES
  // the `return 0` sentinel; test_other (== 5) is killed. Given a FILE nodeid, failedTarget's `|| /FAILED\s+/`
  // fallback + file-only testRel credit the proof off test_other even though the target's OWN test survives.
  // The fix: bind to the exact ::test nodeid (drop the loose fallback / refuse nodeids that expand to >1 test).
  it("does NOT prove off a different test when the credited test survives (no exact-test binding)", () => {
    const verdict = runSpike(path.join(fixtures, "wrong-test-repro"), {
      test: "tests/test_app.py",
      target: "app.py",
      func: "credited"
    });
    expect(verdict.proven).toBe(false);
    expect(verdict.status).not.toBe("proven");
  }, TEST_TIMEOUT);

  it("binds to the exact credited pytest nodeid and ignores a co-located failing test", () => {
    const verdict = runSpike(path.join(fixtures, "wrong-test-repro"), {
      test: "tests/test_app.py::test_credited",
      target: "app.py",
      func: "credited"
    });
    expect(verdict.status).toBe("associated_survived");
    expect(verdict.proven).toBe(false);
    expect(verdict.mutant.assertionFailure).toBe(false);
  }, TEST_TIMEOUT);

  it("proves a single-line-body Python function when the sentinel kills the assertion", () => {
    const verdict = runSpike(path.join(fixtures, "inline-body"), {
      test: "tests/test_app.py::test_value",
      target: "app.py",
      func: "value"
    });
    expect(verdict.status).toBe("proven");
    expect(verdict.proven).toBe(true);
    expect(verdict.mutant.assertionFailure).toBe(true);
  }, TEST_TIMEOUT);

  it("keeps an equivalent mutation associated_survived (no false Proven)", () => {
    const verdict = runSpike(path.join(fixtures, "proven"), { mode: "equivalent" });
    expect(verdict.status).toBe("associated_survived");
    expect(verdict.proven).toBe(false);
    expect(verdict.mutant.assertionFailure).toBe(false);
  }, TEST_TIMEOUT);

  it("refuses an ambiguous function name instead of mutating a decoy", () => {
    const verdict = runSpike(path.join(fixtures, "ambiguous"), {});
    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.reason).toContain("ambiguous_function");
  }, TEST_TIMEOUT);

  it("rejects a red baseline as unrunnable, never Proven", () => {
    const verdict = runSpike(path.join(fixtures, "baseline-red"), {});
    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.reason).toBe("baseline test did not pass");
  }, TEST_TIMEOUT);

  it("rejects pytest collection/import errors as unrunnable, never Proven", () => {
    const verdict = runSpike(path.join(fixtures, "import-error"), {});
    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.reason).toBe("baseline test did not pass");
  }, TEST_TIMEOUT);

  it("rejects mutant pre-assertion runtime exceptions as unrunnable, never Proven", () => {
    const verdict = runSpike(path.join(fixtures, "runtime-exception"), {
      test: "tests/test_app.py::test_has_three_values",
      func: "values"
    });
    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.mutant.assertionFailure).toBe(false);
    expect(verdict.reason).toContain("raised before a trusted assertion");
  }, TEST_TIMEOUT);
});
