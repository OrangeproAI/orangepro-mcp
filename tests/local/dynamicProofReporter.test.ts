import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — .mjs spike reporter, no type declarations
import DynamicProofReporter from "../../scripts/spikes/dynamic-proof-vitest-reporter.mjs";

/**
 * Regression for the Vitest hook-compatibility fix: newer Vitest (v4+) emits
 * `onTestRunEnd(modules)` (module objects wrapped in `.task`) instead of the
 * older `onFinished(files)`. The reporter must produce the SAME assertion report
 * from both hooks — otherwise proofs silently fail to close on v4 repos (Medplum),
 * which under-confirms Proven. This test drives both hooks with mock task trees
 * and asserts byte-identical output, and that a failing assertion reads `failed`
 * while a passing test reads `passed` (the proof gate the oracle reads).
 */
describe("dynamic-proof vitest reporter — onFinished/onTestRunEnd compatibility", () => {
  const testFile = "/repo/src/order.service.test.ts";
  // One suite with a genuinely-failing assertion and a passing test.
  const suite = () => ({
    name: "OrderService",
    tasks: [
      {
        name: "total is 4",
        result: {
          state: "fail",
          errors: [
            {
              name: "AssertionError",
              message: "expected null to be 4",
              stack: "AssertionError: expected null to be 4\n    at order.service.test.ts:3:1",
              actual: null,
              expected: 4,
              operator: "strictEqual"
            }
          ]
        }
      },
      { name: "is a class", result: { state: "pass", errors: [] } }
    ]
  });

  const runHook = (hook: "onFinished" | "onTestRunEnd"): { name: string; assertionResults: any[] } => {
    const dir = mkdtempSync(join(tmpdir(), "opro-reporter-"));
    const out = join(dir, "report.json");
    const prev = process.env.OPRO_DYNAMIC_PROOF_REPORT;
    process.env.OPRO_DYNAMIC_PROOF_REPORT = out;
    try {
      const reporter = new DynamicProofReporter();
      if (hook === "onFinished") {
        // older Vitest: a "file" IS the task, carrying filepath + tasks
        reporter.onFinished([{ filepath: testFile, tasks: [suite()] }]);
      } else {
        // newer Vitest (v4): a "module" wraps the task under `.task`
        reporter.onTestRunEnd([{ task: { file: { filepath: testFile }, tasks: [suite()] } }]);
      }
      return JSON.parse(readFileSync(out, "utf8")).testResults[0];
    } finally {
      if (prev === undefined) delete process.env.OPRO_DYNAMIC_PROOF_REPORT;
      else process.env.OPRO_DYNAMIC_PROOF_REPORT = prev;
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("onTestRunEnd (Vitest v4) resolves the test file name and per-test states", () => {
    const r = runHook("onTestRunEnd");
    expect(r.name).toBe(testFile);
    const byTitle = Object.fromEntries(r.assertionResults.map((a) => [a.title, a.status]));
    expect(byTitle["total is 4"]).toBe("failed");
    expect(byTitle["is a class"]).toBe("passed");
  });

  it("onFinished (older Vitest) produces the same report as onTestRunEnd — the gate is not shifted by hook shape", () => {
    const fromFinished = runHook("onFinished");
    const fromRunEnd = runHook("onTestRunEnd");
    // name + assertion results must be identical across hooks; only the entry point differs.
    expect(fromRunEnd.name).toBe(fromFinished.name);
    expect(fromRunEnd.assertionResults).toEqual(fromFinished.assertionResults);
    // and a failing assertion is genuinely reported failed (the oracle's kill signal)
    expect(fromFinished.assertionResults.some((a) => a.status === "failed")).toBe(true);
    expect(fromFinished.assertionResults.some((a) => a.status === "passed")).toBe(true);
  });
});
