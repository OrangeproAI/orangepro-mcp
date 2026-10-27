import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { dockerExecutor, WORK_OUT } from "./boundary.js";
import { applyAdditivePatch, parseAdditivePatch, readNewTest } from "./candidatePatch.js";
import {
  allowedPaths,
  atDeclared,
  classifyCandidate,
  earlierAttempts,
  globMatches,
  issueOf,
  loadFaultRun,
  runFolderOf,
  setRefusingCommand,
  textControls,
  type FaultRun
} from "./candidateTest.js";
import { checkAssertionRecord, type AssertionRecord, type CandidateVerdict } from "./contracts/candidate.js";
import { planFault, unifiedFileDiff } from "./contracts/faultRecord.js";
import { newRunId, recordBytes, recordSha256, sha256Hex, verifyRunFolder, writeFileAtomic, writeRunManifest } from "./contracts/io.js";
import { RUN_PROFILE_VERSION, type Classification, type RunProfile, type StageName, type StageObservation } from "./contracts/receipt.js";
import { PROOF_ROW_MEANING, VERIFICATION_RECEIPT_VERSION, type ProofRow, type ProofRowResult, type ReceiptStage, type StageRef, type VerificationReceipt } from "./contracts/verificationReceipt.js";
import {
  containerProfile,
  createStageRunner,
  frameLocation,
  makeMountsFor,
  MOCHA_ENTRY,
  MOCHA_NO_REPO_CONFIG,
  prepareFaultCopies,
  ProbeFaultRefusal,
  readFixture,
  realInside,
  REPORTER_TARGET,
  trackedStatus,
  treeHashes,
  type ProbeFaultDeps
} from "./faultProbe.js";
import { resolveTargetSymbol } from "./ledger.js";
import { defaultDynamicProofRunner, ProofRefusalError, proofPreflight } from "./operations.js";
import { toWorkspaceRel } from "./reprove/paths.js";
import { ORANGEPRO_VERSION } from "./version.js";
import { loadGraph, workspacePaths } from "./workspace.js";

// Milestone A4: `opro export-tests --from-run <verify-test run>`. From a verified_gap run it writes the
// test-only patch (orangepro-tests.patch, rebuilt from the verified bytes and checked under `git apply`),
// replays it on a fresh copy of the merged commit inside the container (the existing whole suite, the
// whole suite with the patch, the same fault with the patch, then restored), and writes the
// verification receipt and a one-page summary, computed only from the run folders' observations.

export const EXPORT_REFUSALS = ["run_invalid", "not_verified", "stale_checkout", "patch_invalid", "not_installed"] as const;

const refuse = (code: (typeof EXPORT_REFUSALS)[number] | string, detail: string): never => {
  throw new ProbeFaultRefusal(code, detail, "export-tests");
};

/** Run `fn`; any refusal from a shared helper is re-raised as export-tests', keeping its code. */
function asExport<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ProbeFaultRefusal && !error.message.startsWith("export-tests refused")) refuse(error.code, error.message.replace(/^[a-z-]+ refused \([^)]*\): /, ""));
    if (error instanceof ProofRefusalError) refuse(error.code, error.message.replace(/^prove refused \([^)]*\): /, ""));
    throw error;
  }
}

const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));

/** What `git apply -p1` makes of the patch on the original bytes, in a scratch folder git cannot see out of, with no configuration; null when git refuses it. */
function gitAppliedBytes(path: string, original: Buffer, patch: Buffer): Buffer | null {
  const scratch = mkdtempSync(join(tmpdir(), "opro-git-apply-"));
  try {
    const file = join(scratch, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, original);
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: dirname(scratch) };
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "apply", "-p1", "--whitespace=nowarn", "-"], { cwd: scratch, env, input: patch });
    if (result.status !== 0 || /Skipped patch/.test(result.stderr?.toString() ?? "")) return null;
    return readFileSync(file);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

function git(root: string, args: string[]): string {
  return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
}

/** `github.com/org/repo`, never a URL with credentials. */
function repositoryName(origin: unknown): string | null {
  const text = typeof origin === "string" ? origin : typeof (origin as { url?: unknown })?.url === "string" ? ((origin as { url: string }).url) : typeof (origin as { repository?: unknown })?.repository === "string" ? ((origin as { repository: string }).repository) : null;
  if (!text) return null;
  const m = /github\.com[/:]([^/\s]+)\/([^/\s.]+)/.exec(text);
  return m ? `github.com/${m[1]}/${m[2]}` : null;
}

export interface ExportTestsOptions {
  from_run: string;
  source?: string;
}

export interface ExportTestsResult {
  run_id: string;
  run_dir: string;
  receipt: VerificationReceipt;
}

interface VerifyRun {
  dir: string;
  runId: string;
  manifestSha: string;
  verdict: CandidateVerdict;
  assertion: AssertionRecord;
  candidate: Buffer;
  profile: RunProfile;
  tag: { fault_run?: { run_id?: string; manifest_sha256?: string }; brief_run?: { run_id?: string | null; manifest_sha256?: string } };
  stages: Partial<Record<StageName, StageObservation>>;
  stageRefs: Classification["stages"];
}

function loadVerifyRun(root: string, given: string): VerifyRun {
  const dir = runFolderOf(root, given, "run_invalid");
  const check = verifyRunFolder(dir);
  if (!check.ok) return refuse("run_invalid", `${given}: ${check.message}`);
  for (const need of ["fault-run.json", "classification.json", "assertion-record.json", "candidate.patch", "run-profile.json"]) {
    if (!existsSync(join(dir, need))) refuse("run_invalid", `${given} is not a verify-test run: it has no ${need}.`);
  }
  const tag = readJson(join(dir, "fault-run.json"));
  if (tag.kind !== "verify_test") refuse("run_invalid", `${given} is not a verify-test run.`);
  const verdict = readJson(join(dir, "classification.json")) as CandidateVerdict;
  if (verdict.result !== "verified_gap") refuse("not_verified", `the new test in ${given} was not verified (${verdict.result}${verdict.reason ? `, ${verdict.reason}` : ""}): there is nothing to export.`);
  const recordCheck = checkAssertionRecord(readJson(join(dir, "assertion-record.json")));
  if (!recordCheck.ok) return refuse("run_invalid", recordCheck.message);
  const stages: Partial<Record<StageName, StageObservation>> = {};
  for (const ref of verdict.stages) stages[ref.stage as StageName] = readJson(join(dir, ref.path)) as StageObservation;
  return {
    dir,
    runId: check.manifest.run_id,
    manifestSha: sha256Hex(readFileSync(join(dir, "MANIFEST.json"))),
    verdict,
    assertion: recordCheck.record,
    candidate: readFileSync(join(dir, "candidate.patch")),
    profile: readJson(join(dir, "run-profile.json")) as RunProfile,
    tag,
    stages,
    stageRefs: verdict.stages as Classification["stages"]
  };
}

function stageRef(runId: string, ref: { stage: string; path: string; sha256: string }): StageRef {
  return { run_id: runId, stage: ref.stage, path: ref.path, sha256: ref.sha256 };
}

function receiptStage(runId: string, ref: { stage: string; path: string; sha256: string }, stage: StageObservation, newTest: { file: string; full_title: string } | null): ReceiptStage {
  const t = stage.tests;
  const mine = newTest ? t?.observed.find((test) => test.file === newTest.file && test.full_title === newTest.full_title) : undefined;
  const at = mine?.failure ? frameLocation(mine.failure.first_frame) : null;
  const column = mine?.failure?.first_frame ? Number((/:(\d+)\)?$/.exec(mine.failure.first_frame) ?? [])[1] ?? NaN) : NaN;
  return {
    ...stageRef(runId, ref),
    fault_present: stage.fault_record_sha256 !== null,
    copy_target_sha256: stage.copy_target_sha256,
    argv: stage.argv,
    exit_code: stage.exit_code,
    timed_out: stage.timed_out,
    started_at: stage.started_at,
    duration_ms: stage.duration_ms,
    executed: t?.executed ?? null,
    passed: t?.passed ?? null,
    failed: t?.failed ?? null,
    pending: t?.pending ?? null,
    new_test: newTest ? (mine ? mine.state : "missing") : "not_present",
    new_test_failed_at: at ? { file: at.file, line: at.line, column: Number.isFinite(column) ? column : null } : null,
    logs: [stage.stdout, stage.stderr, ...(stage.report ? [stage.report] : [])].map((f) => ({ path: f.path, sha256: f.sha256 }))
  };
}

/** Rows A–H of the proof contract, computed from the observed stage files only. */
export function computeRows(input: {
  fault: { run: FaultRun; stages: Partial<Record<StageName, StageObservation>>; refs: Classification["stages"] };
  verify: { run: VerifyRun; recomputed: string };
  fresh: { runId: string; stages: Partial<Record<StageName, StageObservation>>; refs: Classification["stages"] };
  baseline: number;
  originalSha: string;
  mutatedSha: string;
  restoreConfirmed: boolean;
  /** The columns where the declared assertion call names its check (row H matches them, as verify-test does). */
  declaredColumns: number[];
}): ProofRowResult[] {
  const { fault, verify, fresh } = input;
  const assertion = verify.run.assertion;
  const isMine = (test: { file: string; full_title: string }): boolean => test.file === assertion.test.file && test.full_title === assertion.test.full_title;
  const refsOf = (runId: string, refs: Classification["stages"], names: string[]): StageRef[] => refs.filter((r) => names.includes(r.stage)).map((r) => stageRef(runId, r));
  const clean = (stage: StageObservation | undefined): boolean => Boolean(stage && issueOf(stage) === null && stage.exit_code === 0 && stage.tests!.failed === 0 && stage.tests!.pending === 0 && stage.tests!.executed > 0);
  const row = (name: ProofRow, met: boolean, reason: string, stages: StageRef[]): ProofRowResult => ({ row: name, meaning: PROOF_ROW_MEANING[name], met, reason: met ? null : reason, stages });

  const a = fresh.stages.fresh_full_suite;
  const b = fault.stages.original_selected;
  const c = fault.stages.fault_selected;
  const cls = fault.run.classification;
  const verified = verify.recomputed === "verified_gap";
  const g = fresh.stages.fresh_full_suite_with_patch;
  const h = fresh.stages.fresh_fault_full_suite_with_patch;
  const hr = fresh.stages.fresh_restored_test_file;
  const hFailed = h?.tests?.observed.filter((test) => test.state === "failed") ?? [];
  return [
    row("A", clean(a) && a!.tests!.passed === input.baseline && a!.copy_target_sha256 === input.originalSha, "the existing whole suite did not pass on the fresh original with the fixture's count", refsOf(fresh.runId, fresh.refs, ["fresh_full_suite"])),
    row("B", clean(b), "the selected tests did not pass cleanly on the original", refsOf(fault.run.runId, fault.refs, ["original_selected"])),
    row(
      "C",
      cls.classification === "survived_unverified" && clean(c) && c!.tests!.passed === b?.tests?.passed && fault.run.faultRecord.validity.parse === "ok" && cls.reached_by_selected_tests === "reached" && cls.behavioral_difference.status === "differs",
      "the selected tests' survival of a valid, reached fault with a behavioral difference is not shown",
      refsOf(fault.run.runId, fault.refs, ["fault_selected", "witness_original", "witness_fault", "original_full_suite", "fault_full_suite"])
    ),
    row("D", verified, `the verify run's stages do not show it (${verify.recomputed})`, refsOf(verify.run.runId, verify.run.stageRefs, ["candidate_original", "candidate_original_repeat"])),
    row("E", verified, `the verify run's stages do not show it (${verify.recomputed})`, refsOf(verify.run.runId, verify.run.stageRefs, ["candidate_fault", "candidate_fault_repeat", "fault_full_suite_with_candidate", "candidate_fault_text_control"])),
    row("F", verified, `the verify run's stages do not show it (${verify.recomputed})`, refsOf(verify.run.runId, verify.run.stageRefs, ["candidate_restored", "candidate_original_text_control", "full_suite_with_candidate"])),
    row(
      "G",
      clean(g) && g!.tests!.executed === input.baseline + 1 && g!.tests!.passed === input.baseline + 1 && g!.copy_target_sha256 === input.originalSha && g!.tests!.observed.some((test) => isMine(test) && test.state === "passed"),
      "the whole suite with the patch did not pass with one more test on the fresh original",
      refsOf(fresh.runId, fresh.refs, ["fresh_full_suite_with_patch"])
    ),
    row(
      "H",
      Boolean(h && issueOf(h) === null && h.copy_target_sha256 === input.mutatedSha && h.tests!.executed === input.baseline + 1 && hFailed.length === 1 && isMine(hFailed[0]!) && atDeclared(hFailed[0], assertion, input.declaredColumns)) &&
        input.restoreConfirmed &&
        clean(hr) &&
        hr!.copy_target_sha256 === input.originalSha &&
        hr!.tests!.observed.some((test) => isMine(test) && test.state === "passed"),
      "on the fresh copy with the patch and the fault, the new test was not the only failure at its declared assertion, or it did not pass once restored",
      refsOf(fresh.runId, fresh.refs, ["fresh_fault_full_suite_with_patch", "fresh_restored_test_file"])
    )
  ];
}

const LIMITATIONS = [
  "Proven means one named test caught one specified fault at its declared assertion on one revision. It is not general correctness or production safety.",
  "The replay's dependencies are the checkout's own install of the frozen lockfile, mounted read-only; no npm install ran for the replay.",
  "The replay runs Mocha with the fixture's options and OrangePro's reporter, not the repository's npm test script.",
  "Generated, verified and adopted are separate states: this patch is verified and not delivered; nothing was merged."
];

export function opExportTests(root: string, opts: ExportTestsOptions, deps: ProbeFaultDeps): ExportTestsResult {
  setRefusingCommand("export-tests");
  try {
    return exportTests(root, opts, deps);
  } finally {
    setRefusingCommand("verify-test");
  }
}

function exportTests(root: string, opts: ExportTestsOptions, deps: ProbeFaultDeps): ExportTestsResult {
  // ── the runs it rests on: each checked against its manifest ──
  const verify = loadVerifyRun(root, opts.from_run);
  const faultRunId = verify.tag.fault_run?.run_id ?? "";
  const run = asExport(() => loadFaultRun(root, join(workspacePaths(root).dir, "proof-runs", faultRunId)));
  if (run.manifestSha !== verify.tag.fault_run?.manifest_sha256) refuse("run_invalid", "the fault run is not the one the verify run names (its manifest changed).");
  const briefRunId = verify.tag.brief_run?.run_id ?? "";
  const briefDir = join(workspacePaths(root).dir, "proof-runs", briefRunId);
  const briefCheck = existsSync(briefDir) ? verifyRunFolder(briefDir) : { ok: false as const, message: "missing" };
  if (!briefCheck.ok || sha256Hex(readFileSync(join(briefDir, "MANIFEST.json"))) !== verify.tag.brief_run?.manifest_sha256) refuse("run_invalid", `the brief run ${briefRunId} is missing or not the one the verify run names.`);
  if (verify.assertion.fault_record_sha256 !== run.profile.fault_record_sha256) refuse("run_invalid", "the verify run's assertion record names another fault.");

  // ── the checkout must still be what the runs saw ──
  const sourceRoot = resolve(opts.source ?? root);
  let head = "";
  try {
    head = git(sourceRoot, ["rev-parse", "HEAD"]);
  } catch {
    refuse("stale_checkout", `${sourceRoot} is not a git checkout.`);
  }
  if (head !== run.record.identity.merged_commit) refuse("stale_checkout", `HEAD is ${head.slice(0, 12)}, not the merged commit ${run.record.identity.merged_commit.slice(0, 12)} the runs used.`);
  const targetAbs = join(sourceRoot, run.record.identity.file);
  if (!existsSync(targetAbs) || sha256Hex(readFileSync(targetAbs)) !== run.faultRecord.file_sha256) refuse("stale_checkout", `the checkout's ${run.record.identity.file} changed since the runs; restore it.`);
  const testPath = verify.assertion.test.file;
  const selected = run.profile.selected_tests.find((t) => t.path === testPath);
  const testAbs = join(sourceRoot, testPath);
  if (!selected || !existsSync(testAbs) || lstatSync(testAbs).isSymbolicLink() || !realInside(sourceRoot, testAbs) || sha256Hex(readFileSync(testAbs)) !== selected.sha256) {
    refuse("stale_checkout", `the checkout's ${testPath} is not as the fault run selected it; restore it with git checkout -- ${testPath}.`);
  }
  const nodeModules = join(sourceRoot, "node_modules");
  const mochaPackage = join(nodeModules, "mocha", "package.json");
  if (!existsSync(join(sourceRoot, MOCHA_ENTRY)) || !existsSync(mochaPackage) || !lstatSync(nodeModules).isDirectory() || !realInside(sourceRoot, nodeModules)) {
    refuse("not_installed", `${sourceRoot} has no installed Mocha of its own: install the fixture first (inside the boundary).`);
  }

  // ── orangepro-tests.patch: rebuilt from the verified bytes, one allowed test file, added lines only, the same under git ──
  const originalTest = readFileSync(testAbs);
  const verifiedApplied = asExport(() => applyAdditivePatch(originalTest, parseAdditivePatch(verify.candidate)));
  const verifiedTest = verifiedApplied.bytes;
  if (sha256Hex(verifiedTest) !== verify.assertion.candidate.files[0]?.sha256_after) refuse("patch_invalid", "the verify run's candidate no longer gives the bytes it verified.");
  // The columns where the declared assertion call names its check, read as verify-test read them.
  const declaredLine = verify.assertion.assertion.line;
  const declaredColumns = [...(asExport(() => readNewTest({ path: testPath, patched: verifiedTest, original: originalTest, added: verifiedApplied.added })).assertionPositions.get(declaredLine) ?? [])];
  if (declaredColumns.length === 0) refuse("run_invalid", `line ${declaredLine} of the verified test is not where an assertion call names its check.`);
  const allowed = asExport(() => allowedPaths(run.fixtureBytes));
  if (!allowed.patterns.some((p) => globMatches(p, testPath)) || allowed.never.some((p) => globMatches(p, testPath))) refuse("patch_invalid", `${testPath} is not a test file the fixture allows a patch to touch.`);
  const mode = git(sourceRoot, ["ls-files", "-s", "--", testPath]).split(/\s+/)[0];
  if (mode !== "100644") refuse("patch_invalid", `${testPath} is not a regular file in the commit (mode ${mode || "none"}).`);
  const testsPatch = Buffer.from(unifiedFileDiff(testPath, originalTest.toString("utf8"), verifiedTest.toString("utf8")), "utf8");
  const parsed = asExport(() => parseAdditivePatch(testsPatch));
  const ours = asExport(() => applyAdditivePatch(originalTest, parsed));
  const byGit = gitAppliedBytes(testPath, originalTest, testsPatch);
  if (parsed.path !== testPath || !ours.bytes.equals(verifiedTest) || !byGit || !byGit.equals(verifiedTest)) refuse("patch_invalid", "the exported patch does not give the verified bytes, by OrangePro's reading or by git's.");
  const faultPatch = readFileSync(join(run.dir, "diagnostic-fault.patch"));
  if (sha256Hex(faultPatch) !== run.faultRecord.diff.sha256) refuse("run_invalid", "the fault run's diagnostic-fault.patch is not the recorded diff.");

  // ── the same fault, re-planned, and the verify run's result recomputed from its stage files ──
  const paths = workspacePaths(root);
  const { symbolTarget, tsjs } = asExport(() => {
    const graph = loadGraph(paths.graphPath);
    const symbol = resolveTargetSymbol(graph, run.record.identity.symbol_id);
    if (!symbol) refuse("stale_checkout", `the graph has no symbol ${run.record.identity.symbol_id}; run opro analyze.`);
    return proofPreflight(root, { target_record: run.record, source: opts.source }, graph, symbol!, "typescript");
  });
  const bound = tsjs?.bound;
  if (!tsjs || !bound) return refuse("stale_checkout", `${run.record.identity.symbol_id} is not changed by its exact position any more.`);
  const fileBytes = readFileSync(tsjs.targetAbs);
  const replanned = planFault(fileBytes, bound.target, run.record.identity.file, run.faultRecord.operator.id, run.faultRecord.site.bytes.start);
  if (!replanned.ok || replanned.plan.mutated_file_sha256 !== run.faultRecord.mutated_file_sha256) refuse("stale_checkout", "the fault planned now is not the fault the run recorded.");
  const plan = replanned.ok ? replanned.plan : (null as never);
  const originalSha = run.faultRecord.file_sha256;
  const controls = textControls(run.record.identity.file, fileBytes, plan.mutated, plan);
  if (!controls) return refuse("run_invalid", `the fault ${run.faultRecord.operator.id} has no text controls, so its verify run cannot have been verified.`);
  const fixture = asExport(() => readFixture(run.fixtureBytes));
  if (fixture.baselinePassing === null) refuse("run_invalid", "the fixture records no baseline count.");
  const recomputed = classifyCandidate({
    stages: verify.stages,
    assertion: verify.assertion,
    baseline: fixture.baselinePassing!,
    priorIds: (run.originalSelected ?? []).filter((t) => t.file === testPath).map((t) => `${t.file}\u0000${t.full_title}`),
    expectedTargetSha: {
      candidate_original: originalSha,
      candidate_original_repeat: originalSha,
      candidate_fault: plan.mutated_file_sha256,
      candidate_fault_repeat: plan.mutated_file_sha256,
      fault_full_suite_with_candidate: plan.mutated_file_sha256,
      candidate_fault_text_control: sha256Hex(controls.faultText),
      candidate_restored: originalSha,
      candidate_original_text_control: sha256Hex(controls.originalText),
      full_suite_with_candidate: originalSha
    },
    copyWriteFailed: null,
    checkoutUnchanged: true,
    declaredColumns,
    faultRunScope: run.classification.scope
  }).result;
  if (recomputed !== verify.verdict.result) refuse("run_invalid", `the verify run's result (${verify.verdict.result}) does not follow from its own stage files (${recomputed}).`);
  const mochaVersion = String((readJson(mochaPackage) as { version?: unknown }).version ?? "unknown");
  const statusBefore = trackedStatus(sourceRoot);

  // ── the export run: the patches first, then the fresh replay ──
  const runId = (deps.runId ?? newRunId)();
  const runDir = join(paths.dir, "proof-runs", runId);
  if (existsSync(runDir)) throw new Error(`${runDir} already exists.`);
  mkdirSync(runDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "opro-export-tests-"));
  const stages: Partial<Record<StageName, StageObservation>> = {};
  const stageRefs: Classification["stages"] = [];
  let restoreConfirmed = false;
  try {
    writeFileAtomic(join(runDir, "fault-run.json"), recordBytes({ kind: "export_tests", fault_run: { run_id: run.runId, manifest_sha256: run.manifestSha }, verify_run: { run_id: verify.runId, manifest_sha256: verify.manifestSha }, brief_run: verify.tag.brief_run }));
    writeFileAtomic(join(runDir, "orangepro-tests.patch"), testsPatch);
    writeFileAtomic(join(runDir, "diagnostic-fault.patch"), faultPatch);
    const mochaHead = ["node", MOCHA_ENTRY, ...MOCHA_NO_REPO_CONFIG, ...fixture.mocha.options, "--reporter", REPORTER_TARGET];
    const fileArgv = [...mochaHead, testPath];
    const fullArgv = [...mochaHead, ...fixture.mocha.operands];
    const deadlineMs = Math.min(deps.stageDeadlineMs ?? 300_000, fixture.shape.deadlineSeconds * 1000);
    const reportEnv = { OPRO_DYNAMIC_PROOF_REPORT: `${WORK_OUT}/report.json` };
    const copyRoots = asExport(() =>
      prepareFaultCopies({ runner: deps.dynamicProofRunner ?? defaultDynamicProofRunner, sourceRoot, targetRel: symbolTarget.file, method: symbolTarget.method, targetAbs: tsjs.targetAbs, bound, plan, tmp, mustHold: run.profile.selected_tests })
    );
    const mountsFor = makeMountsFor(copyRoots, realpathSync(nodeModules), null);
    const profile: RunProfile = {
      version: RUN_PROFILE_VERSION,
      run_id: runId,
      tool: { name: "@orangepro/orangepro-mcp", version: ORANGEPRO_VERSION },
      fixture_manifest_sha256: sha256Hex(run.fixtureBytes),
      source_pr: fixture.prNumber,
      merged_commit: run.record.identity.merged_commit,
      target_record_sha256: run.profile.target_record_sha256,
      oracle_sha256: run.profile.oracle_sha256,
      fault_record_sha256: run.profile.fault_record_sha256,
      witness_sha256: run.profile.witness_sha256,
      selected_tests: [{ path: testPath, sha256: sha256Hex(verifiedTest) }],
      selected_argv: fileArgv,
      full_suite_argv: fullArgv,
      runner: { name: "mocha", version: mochaVersion },
      container: containerProfile(fixture, mountsFor, reportEnv),
      limits: { stage_deadline_ms: deadlineMs },
      candidate: { patch_sha256: sha256Hex(testsPatch), assertion_record_sha256: verify.verdict.assertion_record_sha256, generation_request_sha256: verify.verdict.generation_request_sha256 }
    };
    writeFileAtomic(join(runDir, "run-profile.json"), recordBytes(profile));
    const { runStage, held } = createStageRunner({ runDir, runId, profileSha: recordSha256(profile), faultRecordSha: run.profile.fault_record_sha256, fixture, deadlineMs, tmp, copyRoots, mountsFor, targetRel: symbolTarget.file, faultSpan: plan.site.bytes, executor: deps.container ?? dockerExecutor(), clock: deps.clock, stages, stageRefs });
    const go = (stage: StageName, copy: "original" | "mutant", argv: string[], faultPresent?: boolean): boolean => held(runStage(stage, copy, argv, reportEnv, undefined, faultPresent));
    const sequence = (): void => {
      if (!go("fresh_full_suite", "original", fullArgv)) return;
      // The patch's bytes go into both copies; each copy then differs from before in the test file only.
      for (const copy of Object.values(copyRoots)) {
        const before = treeHashes(copy, new Set());
        writeFileSync(join(copy, testPath), verifiedTest);
        const after = treeHashes(copy, new Set());
        const changed = [...new Set([...before.keys(), ...after.keys()])].filter((p) => before.get(p) !== after.get(p));
        if (changed.length !== 1 || changed[0] !== testPath) refuse("patch_invalid", `a fresh copy is not as the patch leaves it (${changed.join(", ")}).`);
      }
      if (!go("fresh_full_suite_with_patch", "original", fullArgv)) return;
      if (!go("fresh_fault_full_suite_with_patch", "mutant", fullArgv)) return;
      const targetInCopy = join(copyRoots.mutant, symbolTarget.file);
      writeFileSync(targetInCopy, fileBytes);
      restoreConfirmed = sha256Hex(readFileSync(targetInCopy)) === originalSha;
      if (!restoreConfirmed) return;
      go("fresh_restored_test_file", "mutant", fileArgv, false);
    };
    sequence();
  } catch (error) {
    if (error instanceof ProbeFaultRefusal || error instanceof ProofRefusalError) rmSync(runDir, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const checkoutAfter = sha256Hex(readFileSync(targetAbs)) === originalSha && trackedStatus(sourceRoot) === statusBefore;

  // ── rows, receipt and page ──
  const faultStageRefs = (readJson(join(run.dir, "classification.json")) as Classification).stages;
  const faultStages: Partial<Record<StageName, StageObservation>> = {};
  for (const ref of faultStageRefs) faultStages[ref.stage] = readJson(join(run.dir, ref.path)) as StageObservation;
  const rows = computeRows({
    fault: { run, stages: faultStages, refs: faultStageRefs },
    verify: { run: verify, recomputed },
    fresh: { runId, stages, refs: stageRefs },
    baseline: fixture.baselinePassing!,
    originalSha,
    mutatedSha: plan.mutated_file_sha256,
    restoreConfirmed,
    declaredColumns
  });
  const blocked = Object.values(stages).some((s) => s && (s.boundary.failures.length > 0 || !s.stopped)) || !checkoutAfter;
  const firstUnmet = rows.find((r) => !r.met);
  const newTest = { file: testPath, full_title: verify.assertion.test.full_title };
  const fixtureManifest = JSON.parse(run.fixtureBytes.toString("utf8")) as { origin?: unknown; source?: { previous_base_sha?: string; pr?: { number?: number; head_sha?: string } }; dependencies?: { lockfile_sha256?: string } };
  const installedTree = existsSync(join(nodeModules, ".package-lock.json")) ? sha256Hex(readFileSync(join(nodeModules, ".package-lock.json"))) : null;
  const firstFresh = stages.fresh_full_suite;
  const attempts = earlierAttempts(join(paths.dir, "proof-runs"), run.faultKey);
  const receipt: VerificationReceipt = {
    version: VERIFICATION_RECEIPT_VERSION,
    evidence_kind: "runtime_observation",
    tool: { name: "@orangepro/orangepro-mcp", version: ORANGEPRO_VERSION },
    run_ids: { fault: run.runId, brief: briefRunId, verify: verify.runId, export: runId },
    run_manifests: [
      { run_id: run.runId, sha256: run.manifestSha },
      { run_id: briefRunId, sha256: verify.tag.brief_run?.manifest_sha256 ?? "" },
      { run_id: verify.runId, sha256: verify.manifestSha }
    ],
    source: {
      repository: repositoryName(fixtureManifest.origin),
      merged_commit: run.record.identity.merged_commit,
      previous_base: fixtureManifest.source?.previous_base_sha ?? run.record.selection.base_commit ?? null,
      pr_number: fixtureManifest.source?.pr?.number ?? null,
      pr_head: fixtureManifest.source?.pr?.head_sha ?? null,
      target_file: run.record.identity.file,
      target_file_sha256: originalSha,
      lockfile_sha256: fixtureManifest.dependencies?.lockfile_sha256 ?? null,
      clean_checkout: { before: statusBefore === "", after: checkoutAfter && trackedStatus(sourceRoot) === "" }
    },
    environment: {
      container_image: fixture.shape.image,
      container_node: typeof (firstFresh?.boundary.report as { node?: unknown } | null)?.node === "string" ? ((firstFresh!.boundary.report as { node: string }).node) : null,
      host: { node: process.version, platform: `${process.platform}-${process.arch}` },
      runner: { name: "mocha", version: mochaVersion },
      installed_tree_sha256: installedTree,
      run_profiles: [
        { run_id: run.runId, sha256: sha256Hex(readFileSync(join(run.dir, "run-profile.json"))) },
        { run_id: verify.runId, sha256: sha256Hex(readFileSync(join(verify.dir, "run-profile.json"))) },
        { run_id: runId, sha256: sha256Hex(readFileSync(join(runDir, "run-profile.json"))) }
      ]
    },
    selection: {
      target_record_sha256: run.profile.target_record_sha256,
      symbol_id: run.record.identity.symbol_id,
      function_span: run.record.identity.function,
      function_sha256: run.record.identity.function_sha256,
      changed_hunks: run.record.selection.blocks,
      rank: run.record.selection.rank,
      oracle_sha256: run.profile.oracle_sha256,
      oracle_approval: run.oracle.approval,
      assisted: run.oracle.assisted.flag
    },
    mutation: {
      fault_record_sha256: run.profile.fault_record_sha256,
      operator: run.faultRecord.operator,
      site: run.faultRecord.site,
      diff_sha256: run.faultRecord.diff.sha256,
      validity: run.faultRecord.validity,
      reached_by_selected_tests: run.classification.reached_by_selected_tests,
      behavioral_difference: run.classification.behavioral_difference,
      old_tests: { classification: run.classification.classification, scope: run.classification.scope, selected: run.profile.selected_tests }
    },
    generation: {
      state: "generated",
      by: verify.assertion.generation.by,
      agent: verify.assertion.generation.agent,
      assisted: verify.assertion.generation.assisted,
      saw: verify.assertion.generation.saw,
      attempts: attempts.map((a) => ({ run_id: a.run_id, attempt: a.attempt, result: a.result, reason: a.reason })),
      candidate_patch_sha256: verify.assertion.candidate.patch_sha256,
      assertion_record_sha256: verify.verdict.assertion_record_sha256,
      declared_assertion: verify.assertion.assertion,
      new_test: newTest
    },
    stages: [
      ...faultStageRefs.map((ref) => receiptStage(run.runId, ref, faultStages[ref.stage]!, null)),
      ...verify.stageRefs.map((ref) => receiptStage(verify.runId, ref, verify.stages[ref.stage]!, newTest)),
      ...stageRefs.map((ref) => receiptStage(runId, ref, stages[ref.stage]!, ref.stage === "fresh_full_suite" ? null : newTest))
    ],
    rows,
    deliverables: {
      test_patch: { path: "orangepro-tests.patch", sha256: sha256Hex(testsPatch), files: [testPath], added_lines: ours.added.length, removed_lines: 0, allowlist: "passed" },
      diagnostic_fault_patch: { path: "diagnostic-fault.patch", sha256: sha256Hex(faultPatch), note: "the fault, for diagnosis only; never merge it" },
      summary: { path: "summary.html" }
    },
    classification: {
      fault: blocked ? "blocked" : firstUnmet ? "inconclusive" : "verified_gap",
      reason: blocked ? (checkoutAfter ? "boundary_or_container" : "checkout_modified") : firstUnmet ? `row_${firstUnmet.row}_not_met` : null,
      generation: "generated",
      adoption: "not_delivered",
      delivery: "artifact_only"
    },
    limitations: [...LIMITATIONS, ...(verify.verdict.limits ?? [])]
  };
  writeFileAtomic(join(runDir, "verification-receipt.json"), recordBytes(receipt));
  writeFileAtomic(join(runDir, "summary.html"), summaryHtml(receipt, testsPatch.toString("utf8"), verify.verdict.statement, run));
  writeRunManifest(runDir, runId, ORANGEPRO_VERSION);
  return { run_id: runId, run_dir: toWorkspaceRel(root, runDir), receipt };
}

const esc = (text: string): string => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** One local page, from the receipt only: no request leaves it, and the same receipt gives the same bytes. */
export function summaryHtml(r: VerificationReceipt, patch: string, statement: string, run: FaultRun): string {
  const verdictWord = r.classification.fault === "verified_gap" ? "Verified: the new test catches the fault the old tests missed" : r.classification.fault === "blocked" ? "Blocked: no claim" : "Inconclusive: no claim";
  const who = r.generation.by === "provider" ? `OrangePro drafted the test with the owner's model key (${r.generation.agent}) from its brief; OrangePro verified it.` : `A coding agent (${r.generation.agent}) wrote the test from OrangePro's brief; OrangePro verified it.`;
  const old = run.classification;
  const rowsHtml = r.rows.map((row) => `<tr><td>${row.row}</td><td>${esc(row.meaning)}</td><td class="${row.met ? "ok" : "no"}">${row.met ? "met" : `not met: ${esc(row.reason ?? "")}`}</td></tr>`).join("\n");
  const stagesHtml = r.stages
    .map((s) => `<tr><td>${esc(s.run_id)}</td><td>${esc(s.stage)}</td><td>${s.fault_present ? "fault" : "original"}</td><td>${s.executed ?? "—"}</td><td>${s.passed ?? "—"}</td><td>${s.failed ?? "—"}</td><td>${esc(s.new_test)}${s.new_test_failed_at ? ` at ${esc(s.new_test_failed_at.file)}:${s.new_test_failed_at.line}` : ""}</td></tr>`)
    .join("\n");
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>OrangePro verification</title>
<style>
:root{--bg:#fff;--fg:#1d1d1f;--muted:#5f6368;--line:#dadce0;--ok:#137333;--no:#b3261e;--code:#f6f8fa}
@media (prefers-color-scheme: dark){:root{--bg:#121212;--fg:#e8eaed;--muted:#9aa0a6;--line:#3c4043;--ok:#81c995;--no:#f28b82;--code:#1e1e1e}}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
main{max-width:960px;margin:0 auto;padding:24px 16px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:28px 0 8px}
.muted{color:var(--muted)}.ok{color:var(--ok)}.no{color:var(--no)}
.card{border:1px solid var(--line);border-radius:10px;padding:14px 16px;margin:10px 0}
pre{background:var(--code);padding:12px;border-radius:8px;overflow-x:auto;font-size:13px;white-space:pre}
table{border-collapse:collapse;width:100%;font-size:13px;display:block;overflow-x:auto}
td,th{border-bottom:1px solid var(--line);padding:6px 8px;text-align:left;vertical-align:top}
</style></head>
<body><main>
<h1>${esc(verdictWord)}</h1>
<p class="muted">OrangePro ${esc(r.tool.version)} · runtime observations only · receipt <code>verification-receipt.json</code></p>
<div class="card"><strong>Merged change.</strong> ${esc(r.source.repository ?? "repository")} at <code>${esc(r.source.merged_commit.slice(0, 12))}</code>${r.source.pr_number ? `, PR #${r.source.pr_number}` : ""} (previous base <code>${esc((r.source.previous_base ?? "").slice(0, 12))}</code>).</div>
<div class="card"><strong>Behavior and why.</strong> <code>${esc(r.selection.symbol_id)}</code>, which the change touched. Expected (approved oracle): ${esc(run.oracle.behavior)} ${esc(run.oracle.expected)}.${r.selection.assisted ? " Assisted: the target and the fault were known before the run." : ""}</div>
<div class="card"><strong>What the old tests did.</strong> ${esc(old.statement)}</div>
<div class="card"><strong>The new test and its result on the fault.</strong> ${esc(statement)}<br>${esc(who)}</div>
<h2>The test-only patch (<code>orangepro-tests.patch</code>)</h2>
<pre>${esc(patch)}</pre>
<div class="card"><strong>Your action.</strong> Review the test patch. It is not delivered as a pull request, and nothing was merged.</div>
<h2>Proof rows</h2>
<table><tr><th>Row</th><th>What it shows</th><th>Result</th></tr>
${rowsHtml}
</table>
<h2>Not established</h2>
<ul>${r.limitations.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>
<h2>Every stage</h2>
<table><tr><th>Run</th><th>Stage</th><th>Code</th><th>Ran</th><th>Passed</th><th>Failed</th><th>New test</th></tr>
${stagesHtml}
</table>
<p class="muted">Files beside this page: <code>verification-receipt.json</code>, <code>orangepro-tests.patch</code>, <code>diagnostic-fault.patch</code> (diagnostic only, never merge), <code>stages/</code>, <code>logs/</code>, <code>MANIFEST.json</code>.</p>
</main></body></html>
`;
}

/** Plain lines for the terminal. */
export function renderExportTests(result: ExportTestsResult): string[] {
  const r = result.receipt;
  return [
    `Receipt: ${r.classification.fault}${r.classification.reason ? ` — ${r.classification.reason}` : ""} (adoption: ${r.classification.adoption})`,
    ...r.rows.map((row) => `  ${row.row} ${row.met ? "met" : "NOT MET"}: ${row.meaning}`),
    `Test-only patch: ${result.run_dir}/orangepro-tests.patch (${r.deliverables.test_patch.files.join(", ")}, +${r.deliverables.test_patch.added_lines} lines, 0 removed)`,
    `Summary page: ${result.run_dir}/summary.html`,
    `Run folder: ${result.run_dir} (MANIFEST.json lists every file with its sha256)`
  ];
}
