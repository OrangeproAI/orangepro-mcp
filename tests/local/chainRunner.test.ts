import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { installedRunner, runnerMounts, runnerPlanOf, syntaxArgv, testArgv, witnessArgv, witnessTarget } from "../../src/local/chainRunner.js";
import { reachMarkedBytes, REACH_MARK_ENV } from "../../src/local/candidateTest.js";
import { applyAdditivePatch, parseAdditivePatch, readNewTest } from "../../src/local/candidatePatch.js";
import { classifyFaultRun, mochaPlanOf, readFixture } from "../../src/local/faultProbe.js";

const refuse = (detail: string): never => {
  throw new Error(detail);
};

describe("the runner a fixture names", () => {
  it("builds Mocha's command exactly as before", () => {
    const plan = runnerPlanOf(["mocha", "--require", "test/support/env", "--reporter", "spec", "--check-leaks", "test/", "test/acceptance/"], refuse);
    expect(plan).toEqual({ name: "mocha", options: ["--require", "test/support/env", "--check-leaks"], operands: ["test/", "test/acceptance/"] });
    expect(testArgv(plan, ["test/a.js"])).toEqual(["node", "node_modules/mocha/bin/mocha.js", "--no-config", "--no-package", "--require", "test/support/env", "--check-leaks", "--reporter", "/opro/mocha-reporter.cjs", "test/a.js"]);
    expect(testArgv(plan, null).slice(-2)).toEqual(["test/", "test/acceptance/"]);
    expect(syntaxArgv(plan, "lib/x.js")).toEqual(["node", "--check", "lib/x.js"]);
    expect(witnessArgv(plan)).toEqual(["node", "/opro/witness.cjs"]);
    expect(runnerMounts(plan).map((mount) => mount.target)).toEqual(["/opro/mocha-reporter.cjs"]);
    expect(mochaPlanOf(["mocha", "test/"])).toEqual({ options: [], operands: ["test/"] });
  });

  it("takes a Vitest suite command, drops its reporting choices and forces one try, no focus and one reporter", () => {
    const plan = runnerPlanOf(["vitest", "run", "--typecheck", "--reporter=verbose", "--config", "vitest.config.ts", "--project=unit", "test/"], refuse);
    expect(plan).toEqual({ name: "vitest", options: ["--config", "vitest.config.ts", "--project", "unit"], operands: ["test/"] });
    const argv = testArgv(plan, ["test/a.test.ts"]);
    expect(argv.slice(0, 4)).toEqual(["node", "node_modules/vitest/vitest.mjs", "run", "test/a.test.ts"]);
    for (const forced of ["--allowOnly=false", "--passWithNoTests=false", "--coverage.enabled=false"]) expect(argv).toContain(forced);
    expect(argv.join(" ")).toContain("--configLoader runner --reporter /opro/vitest-reporter.mjs --pool forks --retry 0 --bail 0");
    expect(argv.filter((part) => part === "--reporter")).toHaveLength(1);
    expect(syntaxArgv(plan, "src/x.ts")).toEqual(["node", "/opro/vite-loader.mjs", "--check", "src/x.ts", "--config", "vitest.config.ts"]);
    expect(witnessTarget(plan)).toBe("/opro/witness.mjs");
    expect(witnessArgv(plan)).toEqual(["node", "/opro/vite-loader.mjs", "--run", "/opro/witness.mjs", "--config", "vitest.config.ts"]);
    expect(runnerMounts(plan).map((mount) => mount.role)).toEqual(["<reporter>", "<loader>"]);
  });

  it("takes a Jest suite command and keeps every test file out of the reporter's process", () => {
    const plan = runnerPlanOf(["jest", "--ci", "--coverage", "--reporters", "default", "--config", "jest.config.js", "test"], refuse);
    expect(plan).toEqual({ name: "jest", options: ["--config", "jest.config.js"], operands: ["test"] });
    const selected = testArgv(plan, ["test/a.test.js"]);
    expect(selected.slice(-2)).toEqual(["--runTestsByPath", "test/a.test.js"]);
    for (const forced of ["--bail=0", "--passWithNoTests=false", "--coverage=false", "--workerIdleMemoryLimit=64G"]) expect(selected).toContain(forced);
    expect(testArgv(plan, null).slice(-1)).toEqual(["test"]);
    expect(syntaxArgv(plan, "src/x.js")).toEqual(["node", "--check", "src/x.js"]);
  });

  it("refuses an unknown runner by name, and options outside the list", () => {
    expect(() => runnerPlanOf(["ava", "test/"], refuse)).toThrow(/starts with `ava`; the runners a probe can run are mocha, vitest, jest/);
    expect(() => runnerPlanOf(["vitest", "run", "--retry", "3"], refuse)).toThrow(/--retry is not an option a probe takes from the repository for Vitest/);
    expect(() => runnerPlanOf(["vitest", "--config", "../outside.ts"], refuse)).toThrow(/not inside the repository/);
    expect(() => runnerPlanOf(["jest", "--setupFiles", "x.js"], refuse)).toThrow(/for Jest/);
    expect(() => runnerPlanOf("vitest run", refuse)).toThrow(/a list of strings/);
  });

  it("says which runner is missing, and refuses a major version it was not built on", () => {
    const root = mkdtempSync(join(tmpdir(), "opro-chain-runner-"));
    const plan = runnerPlanOf(["vitest", "run"], refuse);
    expect(installedRunner(root, plan)).toEqual({ problem: expect.stringContaining("has no node_modules/vitest") });
    mkdirSync(join(root, "node_modules", "vitest"), { recursive: true });
    writeFileSync(join(root, "node_modules", "vitest", "vitest.mjs"), "");
    writeFileSync(join(root, "node_modules", "vitest", "package.json"), JSON.stringify({ version: "2.1.9" }));
    expect(installedRunner(root, plan)).toEqual({ problem: expect.stringContaining("has Vitest 2.1.9 installed; a probe runs Vitest 4 and 5 only") });
    writeFileSync(join(root, "node_modules", "vitest", "package.json"), JSON.stringify({ version: "5.1.1" }));
    expect(installedRunner(root, plan)).toEqual({ version: "5.1.1" });
  });

  it("reads the runner from a fixture manifest", () => {
    const manifest = {
      schema: "orangepro.fixture_manifest.v1",
      source: { merged_sha: "a".repeat(40) },
      environment: { image: `node@sha256:${"b".repeat(64)}`, platform: "linux/arm64" },
      limits: { memory: "4g", cpus: 2, processes: 256, container_deadline_seconds: 300 },
      commands: { full_suite_expanded: ["vitest", "run"] },
      baseline: { passing: 3 }
    };
    const fixture = readFixture(Buffer.from(JSON.stringify(manifest)));
    expect(fixture.runner).toEqual({ name: "vitest", options: [], operands: [] });
    expect(() => readFixture(Buffer.from(JSON.stringify({ ...manifest, commands: { full_suite_expanded: ["tap", "test"] } })))).toThrow(/profile_option_not_allowed/);
  });
});

describe("the new test on a Vitest or Jest file", () => {
  const original = ['import { describe, expect, test } from "vitest";', 'import { discounted } from "../src";', "", 'describe("price", () => {', "  const cases = [", "    { total: 1000, percent: 10, out: 900 },", "  ];", "  for (const c of cases) {", "    test(`discount ${c.percent}`, () => {", "      expect(discounted(c.total, c.percent)).toBe(c.out);", "    });", "  }", "});", ""].join("\n");
  const patchOf = (at: number, added: string[]): Buffer => {
    const lines = original.split("\n");
    const context = lines[at - 1]!;
    return Buffer.from([`--- a/test/price.test.ts`, `+++ b/test/price.test.ts`, `@@ -${at},1 +${at},${added.length + 1} @@`, ` ${context}`, ...added.map((line) => `+${line}`), ""].join("\n"));
  };
  const read = (patch: Buffer, runner: "mocha" | "vitest" | "jest") => {
    const applied = applyAdditivePatch(Buffer.from(original), parseAdditivePatch(patch));
    return readNewTest({ path: "test/price.test.ts", patched: applied.bytes, original: Buffer.from(original), added: applied.added, runner });
  };

  it("accepts one new test(…) call on Vitest and Jest, and not on Mocha", () => {
    const patch = patchOf(12, ['  test("rounds down", () => {', "    expect(discounted(1005, 10)).toBe(904);", "  });"]);
    expect(read(patch, "vitest").start).toBe(13);
    expect(read(patch, "jest").end).toBe(15);
    expect(() => read(patch, "mocha")).toThrow(/adds no it\(…\) call/);
  });

  it("refuses a new row in a table of cases, with the reason", () => {
    const patch = patchOf(6, ["    { total: 1005, percent: 10, out: 904 },"]);
    expect(() => read(patch, "vitest")).toThrow(/adds no it\(…\) or test\(…\) call; it must add exactly one, as a call of its own \(a new row in a table of cases/);
  });

  it("refuses the runner's helper object and the forms that multiply, repeat or re-judge a test", () => {
    const withVi = patchOf(12, ['  test("mocked", () => {', "    vi.useFakeTimers();", "    expect(discounted(1005, 10)).toBe(904);", "  });"]);
    expect(() => read(withVi, "vitest")).toThrow(/uses vi .*may not mock, spy or fake time/);
    const each = patchOf(12, ['  test("many", () => {', "    expect([1].each).toBe(undefined);", "  });"]);
    expect(() => read(each, "vitest")).toThrow(/uses \.each/);
    expect(read(each.equals(each) ? patchOf(12, ['  it("many", () => {', "    expect([1].each).toBe(undefined);", "  });"]) : each, "mocha").start).toBe(13);
    const fails = patchOf(12, ["  test.fails(\"inverted\", () => {", "    expect(discounted(1005, 10)).toBe(1);", "  });"]);
    expect(() => read(fails, "jest")).toThrow(/\.fails|adds no/);
  });
});

describe("reach by a marked copy", () => {
  const source = Buffer.from(["export function discounted(total: number, percent: number): number {", "  if (percent <= 0) return total;", "  return Math.floor(total * (100 - percent) / 100);", "}", ""].join("\n"));
  const at = (text: string): { start: number; end: number } => ({ start: source.indexOf(text), end: source.indexOf(text) + text.length });

  it("wraps the smallest expression that may be wrapped, and nothing else changes", () => {
    const { start, end } = at("Math.floor");
    const marked = reachMarkedBytes("src/price.ts", source, start, end)!.toString("utf8");
    expect(marked).toContain(`return ((globalThis.process?.getBuiltinModule?.("node:fs")?.writeFileSync?.(globalThis.process.env.${REACH_MARK_ENV}, "")), (Math.floor(total * (100 - percent) / 100)));`);
    expect(marked.split("\n")[1]).toBe("  if (percent <= 0) return total;");
  });

  it("gives nothing where no expression can be wrapped", () => {
    // The site is a whole statement: there is no expression around it to wrap.
    const { start, end } = at("return total;");
    expect(reachMarkedBytes("src/price.ts", source, start, end)).toBeNull();
  });

  const stage = (over: Record<string, unknown>): any => ({
    stopped: true,
    timed_out: false,
    exit_code: 0,
    output_problems: [],
    report: { path: "r", sha256: "0", bytes: 1 },
    boundary: { failures: [], report: { node: "v22.23.3" } },
    fault_span_count: null,
    tests: { executed: 3, passed: 3, failed: 0, pending: 0, hook_failures: 0, runner_totals: { tests: 3, passes: 3, failures: 0, pending: 0 }, observed: [1, 2, 3].map((n) => ({ file: "test/a.test.ts", full_title: `t${n}`, state: "passed", hook: false, duration_ms: 1, failure: null })) },
    ...over
  });
  const reachOf = (marked: any): string =>
    classifyFaultRun({ stages: { original_selected: stage({}), ...(marked ? { reach_marked: marked } : {}) }, parses: true, full_suite_requested: false, checkout_unchanged: true, selected_files: ["test/a.test.ts"], baseline_passing: 3 }).reached_by_selected_tests;

  it("reads reached, not reached and unknown from the marked stage", () => {
    expect(reachOf(stage({ fault_span_count: 1 }))).toBe("reached");
    expect(reachOf(stage({ fault_span_count: 0 }))).toBe("not_reached");
    expect(reachOf(null)).toBe("unknown");
    // A marked stage that did not give the plain original's account says nothing.
    expect(reachOf(stage({ fault_span_count: 1, exit_code: 1 }))).toBe("unknown");
    expect(reachOf(stage({ fault_span_count: 1, tests: { ...stage({}).tests, passed: 2, executed: 2 } }))).toBe("unknown");
    // No marker on a Node that could not have written one is not "not reached".
    expect(reachOf(stage({ fault_span_count: 0, boundary: { failures: [], report: { node: "v20.11.0" } } }))).toBe("unknown");
  });
});
