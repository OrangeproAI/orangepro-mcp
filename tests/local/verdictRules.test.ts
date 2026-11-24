import { afterAll, describe, expect, it } from "vitest";
import { rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dockerExecutor, type ContainerRequest } from "../../src/local/boundary.js";
import { issueOf } from "../../src/local/candidateTest.js";
import type { StageName, StageObservation } from "../../src/local/contracts/receipt.js";
import { classifyFaultRun, needsTimeoutRepeat, runnerTimedOut, statementFor, type ClassifyInput } from "../../src/local/faultProbe.js";
import { WORK_REPO } from "../../src/local/boundary.js";
import { OFFSETS, PASSING_TESTS, probe, readRun, tempDir, tempDirs, workspace, type Workspace } from "./support/probeWorkspace.js";
import type { ProbeFaultResult } from "../../src/local/faultProbe.js";

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const NEGATION = `negation_removal@${OFFSETS.bangInSeconds}`;
const ROUNDING = `rounding_floor_ceil@${OFFSETS.floorInSeconds}`;

/** Every stage file of a run, to classify again after changing one. */
function stagesOf(w: Workspace, result: ProbeFaultResult): Partial<Record<StageName, StageObservation>> {
  const out: Partial<Record<StageName, StageObservation>> = {};
  for (const ref of result.classification.stages) out[ref.stage] = readRun(w, result, ref.path) as StageObservation;
  return out;
}
const input = (stages: Partial<Record<StageName, StageObservation>>, extra: Partial<ClassifyInput> = {}): ClassifyInput => ({
  stages,
  parses: true,
  full_suite_requested: false,
  checkout_unchanged: true,
  selected_files: ["test/api.test.js"],
  baseline_passing: 2,
  ...extra
});
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("verdict rules v1: each failing test is judged by itself (R1)", () => {
  const MIXED = `var assert = require('assert');
var api = require('../lib/api');
describe('api', function () {
  it('converts whole seconds', function () { assert.strictEqual(api.seconds(2000), 2); });
  it('formats', function () { assert.strictEqual(api.seconds(2000).toFixed(0), '2'); });
});
`;

  it("a test that fails at its assertion catches the fault; one that crashes beside it is listed, not counted", () => {
    const result = probe(workspace({ "test/api.test.js": MIXED }), NEGATION);
    expect(result.classification).toMatchObject({ classification: "caught_by_existing", scope: "selected", classifier_version: "orangepro.fault_classifier.v2", verdict_rules: "orangepro.verdict_rules.v1" });
    expect(result.classification.caught_by).toEqual([{ file: "test/api.test.js", full_title: "api converts whole seconds", at_assertion: true }]);
    expect(result.classification.also_failed_off_assertion).toEqual([{ file: "test/api.test.js", full_title: "api formats", error: "TypeError" }]);
    expect(result.classification.statement).toContain('"api converts whole seconds" failed at its assertion. 1 test failed at an assertion; 1 more failed and is not counted.');
  });

  it("a run where every catch is at an assertion reads exactly as before: no new field, the same sentence", () => {
    const w = workspace();
    const result = probe(w, NEGATION);
    expect(result.classification.classification).toBe("caught_by_existing");
    expect(Object.keys(result.classification)).not.toContain("also_failed_off_assertion");
    expect(Object.keys(result.classification)).not.toContain("process_did_not_exit");
    expect(Object.keys(result.classification)).not.toContain("verdict_rules");
    expect(result.classification.statement).toMatch(/failed at its assertion\.( Assisted replay.*)?$/);
    const stage = readRun(w, result, "stages/fault_selected.json");
    expect(Object.keys(stage)).not.toContain("process_did_not_exit");
  });

  it("the whole suite widens to caught when one of its tests fails at an assertion, whatever else crashed", () => {
    // The selected file's test passes on the fault; another file catches it at an assertion and also crashes.
    const selected = "var assert = require('assert');\nvar api = require('../lib/api');\ndescribe('shape', function () {\n  it('is a function', function () { assert.strictEqual(typeof api.seconds, 'function'); });\n});\n";
    const w = workspace({ "test/api.test.js": selected, "test/other.test.js": MIXED }, { baselinePassing: 3 });
    const result = probe(w, NEGATION, { full_suite: true });
    expect(result.classification).toMatchObject({ classification: "caught_by_existing", scope: "full_suite", reason: "caught_outside_selection" });
    expect(result.classification.caught_by).toEqual([{ file: "test/other.test.js", full_title: "api converts whole seconds", at_assertion: true }]);
    expect(result.classification.also_failed_off_assertion).toEqual([{ file: "test/other.test.js", full_title: "api formats", error: "TypeError" }]);
  });
});

describe("verdict rules v1: a stage judged by its complete report, and never as a miss when its process did not end (R2, R5)", () => {
  it("a fault stage at its deadline with a complete report: a catch at an assertion still counts, and says the process was stopped", () => {
    const w = workspace();
    const result = probe(w, NEGATION);
    const stages = clone(stagesOf(w, result));
    stages.fault_selected!.timed_out = true;
    stages.fault_selected!.exit_code = null;
    stages.fault_selected!.process_did_not_exit = true;
    const out = classifyFaultRun(input(stages));
    expect(out).toMatchObject({ classification: "caught_by_existing", process_did_not_exit: true });
    const sentence = statementFor(out, { symbolName: "api.seconds", changedBy: "the change", operatorDescription: "x", line: 1, selectedCount: 2, fullCount: null, assisted: false });
    expect(sentence).toContain("The test process did not end by itself and was stopped.");
  });

  it("a deadline with no report stays a time-out: no claim", () => {
    const w = workspace();
    const stages = clone(stagesOf(w, probe(w, NEGATION)));
    Object.assign(stages.fault_selected!, { timed_out: true, exit_code: null, tests: null, report: null });
    expect(classifyFaultRun(input(stages))).toMatchObject({ classification: "inconclusive", reason: "fault_timeout" });
  });

  it.each([
    ["stopped after its report", { process_did_not_exit: true, exit_code: null, signal: "SIGKILL" }],
    ["at its deadline", { timed_out: true, process_did_not_exit: true, exit_code: null }]
  ] as const)("every test green on the fault, but the process %s: no claim, never survived", (_label, change) => {
    const w = workspace();
    const result = probe(w, ROUNDING);
    expect(result.classification.classification).toBe("survived_unverified");
    const stages = clone(stagesOf(w, result));
    Object.assign(stages.fault_selected!, change);
    expect(classifyFaultRun(input(stages))).toMatchObject({ classification: "inconclusive", reason: "fault_process_did_not_exit", scope: null });
  });

  it("the whole suite green on the fault but its process did not end: the claim is not widened to the whole suite", () => {
    const w = workspace();
    const result = probe(w, ROUNDING, { full_suite: true });
    expect(result.classification).toMatchObject({ classification: "survived_unverified", scope: "full_suite" });
    const stages = clone(stagesOf(w, result));
    Object.assign(stages.fault_full_suite!, { process_did_not_exit: true, exit_code: null });
    expect(classifyFaultRun(input(stages, { full_suite_requested: true }))).toMatchObject({ classification: "survived_unverified", scope: "selected", reason: "full_suite_inconclusive" });
    // A whole-suite-only run has no narrower claim to fall back to.
    const whole = probe(w, ROUNDING, { tests: [], full_suite: true });
    expect(whole.classification).toMatchObject({ classification: "survived_unverified", scope: "full_suite" });
    const wholeStages = clone(stagesOf(w, whole));
    Object.assign(wholeStages.fault_suite!, { process_did_not_exit: true, exit_code: null });
    expect(classifyFaultRun(input(wholeStages, { whole_suite_only: true, selected_files: [] }))).toMatchObject({ classification: "inconclusive", reason: "fault_process_did_not_exit" });
  });

  it("verify-test and export-tests never take a stage whose process did not end as a clean one", () => {
    const w = workspace();
    const stage = clone(stagesOf(w, probe(w, ROUNDING)).fault_selected!);
    expect(issueOf(stage)).toBeNull();
    expect(issueOf({ ...stage, process_did_not_exit: true })).toBe("process_did_not_exit");
  });
});

describe("verdict rules v1: the runner's own time-out, repeated (R3)", () => {
  // On the fault api.seconds(2000) is null, so the callback is never called and Mocha stops the test at its limit.
  const HANGS = `var assert = require('assert');
var api = require('../lib/api');
describe('api', function () {
  it('answers in time', function (done) {
    this.timeout(300);
    if (api.seconds(2000) === 2) done();
  });
});
`;

  it("recognizes each runner's own time-out, and nothing else", () => {
    expect(runnerTimedOut({ code: "ERR_MOCHA_TIMEOUT", message: "Timeout of 300ms exceeded." })).toBe(true);
    expect(runnerTimedOut({ message: "Test timed out in 5000ms.\nIf this is a long-running test…" })).toBe(true);
    expect(runnerTimedOut({ message: "Exceeded timeout of 5000 ms for a test.\nAdd a timeout value…" })).toBe(true);
    expect(runnerTimedOut({ name: "Error", message: "the request timed out" })).toBe(false);
    expect(runnerTimedOut(undefined)).toBe(false);
  });

  it("a test that times out on the fault twice, and passes on the original, catches it and says how", () => {
    const w = workspace({ "test/api.test.js": HANGS }, { baselinePassing: 1 });
    const result = probe(w, NEGATION);
    expect(result.classification.stages.map((stage) => stage.stage)).toContain("fault_selected_repeat");
    expect(result.classification).toMatchObject({ classification: "caught_by_existing", scope: "selected" });
    expect(result.classification.caught_by).toEqual([{ file: "test/api.test.js", full_title: "api answers in time", at_assertion: false, how: "timed_out" }]);
    expect(result.classification.statement).toContain('"api answers in time" timed out on the fault, twice, and passes on the original.');
    expect(readRun(w, result, "stages/fault_selected.json").tests.observed[0].failure.timed_out).toBe(true);

    // The same run, had the second run not timed out: no claim.
    const stages = clone(stagesOf(w, result));
    expect(needsTimeoutRepeat(stages.original_selected, stages.fault_selected)).toBe(true);
    stages.fault_selected_repeat = clone(stages.original_selected!);
    expect(classifyFaultRun(input(stages, { baseline_passing: 1 }))).toMatchObject({ classification: "inconclusive", reason: "fault_timeout_not_repeated" });
    // And with no second run at all.
    delete stages.fault_selected_repeat;
    expect(classifyFaultRun(input(stages, { baseline_passing: 1 }))).toMatchObject({ classification: "inconclusive", reason: "fault_timeout_not_repeated" });
  });

  it("no second run when a test already fails at its assertion, or when nothing timed out", () => {
    const w = workspace();
    expect(probe(w, NEGATION).classification.stages.map((stage) => stage.stage)).not.toContain("fault_selected_repeat");
    expect(probe(w, ROUNDING).classification.stages.map((stage) => stage.stage)).not.toContain("fault_selected_repeat");
  });
});

describe("the executor stops a test process that stays alive after its complete report (R4)", () => {
  const FRAME = `<<OPRO-FRAME:v1:${"a".repeat(64)}:e30=>>`;
  const fakeDocker = (dir: string, afterFrame: string): string => {
    const fake = path.join(dir, "docker");
    const pid = path.join(dir, "pid");
    writeFileSync(
      fake,
      `#!${process.execPath}\nconst fs = require("fs");\nconst [cmd] = process.argv.slice(2);\nif (cmd === "run") { fs.writeFileSync(${JSON.stringify(pid)}, String(process.pid)); process.stdout.write("before\\n" + ${JSON.stringify(FRAME)} + "\\nafter\\n"); ${afterFrame} }\nelse if (cmd === "kill") { try { process.kill(Number(fs.readFileSync(${JSON.stringify(pid)}, "utf8")), "SIGKILL"); } catch {} }\nelse if (cmd === "inspect") process.exit(1);\nelse process.exit(0);\n`,
      { mode: 0o755 }
    );
    return fake;
  };
  const request: ContainerRequest = { shape: { image: "i", platform: "p", memory: "1g", cpus: "1", processes: 64, deadlineSeconds: 60 }, mounts: [], env: {}, workdir: WORK_REPO, command: ["node"], deadlineMs: 60_000, input: "key\n", stopAfterReportMs: 300 };

  it("a process still alive after its report is stopped within seconds, with its output kept", { timeout: 30_000 }, () => {
    const started = Date.now();
    const run = dockerExecutor(fakeDocker(tempDir("hangs"), "setInterval(() => {}, 1000);"))(request);
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(run).toMatchObject({ timedOut: false, stoppedAfterReport: true, stopped: true, exitCode: null });
    expect(run.stdout).toContain(FRAME);
    expect(run.stdout).toContain("after");
  });

  it("a process that ends by itself is untouched", { timeout: 30_000 }, () => {
    const run = dockerExecutor(fakeDocker(tempDir("exits"), "process.exitCode = 3;"))(request);
    expect(run).toMatchObject({ timedOut: false, exitCode: 3, stopped: true });
    expect(Object.keys(run)).not.toContain("stoppedAfterReport");
    expect(run.stdout).toBe(`before\n${FRAME}\nafter\n`);
  });

  it("without the option, docker is run directly as before", { timeout: 30_000 }, () => {
    const { stopAfterReportMs: _unused, ...plain } = request;
    const run = dockerExecutor(fakeDocker(tempDir("plain"), "process.exitCode = 0;"))(plain);
    expect(run).toMatchObject({ timedOut: false, exitCode: 0, stopped: true });
  });
});
