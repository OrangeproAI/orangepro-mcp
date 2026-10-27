import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { applyAdditivePatch, parseAdditivePatch, readNewTest } from "../../src/local/candidatePatch.js";
import { earlierAttempts, faultKeyOf, textControls } from "../../src/local/candidateTest.js";
import { candidateReasonWords, classifyCandidate, opTestBrief, opVerifyTest, type VerifyTestResult } from "../../src/local/candidateTest.js";
import { ASSERTION_RECORD_VERSION, checkAssertionRecord, type AssertionRecord } from "../../src/local/contracts/candidate.js";
import { unifiedFileDiff } from "../../src/local/contracts/faultRecord.js";
import { recordBytes, verifyRunFolder, writeRunManifest } from "../../src/local/contracts/io.js";

import type { StageName, StageObservation } from "../../src/local/contracts/receipt.js";
import type { ContainerExecutor } from "../../src/local/boundary.js";
import { failedAtAssertion, frameColumn, frameLocation, ProbeFaultRefusal } from "../../src/local/faultProbe.js";
import type { DynamicProofRunner } from "../../src/local/operations.js";
import { deps, hostExecutor, OFFSETS, PASSING_TESTS, passingProbe, probe, script, sha256, trackedChanges, workspace, type Workspace } from "./support/probeWorkspace.js";

const ROUNDING = `rounding_floor_ceil@${OFFSETS.floorInSeconds}`;
const NEGATION = `negation_removal@${OFFSETS.bangInSeconds}`;
const TEST_FILE = "test/api.test.js";
const NEW_TITLE = "should round a sub-second value down to whole seconds";
const FULL_TITLE = `api.seconds ${NEW_TITLE}`;
const ASSERT_ONE = "assert.strictEqual(api.seconds(1500), 1);";
const NEW_TEST = `  it('${NEW_TITLE}', function () {
    ${ASSERT_ONE}
  });
`;
const testWith = (body: string): string => `  it('${NEW_TITLE}', function () {\n${body}  });\n`;

type Run = { w: Workspace; faultRun: string; brief: string; requestSha: string };

let briefCounter = 0;
/** A fault run that survived (M07-like), and its brief. */
function survivedRun(tests: Record<string, string> = { [TEST_FILE]: PASSING_TESTS }, opts: Parameters<typeof workspace>[1] = {}, probeExtra: Parameters<typeof probe>[2] = { full_suite: true }): Run {
  const w = workspace(tests, opts);
  return briefFor(w, probe(w, ROUNDING, probeExtra));
}

function briefFor(w: Workspace, result: ReturnType<typeof probe>, source?: string): Run {
  if (result.classification.classification !== "survived_unverified") throw new Error(`fixture error: ${result.classification.classification}`);
  briefCounter += 1;
  const brief = opTestBrief(w.repo, { from_run: result.run_dir, source }, { runId: () => `run_brief_${briefCounter}` });
  return { w, faultRun: result.run_dir, brief: brief.run_dir, requestSha: brief.generation_request_sha256 };
}

/** Insert `block` just before the last line that closes the file's top describe. */
function withTest(before: string, block: string): string {
  const at = before.lastIndexOf("});");
  return `${before.slice(0, at)}${block}${before.slice(at)}`;
}

function candidate(before: string, after: string, file = TEST_FILE): Buffer {
  return Buffer.from(unifiedFileDiff(file, before, after), "utf8");
}

function recordFor(run: Run, patch: Buffer, after: string, assertText: string, extra: Partial<AssertionRecord> = {}, title = FULL_TITLE): AssertionRecord {
  const faultRecordSha = sha256(readFileSync(path.join(run.w.repo, run.faultRun, "fault-record.json")));
  const line = after.split("\n").findIndex((text) => text.includes(assertText)) + 1;
  return {
    version: ASSERTION_RECORD_VERSION,
    generation_request_sha256: run.requestSha,
    fault_record_sha256: faultRecordSha,
    candidate: { patch_sha256: sha256(patch), files: [{ path: TEST_FILE, sha256_after: sha256(after) }] },
    test: { file: TEST_FILE, full_title: title },
    assertion: { file: TEST_FILE, line, text: assertText, condition: "seconds(1500) is 1, the oracle's value" },
    failure_recognition: "first_frame_at_declared_line",
    generation: { by: "host_agent", agent: "test agent", assisted: true, saw: ["the brief"], attempt: 1 },
    ...extra
  };
}

let verifyCounter = 0;
function verify(run: Run, patch: Buffer, record: unknown, executor: ContainerExecutor = hostExecutor(), more: { stageDeadlineMs?: number; dynamicProofRunner?: DynamicProofRunner; source?: string; brief?: string } = {}): VerifyTestResult {
  verifyCounter += 1;
  return opVerifyTest(
    run.w.repo,
    { from_run: run.faultRun, brief: more.brief ?? run.brief, candidate_bytes: patch, assertion: record, source: more.source },
    { clock: deps.clock, container: executor, runId: () => `run_verify_${verifyCounter}`, stageDeadlineMs: more.stageDeadlineMs, dynamicProofRunner: more.dynamicProofRunner }
  );
}

/** Verify one test body against a fresh survived run. */
function verifyBody(body: string, assertText: string, run: Run = survivedRun()): VerifyTestResult {
  const after = withTest(PASSING_TESTS, testWith(body));
  const patch = candidate(PASSING_TESTS, after);
  return verify(run, patch, recordFor(run, patch, after, assertText));
}

function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProbeFaultRefusal) return error.code;
    throw error;
  }
  return "not refused";
}

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  return "not refused";
}

const runFolders = (w: Workspace): string[] => readdirSync(path.join(w.repo, ".orangepro", "proof-runs")).sort();

describe("opro test-brief", { timeout: 120_000 }, () => {
  it("writes what the agent needs from a survived fault, named by the fault run's hashes", () => {
    const run = survivedRun();
    const dir = path.join(run.w.repo, run.brief);
    expect(verifyRunFolder(dir).ok).toBe(true);
    const request = JSON.parse(readFileSync(path.join(dir, "brief", "generation-request.json"), "utf8"));
    expect(request.fault_run.manifest_sha256).toBe(sha256(readFileSync(path.join(run.w.repo, run.faultRun, "MANIFEST.json"))));
    expect(request.fault_record_sha256).toBe(sha256(readFileSync(path.join(run.w.repo, run.faultRun, "fault-record.json"))));
    expect(request.neighbours).toEqual([{ path: TEST_FILE, sha256: sha256(PASSING_TESTS), text: PASSING_TESTS }]);
    expect(request.old_tests).toMatchObject({ classification: "survived_unverified", scope: "full_suite" });
    expect(request.rules.join(" ")).toContain("Never assert what the faulty code returns");
    expect(request.full_title_example).toBe("api.seconds converts whole seconds");
    // CC-4: the counts on both copies, as the fault run's stage files have them.
    for (const stage of ["original_selected", "fault_selected", "original_full_suite", "fault_full_suite"]) {
      const t = JSON.parse(readFileSync(path.join(run.w.repo, run.faultRun, "stages", `${stage}.json`), "utf8")).tests;
      expect(request.old_tests.counts[stage]).toEqual({ executed: t.executed, passed: t.passed, failed: t.failed, pending: t.pending });
    }
    const md = readFileSync(path.join(dir, "brief", "brief.md"), "utf8");
    expect(md).toContain("opro verify-test --from-run");
    // CC-5 and CC-9: where it goes is the selected file, and the checkout is to be left unchanged.
    expect(md).toContain(`One of the selected test files: \`${TEST_FILE}\``);
    expect(md).toContain("git checkout --");
  });

  it("refuses a fault the existing tests already catch: there is no gap", () => {
    const w = workspace();
    const caught = probe(w, NEGATION);
    expect(refusalOf(() => opTestBrief(w.repo, { from_run: caught.run_dir }, {}))).toBe("no_gap");
  });

  it("refuses a fault run altered after it finished", () => {
    const w = workspace();
    const result = probe(w, ROUNDING);
    writeFileSync(path.join(w.repo, result.run_dir, "oracle.json"), "{}\n");
    expect(refusalOf(() => opTestBrief(w.repo, { from_run: result.run_dir }, {}))).toBe("fault_run_invalid");
  });

  it("AR-1: refuses a run whose fault another existing test caught off its own line (a shared assertion helper): no gap", () => {
    const other = `var check = require('./support/check');\nvar api = require('../lib/api');\n\ndescribe('elsewhere', function () {\n  it('rounds 1500 down', function () {\n    check.seconds(api.seconds(1500), 1);\n  });\n});\n`;
    const helper = `var assert = require('assert');\nexports.seconds = function (got, want) {\n  assert.strictEqual(got, want);\n};\n`;
    const w = workspace({ [TEST_FILE]: PASSING_TESTS, "test/other.test.js": other, "test/support/check.js": helper }, { baselinePassing: 3 });
    const result = probe(w, ROUNDING, { full_suite: true });
    expect(result.classification).toMatchObject({ classification: "survived_unverified", reason: "full_suite_failed_off_assertion" });
    expect(messageOf(() => opTestBrief(w.repo, { from_run: result.run_dir }, {}))).toMatch(/^test-brief refused \(no_gap\): .*another existing test failed on the fault/);
  });

  it("HS-4: refuses a fault run folder that is a link to somewhere else", () => {
    const w = workspace();
    const result = probe(w, ROUNDING);
    const real = path.join(w.repo, result.run_dir);
    const elsewhere = `${real}-elsewhere`;
    cpSync(real, elsewhere, { recursive: true });
    const linked = path.join(w.repo, ".orangepro", "proof-runs", "run_linked");
    spawnSync("ln", ["-s", elsewhere, linked]);
    expect(refusalOf(() => opTestBrief(w.repo, { from_run: ".orangepro/proof-runs/run_linked" }, {}))).toBe("fault_run_invalid");
  });
});

describe("opro verify-test — the new test on the same fault", { timeout: 180_000 }, () => {
  it("verified_gap: passes on the original (twice), fails at its declared line on the fault (twice), alone in the whole suite, holds both text controls, passes restored", () => {
    const run = survivedRun();
    const after = withTest(PASSING_TESTS, NEW_TEST);
    const patch = candidate(PASSING_TESTS, after);
    const record = recordFor(run, patch, after, ASSERT_ONE);
    const result = verify(run, patch, record);
    expect(result.verdict).toMatchObject({ result: "verified_gap", reason: null, assisted: true, other_failures_on_fault: [], earlier_attempts: [] });
    expect(result.verdict.stages.map((ref) => ref.stage)).toEqual([
      "candidate_original",
      "candidate_original_repeat",
      "candidate_fault",
      "candidate_fault_repeat",
      "fault_full_suite_with_candidate",
      "candidate_fault_text_control",
      "candidate_restored",
      "candidate_original_text_control",
      "full_suite_with_candidate"
    ]);
    expect(result.verdict.observed).toMatchObject({
      candidate_original: { executed: 3, passed: 3, failed: 0, new_test: "passed" },
      candidate_original_repeat: { executed: 3, passed: 3, new_test: "passed" },
      candidate_fault: { executed: 3, passed: 2, failed: 1, new_test: "failed" },
      candidate_fault_repeat: { executed: 3, failed: 1, new_test: "failed" },
      fault_full_suite_with_candidate: { executed: 3, failed: 1, new_test: "failed" },
      candidate_fault_text_control: { executed: 3, failed: 1, new_test: "failed" },
      candidate_restored: { executed: 3, passed: 3, new_test: "passed" },
      candidate_original_text_control: { executed: 3, passed: 3, new_test: "passed" },
      full_suite_with_candidate: { executed: 3, passed: 3, failed: 0 }
    });
    expect(result.verdict.observed.candidate_fault!.new_test_failed_at).toEqual({ file: TEST_FILE, line: result.verdict.new_test.assertion.line });
    expect(result.verdict.statement).toContain("in api.seconds, which PR #7 changed");
    expect(result.verdict.statement).toContain("Assisted: the test was written by the coding agent test agent, which saw the fault in the brief.");
    expect(result.verdict.statement).not.toMatch(/caused/i);
    expect(result.verdict.limits.join(" ")).toContain("review the patch before it is delivered");
    expect(result.verdict.limits.join(" ")).toContain("not every way");
    const dir = path.join(run.w.repo, result.run_dir);
    expect(verifyRunFolder(dir).ok).toBe(true);
    expect(readFileSync(path.join(dir, "candidate.patch"))).toEqual(patch);
    // RS-7: every stage commits to a profile that names the frozen record and patch.
    const profileBytes = readFileSync(path.join(dir, "run-profile.json"));
    const profile = JSON.parse(profileBytes.toString("utf8"));
    expect(profile.candidate).toEqual({ patch_sha256: sha256(patch), assertion_record_sha256: result.verdict.assertion_record_sha256, generation_request_sha256: run.requestSha });
    expect(readFileSync(path.join(dir, "generation-request.json"))).toEqual(readFileSync(path.join(run.w.repo, run.brief, "brief", "generation-request.json")));
    expect(readFileSync(path.join(dir, "brief.md"))).toEqual(readFileSync(path.join(run.w.repo, run.brief, "brief", "brief.md")));
    const stage = (name: string): StageObservation => JSON.parse(readFileSync(path.join(dir, "stages", `${name}.json`), "utf8"));
    for (const ref of result.verdict.stages) expect(stage(ref.stage).run_profile_sha256).toBe(sha256(profileBytes));
    // RS-6: the restored stage and the original-text control carry no fault.
    expect(stage("candidate_restored").fault_record_sha256).toBeNull();
    expect(stage("candidate_original_text_control").fault_record_sha256).toBeNull();
    expect(stage("candidate_restored").copy_target_sha256).toBe(stage("candidate_original").copy_target_sha256);
    expect(stage("candidate_fault_text_control").fault_record_sha256).toBe(stage("candidate_fault").fault_record_sha256);
    expect(trackedChanges(run.w.repo)).toBe("");
    expect(readFileSync(path.join(run.w.repo, TEST_FILE), "utf8")).toBe(PASSING_TESTS);
  });

  it.each([
    ["fails on the original: candidate_failed", "    assert.strictEqual(api.seconds(1500), 2);\n", "assert.strictEqual(api.seconds(1500), 2);", "candidate_failed", "fails_on_original"],
    ["does not notice the fault: not_caught", "    assert.strictEqual(api.seconds(3000), 3);\n", "assert.strictEqual(api.seconds(3000), 3);", "not_caught", null]
  ] as const)("%s", (_label, body, assertText, result, reason) => {
    expect(verifyBody(body, assertText).verdict).toMatchObject({ result, reason });
  });

  it("fails on the fault but at another line than the declared one: caught_off_assertion", () => {
    expect(verifyBody(`    assert.ok(true);\n    ${ASSERT_ONE}\n`, "assert.ok(true);").verdict).toMatchObject({ result: "caught_off_assertion", reason: "not_at_the_declared_line" });
  });

  it("FP-1, PR-1, CB-1: a test that reads the target's own text instead of running it is mutation_aware, in every form", () => {
    const present = verifyBody("    assert.ok(String(api.seconds).indexOf('Math.floor(value / 1000)') !== -1);\n", "assert.ok(String(api.seconds).indexOf('Math.floor(value / 1000)') !== -1);");
    expect(present.verdict).toMatchObject({ result: "inconclusive", reason: "mutation_aware" });
    expect(present.verdict.observed.candidate_original_text_control).toMatchObject({ new_test: "failed" });
    const stripping = "assert.ok(String(api.seconds).replace(/\\/\\*[^]*?\\*\\//g, '').indexOf('Math.ceil') === -1);";
    expect(verifyBody(`    ${stripping}\n`, stripping).verdict).toMatchObject({ result: "inconclusive", reason: "mutation_aware" });
    const first = "assert.strictEqual(/Math\\.(\\w+)/.exec(String(api.seconds))[1], 'floor');";
    expect(verifyBody(`    ${first}\n`, first).verdict).toMatchObject({ result: "inconclusive", reason: "mutation_aware" });
    const absent = verifyBody("    assert.ok(String(api.seconds).indexOf('Math.ceil') === -1);\n", "assert.ok(String(api.seconds).indexOf('Math.ceil') === -1);");
    expect(absent.verdict).toMatchObject({ result: "inconclusive", reason: "mutation_aware" });
    expect(absent.verdict.observed.candidate_original_text_control).toMatchObject({ new_test: "failed" });
    expect(absent.verdict.statement).toContain("follows the code's text rather than testing its behavior");
  });

  it("a stage past its deadline is a timeout, never a result, and is said in plain words (RS-5)", () => {
    const run = survivedRun(undefined, { mochaArgs: ["mocha", "--timeout", "60000", "test/"] });
    const line = `    setTimeout(function () { ${ASSERT_ONE} done(); }, 20000);`;
    const after = withTest(PASSING_TESTS, `  it('${NEW_TITLE}', function (done) {\n${line}\n  });\n`);
    const patch = candidate(PASSING_TESTS, after);
    const result = verify(run, patch, recordFor(run, patch, after, line.trim()), hostExecutor(), { stageDeadlineMs: 2_000 });
    expect(result.verdict).toMatchObject({ result: "inconclusive", reason: "original_timeout" });
    expect(result.verdict.statement).toContain("the stage timed out on the original");
    expect(result.verdict.statement).not.toMatch(/original_timeout/);
  });

  it("counts attempts per fault, over every probe-fault run of it whatever its rationale, and refuses a fourth (FP-3, RS-1, CB-2)", () => {
    const w = workspace();
    const first = briefFor(w, probe(w, ROUNDING, { full_suite: true }));
    const after = withTest(PASSING_TESTS, NEW_TEST.replace("1500), 1", "1500), 2"));
    const patch = candidate(PASSING_TESTS, after);
    const failing = (run: Run, attempt: number): AssertionRecord =>
      recordFor(run, patch, after, "assert.strictEqual(api.seconds(1500), 2);", { generation: { by: "host_agent", agent: "test agent", assisted: true, saw: ["the brief"], attempt } });
    for (const attempt of [1, 2, 3]) expect(verify(first, patch, failing(first, attempt)).verdict.result).toBe("candidate_failed");
    expect(refusalOf(() => verify(first, patch, failing(first, 4)))).toBe("assertion_invalid");
    // A second probe-fault run of the very same fault, even with another rationale, does not start a new budget.
    const second = briefFor(w, probe(w, ROUNDING, { full_suite: true, rationale: "the rounding direction of whole seconds" }));
    expect(messageOf(() => verify(second, patch, failing(second, 1)))).toMatch(/^verify-test refused \(attempts_exhausted\): 3 candidates already ran on this fault/);
  });

  it("CC-1: a run blocked before any test ran is not an attempt", () => {
    const run = survivedRun();
    const after = withTest(PASSING_TESTS, NEW_TEST);
    const patch = candidate(PASSING_TESTS, after);
    const record = recordFor(run, patch, after, ASSERT_ONE);
    const blocked = verify(run, patch, record, hostExecutor((request) => ({ ...passingProbe(request), network_reachable: true })));
    expect(blocked.verdict).toMatchObject({ result: "blocked", reason: "boundary_check_failed" });
    expect(verify(run, patch, record).verdict).toMatchObject({ result: "verified_gap", earlier_attempts: [] });
  });

  it("CC-2: a repair keeps the first attempt's declared assertion and condition", () => {
    const run = survivedRun();
    const wrong = withTest(PASSING_TESTS, NEW_TEST.replace("1500), 1", "1500), 2"));
    const wrongPatch = candidate(PASSING_TESTS, wrong);
    expect(verify(run, wrongPatch, recordFor(run, wrongPatch, wrong, "assert.strictEqual(api.seconds(1500), 2);")).verdict.result).toBe("candidate_failed");
    const other = withTest(PASSING_TESTS, NEW_TEST);
    const otherPatch = candidate(PASSING_TESTS, other);
    const second = { generation: { by: "host_agent" as const, agent: "test agent", assisted: true, saw: ["the brief"], attempt: 2 } };
    expect(messageOf(() => verify(run, otherPatch, recordFor(run, otherPatch, other, ASSERT_ONE, second)))).toMatch(/assertion_invalid.*a repair keeps attempt 1's declared assertion/);
    // A harness-only repair: the same assertion and condition, a line around it changed.
    const harness = withTest(PASSING_TESTS, testWith("    var value = 1500;\n    assert.strictEqual(api.seconds(1500), 2);\n"));
    const harnessPatch = candidate(PASSING_TESTS, harness);
    const repaired = verify(run, harnessPatch, recordFor(run, harnessPatch, harness, "assert.strictEqual(api.seconds(1500), 2);", second));
    expect(repaired.verdict).toMatchObject({ result: "candidate_failed", earlier_attempts: [{ attempt: 1, result: "candidate_failed" }] });
  });

  it("CC-10: a selected-scope survivor that another existing test catches is named, not taken as a gap", () => {
    const other = `var assert = require('assert');\nvar api = require('../lib/api');\n\ndescribe('elsewhere', function () {\n  it('rounds 1500 down', function () {\n    assert.strictEqual(api.seconds(1500), 1);\n  });\n});\n`;
    const run = survivedRun({ [TEST_FILE]: PASSING_TESTS, "test/other.test.js": other }, { baselinePassing: 3 }, {});
    const after = withTest(PASSING_TESTS, NEW_TEST);
    const patch = candidate(PASSING_TESTS, after);
    const result = verify(run, patch, recordFor(run, patch, after, ASSERT_ONE));
    expect(result.verdict).toMatchObject({ result: "inconclusive", reason: "existing_tests_also_catch", other_failures_on_fault: [{ file: "test/other.test.js", full_title: "elsewhere rounds 1500 down" }] });
    expect(result.verdict.statement).toContain('"elsewhere rounds 1500 down"');
  });

  it("RS-4: a checkout whose target changed since the fault run is refused under verify-test's name", () => {
    const run = survivedRun();
    const after = withTest(PASSING_TESTS, NEW_TEST);
    const patch = candidate(PASSING_TESTS, after);
    const record = recordFor(run, patch, after, ASSERT_ONE);
    const target = path.join(run.w.repo, "lib/api.js");
    const original = readFileSync(target, "utf8");
    writeFileSync(target, `${original}// edited\n`);
    expect(messageOf(() => verify(run, patch, record))).toMatch(/^verify-test refused \(fault_mismatch\): the checkout's lib\/api.js is not as the fault run/);
    writeFileSync(target, original);
  });

  it("HS-5, AR-6: a refusal after the run folder exists names verify-test and leaves no half-written run", () => {
    const run = survivedRun();
    const after = withTest(PASSING_TESTS, NEW_TEST);
    const patch = candidate(PASSING_TESTS, after);
    const lying: DynamicProofRunner = (args) => {
      const real = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
      const json = JSON.parse(real.stdout);
      if (json.bound?.changedBytes) json.bound.changedBytes = { start: json.bound.changedBytes.start, end: json.bound.changedBytes.end + 1 };
      return { stdout: JSON.stringify(json), stderr: "", exitCode: 0 };
    };
    const before = runFolders(run.w);
    expect(messageOf(() => verify(run, patch, recordFor(run, patch, after, ASSERT_ONE), hostExecutor(), { dynamicProofRunner: lying }))).toMatch(/^verify-test refused \(/);
    expect(runFolders(run.w)).toEqual(before);
    expect(trackedChanges(run.w.repo)).toBe("");
  });

  it("CC-3: the separate-workspace route: the brief's hand-back command carries --source, and running it works", () => {
    const w = workspace();
    const result = probe(w, ROUNDING, { full_suite: true });
    const run = briefFor(w, result, w.repo);
    expect(readFileSync(path.join(w.repo, run.brief, "brief", "brief.md"), "utf8")).toContain(`--source ${w.repo}`);
    const after = withTest(PASSING_TESTS, NEW_TEST);
    const patch = candidate(PASSING_TESTS, after);
    expect(verify(run, patch, recordFor(run, patch, after, ASSERT_ONE), hostExecutor(), { source: w.repo }).verdict.result).toBe("verified_gap");
  });
});

describe("opro verify-test — refused before any copy runs", { timeout: 180_000 }, () => {
  const run = survivedRun();
  const good = withTest(PASSING_TESTS, NEW_TEST);
  const goodPatch = candidate(PASSING_TESTS, good);
  const goodRecord = recordFor(run, goodPatch, good, ASSERT_ONE);
  const withBody = (body: string): Buffer => candidate(PASSING_TESTS, withTest(PASSING_TESTS, testWith(body)));
  const raw = (lines: string[]): Buffer => Buffer.from(`${lines.join("\n")}\n`, "latin1");
  const header = [`diff --git a/${TEST_FILE} b/${TEST_FILE}`, `--- a/${TEST_FILE}`, `+++ b/${TEST_FILE}`];

  it.each([
    ["a patch that changes an existing line", () => candidate(PASSING_TESTS, withTest(PASSING_TESTS.replace("2000), 2", "2000), 2 "), NEW_TEST))],
    ["a patch to production code", () => candidate(readFileSync(path.join(run.w.repo, "lib/api.js"), "utf8"), `${readFileSync(path.join(run.w.repo, "lib/api.js"), "utf8")}// x\n`, "lib/api.js")],
    ["two new tests", () => candidate(PASSING_TESTS, withTest(PASSING_TESTS, NEW_TEST + NEW_TEST.replace(NEW_TITLE, "another")))],
    ["no test at all (RS-3)", () => candidate(PASSING_TESTS, withTest(PASSING_TESTS, "  // a comment, no test\n"))],
    ["a test that replaces the code under test", () => withBody(`    api.seconds = function () { return 1; };\n    ${ASSERT_ONE}\n`)],
    ["PG-3: Object.assign on the code under test", () => withBody(`    Object.assign(api, { seconds: function () { return 1; } });\n    ${ASSERT_ONE}\n`)],
    ["PG-3: Reflect.set", () => withBody(`    Reflect.set(api, 'seconds', function () { return 1; });\n    ${ASSERT_ONE}\n`)],
    ["PG-3: a computed name", () => withBody(`    api['sec' + 'onds'] = function () { return 1; };\n    ${ASSERT_ONE}\n`)],
    ["PG-4: a spy on the operator the fault uses", () => withBody(`    var ceil = Math.ceil;\n    Math.ceil = function () { Math.ceil = ceil; throw new Error('rounded up'); };\n    ${ASSERT_ONE}\n`)],
    ["a write to state other tests share", () => withBody(`    api.extra = 1;\n    ${ASSERT_ONE}\n`)],
    ["a new dependency", () => withBody(`    var sinon = require('sinon');\n    ${ASSERT_ONE}\n`)],
    ["a new dependency loaded by import()", () => withBody(`    var sinon = import('sinon');\n    ${ASSERT_ONE}\n`)],
    ["a module named at run time", () => withBody(`    var name = 'assert';\n    var a = require(name);\n    ${ASSERT_ONE}\n`)],
    ["FP-4: process.getBuiltinModule", () => withBody(`    var fs = process.getBuiltinModule('fs');\n    ${ASSERT_ONE}\n`)],
    ["FP-4: module.constructor._load", () => withBody(`    var fs = module.constructor._load('fs');\n    ${ASSERT_ONE}\n`)],
    ["FP-4: reaching Function through .constructor", () => withBody(`    var f = (function () {}).constructor('return 1');\n    ${ASSERT_ONE}\n`)],
    ["an .only", () => candidate(PASSING_TESTS, withTest(PASSING_TESTS, NEW_TEST.replace("  it(", "  it.only(")))],
    ["RS-2: this.skip()", () => withBody(`    if (api.seconds(1500) !== 1) this.skip();\n    ${ASSERT_ONE}\n`)],
    ["this.retries()", () => withBody(`    this.retries(5);\n    ${ASSERT_ONE}\n`)],
    ["a hook inside the new test", () => withBody(`    beforeEach(function () {});\n    ${ASSERT_ONE}\n`)],
    ["an added line outside the new it() call", () => candidate(PASSING_TESTS, withTest(PASSING_TESTS, `${NEW_TEST}  function check() {\n    ${ASSERT_ONE}\n  }\n`))],
    [
      "PG-1: a '\\ No newline' marker inside a hunk (an existing assertion turned into a comment)",
      () => {
        const text = goodPatch.toString("latin1");
        return Buffer.from(text.replace(/\n(\s+assert\.strictEqual\(api\.seconds\('soon'\), null\);)/, "\n+    // \n\\ No newline at end of file\n$1").replace(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/, (_m, a, b, c, d) => `@@ -${a},${b} +${c},${Number(d) + 1} @@`), "latin1");
      }
    ],
    [
      "PG-1: a forbidden line split over two added lines",
      () => raw([...header, "@@ -10,2 +10,6 @@", "   });", `+  it('${NEW_TITLE}', function () {`, "+    api.sec", "\\ No newline at end of file", "+onds = function () { return 1; };", `+  });`, " });"])
    ],
    ["PG-2: paths without the a/ and b/ prefixes", () => Buffer.from(goodPatch.toString("latin1").split(`a/${TEST_FILE}`).join(TEST_FILE).split(`b/${TEST_FILE}`).join(TEST_FILE), "latin1")],
    ["PG-2: a second file section", () => Buffer.concat([goodPatch, raw([`--- a/${TEST_FILE}`, `+++ b/${TEST_FILE}`, "@@ -0,0 +1,1 @@", "+// written outside the test file"])])],
    ["FP-5, PG-5: hunk line numbers that do not match the file", () => Buffer.from(goodPatch.toString("latin1").replace(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/, (_m, a, b, _c, d) => `@@ -${Number(a) - 2},${b} +${Number(a) - 2},${d} @@`), "latin1")],
    ["a binary patch", () => raw([`diff --git a/${TEST_FILE} b/${TEST_FILE}`, "GIT binary patch", "literal 0", "HcmV?d00001"])]
  ])("refuses %s", (_label, makePatch) => {
    const patch = makePatch();
    expect(refusalOf(() => verify(run, patch, { ...goodRecord, candidate: { ...goodRecord.candidate, patch_sha256: sha256(patch) } }))).toBe("candidate_invalid");
  });

  it.each([
    ["names another patch", { candidate: { ...goodRecord.candidate, patch_sha256: "0".repeat(64) } }],
    ["names other file bytes", { candidate: { ...goodRecord.candidate, files: [{ path: TEST_FILE, sha256_after: "0".repeat(64) }] } }],
    ["declares a line outside the new test", { assertion: { ...goodRecord.assertion, line: 6, text: "assert.strictEqual(api.seconds(2000), 2);" } }],
    ["declares a line that is not an assertion", { assertion: { ...goodRecord.assertion, line: goodRecord.assertion.line - 1, text: `it('${NEW_TITLE}', function () {` } }],
    ["quotes other text than the declared line has", { assertion: { ...goodRecord.assertion, text: "assert.strictEqual(api.seconds(1500), 2);" } }],
    ["CC-6: gives the full title with another separator", { test: { ...goodRecord.test, full_title: `api.seconds > ${NEW_TITLE}` } }],
    ["gives the wrong attempt number", { generation: { ...goodRecord.generation, attempt: 2 } }],
    ["names another brief", { generation_request_sha256: "f".repeat(64) }],
    ["CC-8: says the writer saw nothing", { generation: { ...goodRecord.generation, saw: [] } }]
  ] as const)("refuses an assertion record that %s", (_label, change) => {
    const before = runFolders(run.w);
    expect(refusalOf(() => verify(run, goodPatch, { ...goodRecord, ...change }))).toBe("assertion_invalid");
    expect(runFolders(run.w)).toEqual(before);
  });

  it("HS-2, FP-6: refuses a brief outside proof-runs, and a brief edited and sealed again", () => {
    const outside = path.join(run.w.repo, "brief-copy");
    cpSync(path.join(run.w.repo, run.brief), outside, { recursive: true });
    expect(refusalOf(() => verify(run, goodPatch, goodRecord, hostExecutor(), { brief: "brief-copy" }))).toBe("brief_invalid");
    const edited = path.join(run.w.repo, ".orangepro", "proof-runs", "run_brief_edited");
    cpSync(path.join(run.w.repo, run.brief), edited, { recursive: true });
    const requestPath = path.join(edited, "brief", "generation-request.json");
    const request = JSON.parse(readFileSync(requestPath, "utf8"));
    request.fault.diff = "";
    writeFileSync(requestPath, recordBytes(request));
    rmSync(path.join(edited, "MANIFEST.json"));
    writeRunManifest(edited, "run_brief_edited", "test");
    expect(refusalOf(() => verify(run, goodPatch, { ...goodRecord, generation_request_sha256: sha256(recordBytes(request)) }, hostExecutor(), { brief: ".orangepro/proof-runs/run_brief_edited" }))).toBe("brief_invalid");
  });

  it("CC-9: a test file changed in the checkout is refused with the way to restore it", () => {
    const file = path.join(run.w.repo, TEST_FILE);
    writeFileSync(file, good);
    expect(messageOf(() => verify(run, goodPatch, goodRecord))).toContain(`git checkout -- ${TEST_FILE}`);
    writeFileSync(file, PASSING_TESTS);
  });

  it("CC-7: a test file with a line break other than \\n or \\r\\n is refused by name", () => {
    const tests = PASSING_TESTS.replace("var api", "var SEP = ' ';\nvar api");
    const sepRun = survivedRun({ [TEST_FILE]: tests });
    const after = withTest(tests, NEW_TEST);
    const patch = candidate(tests, after);
    expect(messageOf(() => verify(sepRun, patch, recordFor(sepRun, patch, after, ASSERT_ONE)))).toMatch(/candidate_invalid.*line break other than/);
  });

  it("reads a patch that only adds lines, applying it itself", () => {
    const parsed = parseAdditivePatch(goodPatch);
    expect(parsed.path).toBe(TEST_FILE);
    const applied = applyAdditivePatch(Buffer.from(PASSING_TESTS), parsed);
    expect(applied.bytes.toString("utf8")).toBe(good);
    expect(applied.added).toEqual(NEW_TEST.trimEnd().split("\n").map((text, i) => ({ line: 11 + i, text })));
    expect(() => parseAdditivePatch(Buffer.from("diff --git a/x.js b/x.js\nnew file mode 100644\n--- /dev/null\n+++ b/x.js\n@@ -0,0 +1 @@\n+x\n"))).toThrow(ProbeFaultRefusal);
  });

  it("PG-8: keeps a test file's bytes exactly, even when they are not valid UTF-8", () => {
    const before = Buffer.concat([Buffer.from("// caf"), Buffer.from([0xe9]), Buffer.from(`\n${PASSING_TESTS}`)]);
    const after = Buffer.concat([Buffer.from("// caf"), Buffer.from([0xe9]), Buffer.from(`\n${good}`)]);
    const patch = Buffer.from(unifiedFileDiff(TEST_FILE, before.toString("latin1"), after.toString("latin1")), "latin1");
    expect(applyAdditivePatch(before, parseAdditivePatch(patch)).bytes.equals(after)).toBe(true);
  });

  it("checks the assertion record strictly", () => {
    expect(checkAssertionRecord(goodRecord).ok).toBe(true);
    expect(checkAssertionRecord({ ...goodRecord, extra: 1 }).ok).toBe(false);
    expect(checkAssertionRecord({ ...goodRecord, assertion: { ...goodRecord.assertion, file: "test/other.js" } }).ok).toBe(false);
    expect(checkAssertionRecord({ ...goodRecord, generation: { ...goodRecord.generation, attempt: 4 } }).ok).toBe(false);
    expect(checkAssertionRecord({ ...goodRecord, generation: { ...goodRecord.generation, assisted: false } }).ok).toBe(false);
    expect(checkAssertionRecord({ ...goodRecord, generation: { ...goodRecord.generation, by: "provider", assisted: false } }).ok).toBe(true);
  });
});

describe("the new test, read on the syntax tree", () => {
  const read = (body: string) => {
    const after = withTest(PASSING_TESTS, testWith(body));
    const applied = applyAdditivePatch(Buffer.from(PASSING_TESTS), parseAdditivePatch(candidate(PASSING_TESTS, after)));
    return { after, test: readNewTest({ path: TEST_FILE, patched: applied.bytes, original: Buffer.from(PASSING_TESTS), added: applied.added }) };
  };
  const lineOf = (text: string, needle: string): number => text.split("\n").findIndex((line) => line.includes(needle)) + 1;

  it("PG-6: ordinary test code is not refused (objects it makes, comments and strings that look like code)", () => {
    const { test } = read(
      [
        "    // it (the value) is rounded down, from 1500 to 1",
        "    var expected = {};",
        "    expected.seconds = 1;",
        "    var err = new Error('x');",
        "    err.status = 400;",
        "    var o = {};",
        "    Object.defineProperty(o, 'v', { value: 1 });",
        "    var label = 'users from ' + 'a' + ' to ' + 'b';",
        "    var n = 0;",
        "    n += 1;",
        `    ${ASSERT_ONE}`,
        ""
      ].join("\n")
    );
    expect(test.fullTitle).toBe(FULL_TITLE);
  });

  it("FP-2: an assertion chain split over two lines is declared at the line its check is named on", () => {
    const { after, test } = read("    expect(api.seconds(1500))\n      .to.equal(1);\n");
    // `equal` names the check (column 11); the `.` before `to` is a property of the same assertion (FR-2, column 7).
    expect([...test.assertionPositions.get(lineOf(after, ".to.equal(1)"))!].sort((a, b) => a - b)).toEqual([7, 11]);
    const supertest = read("    request(app)\n      .get('/')\n      .expect('Set-Cookie', /Max-Age=1/)\n      .expect(200, done);\n");
    expect([...supertest.test.assertionPositions.get(lineOf(supertest.after, ".expect('Set-Cookie'"))!]).toEqual([8]);
    expect(supertest.test.assertionPositions.has(lineOf(supertest.after, ".get('/')"))).toBe(false);
  });
});

describe("classifier v2: where a failure was raised", () => {
  it("AR-2: reads file paths that hold spaces and parentheses", () => {
    expect(frameLocation("at Context.<anonymous> (test/space dir/space.test.js:4:12)")).toEqual({ file: "test/space dir/space.test.js", line: 4 });
    expect(frameLocation("at Context.<anonymous> (test/(group)/paren.test.js:4:12)")).toEqual({ file: "test/(group)/paren.test.js", line: 4 });
    expect(frameLocation("at /work/repo/test/a b.test.js:7:3")).toEqual({ file: "test/a b.test.js", line: 7 });
    expect(frameLocation("at async Context.<anonymous> (file:///work/repo/test/x.mjs:9:5)")).toEqual({ file: "test/x.mjs", line: 9 });
    expect(frameLocation("at new Promise (<anonymous>)")).toBeNull();
    expect(failedAtAssertion({ name: "AssertionError", stack: "AssertionError: x\n    at Context.<anonymous> (test/space dir/space.test.js:4:12)" }, "test/space dir/space.test.js")).toBe(true);
  });

  it("AR-4: a rewritten stack counts only when the error was raised by the test or an installed library, never by the code under test", () => {
    const control =
      'Error: expected "Set-Cookie" matching /Max-Age=1/, got "Max-Age=1000"\n    at Context.<anonymous> (test/res.cookie.js:111:12)\n    at process.processImmediate (node:internal/timers:484:21)\n----\n    at Test._assertHeader (node_modules/supertest/lib/test.js:232:16)\n    at /work/repo/node_modules/supertest/lib/test.js:308:13';
    expect(failedAtAssertion({ name: "Error", stack: control }, "test/res.cookie.js")).toBe(true);
    const fromLib = "Error: invalid signature\n    at Context.<anonymous> (test/res.cookie.js:111:12)\n----\n    at exports.unsign (lib/utils.js:40:11)\n    at /work/repo/node_modules/supertest/lib/test.js:308:13";
    expect(failedAtAssertion({ name: "Error", stack: fromLib }, "test/res.cookie.js")).toBe(false);
  });
});

describe("classifyCandidate — computed from the stage files", { timeout: 180_000 }, () => {
  it("names the stage that breaks the claim", () => {
    const run = survivedRun();
    const after = withTest(PASSING_TESTS, NEW_TEST);
    const patch = candidate(PASSING_TESTS, after);
    const record = recordFor(run, patch, after, ASSERT_ONE);
    const result = verify(run, patch, record);
    const dir = path.join(run.w.repo, result.run_dir);
    const stages = Object.fromEntries(result.verdict.stages.map((ref) => [ref.stage, JSON.parse(readFileSync(path.join(dir, ref.path), "utf8"))])) as Record<StageName, StageObservation>;
    const expectedTargetSha = Object.fromEntries(Object.entries(stages).map(([name, stage]) => [name, stage.copy_target_sha256])) as Partial<Record<StageName, string>>;
    const priorIds = [`${TEST_FILE}\u0000api.seconds converts whole seconds`, `${TEST_FILE}\u0000api.seconds returns null for a value that is not a number`];
    const declaredColumns = [frameColumn(stages.candidate_fault.tests!.observed.find((t) => t.full_title === FULL_TITLE)!.failure!.first_frame)!];
    const base = { stages, assertion: record, baseline: 2, priorIds, expectedTargetSha, copyWriteFailed: null, checkoutUnchanged: true, declaredColumns, faultRunScope: "full_suite" as const };
    const edited = (name: StageName, change: (stage: any) => void) => {
      const copy = JSON.parse(JSON.stringify(stages[name]));
      change(copy);
      return { ...base, stages: { ...stages, [name]: copy } };
    };
    const fail = (test: any, line: number): void => {
      test.state = "failed";
      test.failure = { name: "AssertionError", message: "x", first_frame: `at Context.<anonymous> (test/api.test.js:${line}:12)`, at_assertion: true };
    };
    const shift = (t: any, passes: number, failures: number, pending = 0): void => {
      t.passed += passes;
      t.failed += failures;
      t.pending += pending;
      t.runner_totals.passes += passes;
      t.runner_totals.failures += failures;
      t.runner_totals.pending += pending;
    };
    expect(classifyCandidate(base).result).toBe("verified_gap");
    expect(classifyCandidate({ ...base, checkoutUnchanged: false })).toMatchObject({ result: "blocked", reason: "checkout_modified" });
    // FP-7, HS-3: each stage must have run on the bytes it names.
    expect(classifyCandidate({ ...base, expectedTargetSha: { ...expectedTargetSha, candidate_fault: expectedTargetSha.candidate_original } })).toMatchObject({ result: "inconclusive", reason: "stage_copy_mismatch" });
    // FP-3: a repeat that disagrees.
    expect(
      classifyCandidate(
        edited("candidate_original_repeat", (s) => {
          fail(s.tests.observed.find((t: any) => t.full_title === FULL_TITLE), 12);
          shift(s.tests, -1, 1);
        })
      )
    ).toMatchObject({ result: "inconclusive", reason: "candidate_not_deterministic" });
    // RS-3: another test fails on the fault too.
    expect(
      classifyCandidate(
        edited("candidate_fault", (s) => {
          fail(s.tests.observed.find((t: any) => t.state === "passed"), 6);
          shift(s.tests, -1, 1);
        })
      )
    ).toMatchObject({ result: "caught_off_assertion", reason: "other_tests_failed" });
    // RS-2: the new test skipped itself on the fault.
    expect(
      classifyCandidate(
        edited("candidate_fault", (s) => {
          const mine = s.tests.observed.find((t: any) => t.full_title === FULL_TITLE);
          mine.state = "pending";
          mine.failure = null;
          s.tests.executed -= 1;
          shift(s.tests, 0, -1, 1);
        })
      )
    ).toMatchObject({ result: "inconclusive", reason: "a_test_was_skipped_on_fault" });
    expect(classifyCandidate({ ...base, copyWriteFailed: "restore" })).toMatchObject({ result: "inconclusive", reason: "restore_not_verified" });
    expect(classifyCandidate(edited("candidate_restored", (s) => shift(s.tests, -1, 0, 1)))).toMatchObject({ result: "inconclusive" });
    expect(classifyCandidate({ ...base, baseline: 3 })).toMatchObject({ result: "inconclusive", reason: "fault_full_suite_differs" });
    expect(
      classifyCandidate(
        edited("fault_full_suite_with_candidate", (s) => {
          fail(s.tests.observed.find((t: any) => t.state === "passed"), 6);
          shift(s.tests, -1, 1);
        })
      )
    ).toMatchObject({ result: "inconclusive", reason: "new_test_breaks_other_tests" });
    // CB-3: only when the fault run covered the selected tests alone can other failures be existing catches.
    const scoped = edited("fault_full_suite_with_candidate", (s) => {
      fail(s.tests.observed.find((t: any) => t.state === "passed"), 6);
      shift(s.tests, -1, 1);
    });
    expect(classifyCandidate({ ...scoped, faultRunScope: "selected" })).toMatchObject({ result: "inconclusive", reason: "existing_tests_also_catch" });
    // PR-8: the declared line with another column is not the declared assertion.
    expect(classifyCandidate({ ...base, declaredColumns: [declaredColumns[0]! + 7] })).toMatchObject({ result: "caught_off_assertion", reason: "not_at_the_declared_line" });
    rmSync(dir, { recursive: true, force: true });
  });

  it("RS-5: every stage-prefixed reason has plain words", () => {
    for (const stage of ["original", "original_repeat", "fault", "fault_repeat", "fault_full_suite", "fault_text_control", "restored", "original_text_control", "full_suite"]) {
      for (const issue of ["not_run", "timeout", "runner_error", "hook_failure", "runner_totals_mismatch"]) expect(candidateReasonWords(`${stage}_${issue}`)).not.toMatch(/_/);
    }
  });
});

describe("the brief from a fault run made in a separate workspace", { timeout: 120_000 }, () => {
  it("is refused without --source, naming --source", () => {
    const w = workspace();
    const result = probe(w, ROUNDING, { full_suite: true });
    const elsewhere = path.join(w.repo, "..", `${path.basename(w.repo)}-ws`);
    cpSync(path.join(w.repo, ".orangepro"), path.join(elsewhere, ".orangepro"), { recursive: true });
    expect(existsSync(path.join(elsewhere, result.run_dir))).toBe(true);
    expect(messageOf(() => opTestBrief(elsewhere, { from_run: result.run_dir }, {}))).toContain("--source <checkout>");
    rmSync(elsewhere, { recursive: true, force: true });
  });
});

describe("the fresh read's findings (round 2)", { timeout: 180_000 }, () => {
  const readWith = (original: string, body: string) => {
    const after = withTest(original, testWith(body));
    const applied = applyAdditivePatch(Buffer.from(original), parseAdditivePatch(candidate(original, after)));
    return { after, test: readNewTest({ path: TEST_FILE, patched: applied.bytes, original: Buffer.from(original), added: applied.added }) };
  };
  const refusedBody = (body: string, original = PASSING_TESTS): string => messageOf(() => readWith(original, body));

  it.each([
    ["PR-2: a spy reached through new Object(Math)", "    var M = new Object(Math);\n    M.ceil = function () { throw new Error('up'); };\n"],
    ["PR-2: a block-scoped shadow", "    { let Math = {}; }\n    Math.ceil = function () { return 0; };\n"],
    ["PR-2: a declaration in another function", "    function unused() { var api = {}; }\n    api.seconds = function () { return 1; };\n"],
    ["PR-2: a parameter of the same name elsewhere", "    [].forEach(function (api) {});\n    api = { seconds: function () { return 1; } };\n"],
    ["PR-2: a literal holding the shared object", "    var box = [api];\n    box[0].seconds = function () { return 1; };\n"],
    ["PR-2: a class whose constructor returns the shared object", "    var x = new (class { constructor() { return api; } })();\n    x.seconds = function () { return 1; };\n"],
    ["PR-2: a for-of target", "    for (api.seconds of [function () { return 1; }]);\n"],
    ["PR-2: a for-in target", "    for (Math.ceil in { a: 1 });\n"],
    ["PR-2: Object.assign through a comma", "    (0, Object.assign)(api, { seconds: null });\n"],
    ["PR-2: Object.assign through .call", "    Object.assign.call(null, api, { seconds: null });\n"],
    ["PR-2: Object['assign']", "    Object['assign'](api, { seconds: null });\n"],
    ["PR-2: assign destructured from Object", "    var { assign } = Object;\n    assign(Math, { ceil: null });\n"],
    ["PR-2: defineProperty through .call", "    Object.defineProperty.call(null, Math, 'ceil', { value: null });\n"],
    ["PR-2: a local reassigned to the shared object", "    var o = {};\n    o = api;\n    o.seconds = null;\n"],
    ["PR-3: constructor taken by destructuring", "    var { constructor: F } = function () {};\n"],
    ["PR-3: constructor through a computed literal", "    var f = (function () {})['constr' + 'uctor'];\n"],
    ["PR-3: this inside a nested function", "    var g = (function () { return this; })();\n"],
    ["PR-3: this['skip']()", "    this['skip']();\n"],
    ["PR-3: this['retries'](3)", "    this['retries'](3);\n"],
    ["a forged stack", "    var e = new Error('x');\n    e.stack = 'Error';\n"],
    ["PR-6: a value from a call the test did not make itself", "    var app = express();\n    app.locals.user = { name: 'tobi' };\n"]
  ])("refuses %s", (_label, body) => {
    expect(refusedBody(`${body}    ${ASSERT_ONE}\n`)).toMatch(/verify-test refused \(candidate_invalid\)/);
  });

  it("PR-6: the refusal states the real rule, and __dirname is allowed", () => {
    expect(refusedBody(`    var app = express();\n    app.locals.user = 1;\n    ${ASSERT_ONE}\n`)).toContain("never a value it gets from a call it did not make");
    expect(readWith(PASSING_TESTS, `    var fixtures = __dirname + '/fixtures';\n    ${ASSERT_ONE}\n`).test.fullTitle).toBe(FULL_TITLE);
  });

  it("PR-5: a blank line inside an existing string, and an it() that takes over a chained call, are refused", () => {
    const withTemplate = PASSING_TESTS.replace("    assert.strictEqual(api.seconds(2000), 2);", "    assert.ok(String(api.seconds(2000)).indexOf(`2\n0`) === -1);");
    const tl = withTemplate.split("\n");
    const blankInString = Buffer.from(
      [`diff --git a/${TEST_FILE} b/${TEST_FILE}`, `--- a/${TEST_FILE}`, `+++ b/${TEST_FILE}`, "@@ -6,2 +6,3 @@", ` ${tl[5]}`, "+   ", ` ${tl[6]}`, "@@ -11,2 +12,5 @@", ` ${tl[10]}`, ...NEW_TEST.trimEnd().split("\n").map((l) => `+${l}`), ` ${tl[11]}`, ""].join("\n")
    );
    expect(messageOf(() => {
      const applied = applyAdditivePatch(Buffer.from(withTemplate), parseAdditivePatch(blankInString));
      expect(applied.added.map((a) => a.line)).toEqual([7, 13, 14, 15]);
      readNewTest({ path: TEST_FILE, patched: applied.bytes, original: Buffer.from(withTemplate), added: applied.added });
    })).toMatch(/candidate_invalid.*added outside the new it/);
    const chained = PASSING_TESTS.replace("    assert.strictEqual(api.seconds('soon'), null);\n  });", "    assert.strictEqual(api.seconds('soon'), null);\n  })\n  .timeout(5000);");
    const takeover = chained.replace("  })\n  .timeout(5000);", `  });\n  it('${NEW_TITLE}', function () {\n    ${ASSERT_ONE}\n  })\n  .timeout(5000);`);
    expect(messageOf(() => {
      const applied = applyAdditivePatch(Buffer.from(chained), parseAdditivePatch(candidate(chained, takeover)));
      readNewTest({ path: TEST_FILE, patched: applied.bytes, original: Buffer.from(chained), added: applied.added });
    })).toMatch(/candidate_invalid/);
  });

  it("PR-7: assertions in other common styles are recognised", () => {
    const destructured = `var { strictEqual } = require('assert');\n${PASSING_TESTS}`;
    const a = readWith(destructured, "    strictEqual(api.seconds(1500), 1);\n");
    expect(a.test.assertionPositions.has(a.after.split("\n").findIndex((l) => l.includes("strictEqual(api.seconds(1500)")) + 1)).toBe(true);
    const b = readWith(PASSING_TESTS, "    should(api.seconds(1500)).equal(1);\n");
    expect(b.test.assertionPositions.size).toBe(1);
    const c = readWith(PASSING_TESTS, "    var spy = {};\n    sinon.assert.calledOnce(spy);\n");
    expect(c.test.assertionPositions.size).toBe(1);
  });

  it("PR-8: a throw on the declared line is not the declared assertion failing", () => {
    const line = "assert.ok(true); if (api.seconds(1500) !== 1) throw new Error('not one');";
    expect(verifyBody(`    ${line}\n`, line).verdict).toMatchObject({ result: "caught_off_assertion", reason: "not_at_the_declared_line" });
  });

  it("PR-4: a hunk git would place elsewhere is refused, so the stored patch always gives the verified bytes", () => {
    const run = survivedRun();
    const lines = PASSING_TESTS.split("\n");
    const at = lines.length - 2; // insert before the closing `});`
    const added = NEW_TEST.trimEnd().split("\n");
    const zeroContext = Buffer.from([`diff --git a/${TEST_FILE} b/${TEST_FILE}`, `--- a/${TEST_FILE}`, `+++ b/${TEST_FILE}`, `@@ -${at},0 +${at + 1},${added.length} @@`, ...added.map((l) => `+${l}`), ""].join("\n"));
    const after = [...lines.slice(0, at), ...added, ...lines.slice(at)].join("\n");
    expect(messageOf(() => verify(run, zeroContext, recordFor(run, zeroContext, after, ASSERT_ONE)))).toMatch(/candidate_invalid.*git applies this patch/);
  });

  it("CB-3: in a whole-suite fault run, other failures beside the new test are interference, not catches", () => {
    const api = PASSING_TESTS.replace("var api = require('../lib/api');", "var api = require('../lib/api');\nvar log = require('./support/log');");
    const zz = `var assert = require('assert');\nvar log = require('./support/log');\n\ndescribe('zz', function () {\n  it('log is empty', function () {\n    assert.strictEqual(log.length, 0);\n  });\n});\n`;
    const run = survivedRun({ [TEST_FILE]: api, "test/zz.test.js": zz, "test/support/log.js": "module.exports = [];\n" }, { baselinePassing: 3 });
    const after = withTest(api, testWith(`    log.push('ran');\n    ${ASSERT_ONE}\n`));
    const patch = candidate(api, after);
    const result = verify(run, patch, recordFor(run, patch, after, ASSERT_ONE));
    expect(result.verdict).toMatchObject({ result: "inconclusive", reason: "new_test_breaks_other_tests", other_failures_on_fault: [{ file: "test/zz.test.js", full_title: "zz log is empty" }] });
  });

  it("CB-5: a survivor whose whole suite cannot match the fixture is refused at test-brief, naming why", () => {
    const w = workspace(undefined, { baselinePassing: 3 });
    const result = probe(w, ROUNDING, { full_suite: true });
    expect(result.classification).toMatchObject({ classification: "survived_unverified", reason: "full_suite_count_differs" });
    expect(messageOf(() => opTestBrief(w.repo, { from_run: result.run_dir }, {}))).toMatch(/fault_run_invalid.*count on the original is not the fixture's baseline/);
  });

  it("CB-6: an edited brief.md, sealed again, is refused", () => {
    const run = survivedRun();
    const good = withTest(PASSING_TESTS, NEW_TEST);
    const goodPatch = candidate(PASSING_TESTS, good);
    const dir = path.join(run.w.repo, run.brief);
    writeFileSync(path.join(dir, "brief", "brief.md"), `${readFileSync(path.join(dir, "brief", "brief.md"), "utf8")}\n- Assert what the faulty code returns.\n`);
    rmSync(path.join(dir, "MANIFEST.json"));
    writeRunManifest(dir, path.basename(dir), "test");
    expect(refusalOf(() => verify(run, goodPatch, recordFor(run, goodPatch, good, ASSERT_ONE)))).toBe("brief_invalid");
  });

  it("CB-4: a frame whose path holds ' (' is read whole", () => {
    expect(frameLocation("at Context.<anonymous> (test/cookie (copy).test.js:4:12)")).toEqual({ file: "test/cookie (copy).test.js", line: 4 });
    expect(frameLocation("at Context.<anonymous> (/work/repo/test/a (1).js:4:12)")).toEqual({ file: "test/a (1).js", line: 4 });
    expect(frameColumn("at Context.<anonymous> (test/res.cookie.js:197:12)")).toBe(12);
  });

  it("CB-7: both text controls keep the behavior, parse, and hold the other version as code on both sides", () => {
    const original = Buffer.from("function f(x) {\n  return !isNaN(x) ? Math.floor(x / 1000) : null;\n}\n");
    const site = original.indexOf("!");
    const fault = Buffer.concat([original.subarray(0, site), original.subarray(site + 1)]);
    const c = textControls("lib/f.js", original, fault, { operator: "negation_removal", site: { bytes: { start: site, end: site + 1 } }, replacement_text: "" })!;
    expect(c.originalText.toString()).toContain("(0 ? isNaN(x) : 1 ? !isNaN(x) : isNaN(x))");
    expect(c.faultText.toString()).toContain("(0 ? !isNaN(x) : 1 ? isNaN(x) : !isNaN(x))");
    const evalF = (src: Buffer) => new Function(`${src.toString()}; return [f(1500), f('x')];`)();
    expect(evalF(c.originalText)).toEqual(evalF(original));
    expect(evalF(c.faultText)).toEqual(evalF(fault));
  });

  it("CB-8: a manifest with a null entry or a '.' path is refused, not a crash", () => {
    const run = survivedRun();
    const dir = path.join(run.w.repo, run.brief);
    const manifest = JSON.parse(readFileSync(path.join(dir, "MANIFEST.json"), "utf8"));
    writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify({ ...manifest, files: [...manifest.files, null] }));
    expect(verifyRunFolder(dir).ok).toBe(false);
    writeFileSync(path.join(dir, "MANIFEST.json"), JSON.stringify({ ...manifest, files: [...manifest.files, { path: ".", sha256: "0" }] }));
    expect(verifyRunFolder(dir).ok).toBe(false);
  });
});

describe("the independent read of demo.7 (round 3)", { timeout: 180_000 }, () => {
  const readWith = (original: string, body: string) => {
    const after = withTest(original, testWith(body));
    const applied = applyAdditivePatch(Buffer.from(original), parseAdditivePatch(candidate(original, after)));
    return { after, test: readNewTest({ path: TEST_FILE, patched: applied.bytes, original: Buffer.from(original), added: applied.added }) };
  };
  const refusedBody = (body: string, original = PASSING_TESTS): string => messageOf(() => readWith(original, body));

  it.each([
    ["F1: a built-in stored in an array slot, then replaced through it", "    var box = [];\n    box[0] = Math;\n    box[0].ceil = function () { return 0; };\n"],
    ["F1: the target stored in a member, then replaced through it", "    var holder = {};\n    holder.api = api;\n    holder.api.seconds = function () { return 1; };\n"],
    ["F1: a built-in returned by a getter, then replaced through it", "    var o = { get m() { return Math; } };\n    o.m.ceil = function () { return 0; };\n"],
    ["F1: the target pushed into an array, then replaced through it", "    var box = [];\n    box.push(api);\n    box[0].seconds = function () { return 1; };\n"],
    ["F1: a member named at run time", "    var o = {};\n    var k = 'seconds';\n    o[k] = 1;\n"],
    ["FR-4: new Object(x), which returns x itself", "    var o = new Object(api);\n    o.seconds = null;\n"],
    ["F3: a stack set with Object.assign", "    var e = new Error('not one');\n    Object.assign(e, { stack: 'forged' });\n"],
    ["F3: a stack defined with defineProperty", "    var e = new Error('not one');\n    Object.defineProperty(e, 'stack', { value: 'forged' });\n"],
    ["F3: a stack defined with defineProperties", "    var e = new Error('not one');\n    Object.defineProperties(e, { stack: { value: 'forged' } });\n"],
    ["F3: a literal with a stack member", "    var e = { name: 'AssertionError', stack: 'forged' };\n"],
    ["F3: prepareStackTrace written through a member named at run time", "    var o = {};\n    o.E = Error;\n    var k = 'prepare';\n    k += 'StackTrace';\n    o.E[k] = function () { return 'x'; };\n"],
    ["F3: defineProperty with a name computed at run time", "    var e = new Error('x');\n    var k = 'sta' + String('ck');\n    Object.defineProperty(e, k, { value: 'forged' });\n"],
    ["F3: defineProperties with names it does not spell out", "    var e = new Error('x');\n    var props = {};\n    Object.defineProperties(e, props);\n"],
    ["FR-1: Mocha's own after() hook inside the test", "    after(function () {});\n"]
  ])("refuses %s", (_label, body) => {
    expect(refusedBody(`${body}    ${ASSERT_ONE}\n`)).toMatch(/verify-test refused \(candidate_invalid\)/);
  });

  it("F1, FR-4: a direct member of a local the test made may be written, whatever the literal holds", () => {
    for (const body of [
      "    var o = {};\n    o.x = api;\n",
      "    var options = { maxAge: 60 * 60 * 1000 };\n    options.path = '/admin';\n",
      "    var options = { maxAge: 1500, signed: !true };\n    options.path = '/admin';\n",
      "    var maxAge = 1500;\n    var options = { maxAge: maxAge };\n    options.httpOnly = true;\n",
      "    var options = { maxAge: Number('1500') };\n    options['path'] = '/';\n",
      "    var opts = new Object();\n    opts.maxAge = 1500;\n",
      "    var a = new Uint16Array(1);\n    a[0] = 1;\n"
    ]) {
      expect(readWith(PASSING_TESTS, `${body}    ${ASSERT_ONE}\n`).test.fullTitle).toBe(FULL_TITLE);
    }
  });

  it("F1, F3: the reviewers' end-to-end spy and forged-stack tests are refused before any copy runs", () => {
    const spy = "    var box = [];\n    box[0] = Math;\n    var ceil = Math.ceil;\n    box[0].ceil = function () {\n      box[0].ceil = ceil;\n      assert.fail('rounded up');\n    };\n    try { api.seconds(1500); } finally { box[0].ceil = ceil; }\n";
    expect(messageOf(() => verifyBody(spy, "assert.fail('rounded up');"))).toMatch(/^verify-test refused \(candidate_invalid\)/);
    const forged = "    var e = new Error('not one');\n    Object.assign(e, { name: 'AssertionError', stack: 'AssertionError: not one' });\n    if (api.seconds(1500) !== 1) throw e;\n    assert.ok(true);\n";
    expect(messageOf(() => verifyBody(forged, "assert.ok(true);"))).toMatch(/^verify-test refused \(candidate_invalid\)/);
  });

  it("F4, A4-2: a control that would change how code without semicolons parses is not built", () => {
    const roundingPlan = (bytes: Buffer, at: number) => ({ operator: "rounding_floor_ceil", site: { bytes: { start: at, end: at + "Math.floor".length } }, replacement_text: "Math.ceil" });
    const ceilAt = (bytes: Buffer, at: number) => Buffer.concat([bytes.subarray(0, at), Buffer.from("Math.ceil"), bytes.subarray(at + "Math.floor".length)]);
    const rounding = Buffer.from("function f(ms) {\n  var s = 0\n  Math.floor(ms / 1000) < ms / 1000 && (s = -1)\n  return Math.round(ms / 1000) + s\n}\n");
    const at = rounding.indexOf("Math.floor");
    expect(textControls("lib/f.js", rounding, ceilAt(rounding, at), roundingPlan(rounding, at))).toBeNull();
    const negation = Buffer.from("function g(x) {\n  var out = null\n  !isNaN(x) && (out = x)\n  return out\n}\n");
    const bang = negation.indexOf("!");
    const negationFault = Buffer.concat([negation.subarray(0, bang), negation.subarray(bang + 1)]);
    expect(textControls("lib/g.js", negation, negationFault, { operator: "negation_removal", site: { bytes: { start: bang, end: bang + 1 } }, replacement_text: "" })).toBeNull();
    // With the semicolon, the same site gets both controls.
    const semicolon = Buffer.from(rounding.toString().replace("var s = 0\n", "var s = 0;\n"));
    const at2 = semicolon.indexOf("Math.floor");
    expect(textControls("lib/f.js", semicolon, ceilAt(semicolon, at2), roundingPlan(semicolon, at2))).not.toBeNull();
  });

  it("FR-1: a name the file declares is not Mocha's hook (var after = require('after'))", () => {
    const withAfter = PASSING_TESTS.replace("var api = require('../lib/api');", "var api = require('../lib/api');\nvar after = require('after');");
    expect(withAfter).not.toBe(PASSING_TESTS);
    expect(readWith(withAfter, `    var cb = after(1, function () {});\n    cb();\n    ${ASSERT_ONE}\n`).test.fullTitle).toBe(FULL_TITLE);
  });

  it("FR-2: a chai property assertion is declared at the `.` before its property, where V8 reports a getter's throw", () => {
    for (const assertion of ["    expect(api.seconds(1500) === 1).to.be.true;", "    (api.seconds(1500) === 1).should.be.true;"]) {
      const { after, test } = readWith(PASSING_TESTS, `${assertion}\n`);
      const line = after.split("\n").indexOf(assertion) + 1;
      expect([...(test.assertionPositions.get(line) ?? [])]).toContain(assertion.indexOf(".true") + 1);
    }
  });

  it("A4-1: a verify run made before the fault key was recorded still counts as an attempt", () => {
    const run = survivedRun();
    const after = withTest(PASSING_TESTS, NEW_TEST);
    const patch = candidate(PASSING_TESTS, after);
    const result = verify(run, patch, recordFor(run, patch, after, ASSERT_ONE));
    const dir = path.join(run.w.repo, result.run_dir);
    const tag = JSON.parse(readFileSync(path.join(dir, "fault-run.json"), "utf8"));
    delete tag.fault_key;
    writeFileSync(path.join(dir, "fault-run.json"), recordBytes(tag));
    rmSync(path.join(dir, "MANIFEST.json"));
    writeRunManifest(dir, path.basename(dir), "test");
    const key = faultKeyOf(JSON.parse(readFileSync(path.join(run.w.repo, run.faultRun, "fault-record.json"), "utf8")));
    expect(earlierAttempts(path.join(run.w.repo, ".orangepro", "proof-runs"), key).map((a) => a.run_id)).toEqual([path.basename(dir)]);
  });

  it("A4-4: the repeat run on the fault must fail at the declared column, as an assertion, too", () => {
    const run = survivedRun();
    const after = withTest(PASSING_TESTS, NEW_TEST);
    const patch = candidate(PASSING_TESTS, after);
    const record = recordFor(run, patch, after, ASSERT_ONE);
    const result = verify(run, patch, record);
    expect(result.verdict.result).toBe("verified_gap");
    const dir = path.join(run.w.repo, result.run_dir);
    const stages = Object.fromEntries(result.verdict.stages.map((ref) => [ref.stage, JSON.parse(readFileSync(path.join(dir, ref.path), "utf8"))])) as Record<StageName, StageObservation>;
    const expectedTargetSha = Object.fromEntries(Object.entries(stages).map(([name, stage]) => [name, stage.copy_target_sha256])) as Partial<Record<StageName, string>>;
    const priorIds = [`${TEST_FILE}\u0000api.seconds converts whole seconds`, `${TEST_FILE}\u0000api.seconds returns null for a value that is not a number`];
    const mineE = stages.candidate_fault.tests!.observed.find((t) => t.full_title === FULL_TITLE)!;
    const declaredColumns = [frameColumn(mineE.failure!.first_frame)!];
    const base = { stages, assertion: record, baseline: 2, priorIds, expectedTargetSha, copyWriteFailed: null, checkoutUnchanged: true, declaredColumns, faultRunScope: "full_suite" as const };
    expect(classifyCandidate(base).result).toBe("verified_gap");
    const repeatWith = (change: (failure: any) => void) => {
      const copy = JSON.parse(JSON.stringify(stages.candidate_fault_repeat));
      change(copy.tests.observed.find((t: any) => t.full_title === FULL_TITLE).failure);
      return classifyCandidate({ ...base, stages: { ...stages, candidate_fault_repeat: copy } });
    };
    expect(repeatWith((f) => { f.first_frame = f.first_frame.replace(/:(\d+)\)$/, ":40)"); })).toMatchObject({ result: "inconclusive", reason: "candidate_not_deterministic" });
    expect(repeatWith((f) => { f.name = "TypeError"; f.at_assertion = false; })).toMatchObject({ result: "inconclusive", reason: "candidate_not_deterministic" });
  });

  it("A4-3: the refusal, the brief and the docs state the write rule as the code applies it", () => {
    const message = refusedBody(`    var holder = {};\n    holder.api = api;\n    holder.api.seconds = null;\n    ${ASSERT_ONE}\n`);
    for (const words of ["one level", "new Object() with no argument", "Uint16Array", "never a value it gets from a call it did not make"]) expect(message).toContain(words);
    const run = survivedRun();
    const brief = readFileSync(path.join(run.w.repo, run.brief, "brief", "brief.md"), "utf8");
    for (const words of ["one level and named in the code", "captureStackTrace or __proto__", "this inside a nested function", "a with statement"]) expect(brief).toContain(words);
    const docs = readFileSync(path.join(process.cwd(), "docs", "local-proof-kit.md"), "utf8").replace(/\s+/g, " ");
    for (const words of ["one level and named in the code", "a whole-suite count other than the fixture's baseline", "count as hooks only when the file does not declare", "used only when it parses exactly as the fault"]) expect(docs).toContain(words);
  });
});
