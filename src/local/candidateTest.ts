import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { dockerExecutor, WORK_OUT } from "./boundary.js";
import { applyAdditivePatch, parseAdditivePatch, readNewTest } from "./candidatePatch.js";
import {
  ASSERTION_RECORD_VERSION,
  CANDIDATE_VERDICT_VERSION,
  checkAssertionRecord,
  GENERATION_REQUEST_VERSION,
  MAX_CANDIDATE_ATTEMPTS,
  type AssertionRecord,
  type CandidateResult,
  type CandidateVerdict,
  type GenerationRequest
} from "./contracts/candidate.js";
import { planFault, type FaultRecord } from "./contracts/faultRecord.js";
import { newRunId, recordBytes, recordSha256, sha256Hex, verifyRunFolder, writeFileAtomic, writeRunManifest } from "./contracts/io.js";
import { checkOracle, type Oracle } from "./contracts/oracle.js";
import { FAULT_CLASSIFIER_VERSION, RUN_PROFILE_VERSION, type Classification, type ObservedTest, type RunProfile, type StageName, type StageObservation } from "./contracts/receipt.js";
import type { TargetRecord } from "./contracts/targetRecord.js";
import {
  containerProfile,
  createStageRunner,
  frameLocation,
  insideRepoPath,
  makeMountsFor,
  MOCHA_ENTRY,
  MOCHA_NO_REPO_CONFIG,
  NOT_AN_ASSERTION_ERRORS,
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

// Milestone A3: one new test for a fault the existing tests missed.
//   opro test-brief   reads a finished `probe-fault` run whose fault survived and writes what a
//                     coding agent needs to write the test (and nothing it should not rely on).
//   opro verify-test  takes the agent's test as a patch that only adds one it(…) call to one
//                     selected test file, and the assertion record naming the one line whose
//                     failure counts, frozen before any stage runs; then, on the same fault bytes,
//                     inside the same container: original PASS (twice), fault FAIL at that line
//                     (twice), whole suite on the fault fails only there, the fault with the
//                     original's text kept in a comment still FAILs there, restored PASS, the
//                     original with the fault's text kept in a comment PASS, whole suite PASS.

export const CANDIDATE_REFUSALS = [
  "fault_run_invalid",
  "no_gap",
  "brief_invalid",
  "assertion_invalid",
  "candidate_invalid",
  "fault_mismatch",
  "attempts_exhausted",
  "not_installed"
] as const;

// Which command is refusing: both share the fault-run checks.
let refusingCommand = "verify-test";
const refuse = (code: (typeof CANDIDATE_REFUSALS)[number] | string, detail: string): never => {
  throw new ProbeFaultRefusal(code, detail, refusingCommand);
};

/** Run `fn`; a refusal from a shared helper is re-raised under this command's name, with its own code. */
function asThisCommand<T>(fn: () => T): T {
  try {
    return fn();
  } catch (error) {
    if (error instanceof ProbeFaultRefusal && !error.message.startsWith(`${refusingCommand} refused`)) refuse(error.code, error.message.replace(/^[a-z-]+ refused \([^)]*\): /, ""));
    if (error instanceof ProofRefusalError) refuse(error.code, error.message.replace(/^prove refused \([^)]*\): /, ""));
    throw error;
  }
}

const SOURCE_HINT = " If the checkout is not this folder, pass --source <checkout>.";

interface StageCounts {
  executed: number;
  passed: number;
  failed: number;
  pending: number;
}

interface FaultRun {
  dir: string;
  manifestSha: string;
  runId: string;
  classification: Classification;
  record: TargetRecord;
  oracle: Oracle;
  faultRecord: FaultRecord;
  faultRecordSha: string;
  profile: RunProfile;
  diff: string;
  fixtureBytes: Buffer;
  counts: Record<string, StageCounts>;
  /** The ids the run saw on the original in its selected-test stage. */
  originalSelected: ObservedTest[];
}

const readJson = (path: string): any => JSON.parse(readFileSync(path, "utf8"));

/** A run folder named on the command line: a direct child of proof-runs, a real folder, not a link to somewhere else. */
function runFolderOf(root: string, given: string, code: "fault_run_invalid" | "brief_invalid"): string {
  const runsDir = join(workspacePaths(root).dir, "proof-runs");
  const dir = resolve(root, given);
  const rel = relative(runsDir, dir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel) || rel.includes(sep)) refuse(code, `${given} is not a run folder under ${toWorkspaceRel(root, runsDir)}.`);
  if (!existsSync(dir) || lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory() || dirname(realpathSync(dir)) !== realpathSync(runsDir)) {
    refuse(code, `${given} is not a folder of ${toWorkspaceRel(root, runsDir)} (missing, or a link to somewhere else).`);
  }
  return dir;
}

/** A finished probe-fault run, read only after its manifest verifies, and only when its fault survived. */
function loadFaultRun(root: string, fromRun: string): FaultRun {
  const dir = runFolderOf(root, fromRun, "fault_run_invalid");
  const check = verifyRunFolder(dir);
  if (!check.ok) return refuse("fault_run_invalid", `${fromRun}: ${check.message}`);
  const files = new Set(check.manifest.files.map((file) => file.path));
  for (const need of ["classification.json", "target-record.json", "oracle.json", "fault-record.json", "run-profile.json", "diagnostic-fault.patch", "fixture-manifest.json", "stages/original_selected.json"]) {
    if (!files.has(need)) refuse("fault_run_invalid", `${fromRun} is not a probe-fault run: it has no ${need}.`);
  }
  const classification = readJson(join(dir, "classification.json")) as Classification;
  if (classification.classification !== "survived_unverified") {
    refuse("no_gap", `the fault in ${fromRun} was not missed by the existing tests (${classification.classification}${classification.reason ? `, ${classification.reason}` : ""}): there is no gap for a new test to close.`);
  }
  if (classification.reason === "full_suite_failed_off_assertion") {
    refuse("no_gap", `in ${fromRun} another existing test failed on the fault when the whole suite ran (not at its own line), so a new test cannot be shown to be the one that catches it.`);
  }
  const oracleCheck = checkOracle(readJson(join(dir, "oracle.json")));
  if (!oracleCheck.ok) refuse("fault_run_invalid", oracleCheck.message);
  const counts: Record<string, StageCounts> = {};
  for (const stage of ["original_selected", "fault_selected", "original_full_suite", "fault_full_suite"]) {
    if (!files.has(`stages/${stage}.json`)) continue;
    const t = (readJson(join(dir, "stages", `${stage}.json`)) as StageObservation).tests;
    if (t) counts[stage] = { executed: t.executed, passed: t.passed, failed: t.failed, pending: t.pending };
  }
  return {
    dir,
    manifestSha: sha256Hex(readFileSync(join(dir, "MANIFEST.json"))),
    runId: check.manifest.run_id,
    classification,
    record: readJson(join(dir, "target-record.json")) as TargetRecord,
    oracle: (oracleCheck as { oracle: Oracle }).oracle,
    faultRecord: readJson(join(dir, "fault-record.json")) as FaultRecord,
    faultRecordSha: sha256Hex(readFileSync(join(dir, "fault-record.json"))),
    profile: readJson(join(dir, "run-profile.json")) as RunProfile,
    diff: readFileSync(join(dir, "diagnostic-fault.patch"), "utf8"),
    fixtureBytes: readFileSync(join(dir, "fixture-manifest.json")),
    counts,
    originalSelected: (readJson(join(dir, "stages", "original_selected.json")) as StageObservation).tests?.observed ?? []
  };
}

function allowedPaths(fixtureBytes: Buffer): { patterns: string[]; never: string[] } {
  const manifest = JSON.parse(fixtureBytes.toString("utf8")) as { allowed_patch_paths?: { patterns?: unknown; never?: unknown } };
  const patterns = manifest.allowed_patch_paths?.patterns;
  const never = manifest.allowed_patch_paths?.never ?? [];
  if (!Array.isArray(patterns) || patterns.length === 0 || !patterns.every((p) => typeof p === "string") || !Array.isArray(never) || !never.every((p) => typeof p === "string")) {
    return refuse("fault_run_invalid", "the fixture manifest has no allowed_patch_paths.patterns: where a test may be added is not decided.");
  }
  return { patterns: patterns as string[], never: never as string[] };
}

/** `test/*.js` and `test/**` style patterns: `*` stays inside one folder, `**` crosses folders. */
function globMatches(pattern: string, path: string): boolean {
  const re = pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${re}$`).test(path);
}

/** The selected test files as the checkout holds them, each checked to be a regular file of the checkout with the fault run's bytes. */
function selectedFiles(run: FaultRun, sourceRoot: string): Array<{ path: string; sha256: string; bytes: Buffer }> {
  return run.profile.selected_tests.map((test) => {
    const abs = join(sourceRoot, test.path);
    const regular = insideRepoPath(test.path) && existsSync(abs) && lstatSync(abs).isFile() && realInside(sourceRoot, abs);
    const bytes = regular ? readFileSync(abs) : null;
    if (!bytes || sha256Hex(bytes) !== test.sha256) {
      refuse(
        "fault_run_invalid",
        `${test.path} is not in the checkout as the fault run selected it (missing, a link, or changed since; restore it with git checkout -- ${test.path}).${SOURCE_HINT}`
      );
    }
    return { path: test.path, sha256: test.sha256, bytes: bytes! };
  });
}

const RULES = (run: FaultRun): string[] => [
  "Write exactly one new test: one it(…) call, added to one of the selected test files. Do not change, move or remove any existing line: the patch only adds lines.",
  `Put everything the test needs inside that one it(…) call, next to the tests it belongs with (${run.profile.selected_tests.map((test) => test.path).join(", ")}), in the same style as its neighbours.`,
  "Go through the public entry point the oracle names, as the neighbouring tests do. Use only modules the file already loads.",
  "Assert the oracle's expected result. Never assert what the faulty code returns, and never read the code's own text: the fault is shown so you know what must be caught, not as an expected value.",
  `Change only objects the test creates itself. Never replace, stub or assign to ${run.record.identity.name}, anything it is defined on, or anything it uses; never use .only, .skip or .retries.`,
  "Do not use process, require.cache, globalThis, eval or Function: a test of the behavior does not need them, and verify-test refuses them.",
  "Keep the test plain: a title like its neighbours', no tool name and no generated-by comment in the code. Attribution goes in the assertion record.",
  "Write assertion-record.json from the template: the one assertion call inside the new test whose failure must catch the fault, the line its called name is on, that line's text, what it checks, and the sha256 of your patch and of the file after it.",
  "The full title is the suite titles and the test's own, joined by single spaces, as Mocha reports it (see full_title_example).",
  "The record is frozen before any stage runs; a changed candidate needs a new record and counts as a new attempt, and a repair keeps the first attempt's declared assertion and condition.",
  "Leave the checkout unchanged: make the patch, then restore the file (for example git diff > candidate.patch, then git checkout -- <file>)."
];

/** The generation request for a fault run and a checkout. test-brief writes it; verify-test rebuilds it and requires the same bytes. */
function buildGenerationRequest(run: FaultRun, sourceRoot: string): GenerationRequest {
  const neighbours = selectedFiles(run, sourceRoot).map((file) => ({ path: file.path, sha256: file.sha256, text: file.bytes.toString("utf8") }));
  const fault = run.faultRecord;
  const first = run.profile.selected_tests[0]!.path;
  return {
    version: GENERATION_REQUEST_VERSION,
    fault_run: { run_id: run.runId, manifest_sha256: run.manifestSha },
    target_record_sha256: run.profile.target_record_sha256,
    oracle_sha256: run.profile.oracle_sha256,
    fault_record_sha256: run.profile.fault_record_sha256,
    symbol_id: run.record.identity.symbol_id,
    oracle: run.oracle,
    fault: { operator: fault.operator.id, file: fault.file, line: fault.site.lines.start, original_text: fault.original_text, replacement_text: fault.replacement_text, diff: run.diff },
    old_tests: {
      classification: run.classification.classification,
      scope: run.classification.scope,
      statement: run.classification.statement,
      selected: run.profile.selected_tests,
      witness: { input: run.oracle.witness.input, original: run.classification.behavioral_difference.original, fault: run.classification.behavioral_difference.fault },
      counts: run.counts
    },
    full_title_example: run.originalSelected[0]?.full_title ?? null,
    neighbours,
    allowed_paths: allowedPaths(run.fixtureBytes),
    rules: RULES(run),
    assertion_record_template: {
      version: ASSERTION_RECORD_VERSION,
      generation_request_sha256: "<sha256 of generation-request.json>",
      fault_record_sha256: run.profile.fault_record_sha256,
      candidate: { patch_sha256: "<sha256 of your patch>", files: [{ path: first, sha256_after: "<sha256 of the file after your patch>" }] },
      test: { file: first, full_title: "<the new test's full title: suite titles and its own, joined by single spaces>" },
      assertion: { file: first, line: 0, text: "<that line, as written>", condition: "<what it checks, from the oracle>" },
      failure_recognition: "first_frame_at_declared_line",
      generation: { by: "host_agent", agent: "<your name>", assisted: true, saw: ["this brief"], attempt: 1 }
    }
  };
}

function tagged<T extends object>(kind: "test_brief" | "verify_test", run: FaultRun, extra: T): T & { kind: string; fault_run: { run_id: string; manifest_sha256: string } } {
  return { kind, fault_run: { run_id: run.runId, manifest_sha256: run.manifestSha }, ...extra };
}

// ── opro test-brief ──────────────────────────────────────────────────────────────

export interface TestBriefResult {
  run_id: string;
  run_dir: string;
  brief: string;
  generation_request_sha256: string;
}

export function opTestBrief(root: string, opts: { from_run: string; source?: string }, deps: Pick<ProbeFaultDeps, "runId">): TestBriefResult {
  refusingCommand = "test-brief";
  const run = loadFaultRun(root, opts.from_run);
  const sourceRoot = resolve(opts.source ?? root);
  const request = buildGenerationRequest(run, sourceRoot);
  const runId = (deps.runId ?? newRunId)();
  const runDir = join(workspacePaths(root).dir, "proof-runs", runId);
  if (existsSync(runDir)) throw new Error(`${runDir} already exists.`);
  mkdirSync(runDir, { recursive: true });
  writeFileAtomic(join(runDir, "fault-run.json"), recordBytes(tagged("test_brief", run, {})));
  writeFileAtomic(join(runDir, "brief", "generation-request.json"), recordBytes(request));
  writeFileAtomic(join(runDir, "brief", "brief.md"), briefMarkdown(request, toWorkspaceRel(root, run.dir), toWorkspaceRel(root, runDir), opts.source ?? null));
  writeRunManifest(runDir, runId, ORANGEPRO_VERSION);
  return { run_id: runId, run_dir: toWorkspaceRel(root, runDir), brief: toWorkspaceRel(root, join(runDir, "brief")), generation_request_sha256: recordSha256(request) };
}

const countsLine = (name: string, c: StageCounts): string => `${name}: ${c.executed} ran, ${c.passed} passed, ${c.failed} failed, ${c.pending} skipped`;

function briefMarkdown(request: GenerationRequest, faultRunRel: string, briefRunRel: string, source: string | null): string {
  const o = request.oracle;
  const counts = request.old_tests.counts;
  const countWords: Record<string, string> = {
    original_selected: "Selected tests, original",
    fault_selected: "Selected tests, with the fault",
    original_full_suite: "Whole suite, original",
    fault_full_suite: "Whole suite, with the fault"
  };
  return [
    `# Write one test for a fault the existing tests missed`,
    "",
    `**Target:** \`${request.symbol_id}\`. **Fault run:** ${request.fault_run.run_id}.`,
    "",
    `**What happened:** ${request.old_tests.statement}`,
    "",
    ...Object.entries(counts).map(([name, c]) => `- ${countsLine(countWords[name] ?? name, c)}`),
    "",
    "## The expected behavior (approved oracle, the only source of the expected value)",
    "",
    `- **Behavior:** ${o.behavior}`,
    `- **Entry point:** ${o.entry_point}`,
    `- **Inputs:** ${o.inputs}`,
    `- **Expected:** ${o.expected}`,
    `- **Not covered:** ${o.excluded_inputs}`,
    `- **Witness (${o.witness.input}):** original ${JSON.stringify(request.old_tests.witness.original)}, with the fault ${JSON.stringify(request.old_tests.witness.fault)}`,
    "",
    "## The fault the test must catch (context only, never an expected value)",
    "",
    "```diff",
    request.fault.diff.trimEnd(),
    "```",
    "",
    "## Rules",
    "",
    ...request.rules.map((rule) => `- ${rule}`),
    "",
    "## Where the test goes",
    "",
    `One of the selected test files: ${request.old_tests.selected.map((test) => `\`${test.path}\``).join(", ")} (the fixture allows ${request.allowed_paths.patterns.join(", ")}; only these were selected). The files are in \`generation-request.json\` (\`neighbours\`), whole.`,
    "",
    request.full_title_example ? `A full title as the runner reports it: "${request.full_title_example}".` : "The full title is the suite titles and the test's own, joined by single spaces.",
    "",
    "## Hand back",
    "",
    "- `candidate.patch`: a unified diff, as `git diff` writes it, that only adds lines. Leave the checkout unchanged afterwards.",
    "- `assertion-record.json`: from `assertion_record_template` in `generation-request.json`.",
    "",
    `Then: \`opro verify-test --from-run ${faultRunRel} --brief ${briefRunRel} --candidate candidate.patch --assertion assertion-record.json${source ? ` --source ${source}` : ""}\``,
    ""
  ].join("\n");
}

// ── opro verify-test ─────────────────────────────────────────────────────────────

export interface VerifyTestOptions {
  from_run: string;
  /** The `test-brief` run folder. */
  brief: string;
  candidate_bytes: Buffer;
  assertion: unknown;
  source?: string;
}

export interface VerifyTestResult {
  run_id: string;
  run_dir: string;
  verdict: CandidateVerdict;
}

interface EarlierAttempt {
  run_id: string;
  attempt: number;
  result: string;
  reason: string | null;
  text: string;
  condition: string;
}

/**
 * The candidates already run on this fault: finished verify-test runs, in any fault run of the same
 * fault (same fault record and target record), in which the new test's file ran. A run blocked before
 * any test ran is not an attempt.
 */
function earlierAttempts(runsDir: string, faultRecordSha: string, targetRecordSha: string): EarlierAttempt[] {
  const found: EarlierAttempt[] = [];
  for (const name of readdirSync(runsDir).sort()) {
    const dir = join(runsDir, name);
    try {
      if (!lstatSync(dir).isDirectory() || !existsSync(join(dir, "MANIFEST.json"))) continue;
      const tag = readJson(join(dir, "fault-run.json")) as { kind?: string; fault_record_sha256?: string; target_record_sha256?: string };
      if (tag.kind !== "verify_test" || tag.fault_record_sha256 !== faultRecordSha || tag.target_record_sha256 !== targetRecordSha) continue;
      const verdict = readJson(join(dir, "classification.json")) as CandidateVerdict;
      if ((verdict.observed?.candidate_original?.executed ?? 0) === 0) continue;
      const record = readJson(join(dir, "assertion-record.json")) as AssertionRecord;
      found.push({ run_id: verdict.run_id, attempt: record.generation.attempt, result: verdict.result, reason: verdict.reason, text: record.assertion.text, condition: record.assertion.condition });
    } catch {
      continue;
    }
  }
  return found.sort((a, b) => a.attempt - b.attempt || a.run_id.localeCompare(b.run_id));
}

/** The line holding the site, as text, for a comment that keeps it in the file without running it. */
function lineAround(bytes: Buffer, at: number): string {
  const start = at > 0 ? bytes.lastIndexOf(0x0a, at - 1) + 1 : 0;
  const stop = bytes.indexOf(0x0a, at);
  return bytes.subarray(start, stop < 0 ? bytes.length : stop).toString("utf8").replace(/\r$/, "").trim();
}

/**
 * The two text controls: the original with the faulty line's text kept in a comment just after the
 * site, and the fault with the original line's text kept there. Behavior is unchanged, so a test of
 * the behavior gives the same result; a test that reads the code's text does not.
 */
function textControls(original: Buffer, fault: Buffer, site: { start: number; end: number }, replacement: string): { originalText: Buffer; faultText: Buffer } {
  const comment = (text: string): Buffer => Buffer.from(`/* ${text.replace(/\*\//g, "* /")} */`, "utf8");
  const faultEnd = site.start + Buffer.byteLength(replacement, "utf8");
  return {
    originalText: Buffer.concat([original.subarray(0, site.end), comment(lineAround(fault, site.start)), original.subarray(site.end)]),
    faultText: Buffer.concat([fault.subarray(0, faultEnd), comment(lineAround(original, site.start)), fault.subarray(faultEnd)])
  };
}

const LIMITS = [
  "The new test runs inside the container, but verify-test does not stop a test written to tamper with its own runner (for example by rewriting the runner's report); review the patch before it is delivered.",
  "The text controls catch common ways a test can follow the code's text instead of its behavior, not every way; a test written to get past them, or to replace a built-in through an alias, is not excluded.",
  "Whether the declared assertion checks the oracle's expected value is not checked by the tool; it rests on review of the test."
];

export function opVerifyTest(root: string, opts: VerifyTestOptions, deps: ProbeFaultDeps): VerifyTestResult {
  refusingCommand = "verify-test";
  // ── everything that can be checked before a copy exists ──
  const run = loadFaultRun(root, opts.from_run);
  const sourceRoot = resolve(opts.source ?? root);
  const briefDir = runFolderOf(root, opts.brief, "brief_invalid");
  const briefCheck = verifyRunFolder(briefDir);
  if (!briefCheck.ok) return refuse("brief_invalid", `${opts.brief}: ${briefCheck.message}`);
  const requestPath = join(briefDir, "brief", "generation-request.json");
  const briefTagPath = join(briefDir, "fault-run.json");
  if (!existsSync(requestPath) || !existsSync(briefTagPath)) refuse("brief_invalid", `${opts.brief} is not a test-brief run.`);
  const briefTag = readJson(briefTagPath) as { kind?: string; fault_run?: { manifest_sha256?: string } };
  if (briefTag.kind !== "test_brief" || briefTag.fault_run?.manifest_sha256 !== run.manifestSha) refuse("brief_invalid", "the brief was written for another fault run.");
  const requestBytes = readFileSync(requestPath);
  if (!requestBytes.equals(recordBytes(buildGenerationRequest(run, sourceRoot)))) {
    refuse("brief_invalid", "the brief is not the one test-brief writes for this fault run and this checkout (edited, or written by another version).");
  }
  const requestSha = sha256Hex(requestBytes);

  const recordCheck = checkAssertionRecord(opts.assertion);
  if (!recordCheck.ok) return refuse("assertion_invalid", recordCheck.message);
  const assertion: AssertionRecord = recordCheck.record;
  if (assertion.generation_request_sha256 !== requestSha) refuse("assertion_invalid", "the assertion record names another brief.");
  if (assertion.fault_record_sha256 !== run.profile.fault_record_sha256) refuse("assertion_invalid", "the assertion record names another fault.");
  if (assertion.candidate.patch_sha256 !== sha256Hex(opts.candidate_bytes)) refuse("assertion_invalid", "the assertion record's patch sha256 is not this candidate's.");

  // Attempts are counted per fault, over every fault run of it, from the runs in which a candidate actually ran.
  const runsDir = join(workspacePaths(root).dir, "proof-runs");
  const earlier = earlierAttempts(runsDir, run.faultRecordSha, run.profile.target_record_sha256);
  if (earlier.length >= MAX_CANDIDATE_ATTEMPTS) {
    refuse("attempts_exhausted", `${earlier.length} candidates already ran on this fault (counting every probe-fault run of it); the limit is ${MAX_CANDIDATE_ATTEMPTS}.`);
  }
  if (assertion.generation.attempt !== earlier.length + 1) refuse("assertion_invalid", `this is attempt ${earlier.length + 1} for this fault; the record says ${assertion.generation.attempt}.`);
  const norm = (text: string): string => text.trim().replace(/\s+/g, " ");
  if (earlier.length > 0 && (norm(earlier[0]!.text) !== norm(assertion.assertion.text) || norm(earlier[0]!.condition) !== norm(assertion.assertion.condition))) {
    refuse("assertion_invalid", `a repair keeps attempt 1's declared assertion and condition (${JSON.stringify(earlier[0]!.text.trim())}, ${JSON.stringify(earlier[0]!.condition)}); only the lines around it may change.`);
  }

  // The candidate: read once, applied by OrangePro itself, and read again on the syntax tree.
  const patch = parseAdditivePatch(opts.candidate_bytes);
  const allowed = allowedPaths(run.fixtureBytes);
  if (!allowed.patterns.some((p) => globMatches(p, patch.path)) || allowed.never.some((p) => globMatches(p, patch.path))) {
    refuse("candidate_invalid", `${patch.path} is not a test file the fixture allows a patch to touch.`);
  }
  const selected = selectedFiles(run, sourceRoot);
  const target = selected.find((file) => file.path === patch.path);
  if (!target) refuse("candidate_invalid", `${patch.path} is not one of the test files the fault run selected; the new test goes beside them.`);
  const applied = applyAdditivePatch(target!.bytes, patch);
  const afterSha = sha256Hex(applied.bytes);
  const newTest = readNewTest({ path: applied.path, patched: applied.bytes, original: target!.bytes, added: applied.added });
  const declaredFiles = assertion.candidate.files;
  if (declaredFiles.length !== 1 || declaredFiles[0]!.path !== applied.path || declaredFiles[0]!.sha256_after !== afterSha) {
    refuse("assertion_invalid", `the assertion record's files are not the one file as this patch leaves it (${applied.path}, sha256 ${afterSha}).`);
  }
  if (assertion.test.file !== applied.path) refuse("assertion_invalid", `the new test's file ${assertion.test.file} is not the file the patch changes.`);
  const declaredLine = assertion.assertion.line;
  if (declaredLine < newTest.start || declaredLine > newTest.end || !newTest.assertionLines.has(declaredLine)) {
    refuse("assertion_invalid", `line ${declaredLine} is not where an assertion call inside the new it(…) call (lines ${newTest.start}–${newTest.end}) names its check.`);
  }
  const patchedLines = applied.bytes.toString("utf8").split("\n");
  if (norm(patchedLines[declaredLine - 1]!.replace(/\r$/, "")) !== norm(assertion.assertion.text)) refuse("assertion_invalid", `line ${declaredLine} does not read as the record says.`);
  if (newTest.fullTitle !== null && newTest.fullTitle !== assertion.test.full_title) {
    refuse("assertion_invalid", `the new test's full title is "${newTest.fullTitle}" (suite titles and its own, joined by single spaces); the record says "${assertion.test.full_title}".`);
  }

  // ── the target and the same fault, on the checkout as the fault run saw it ──
  const targetFile = join(sourceRoot, run.record.identity.file);
  if (!existsSync(targetFile) || sha256Hex(readFileSync(targetFile)) !== run.faultRecord.file_sha256) {
    refuse("fault_mismatch", `the checkout's ${run.record.identity.file} is not as the fault run ${run.runId} had it; restore it, or run probe-fault again.${SOURCE_HINT}`);
  }
  const paths = workspacePaths(root);
  const { symbolTarget, tsjs } = asThisCommand(() => {
    const graph = loadGraph(paths.graphPath);
    const symbol = resolveTargetSymbol(graph, run.record.identity.symbol_id);
    if (!symbol) refuse("fault_mismatch", `the graph has no symbol ${run.record.identity.symbol_id}; run opro analyze.`);
    return proofPreflight(root, { target_record: run.record, source: opts.source }, graph, symbol!, "typescript");
  });
  const bound = tsjs?.bound;
  if (!tsjs || !bound) return refuse("fault_mismatch", `${run.record.identity.symbol_id} is not changed by its exact position any more.`);
  const fileBytes = readFileSync(tsjs.targetAbs);
  const replanned = planFault(fileBytes, bound.target, run.record.identity.file, run.faultRecord.operator.id, run.faultRecord.site.bytes.start);
  if (!replanned.ok || replanned.plan.mutated_file_sha256 !== run.faultRecord.mutated_file_sha256 || sha256Hex(Buffer.from(replanned.plan.diff, "utf8")) !== run.faultRecord.diff.sha256) {
    return refuse("fault_mismatch", "the fault planned now is not the fault the run recorded (bytes or diff differ).");
  }
  const plan = replanned.plan;
  const originalSha = run.faultRecord.file_sha256;
  const controls = textControls(fileBytes, plan.mutated, plan.site.bytes, plan.replacement_text);
  const fixture = asThisCommand(() => readFixture(run.fixtureBytes));
  if (fixture.baselinePassing === null) refuse("fault_run_invalid", "the fixture records no baseline count, so the whole suite with the new test cannot be checked.");
  const nodeModules = join(sourceRoot, "node_modules");
  const mochaPackage = join(nodeModules, "mocha", "package.json");
  if (!existsSync(join(sourceRoot, MOCHA_ENTRY)) || !existsSync(mochaPackage) || !lstatSync(nodeModules).isDirectory() || !realInside(sourceRoot, nodeModules)) {
    refuse("not_installed", `${sourceRoot} has no installed Mocha of its own: install the fixture first (inside the boundary).`);
  }
  const mochaVersion = String((readJson(mochaPackage) as { version?: unknown }).version ?? "unknown");
  const statusBefore = trackedStatus(sourceRoot);

  // ── the run folder: the brief, the candidate and its assertion record are frozen here, before any copy runs ──
  const runId = (deps.runId ?? newRunId)();
  const runDir = join(paths.dir, "proof-runs", runId);
  if (existsSync(runDir)) throw new Error(`${runDir} already exists.`);
  mkdirSync(runDir, { recursive: true });
  const tmp = mkdtempSync(join(tmpdir(), "opro-verify-test-"));
  const stages: Partial<Record<StageName, StageObservation>> = {};
  const stageRefs: Classification["stages"] = [];
  let copyWriteFailed: "fault_text" | "restore" | "original_text" | null = null;
  try {
    writeFileAtomic(
      join(runDir, "fault-run.json"),
      recordBytes(
        tagged("verify_test", run, {
          fault_record_sha256: run.faultRecordSha,
          target_record_sha256: run.profile.target_record_sha256,
          brief_run: { run_id: briefCheck.ok ? briefCheck.manifest.run_id : null, manifest_sha256: sha256Hex(readFileSync(join(briefDir, "MANIFEST.json"))) },
          generation_request_sha256: requestSha
        })
      )
    );
    writeFileAtomic(join(runDir, "generation-request.json"), requestBytes);
    writeFileAtomic(join(runDir, "candidate.patch"), opts.candidate_bytes);
    writeFileAtomic(join(runDir, "assertion-record.json"), recordBytes(assertion));
    const assertionSha = recordSha256(assertion);
    const mochaHead = ["node", MOCHA_ENTRY, ...MOCHA_NO_REPO_CONFIG, ...fixture.mocha.options, "--reporter", REPORTER_TARGET];
    const fileArgv = [...mochaHead, applied.path];
    const fullArgv = [...mochaHead, ...fixture.mocha.operands];
    const deadlineMs = Math.min(deps.stageDeadlineMs ?? 300_000, fixture.shape.deadlineSeconds * 1000);
    const reportEnv = { OPRO_DYNAMIC_PROOF_REPORT: `${WORK_OUT}/report.json` };

    const copyRoots = asThisCommand(() =>
      prepareFaultCopies({
        runner: deps.dynamicProofRunner ?? defaultDynamicProofRunner,
        sourceRoot,
        targetRel: symbolTarget.file,
        method: symbolTarget.method,
        targetAbs: tsjs.targetAbs,
        bound,
        plan,
        tmp,
        mustHold: run.profile.selected_tests
      })
    );
    // The patched test file goes into both copies as OrangePro built it; each copy then differs from before in that file only.
    for (const copy of Object.values(copyRoots)) {
      const before = treeHashes(copy, new Set());
      writeFileSync(join(copy, applied.path), applied.bytes);
      const after = treeHashes(copy, new Set());
      const changed = [...new Set([...before.keys(), ...after.keys()])].filter((path) => before.get(path) !== after.get(path));
      if (changed.length !== 1 || changed[0] !== applied.path || after.get(applied.path) !== afterSha) refuse("candidate_invalid", `a copy is not as the patch leaves it (${changed.join(", ") || "nothing changed"}).`);
    }
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
      selected_tests: [{ path: applied.path, sha256: afterSha }],
      selected_argv: fileArgv,
      full_suite_argv: fullArgv,
      runner: { name: "mocha", version: mochaVersion },
      container: containerProfile(fixture, mountsFor, reportEnv),
      limits: { stage_deadline_ms: deadlineMs },
      candidate: { patch_sha256: assertion.candidate.patch_sha256, assertion_record_sha256: assertionSha, generation_request_sha256: requestSha }
    };
    writeFileAtomic(join(runDir, "run-profile.json"), recordBytes(profile));
    const { runStage, held } = createStageRunner({
      runDir,
      runId,
      profileSha: recordSha256(profile),
      faultRecordSha: run.profile.fault_record_sha256,
      fixture,
      deadlineMs,
      tmp,
      copyRoots,
      mountsFor,
      targetRel: symbolTarget.file,
      faultSpan: plan.site.bytes,
      executor: deps.container ?? dockerExecutor(),
      clock: deps.clock,
      stages,
      stageRefs
    });
    const go = (stage: StageName, copy: "original" | "mutant", argv: string[], faultPresent?: boolean): boolean => held(runStage(stage, copy, argv, reportEnv, undefined, faultPresent));
    // The faulty copy's target file is rewritten between stages: the original-text control, the restore, the fault-text control.
    const targetInCopy = join(copyRoots.mutant, symbolTarget.file);
    const put = (bytes: Buffer): boolean => {
      writeFileSync(targetInCopy, bytes);
      return sha256Hex(readFileSync(targetInCopy)) === sha256Hex(bytes);
    };
    const sequence = (): void => {
      if (!go("candidate_original", "original", fileArgv) || !cleanPass(stages.candidate_original, assertion)) return;
      if (!go("candidate_original_repeat", "original", fileArgv)) return;
      if (!go("candidate_fault", "mutant", fileArgv) || !go("candidate_fault_repeat", "mutant", fileArgv)) return;
      if (!go("fault_full_suite_with_candidate", "mutant", fullArgv)) return;
      if (!put(controls.faultText)) return void (copyWriteFailed = "fault_text");
      if (!go("candidate_fault_text_control", "mutant", fileArgv, true)) return;
      if (!put(fileBytes) || sha256Hex(readFileSync(targetInCopy)) !== originalSha) return void (copyWriteFailed = "restore");
      if (!go("candidate_restored", "mutant", fileArgv, false)) return;
      if (!put(controls.originalText)) return void (copyWriteFailed = "original_text");
      if (!go("candidate_original_text_control", "mutant", fileArgv, false)) return;
      go("full_suite_with_candidate", "original", fullArgv);
    };
    sequence();
  } catch (error) {
    // A refusal raised after the run folder exists leaves no half-written run behind.
    if (error instanceof ProbeFaultRefusal || error instanceof ProofRefusalError) rmSync(runDir, { recursive: true, force: true });
    throw error;
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  const checkoutUnchanged = sha256Hex(readFileSync(tsjs.targetAbs)) === originalSha && trackedStatus(sourceRoot) === statusBefore;
  const expectedTargetSha: Partial<Record<StageName, string>> = {
    candidate_original: originalSha,
    candidate_original_repeat: originalSha,
    candidate_fault: plan.mutated_file_sha256,
    candidate_fault_repeat: plan.mutated_file_sha256,
    fault_full_suite_with_candidate: plan.mutated_file_sha256,
    candidate_fault_text_control: sha256Hex(controls.faultText),
    candidate_restored: originalSha,
    candidate_original_text_control: sha256Hex(controls.originalText),
    full_suite_with_candidate: originalSha
  };
  const outcome = classifyCandidate({
    stages,
    assertion,
    baseline: fixture.baselinePassing!,
    priorIds: run.originalSelected.filter((test) => test.file === applied.path).map((test) => `${test.file}\u0000${test.full_title}`),
    expectedTargetSha,
    copyWriteFailed,
    checkoutUnchanged
  });
  const changedBy = fixture.prNumber !== null ? `PR #${fixture.prNumber}` : `the change ${run.record.selection.base_commit.slice(0, 12)}..${run.record.identity.merged_commit.slice(0, 12)}`;
  const assisted = assertion.generation.assisted || run.oracle.assisted.flag;
  const verdict: CandidateVerdict = {
    version: CANDIDATE_VERDICT_VERSION,
    classifier_version: FAULT_CLASSIFIER_VERSION,
    run_id: runId,
    fault_run: { run_id: run.runId, manifest_sha256: run.manifestSha },
    generation_request_sha256: requestSha,
    assertion_record_sha256: recordSha256(assertion),
    fault_record_sha256: run.profile.fault_record_sha256,
    result: outcome.result,
    reason: outcome.reason,
    statement: candidateStatement(outcome, {
      symbol: run.record.identity.name,
      changedBy,
      fault: `${run.faultRecord.original_text}${run.faultRecord.replacement_text ? ` → ${run.faultRecord.replacement_text}` : " removed"}, line ${run.faultRecord.site.lines.start}`,
      missedBy: run.classification.scope === "full_suite" ? "the whole suite" : "the selected tests",
      title: assertion.test.full_title,
      at: `${assertion.assertion.file}:${assertion.assertion.line}`,
      agent: assertion.generation.agent,
      by: assertion.generation.by,
      assisted,
      oracleAssisted: run.oracle.assisted.flag
    }),
    assisted,
    attribution: { by: assertion.generation.by, agent: assertion.generation.agent, attempt: assertion.generation.attempt },
    new_test: { file: assertion.test.file, full_title: assertion.test.full_title, assertion: { file: assertion.assertion.file, line: assertion.assertion.line } },
    observed: outcome.observed,
    other_failures_on_fault: outcome.otherFailures,
    earlier_attempts: earlier.map((attempt) => ({ run_id: attempt.run_id, attempt: attempt.attempt, result: attempt.result, reason: attempt.reason })),
    limits: LIMITS,
    stages: stageRefs
  };
  writeFileAtomic(join(runDir, "classification.json"), recordBytes(verdict));
  writeRunManifest(runDir, runId, ORANGEPRO_VERSION);
  return { run_id: runId, run_dir: toWorkspaceRel(root, runDir), verdict };
}

function cleanPass(stage: StageObservation | undefined, assertion: AssertionRecord): boolean {
  const t = stage?.tests;
  return Boolean(t && !stage!.timed_out && stage!.exit_code === 0 && t.failed === 0 && t.hook_failures === 0 && t.pending === 0 && t.observed.some((test) => test.full_title === assertion.test.full_title && test.state === "passed"));
}

interface CandidateOutcome {
  result: CandidateResult;
  reason: string | null;
  observed: CandidateVerdict["observed"];
  otherFailures: CandidateVerdict["other_failures_on_fault"];
}

function issueOf(stage: StageObservation | undefined): string | null {
  if (!stage) return "not_run";
  if (stage.boundary.failures.length > 0) return "boundary_check_failed";
  if (!stage.stopped) return "container_not_stopped";
  if (stage.timed_out) return "timeout";
  const t = stage.tests;
  if (!t || stage.report === null) return "runner_error";
  if (t.hook_failures > 0) return "hook_failure";
  const totals = t.runner_totals;
  if (!totals || totals.passes !== t.passed || totals.failures !== t.failed + t.hook_failures || totals.pending !== t.pending) return "runner_totals_mismatch";
  return null;
}

function atDeclared(test: ObservedTest | undefined, assertion: AssertionRecord): boolean {
  if (!test?.failure || !test.failure.at_assertion || NOT_AN_ASSERTION_ERRORS.has(test.failure.name ?? "")) return false;
  const at = frameLocation(test.failure.first_frame);
  return at !== null && at.file === assertion.assertion.file && at.line === assertion.assertion.line;
}

/** Each test's outcome in a stage, with the line a failure was raised at: what a repeat must reproduce. */
function outcomes(stage: StageObservation | undefined): string {
  return (stage?.tests?.observed ?? [])
    .map((test) => `${test.file}\u0000${test.full_title}\u0000${test.state}\u0000${test.state === "failed" ? JSON.stringify(frameLocation(test.failure?.first_frame ?? null)) : ""}`)
    .sort()
    .join("\n");
}

/** Computed from the stage files, in the order of the pre-registration's section F (with amendment O). */
export function classifyCandidate(input: {
  stages: Partial<Record<StageName, StageObservation>>;
  assertion: AssertionRecord;
  baseline: number;
  priorIds: string[];
  /** The target file's sha256 each stage must have run on. */
  expectedTargetSha: Partial<Record<StageName, string>>;
  /** A rewrite of the faulty copy's target file that could not be confirmed, if any. */
  copyWriteFailed: "fault_text" | "restore" | "original_text" | null;
  checkoutUnchanged: boolean;
}): CandidateOutcome {
  const { stages, assertion } = input;
  const title = assertion.test.full_title;
  const isMine = (test: ObservedTest): boolean => test.full_title === title && test.file === assertion.test.file;
  const observed: CandidateVerdict["observed"] = {};
  for (const [name, stage] of Object.entries(stages)) {
    const t = stage?.tests;
    const mine = t?.observed.filter(isMine) ?? [];
    observed[name] = {
      executed: t?.executed ?? 0,
      passed: t?.passed ?? 0,
      failed: t?.failed ?? 0,
      new_test: mine.length === 0 ? "missing" : mine[0]!.state,
      new_test_failed_at: mine[0]?.failure ? frameLocation(mine[0].failure.first_frame) : null
    };
  }
  let otherFailures: CandidateOutcome["otherFailures"] = [];
  const out = (result: CandidateResult, reason: string | null): CandidateOutcome => ({ result, reason, observed, otherFailures });
  if (!input.checkoutUnchanged) return out("blocked", "checkout_modified");
  for (const stage of Object.values(stages)) {
    const issue = issueOf(stage);
    if (issue === "boundary_check_failed" || issue === "container_not_stopped") return out("blocked", issue);
  }
  for (const [name, stage] of Object.entries(stages)) {
    if (stage && stage.copy_target_sha256 !== input.expectedTargetSha[name as StageName]) return out("inconclusive", "stage_copy_mismatch");
  }
  const ids = (stage: StageObservation | undefined): string => (stage?.tests?.observed ?? []).map((test) => `${test.file}\u0000${test.full_title}`).sort().join("\n");
  const expectedIds = [...input.priorIds, `${assertion.test.file}\u0000${title}`].sort().join("\n");
  const cleanFile = (stage: StageObservation): boolean => {
    const t = stage.tests!;
    return t.failed === 0 && t.pending === 0 && stage.exit_code === 0 && ids(stage) === expectedIds && t.observed.some((test) => isMine(test) && test.state === "passed");
  };
  const caughtAtLine = (stage: StageObservation): boolean => {
    const t = stage.tests!;
    const mine = t.observed.find(isMine);
    return ids(stage) === expectedIds && t.pending === 0 && !t.observed.some((test) => test.state === "failed" && test !== mine) && atDeclared(mine, assertion);
  };

  // D: the original copy with the new test, then again.
  const d = stages.candidate_original;
  const dIssue = issueOf(d);
  if (dIssue) return out("inconclusive", `original_${dIssue}`);
  const dt = d!.tests!;
  const mineD = dt.observed.filter(isMine);
  if (mineD.length !== 1) return out("candidate_failed", mineD.length === 0 ? "new_test_not_found" : "new_test_title_not_unique");
  if (dt.failed > 0 || d!.exit_code !== 0) return out("candidate_failed", mineD[0]!.state === "failed" ? "fails_on_original" : "breaks_another_test");
  if (dt.pending > 0) return out("inconclusive", "a_test_was_skipped");
  if (ids(d) !== expectedIds) return out("inconclusive", "test_set_differs");
  const dr = stages.candidate_original_repeat;
  const drIssue = issueOf(dr);
  if (drIssue) return out("inconclusive", `original_repeat_${drIssue}`);
  if (outcomes(dr) !== outcomes(d)) return out("inconclusive", "candidate_not_deterministic");

  // E: the same fault, then again.
  const e = stages.candidate_fault;
  const eIssue = issueOf(e);
  if (eIssue) return out("inconclusive", `fault_${eIssue}`);
  const et = e!.tests!;
  if (ids(e) !== expectedIds) return out("inconclusive", "test_set_differs_on_fault");
  const mineE = et.observed.find(isMine);
  if (et.pending > 0 || mineE?.state === "pending") return out("inconclusive", "a_test_was_skipped_on_fault");
  if (mineE?.state === "passed") return out("not_caught", null);
  if (et.observed.some((test) => test.state === "failed" && test !== mineE)) return out("caught_off_assertion", "other_tests_failed");
  if (!atDeclared(mineE, assertion)) return out("caught_off_assertion", "not_at_the_declared_line");
  const er = stages.candidate_fault_repeat;
  const erIssue = issueOf(er);
  if (erIssue) return out("inconclusive", `fault_repeat_${erIssue}`);
  if (outcomes(er) !== outcomes(e)) return out("inconclusive", "candidate_not_deterministic");

  // E2: the whole suite with the new test on the fault: one failure, the new test, at its line.
  const e2 = stages.fault_full_suite_with_candidate;
  const e2Issue = issueOf(e2);
  if (e2Issue) return out("inconclusive", `fault_full_suite_${e2Issue}`);
  const e2t = e2!.tests!;
  const failedE2 = e2t.observed.filter((test) => test.state === "failed");
  const mineE2 = failedE2.find(isMine);
  otherFailures = failedE2.filter((test) => test !== mineE2).map((test) => ({ file: test.file, full_title: test.full_title }));
  if (e2t.executed === input.baseline + 1 && mineE2 && atDeclared(mineE2, assertion) && otherFailures.length > 0) return out("inconclusive", "existing_tests_also_catch");
  if (e2t.executed !== input.baseline + 1 || failedE2.length !== 1 || !mineE2 || !atDeclared(mineE2, assertion)) return out("inconclusive", "fault_full_suite_differs");

  // The fault with the original line's text kept in a comment: a test of the behavior still fails at its line.
  if (input.copyWriteFailed === "fault_text") return out("inconclusive", "text_control_not_written");
  const ft = stages.candidate_fault_text_control;
  const ftIssue = issueOf(ft);
  if (ftIssue) return out("inconclusive", `fault_text_control_${ftIssue}`);
  if (!caughtAtLine(ft!)) return out("inconclusive", "mutation_aware");

  // F: the faulty copy restored.
  if (input.copyWriteFailed === "restore") return out("inconclusive", "restore_not_verified");
  const f = stages.candidate_restored;
  const fIssue = issueOf(f);
  if (fIssue) return out("inconclusive", `restored_${fIssue}`);
  if (!cleanFile(f!)) return out("inconclusive", "restored_failed");

  // The original with the faulty line's text kept in a comment: a test of the behavior still passes.
  if (input.copyWriteFailed === "original_text") return out("inconclusive", "text_control_not_written");
  const ot = stages.candidate_original_text_control;
  const otIssue = issueOf(ot);
  if (otIssue) return out("inconclusive", `original_text_control_${otIssue}`);
  if (!cleanFile(ot!)) return out("inconclusive", "mutation_aware");

  // G: the whole suite with the new test on the original.
  const g = stages.full_suite_with_candidate;
  const gIssue = issueOf(g);
  if (gIssue) return out("inconclusive", `full_suite_${gIssue}`);
  const gt = g!.tests!;
  if (gt.failed > 0 || g!.exit_code !== 0 || gt.executed !== input.baseline + 1 || gt.passed !== input.baseline + 1) return out("inconclusive", "full_suite_with_candidate_differs");
  return out("verified_gap", null);
}

const CANDIDATE_REASON_WORDS: Record<string, string> = {
  checkout_modified: "the checkout changed during the run",
  boundary_check_failed: "the container boundary check failed",
  container_not_stopped: "a container could not be confirmed stopped",
  stage_copy_mismatch: "a stage did not run on the bytes it should have",
  new_test_not_found: "the new test did not run under the title the record gives",
  new_test_title_not_unique: "two tests have the new test's title",
  fails_on_original: "the new test fails on the original code",
  breaks_another_test: "another test fails once the new test is added",
  a_test_was_skipped: "a test was skipped",
  a_test_was_skipped_on_fault: "a test was skipped on the fault",
  test_set_differs: "a different set of tests ran than the file holds plus the new test",
  test_set_differs_on_fault: "a different set of tests ran on the fault",
  candidate_not_deterministic: "the new test's file gave different results when run again",
  other_tests_failed: "other tests failed on the fault too",
  not_at_the_declared_line: "the new test failed on the fault, but not at its declared line",
  existing_tests_also_catch: "existing tests outside the selected files also fail on the fault, so they catch it already",
  fault_full_suite_differs: "the whole suite with the new test did not fail on the fault at the new test alone",
  text_control_not_written: "a text control could not be written into the copy",
  mutation_aware: "the new test's result changed when only a comment holding the other version's text was added, so it reads the code's text rather than testing its behavior",
  restore_not_verified: "restoring the original bytes could not be confirmed",
  restored_failed: "the new test's file did not pass after restoring the original",
  full_suite_with_candidate_differs: "the whole suite with the new test did not pass, or did not count one more test"
};

const STAGE_WORDS: Record<string, string> = {
  original: "on the original",
  original_repeat: "on the original, the second time",
  fault: "on the fault",
  fault_repeat: "on the fault, the second time",
  fault_full_suite: "for the whole suite on the fault",
  fault_text_control: "on the fault with the original's text in a comment",
  restored: "after restoring the original",
  original_text_control: "on the original with the fault's text in a comment",
  full_suite: "for the whole suite on the original"
};
const ISSUE_WORDS: Record<string, string> = {
  not_run: "the stage did not run",
  timeout: "the stage timed out",
  runner_error: "the test runner gave no clean account",
  hook_failure: "a setup hook failed",
  runner_totals_mismatch: "the runner's totals disagree with its report"
};

/** Plain words for a reason code, including a stage's issue (`fault_repeat_timeout`). */
export function candidateReasonWords(reason: string | null): string {
  if (!reason) return "";
  if (CANDIDATE_REASON_WORDS[reason]) return CANDIDATE_REASON_WORDS[reason]!;
  for (const [stage, where] of Object.entries(STAGE_WORDS).sort((a, b) => b[0].length - a[0].length)) {
    const issue = reason.startsWith(`${stage}_`) ? reason.slice(stage.length + 1) : null;
    if (issue && ISSUE_WORDS[issue]) return `${ISSUE_WORDS[issue]} ${where}`;
  }
  return reason;
}

function candidateStatement(
  outcome: CandidateOutcome,
  ctx: { symbol: string; changedBy: string; fault: string; missedBy: string; title: string; at: string; agent: string; by: string; assisted: boolean; oracleAssisted: boolean }
): string {
  const where = `in ${ctx.symbol}, which ${ctx.changedBy} changed (${ctx.fault})`;
  const words = candidateReasonWords(outcome.reason);
  let sentence: string;
  if (outcome.result === "verified_gap") {
    sentence = `A new test catches a fault ${ctx.missedBy} missed, ${where}: "${ctx.title}" passes on the original and after the fault is removed, and fails at its own assertion (${ctx.at}) on the fault; with it, the whole suite fails on the fault at that test alone. Each result held when run again, and under two text controls.`;
  } else if (outcome.result === "not_caught") {
    sentence = `The new test "${ctx.title}" passes with the fault ${where}: it does not catch it.`;
  } else if (outcome.result === "candidate_failed") {
    sentence = `The new test cannot be used: ${words}.`;
  } else if (outcome.result === "caught_off_assertion") {
    sentence = `No claim: ${words}.`;
  } else {
    const others = outcome.otherFailures.length > 0 && outcome.reason === "existing_tests_also_catch" ? ` (${outcome.otherFailures.map((test) => `"${test.full_title}"`).join(", ")})` : "";
    sentence = `No claim about the new test ${where}: ${words}${others}.`;
  }
  if (!ctx.assisted) return sentence;
  const who = ctx.by === "host_agent" ? `the coding agent ${ctx.agent}, which` : ctx.by === "provider" ? `the model ${ctx.agent}, which` : `${ctx.agent}, who`;
  return `${sentence} Assisted: the test was written by ${who} saw the fault in the brief${ctx.oracleAssisted ? "; the target and the fault were known before the run" : ""}.`;
}

/** Plain lines for the terminal. */
export function renderVerifyTest(result: VerifyTestResult): string[] {
  const v = result.verdict;
  const lines = [`Result: ${v.result}${v.reason ? ` — ${v.reason}` : ""}`, v.statement];
  for (const [stage, o] of Object.entries(v.observed)) {
    lines.push(`  ${stage}: ${o.executed} ran, ${o.passed} passed, ${o.failed} failed; new test ${o.new_test}${o.new_test_failed_at ? ` at ${o.new_test_failed_at.file}:${o.new_test_failed_at.line}` : ""}`);
  }
  if (v.earlier_attempts.length > 0) lines.push(`Earlier attempts: ${v.earlier_attempts.map((a) => `${a.attempt} ${a.result}${a.reason ? ` (${a.reason})` : ""}`).join("; ")}`);
  for (const limit of v.limits) lines.push(`Not established: ${limit}`);
  lines.push(`Run folder: ${result.run_dir} (MANIFEST.json lists every file with its sha256)`);
  return lines;
}

export function renderTestBrief(result: TestBriefResult): string[] {
  return [`Brief written: ${result.brief} (brief.md and generation-request.json, sha256 ${result.generation_request_sha256.slice(0, 12)}…)`, `Run folder: ${result.run_dir}`];
}
