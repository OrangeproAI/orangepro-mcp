import { readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { opTestBrief, opVerifyTest } from "../../src/local/candidateTest.js";
import { ASSERTION_RECORD_VERSION, type AssertionRecord } from "../../src/local/contracts/candidate.js";
import { unifiedFileDiff } from "../../src/local/contracts/faultRecord.js";
import { recordBytes, verifyRunFolder, writeRunManifest } from "../../src/local/contracts/io.js";
import type { VerificationReceipt } from "../../src/local/contracts/verificationReceipt.js";
import type { ContainerExecutor } from "../../src/local/boundary.js";
import { computeRows, opExportTests, summaryHtml } from "../../src/local/exportTests.js";
import { ProbeFaultRefusal } from "../../src/local/faultProbe.js";
import { deps, hostExecutor, OFFSETS, PASSING_TESTS, passingProbe, probe, sha256, trackedChanges, workspace, type Workspace } from "./support/probeWorkspace.js";

const ROUNDING = `rounding_floor_ceil@${OFFSETS.floorInSeconds}`;
const TEST_FILE = "test/api.test.js";
const TITLE = "should round a sub-second value down to whole seconds";
const ASSERT = "assert.strictEqual(api.seconds(1500), 1);";

function withTest(before: string, block: string): string {
  const at = before.lastIndexOf("});");
  return `${before.slice(0, at)}${block}${before.slice(at)}`;
}

let n = 0;
/** A2 → brief → A3 on a fresh synthetic workspace; returns the verify run. */
function verified(body = `    ${ASSERT}\n`, assertText = ASSERT): { w: Workspace; verifyRun: string; faultRun: string; brief: string } {
  const w = workspace();
  const fault = probe(w, ROUNDING, { full_suite: true });
  n += 1;
  const brief = opTestBrief(w.repo, { from_run: fault.run_dir }, { runId: () => `run_brief_x${n}` });
  const after = withTest(PASSING_TESTS, `  it('${TITLE}', function () {\n${body}  });\n`);
  const patch = Buffer.from(unifiedFileDiff(TEST_FILE, PASSING_TESTS, after), "utf8");
  const record: AssertionRecord = {
    version: ASSERTION_RECORD_VERSION,
    generation_request_sha256: brief.generation_request_sha256,
    fault_record_sha256: sha256(readFileSync(path.join(w.repo, fault.run_dir, "fault-record.json"))),
    candidate: { patch_sha256: sha256(patch), files: [{ path: TEST_FILE, sha256_after: sha256(after) }] },
    test: { file: TEST_FILE, full_title: `api.seconds ${TITLE}` },
    assertion: { file: TEST_FILE, line: after.split("\n").findIndex((l) => l.includes(assertText)) + 1, text: assertText, condition: "seconds(1500) is 1, the oracle's value" },
    failure_recognition: "first_frame_at_declared_line",
    generation: { by: "host_agent", agent: "test agent", assisted: true, saw: ["the brief"], attempt: 1 }
  };
  const v = opVerifyTest(w.repo, { from_run: fault.run_dir, brief: brief.run_dir, candidate_bytes: patch, assertion: record }, { clock: deps.clock, container: hostExecutor(), runId: () => `run_verify_x${n}` });
  return { w, verifyRun: v.run_dir, faultRun: fault.run_dir, brief: brief.run_dir };
}

let e = 0;
const exportRun = (w: Workspace, from: string, executor: ContainerExecutor = hostExecutor()) =>
  opExportTests(w.repo, { from_run: from }, { clock: deps.clock, container: executor, runId: () => `run_export_${++e}` });

function refusalOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof ProbeFaultRefusal) return error.code;
    throw error;
  }
  return "not refused";
}

describe("opro export-tests — the test-only patch, the fresh replay and the receipt", { timeout: 240_000 }, () => {
  it("exports a test-only patch, replays it on a fresh copy, and writes a receipt with rows A–H met", () => {
    const s = verified();
    const result = exportRun(s.w, s.verifyRun);
    const r = result.receipt;
    expect(r.classification).toEqual({ fault: "verified_gap", reason: null, generation: "generated", adoption: "not_delivered", delivery: "artifact_only" });
    expect(r.rows.map((row) => [row.row, row.met])).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"].map((x) => [x, true]));
    const dir = path.join(s.w.repo, result.run_dir);
    expect(verifyRunFolder(dir).ok).toBe(true);
    const patch = readFileSync(path.join(dir, "orangepro-tests.patch"), "utf8");
    expect(patch.split("\n").filter((l) => /^diff --git /.test(l))).toEqual([`diff --git a/${TEST_FILE} b/${TEST_FILE}`]);
    expect(patch.split("\n").filter((l) => l.startsWith("-") && !l.startsWith("---"))).toEqual([]);
    expect(r.deliverables.test_patch.sha256).toBe(sha256(readFileSync(path.join(dir, "orangepro-tests.patch"))));
    expect(r.deliverables.diagnostic_fault_patch.sha256).toBe(sha256(readFileSync(path.join(dir, "diagnostic-fault.patch"))));
    expect(readFileSync(path.join(dir, "diagnostic-fault.patch"))).toEqual(readFileSync(path.join(s.w.repo, s.faultRun, "diagnostic-fault.patch")));
    // Every stage the receipt names is a file whose sha256 matches.
    for (const stage of r.stages) {
      const runDir = stage.run_id === r.run_ids.export ? dir : path.join(s.w.repo, ".orangepro", "proof-runs", stage.run_id);
      expect(sha256(readFileSync(path.join(runDir, stage.path)))).toBe(stage.sha256);
    }
    expect(r.stages.filter((st) => st.run_id === r.run_ids.export).map((st) => [st.stage, st.executed, st.failed])).toEqual([
      ["fresh_full_suite", 2, 0],
      ["fresh_full_suite_with_patch", 3, 0],
      ["fresh_fault_full_suite_with_patch", 3, 1],
      ["fresh_restored_test_file", 3, 0]
    ]);
    expect(r.generation).toMatchObject({ by: "host_agent", agent: "test agent", assisted: true });
    // The page: no request leaves it, and the same receipt gives the same bytes.
    const html = readFileSync(path.join(dir, "summary.html"), "utf8");
    expect(html).not.toMatch(/(?:src|href)\s*=\s*["']?https?:/i);
    expect(html).toContain("Verified: the new test catches the fault the old tests missed");
    expect(html).toContain("A coding agent (test agent) wrote the test from OrangePro's brief; OrangePro verified it.");
    expect(trackedChanges(s.w.repo)).toBe("");
  });

  it("refuses a run whose new test was not verified", () => {
    const s = verified("    assert.strictEqual(api.seconds(1500), 2);\n", "assert.strictEqual(api.seconds(1500), 2);");
    expect(refusalOf(() => exportRun(s.w, s.verifyRun))).toBe("not_verified");
  });

  it("refuses a verify run edited after it finished, or a verdict edited and sealed again", () => {
    const s = verified();
    const stage = path.join(s.w.repo, s.verifyRun, "stages", "candidate_fault.json");
    const original = readFileSync(stage);
    writeFileSync(stage, `${original.toString().trimEnd()} `);
    expect(refusalOf(() => exportRun(s.w, s.verifyRun))).toBe("run_invalid");
    writeFileSync(stage, original);
    const failing = verified("    assert.strictEqual(api.seconds(1500), 2);\n", "assert.strictEqual(api.seconds(1500), 2);");
    const dir = path.join(failing.w.repo, failing.verifyRun);
    const verdict = JSON.parse(readFileSync(path.join(dir, "classification.json"), "utf8"));
    writeFileSync(path.join(dir, "classification.json"), recordBytes({ ...verdict, result: "verified_gap", reason: null }));
    rmSync(path.join(dir, "MANIFEST.json"));
    writeRunManifest(dir, path.basename(dir), "test");
    expect(refusalOf(() => exportRun(failing.w, failing.verifyRun))).toBe("run_invalid");
  });

  it("refuses a candidate edited and sealed again: it no longer gives the verified bytes", () => {
    const s = verified();
    const dir = path.join(s.w.repo, s.verifyRun);
    const patch = readFileSync(path.join(dir, "candidate.patch"), "utf8");
    writeFileSync(path.join(dir, "candidate.patch"), patch.replace("1500), 1", "1500), 1 "));
    rmSync(path.join(dir, "MANIFEST.json"));
    writeRunManifest(dir, path.basename(dir), "test");
    expect(refusalOf(() => exportRun(s.w, s.verifyRun))).toBe("patch_invalid");
  });

  it("refuses a checkout that changed since the runs, and a missing brief run", () => {
    const s = verified();
    const target = path.join(s.w.repo, "lib/api.js");
    const original = readFileSync(target, "utf8");
    writeFileSync(target, `${original}// edited\n`);
    expect(refusalOf(() => exportRun(s.w, s.verifyRun))).toBe("stale_checkout");
    writeFileSync(target, original);
    rmSync(path.join(s.w.repo, s.brief), { recursive: true });
    expect(refusalOf(() => exportRun(s.w, s.verifyRun))).toBe("run_invalid");
  });

  it("a boundary that does not hold in the replay blocks the receipt", () => {
    const s = verified();
    const result = exportRun(s.w, s.verifyRun, hostExecutor((request) => ({ ...passingProbe(request), network_reachable: true })));
    expect(result.receipt.classification.fault).toBe("blocked");
  });

  it("a replay row that is not met makes the receipt inconclusive, naming the row; the page says so", () => {
    const s = verified();
    const result = exportRun(s.w, s.verifyRun);
    const dir = path.join(s.w.repo, result.run_dir);
    const r: VerificationReceipt = result.receipt;
    const fresh = Object.fromEntries(r.stages.filter((st) => st.run_id === r.run_ids.export).map((st) => [st.stage, JSON.parse(readFileSync(path.join(dir, st.path), "utf8"))]));
    const refs = r.stages.filter((st) => st.run_id === r.run_ids.export).map((st) => ({ stage: st.stage as never, path: st.path, sha256: st.sha256 }));
    // G with one failure: not met.
    const g = JSON.parse(JSON.stringify(fresh.fresh_full_suite_with_patch));
    g.tests.failed = 1;
    g.tests.passed -= 1;
    const rows = computeRows({
      fault: { run: { runId: r.run_ids.fault, classification: { classification: "survived_unverified", reached_by_selected_tests: "reached", behavioral_difference: { status: "differs" } }, faultRecord: { validity: { parse: "ok" } } } as never, stages: {}, refs: [] },
      verify: { run: { runId: r.run_ids.verify, assertion: JSON.parse(readFileSync(path.join(s.w.repo, s.verifyRun, "assertion-record.json"), "utf8")), stageRefs: [] } as never, recomputed: "verified_gap" },
      fresh: { runId: r.run_ids.export, stages: { ...fresh, fresh_full_suite_with_patch: g }, refs },
      baseline: 2,
      originalSha: fresh.fresh_full_suite.copy_target_sha256,
      mutatedSha: fresh.fresh_fault_full_suite_with_patch.copy_target_sha256,
      restoreConfirmed: true
    });
    expect(rows.find((row) => row.row === "G")).toMatchObject({ met: false });
    expect(rows.find((row) => row.row === "H")).toMatchObject({ met: true });
    const page = summaryHtml({ ...r, rows, classification: { ...r.classification, fault: "inconclusive", reason: "row_G_not_met" } }, "", "x", { oracle: { behavior: "b", expected: "e" }, classification: { statement: "s" } } as never);
    expect(page).toContain("Inconclusive: no claim");
    expect(page).toContain("not met:");
  });
});
