import { execFileSync } from "node:child_process";
import { closeSync, constants as fsConstants, existsSync, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, readSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, posix, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  BOUNDARY_PROBE_SOURCE,
  boundaryFailures,
  boundaryProbeRequest,
  dockerExecutor,
  OPRO_DIR,
  shapeEnvNames,
  WORK_OUT,
  WORK_REPO,
  type ContainerExecutor,
  type ContainerMount,
  type ContainerRequest,
  type ContainerShape
} from "./boundary.js";
import { canonicalJson, newRunId, recordBytes, recordSha256, sha256Hex, writeFileAtomic, writeRunManifest } from "./contracts/io.js";
import { checkOracle, type Oracle } from "./contracts/oracle.js";
import { FAULT_OPERATORS, faultRecordOf, parseFaultSpec, planFault, type FaultPlan, type FaultRecord } from "./contracts/faultRecord.js";
import {
  CLASSIFICATION_VERSION,
  FAULT_CLASSIFIER_VERSION,
  RUN_PROFILE_VERSION,
  STAGE_OBSERVATION_VERSION,
  type Classification,
  type FaultClass,
  type FileRef,
  type ObservedTest,
  type RunProfile,
  type StageName,
  type StageObservation
} from "./contracts/receipt.js";
import { TARGET_RECORD_VERSION, type TargetRecord } from "./contracts/targetRecord.js";
import { resolveTargetSymbol, targetLanguage } from "./ledger.js";
import { defaultDynamicProofRunner, dynamicProofSpikePath, ProofRefusalError, proofPreflight, runBoundSpike, type DynamicProofRunner } from "./operations.js";
import { resolveContained, toWorkspaceRel } from "./reprove/paths.js";
import { redactSecrets } from "./util/redact.js";
import type { Clock } from "./util/time.js";
import { ORANGEPRO_VERSION } from "./version.js";
import { loadGraph, workspacePaths } from "./workspace.js";

// `opro probe-fault` (milestone A2): one exact, recorded fault inside a function a change
// touched, checked to matter, and run against named existing tests, the original copy
// and the faulty copy side by side, every command inside the execution boundary. The
// result is computed from what the runs observed, written as files with hashes, and
// says only what was observed: caught by the selected tests, missed by them (or by the
// whole suite, when it ran), or why no claim can be made.

export const PROBE_FAULT_REFUSALS = [
  "invalid_fault_spec",
  "unsupported_route",
  "oracle_invalid",
  "oracle_mismatch",
  "witness_mismatch",
  "fixture_invalid",
  "fixture_mismatch",
  "profile_option_not_allowed",
  "tests_invalid",
  "not_installed",
  "prepare_failed"
] as const;
export type ProbeFaultRefusalCode = (typeof PROBE_FAULT_REFUSALS)[number];

/** Refused before any run: no result exists. */
export class ProbeFaultRefusal extends Error {
  readonly code: string;
  constructor(code: ProbeFaultRefusalCode | string, detail: string, command = "probe-fault") {
    super(`${command} refused (${code}): ${detail}`);
    this.name = "ProbeFaultRefusal";
    this.code = code;
  }
}

export interface ProbeFaultOptions {
  /** A record from `opro changed-targets --json`. */
  target_record: unknown;
  /** `<operator>@<byte offset>` in the target file. */
  fault: string;
  oracle: unknown;
  /** The fixture manifest's bytes, exactly as on disk (its hash is recorded). */
  fixture_bytes: Buffer;
  /** Selected existing test files, relative to the source root. */
  tests: string[];
  /** The witness script's bytes; its sha256 must be the oracle's. */
  witness_bytes: Buffer;
  full_suite?: boolean;
  source?: string;
  rationale?: string;
}

export interface ProbeFaultDeps {
  clock: Clock;
  container?: ContainerExecutor;
  dynamicProofRunner?: DynamicProofRunner;
  runId?: () => string;
  stageDeadlineMs?: number;
}

export interface ProbeFaultResult {
  run_id: string;
  /** Workspace-relative run folder. */
  run_dir: string;
  fault_record: FaultRecord;
  classification: Classification;
}

export const DEFAULT_STAGE_DEADLINE_MS = 300_000;
export const REPORTER_TARGET = `${OPRO_DIR}/mocha-reporter.cjs`;
const WITNESS_TARGET = `${OPRO_DIR}/witness.cjs`;
export const WITNESS_STORED = "inputs/witness.cjs";
export const MOCHA_ENTRY = "node_modules/mocha/bin/mocha.js";
// Mocha would otherwise also read the repository's .mocharc* and package.json "mocha" key, which can add
// files to the selection, skip some, or not run tests at all (dry-run). Only the profile's options apply.
export const MOCHA_NO_REPO_CONFIG = ["--no-config", "--no-package"];
const MAX_REPORT_BYTES = 64 * 1024 * 1024;
const MAX_COVERAGE_FILE_BYTES = 256 * 1024 * 1024;

// ── the fixture manifest ─────────────────────────────────────────────────────────

export interface FixtureProfile {
  mergedSha: string;
  prNumber: number | null;
  shape: ContainerShape;
  node: string | null;
  mocha: { options: string[]; operands: string[] };
  baselinePassing: number | null;
}

const VALUE_OPTIONS = new Set(["--require", "--ui", "--timeout"]);
const FLAG_OPTIONS = new Set(["--check-leaks", "--exit"]);

export const insideRepoPath = (value: string): boolean => !isAbsolute(value) && !value.startsWith("-") && !value.split(/[\\/]/).includes("..");

/**
 * The repository's own Mocha options, from the fixture's full-suite command. Only options
 * that change how tests run, never what is loaded from outside the repository, are taken;
 * its reporter is replaced by OrangePro's and its folder operands are kept for the whole
 * suite only. Anything else refuses the run.
 */
export function mochaPlanOf(expanded: unknown): { options: string[]; operands: string[] } {
  const refuse = (detail: string): never => {
    throw new ProbeFaultRefusal("profile_option_not_allowed", detail);
  };
  if (!Array.isArray(expanded) || expanded[0] !== "mocha" || !expanded.every((part) => typeof part === "string")) {
    return refuse("the fixture's commands.full_suite_expanded must be a Mocha command line, starting with `mocha`.");
  }
  const options: string[] = [];
  const operands: string[] = [];
  for (let i = 1; i < expanded.length; i++) {
    const part = expanded[i] as string;
    if (!part.startsWith("-")) {
      if (!insideRepoPath(part)) refuse(`the test path ${part} is not inside the repository.`);
      operands.push(part);
      continue;
    }
    if (FLAG_OPTIONS.has(part)) {
      options.push(part);
      continue;
    }
    const value = expanded[i + 1];
    if (part === "--reporter") {
      if (typeof value !== "string") refuse("--reporter has no value.");
      i++;
      continue;
    }
    if (!VALUE_OPTIONS.has(part) || typeof value !== "string" || value.startsWith("-")) {
      return refuse(`${part} is not an option a probe takes from the repository (allowed: --require, --ui, --timeout, --check-leaks, --exit).`);
    }
    if (part === "--require" && !insideRepoPath(value)) refuse(`--require ${value} is not inside the repository.`);
    if (part === "--timeout" && !/^[1-9]\d*$/.test(value)) refuse(`--timeout ${value} is not a whole number of milliseconds.`);
    if (part === "--ui" && !/^[a-z-]+$/.test(value)) refuse(`--ui ${value} is not a Mocha interface name.`);
    options.push(part, value);
    i++;
  }
  return { options, operands };
}

export function readFixture(bytes: Buffer): FixtureProfile {
  const refuse = (detail: string): never => {
    throw new ProbeFaultRefusal("fixture_invalid", detail);
  };
  let manifest: Record<string, any>;
  try {
    manifest = JSON.parse(bytes.toString("utf8")) as Record<string, any>;
  } catch {
    return refuse("the fixture manifest is not valid JSON.");
  }
  if (manifest?.schema !== "orangepro.fixture_manifest.v1") refuse("the fixture manifest is not an orangepro.fixture_manifest.v1 file.");
  const merged = manifest.source?.merged_sha;
  if (typeof merged !== "string" || !/^[0-9a-f]{40}$/.test(merged)) refuse("source.merged_sha must be a full commit id.");
  const env = manifest.environment ?? {};
  const limits = manifest.limits ?? {};
  // A leading letter or digit: a value starting with `-` would be read by docker as an option.
  if (typeof env.image !== "string" || !/^[a-z0-9][a-z0-9._/-]*@sha256:[0-9a-f]{64}$/.test(env.image)) refuse("environment.image must be an image pinned by digest.");
  if (typeof env.platform !== "string" || !/^[a-z0-9]+\/[a-z0-9]+$/.test(env.platform)) refuse("environment.platform must be like linux/arm64.");
  if (env.node !== undefined && (typeof env.node !== "string" || !/^v\d+\.\d+\.\d+$/.test(env.node))) refuse("environment.node must be like v22.23.3 when given.");
  if (typeof limits.memory !== "string" || !/^[1-9]\d*[kmg]$/.test(limits.memory)) refuse("limits.memory must be like 4g.");
  if (!Number.isInteger(limits.cpus) || limits.cpus < 1) refuse("limits.cpus must be a positive whole number.");
  if (!Number.isInteger(limits.processes) || limits.processes < 16) refuse("limits.processes must be a whole number of at least 16.");
  if (!Number.isInteger(limits.container_deadline_seconds) || limits.container_deadline_seconds < 1) refuse("limits.container_deadline_seconds must be a positive whole number.");
  const pr = manifest.source?.pr?.number;
  const passing = manifest.baseline?.passing;
  return {
    mergedSha: merged,
    prNumber: Number.isInteger(pr) ? pr : null,
    shape: {
      image: env.image,
      platform: env.platform,
      memory: limits.memory,
      cpus: String(limits.cpus),
      processes: limits.processes,
      deadlineSeconds: limits.container_deadline_seconds
    },
    node: typeof env.node === "string" ? env.node : null,
    mocha: mochaPlanOf(manifest.commands?.full_suite_expanded),
    baselinePassing: Number.isInteger(passing) && passing > 0 ? passing : null
  };
}

// ── reading what a stage observed ────────────────────────────────────────────────

const NOT_AN_ASSERTION = new Set(["TypeError", "ReferenceError", "SyntaxError", "RangeError"]);

function firstFrame(stack: unknown): string | null {
  if (typeof stack !== "string") return null;
  const line = stack.split("\n").find((entry) => /^\s+at\s/.test(entry));
  return line ? line.trim() : null;
}

/**
 * The file and line one V8 frame names. The file may hold spaces and parentheses:
 * `at fn (test/(group)/a b.test.js:4:12)`, `at test/x.js:4:12`, `at async file:///…/x.mjs:4:12`.
 */
function frameParts(frame: string): { file: string; line: number; column: number } | null {
  let match: RegExpExecArray | null = null;
  if (frame.endsWith(")")) {
    // The location is the first " (…)" whose content ends in :line:col; the path may itself hold " (" or ")".
    for (let at = frame.indexOf(" ("); at >= 0 && !match; at = frame.indexOf(" (", at + 1)) {
      match = /^ \((.+):(\d+):(\d+)\)$/.exec(frame.slice(at));
    }
  } else {
    match = /^at (?:async )?(.+):(\d+):(\d+)$/.exec(frame);
  }
  if (!match) return null;
  const file = match[1]!.startsWith("file://") ? fileURLToPath(match[1]!) : match[1]!;
  return { file: posix.resolve(WORK_REPO, file), line: Number(match[2]), column: Number(match[3]) };
}

/** The 1-based column one V8 frame names, or null. */
export function frameColumn(frame: string | null): number | null {
  return frame ? (frameParts(frame)?.column ?? null) : null;
}

/** Where one stack frame points: its file (as a repository path) and line, or null. */
export function frameLocation(frame: string | null): { file: string; line: number } | null {
  const parts = frame ? frameParts(frame) : null;
  return parts ? { file: repoRel(parts.file), line: parts.line } : null;
}

/** Where a failure was raised: the first stack frame's file (as a repository path) and line, or null. */
export function failureLocation(stack: unknown): { file: string; line: number } | null {
  return frameLocation(firstFrame(stack));
}

/**
 * Where an error really came from when its stack was rewritten to start at the test's call:
 * supertest puts the test's frames first, then a `----` line, then the frames where the error
 * was raised. Null when the stack has no such line.
 */
export function rewrittenOrigin(stack: unknown): { file: string; line: number } | null {
  if (typeof stack !== "string") return null;
  const lines = stack.split("\n");
  const separator = lines.findIndex((line) => line.trim() === "----");
  if (separator < 0) return null;
  const frame = lines.slice(separator + 1).find((line) => /^\s+at\s/.test(line));
  return frame ? frameLocation(frame.trim()) : null;
}

export const NOT_AN_ASSERTION_ERRORS: ReadonlySet<string> = NOT_AN_ASSERTION;

/**
 * "At an assertion" (classifier v2, tightened for A3 on the owner's direction): the
 * failure's first stack frame is a line of the failing test's own file, and the error
 * is not a TypeError, ReferenceError, SyntaxError or RangeError. An AssertionError, or
 * an error carrying `expected` and `actual`, raised inside the library under test no
 * longer counts by itself: only the test's own line does. When the stack was rewritten
 * to start at the test's call, the frame it was really raised at must not be repository
 * code outside the test.
 */
export function failedAtAssertion(detail: Record<string, unknown> | undefined, testFile: string): boolean {
  if (!detail) return false;
  const name = String(detail.name ?? detail.constructorName ?? "");
  if (NOT_AN_ASSERTION.has(name)) return false;
  const at = failureLocation(detail.stack);
  if (at === null || at.file !== testFile) return false;
  // A rewritten stack (supertest) names the test's line first; where the error was raised must be the
  // test itself, an installed library (the assertion code), or Node: never the code under test.
  const origin = rewrittenOrigin(detail.stack);
  return origin === null || origin.file === testFile || origin.file.startsWith("node_modules/") || origin.file.startsWith("node:");
}

function repoRel(file: unknown): string {
  const text = typeof file === "string" ? file : "";
  return text.startsWith(`${WORK_REPO}/`) ? text.slice(WORK_REPO.length + 1) : text;
}

export function testsFromReport(report: any): NonNullable<StageObservation["tests"]> {
  const observed: ObservedTest[] = [];
  for (const suite of Array.isArray(report?.testResults) ? report.testResults : []) {
    for (const entry of Array.isArray(suite?.assertionResults) ? suite.assertionResults : []) {
      const state = entry.status === "passed" || entry.status === "failed" || entry.status === "pending" ? entry.status : null;
      if (!state) continue;
      const file = repoRel(entry.file ?? suite.name);
      const detail = Array.isArray(entry.failureDetails) ? (entry.failureDetails[0] as Record<string, unknown> | undefined) : undefined;
      observed.push({
        file,
        full_title: String(entry.fullName ?? ""),
        state,
        hook: entry.failurePhase === "hook",
        duration_ms: typeof entry.duration === "number" ? entry.duration : null,
        failure:
          state === "failed"
            ? {
                name: typeof detail?.name === "string" ? detail.name : typeof detail?.constructorName === "string" ? (detail.constructorName as string) : null,
                message: redactSecrets(String(detail?.message ?? "").split("\n")[0] ?? "").slice(0, 500),
                first_frame: firstFrame(detail?.stack),
                at_assertion: failedAtAssertion(detail, file)
              }
            : null
      });
    }
  }
  const totals = report?.stats;
  return {
    executed: observed.filter((test) => !test.hook && (test.state === "passed" || test.state === "failed")).length,
    passed: observed.filter((test) => test.state === "passed").length,
    failed: observed.filter((test) => test.state === "failed" && !test.hook).length,
    pending: observed.filter((test) => test.state === "pending").length,
    hook_failures: observed.filter((test) => test.hook).length,
    runner_totals:
      totals && typeof totals === "object"
        ? { tests: totals.tests ?? null, passes: totals.passes ?? null, failures: totals.failures ?? null, pending: totals.pending ?? null }
        : null,
    observed
  };
}

/** The URL V8 coverage gives a file in the container: percent-encoded, like Node's own. */
export function containerFileUrl(repoPath: string): string {
  return pathToFileURL(posix.join(WORK_REPO, repoPath)).href;
}

/**
 * The fault span's execution count from V8 block coverage: the innermost range that
 * contains it. 0 when the run covered repository files but never loaded this one; null
 * when the coverage shows no repository file at all (coverage did not work).
 */
export function faultSpanCount(coverageFiles: unknown[], scriptUrl: string, fileBytes: Buffer, span: { start: number; end: number }): number | null {
  const charStart = fileBytes.subarray(0, span.start).toString("utf8").length;
  const charEnd = fileBytes.subarray(0, span.end).toString("utf8").length;
  const repoPrefix = `${pathToFileURL(WORK_REPO).href}/`;
  let sawRepo = false;
  let loaded = false;
  let total = 0;
  for (const file of coverageFiles) {
    for (const script of Array.isArray((file as any)?.result) ? (file as any).result : []) {
      if (typeof script?.url === "string" && script.url.startsWith(repoPrefix)) sawRepo = true;
      if (script?.url !== scriptUrl) continue;
      loaded = true;
      let best: { width: number; count: number } | null = null;
      for (const fn of Array.isArray(script.functions) ? script.functions : []) {
        for (const range of Array.isArray(fn?.ranges) ? fn.ranges : []) {
          if (range.startOffset <= charStart && charEnd <= range.endOffset) {
            const width = range.endOffset - range.startOffset;
            if (!best || width <= best.width) best = { width, count: range.count };
          }
        }
      }
      if (!best) return null;
      total += best.count;
    }
  }
  if (loaded) return total;
  return sawRepo ? 0 : null;
}

/**
 * Read one file the container left in its output folder. The folder is untrusted: the
 * code under test can write to it, so a link, a device, a folder or an oversized file is
 * never read (a link could point at any file on this machine).
 */
function readUntrustedFile(abs: string, maxBytes: number): { bytes: Buffer } | { problem: string } {
  let st;
  try {
    st = lstatSync(abs);
  } catch {
    return { problem: "missing" };
  }
  if (!st.isFile()) return { problem: st.isSymbolicLink() ? "a symbolic link" : "not a regular file" };
  if (st.size > maxBytes) return { problem: `larger than ${maxBytes} bytes` };
  let fd: number | null = null;
  try {
    fd = openSync(abs, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.size > maxBytes) return { problem: "changed while being read" };
    const bytes = Buffer.alloc(fst.size);
    let read = 0;
    while (read < fst.size) {
      const n = readSync(fd, bytes, read, fst.size - read, read);
      if (n === 0) break;
      read += n;
    }
    return { bytes: bytes.subarray(0, read) };
  } catch {
    return { problem: "could not be opened as a regular file" };
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

// ── classification ───────────────────────────────────────────────────────────────

export interface ClassifyInput {
  stages: Partial<Record<StageName, StageObservation>>;
  parses: boolean;
  full_suite_requested: boolean;
  checkout_unchanged: boolean;
  /** Repository paths of the selected test files. */
  selected_files: string[];
  /** The fixture's recorded passing count for the whole suite. */
  baseline_passing: number | null;
}

export interface ClassifyOutput {
  classification: FaultClass;
  scope: "selected" | "full_suite" | null;
  reason: string | null;
  caught_by: Classification["caught_by"];
  behavioral_difference: Classification["behavioral_difference"];
  reached_by_selected_tests: Classification["reached_by_selected_tests"];
}

const idOf = (test: ObservedTest): string => `${test.file}\u0000${test.full_title}`;

/** Each test id with how many times it was seen. */
function idCounts(tests: ObservedTest[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const test of tests) counts.set(idOf(test), (counts.get(idOf(test)) ?? 0) + 1);
  return counts;
}

function sameCounts(a: Map<string, number>, b: Map<string, number>): boolean {
  return a.size === b.size && [...a].every(([id, n]) => b.get(id) === n);
}

/** A Mocha stage that cannot be read as a clean account of what ran, or null when it can. */
function runIssue(stage: StageObservation | undefined): string | null {
  if (!stage) return "stage_missing";
  if (stage.timed_out) return "timeout";
  const t = stage.tests;
  if (!t || stage.report === null) return "runner_error";
  if (t.hook_failures > 0) return "hook_failure";
  // The reporter's entries and Mocha's own totals must tell the same story.
  const totals = t.runner_totals;
  if (!totals || totals.passes !== t.passed || totals.failures !== t.failed + t.hook_failures || totals.pending !== t.pending) return "runner_totals_mismatch";
  return null;
}

/** Computed from the stage files, in the order the pre-registration fixes (section G). */
export function classifyFaultRun(input: ClassifyInput): ClassifyOutput {
  const { stages } = input;
  const original = stages.original_selected;
  const witnessOriginal = stages.witness_original;
  const witnessRepeat = stages.witness_original_repeat;
  const witnessFault = stages.witness_fault;
  const unknownDifference = { status: "unknown" as const, original: witnessOriginal?.output ?? null, fault: witnessFault?.output ?? null };
  const reached: ClassifyOutput["reached_by_selected_tests"] =
    original?.fault_span_count === null || original?.fault_span_count === undefined ? "unknown" : original.fault_span_count > 0 ? "reached" : "not_reached";
  const result = (classification: FaultClass, reason: string | null, extra: Partial<ClassifyOutput> = {}): ClassifyOutput => ({
    classification,
    scope: null,
    reason,
    caught_by: [],
    behavioral_difference: unknownDifference,
    reached_by_selected_tests: reached,
    ...extra
  });
  const ran = Object.values(stages).filter((stage): stage is StageObservation => stage !== undefined);
  // 1. blocked
  if (!input.checkout_unchanged) return result("blocked", "checkout_modified");
  if (ran.some((stage) => !stage.stopped)) return result("blocked", "container_not_stopped");
  if (ran.some((stage) => stage.boundary.failures.length > 0)) return result("blocked", "boundary_check_failed");
  const originalIssue = runIssue(original);
  if (originalIssue === "stage_missing") return result("blocked", "original_not_run");
  if (originalIssue) return result("inconclusive", `original_${originalIssue}`);
  const o = original!.tests!;
  if (o.failed > 0 || original!.exit_code !== 0) return result("blocked", "red_baseline");
  if (o.executed === 0) return result("inconclusive", "no_tests_executed");
  if (o.pending > 0) return result("inconclusive", "selected_test_pending");
  const originalIds = idCounts(o.observed);
  if ([...originalIds.values()].some((n) => n > 1)) return result("inconclusive", "duplicate_test_titles");
  // Every selected file ran at least one test, and nothing ran that was not selected.
  if (input.selected_files.some((file) => !o.observed.some((test) => test.file === file))) return result("inconclusive", "selected_file_not_run");
  if (o.observed.some((test) => !input.selected_files.includes(test.file))) return result("inconclusive", "unselected_test_ran");
  // 2. invalid mutation
  if (!input.parses) return result("invalid_mutation", "does_not_parse");
  if (!stages.fault_syntax || stages.fault_syntax.exit_code !== 0) return result("invalid_mutation", "syntax_check_failed");
  // 3. does the fault matter for the oracle's input? The witness must answer, the same way twice on the original.
  const answered = (stage: StageObservation | undefined): boolean => stage !== undefined && !stage.timed_out && stage.exit_code === 0 && stage.output !== null;
  if (!answered(witnessOriginal) || !answered(witnessRepeat)) return result("inconclusive", "witness_failed");
  if (canonicalJson(witnessOriginal!.output) !== canonicalJson(witnessRepeat!.output)) return result("inconclusive", "witness_not_deterministic");
  if (!answered(witnessFault)) return result("inconclusive", "witness_failed_on_fault");
  const same = canonicalJson(witnessFault!.output) === canonicalJson(witnessOriginal!.output);
  const difference = { status: same ? ("same" as const) : ("differs" as const), original: witnessOriginal!.output, fault: witnessFault!.output };
  if (same) return result("inconclusive", "no_behavioral_difference", { behavioral_difference: difference });
  // 4./5. the selected tests on the fault
  const fault = stages.fault_selected;
  const faultIssue = runIssue(fault);
  if (faultIssue) return result("inconclusive", `fault_${faultIssue}`, { behavioral_difference: difference });
  const f = fault!.tests!;
  if (f.pending > 0) return result("inconclusive", "selected_test_pending", { behavioral_difference: difference });
  if (!sameCounts(originalIds, idCounts(f.observed)) || f.executed !== o.executed) {
    return result("inconclusive", "test_set_differs", { behavioral_difference: difference });
  }
  const before = new Map(o.observed.map((test) => [idOf(test), test]));
  const caught = f.observed
    .filter((test) => test.state === "failed" && before.get(idOf(test))?.state === "passed")
    .map((test) => ({ file: test.file, full_title: test.full_title, at_assertion: test.failure?.at_assertion === true }));
  // One failure off an assertion makes every other failure on the same run suspect.
  if (caught.some((test) => !test.at_assertion)) return result("inconclusive", "failed_off_assertion", { caught_by: caught, behavioral_difference: difference });
  if (caught.length > 0) return result("caught_by_existing", null, { scope: "selected", caught_by: caught, behavioral_difference: difference });
  if (f.failed > 0 || f.passed !== o.executed || fault!.exit_code !== 0) return result("inconclusive", "fault_runner_error", { behavioral_difference: difference });
  // Every selected test passed on the fault. The whole suite widens the claim only when it ran cleanly on both
  // copies, matched the fixture's recorded count, and contained the selected tests.
  const survived = (reason: string | null): ClassifyOutput => result("survived_unverified", reason, { scope: "selected", behavioral_difference: difference });
  if (!input.full_suite_requested) return survived(null);
  const fullOriginal = stages.original_full_suite;
  const fullFault = stages.fault_full_suite;
  if (runIssue(fullOriginal) || runIssue(fullFault)) return survived("full_suite_inconclusive");
  const fo = fullOriginal!.tests!;
  const ff = fullFault!.tests!;
  if (fo.failed > 0 || fullOriginal!.exit_code !== 0) return survived("full_suite_red_on_original");
  if (input.baseline_passing === null || fo.passed !== input.baseline_passing || fo.pending !== 0) return survived("full_suite_count_differs");
  const fullOriginalIds = idCounts(fo.observed);
  if (!sameCounts(fullOriginalIds, idCounts(ff.observed))) return survived("full_suite_test_set_differs");
  if ([...originalIds.keys()].some((id) => !fullOriginalIds.has(id))) return survived("full_suite_lacks_selected");
  const fullBefore = new Map(fo.observed.map((test) => [idOf(test), test]));
  const fullCaught = ff.observed
    .filter((test) => test.state === "failed" && fullBefore.get(idOf(test))?.state === "passed")
    .map((test) => ({ file: test.file, full_title: test.full_title, at_assertion: test.failure?.at_assertion === true }));
  if (fullCaught.length > 0) {
    if (fullCaught.every((test) => test.at_assertion)) {
      return result("caught_by_existing", "caught_outside_selection", { scope: "full_suite", caught_by: fullCaught, behavioral_difference: difference });
    }
    return survived("full_suite_failed_off_assertion");
  }
  if (ff.failed > 0 || fullFault!.exit_code !== 0 || ff.passed !== input.baseline_passing) return survived("full_suite_inconclusive");
  return result("survived_unverified", null, { scope: "full_suite", behavioral_difference: difference });
}

const REASON_WORDS: Record<string, string> = {
  checkout_modified: "the checkout changed during the run",
  container_not_stopped: "a container could not be confirmed stopped after its deadline",
  boundary_check_failed: "the container boundary check failed",
  original_not_run: "the selected tests did not run on the original",
  original_timeout: "the selected tests timed out on the original",
  original_runner_error: "the test runner gave no report on the original",
  original_hook_failure: "a setup hook failed on the original",
  original_runner_totals_mismatch: "the runner's totals disagree with its report on the original",
  red_baseline: "the selected tests do not all pass on the original",
  no_tests_executed: "no selected test ran",
  selected_test_pending: "a selected test was skipped",
  duplicate_test_titles: "two selected tests have the same name, so they cannot be told apart",
  selected_file_not_run: "a selected file ran no test",
  unselected_test_ran: "a test that was not selected ran",
  does_not_parse: "the faulty file does not parse",
  syntax_check_failed: "the faulty file failed Node's syntax check",
  witness_failed: "the witness did not run cleanly on the original",
  witness_not_deterministic: "the witness gave two different answers on the original",
  witness_failed_on_fault: "the witness did not answer on the faulty copy",
  no_behavioral_difference: "the witness shows the same result with and without the fault",
  fault_timeout: "the selected tests timed out on the fault",
  fault_runner_error: "the test runner did not give a clean account on the fault",
  fault_hook_failure: "a setup hook failed on the fault",
  fault_runner_totals_mismatch: "the runner's totals disagree with its report on the fault",
  test_set_differs: "a different set of tests ran on the fault",
  failed_off_assertion: "a selected test failed on the fault, but not at an assertion"
};

/** The one sentence shown to people. It names the function the change touched; it never says the change caused the gap. */
export function statementFor(
  out: ClassifyOutput,
  ctx: { symbolName: string; changedBy: string; operatorDescription: string; line: number; selectedCount: number; fullCount: number | null; assisted: boolean }
): string {
  const where = `in ${ctx.symbolName}, which ${ctx.changedBy} changed (${ctx.operatorDescription}, line ${ctx.line})`;
  let sentence: string;
  if (out.classification === "survived_unverified" && out.scope === "full_suite") {
    sentence = `The whole existing suite (${ctx.fullCount ?? "?"} tests) passed with a valid fault ${where}: the suite missed it.`;
  } else if (out.classification === "survived_unverified") {
    sentence = `The ${ctx.selectedCount} selected tests passed with a valid fault ${where}: the selected tests missed it. The rest of the suite was not shown to miss it.`;
  } else if (out.classification === "caught_by_existing") {
    const first = out.caught_by[0];
    sentence = `The existing tests caught a fault ${where}: "${first?.full_title ?? "a test"}" failed at its assertion${out.scope === "full_suite" ? " (outside the selected files)" : ""}.`;
  } else if (out.classification === "invalid_mutation") {
    sentence = `No claim: the fault ${where} is not a valid change (${REASON_WORDS[out.reason ?? ""] ?? out.reason}).`;
  } else {
    sentence = `No claim about the fault ${where}: ${REASON_WORDS[out.reason ?? ""] ?? out.reason}.`;
  }
  return ctx.assisted ? `${sentence} Assisted replay: this target and fault were known before the run (see the oracle).` : sentence;
}

// ── the operation ────────────────────────────────────────────────────────────────

function reporterPath(): string {
  return resolve(dirname(dynamicProofSpikePath()), "dynamic-proof-mocha-reporter.cjs");
}

function fileRef(runDir: string, rel: string, bytes: Buffer): FileRef {
  writeFileAtomic(join(runDir, rel), bytes);
  return { path: rel, sha256: sha256Hex(bytes), bytes: bytes.length };
}

function lastJsonLine(stdout: string): unknown {
  const line = stdout.trim().split("\n").pop()?.trim();
  if (!line) return null;
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
}

/** Every file under `dir` with its sha256, `/`-separated, except the folders named. */
export function treeHashes(dir: string, skip: Set<string>): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (abs: string, rel: string): void => {
    for (const name of readdirSync(abs).sort()) {
      const childRel = rel ? `${rel}/${name}` : name;
      if (skip.has(childRel)) continue;
      const child = join(abs, name);
      const st = lstatSync(child);
      if (st.isDirectory()) walk(child, childRel);
      else out.set(childRel, st.isFile() ? sha256Hex(readFileSync(child)) : `<${st.isSymbolicLink() ? "link" : "special"}>`);
    }
  };
  walk(dir, "");
  return out;
}

export function trackedStatus(root: string): string | null {
  try {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-C", root, "status", "--porcelain", "--untracked-files=no"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

export function realInside(root: string, abs: string): boolean {
  const rel = relative(realpathSync(root), realpathSync(abs));
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
}

export function opProbeFault(root: string, opts: ProbeFaultOptions, deps: ProbeFaultDeps): ProbeFaultResult {
  // ── checks that need no copy and no run ──
  const record = opts.target_record as TargetRecord;
  if (typeof record !== "object" || record === null || record.version !== TARGET_RECORD_VERSION || typeof record.identity?.symbol_id !== "string") {
    throw new ProofRefusalError("stale_record", `not a target record of version ${TARGET_RECORD_VERSION}.`);
  }
  const spec = parseFaultSpec(opts.fault);
  if (!spec) throw new ProbeFaultRefusal("invalid_fault_spec", `--fault must be <operator>@<byte>, operator one of ${Object.keys(FAULT_OPERATORS).join(", ")}.`);
  const paths = workspacePaths(root);
  const graph = loadGraph(paths.graphPath);
  const target = resolveTargetSymbol(graph, record.identity.symbol_id);
  if (!target || target !== record.identity.symbol_id) throw new ProofRefusalError("stale_record", `the graph has no symbol ${record.identity.symbol_id}.`);
  if (targetLanguage(target) !== "typescript") throw new ProbeFaultRefusal("unsupported_route", "probe-fault supports JavaScript and TypeScript targets only.");
  const { sourceRoot, symbolTarget, tsjs } = proofPreflight(root, { target_record: record, source: opts.source }, graph, target, "typescript");
  const bound = tsjs?.bound;
  if (!tsjs || !bound) throw new ProbeFaultRefusal("unsupported_route", `${target} is not changed by its exact position (a prototype or exported-object method); an exact fault needs that route.`);
  const fileBytes = readFileSync(tsjs.targetAbs);
  const planned = planFault(fileBytes, bound.target, record.identity.file, spec.operator, spec.offset);
  if (!planned.ok) {
    if (planned.refused === "not_parsable") throw new ProbeFaultRefusal("unsupported_route", planned.message);
    throw new ProofRefusalError(planned.refused, planned.message);
  }
  const plan: FaultPlan = planned.plan;

  const oracleCheck = checkOracle(opts.oracle);
  if (!oracleCheck.ok) throw new ProbeFaultRefusal("oracle_invalid", oracleCheck.message);
  const oracle: Oracle = oracleCheck.oracle;
  const recordSha = recordSha256(record);
  if (oracle.target_record_sha256 !== recordSha || oracle.symbol_id !== record.identity.symbol_id) {
    throw new ProbeFaultRefusal("oracle_mismatch", `the oracle is for another target (record sha256 ${oracle.target_record_sha256}, this record is ${recordSha}).`);
  }
  if (sha256Hex(opts.witness_bytes) !== oracle.witness.sha256) throw new ProbeFaultRefusal("witness_mismatch", "the witness script is not the one the oracle names (sha256 differs).");

  const fixture = readFixture(opts.fixture_bytes);
  if (fixture.mergedSha !== record.identity.merged_commit) {
    throw new ProbeFaultRefusal("fixture_mismatch", `the fixture is frozen at ${fixture.mergedSha}; the record was made at ${record.identity.merged_commit}.`);
  }
  if (opts.full_suite && fixture.baselinePassing === null) {
    throw new ProbeFaultRefusal("fixture_invalid", "--full-suite needs the fixture's recorded baseline.passing count, to tell a whole suite from part of one.");
  }

  const tests = [...new Set(opts.tests.map((test) => test.trim()).filter(Boolean))].map((test) => {
    const invalid = (detail: string): never => {
      throw new ProbeFaultRefusal("tests_invalid", detail);
    };
    if (!insideRepoPath(test)) invalid(`${test} is not a path inside the source root.`);
    let abs = "";
    try {
      abs = resolveContained(sourceRoot, test);
    } catch {
      invalid(`${test} is outside the source root.`);
    }
    if (!existsSync(abs) || !lstatSync(abs).isFile()) invalid(`${test} is not a regular file in the source root (a symbolic link is not taken).`);
    if (!realInside(sourceRoot, abs)) invalid(`${test} leads outside the source root.`);
    const rel = toWorkspaceRel(sourceRoot, abs);
    if (rel === symbolTarget.file) invalid(`${test} is the target file, not a test.`);
    return { path: rel, sha256: sha256Hex(readFileSync(abs)) };
  });
  if (tests.length === 0) throw new ProbeFaultRefusal("tests_invalid", "name at least one selected test file.");

  // The installed dependencies: a real folder of the checkout, never a link to somewhere else on this machine.
  const nodeModules = join(sourceRoot, "node_modules");
  const mochaPackage = join(nodeModules, "mocha", "package.json");
  if (!existsSync(nodeModules) || !lstatSync(nodeModules).isDirectory() || !realInside(sourceRoot, nodeModules)) {
    throw new ProbeFaultRefusal("not_installed", `${sourceRoot} has no node_modules folder of its own: install the fixture first (inside the boundary).`);
  }
  if (!existsSync(join(sourceRoot, MOCHA_ENTRY)) || !existsSync(mochaPackage)) {
    throw new ProbeFaultRefusal("not_installed", `${sourceRoot} has no node_modules/mocha: install the fixture first (inside the boundary).`);
  }
  const mochaVersion = String((JSON.parse(readFileSync(mochaPackage, "utf8")) as { version?: unknown }).version ?? "unknown");
  const statusBefore = trackedStatus(sourceRoot);

  // ── the run folder: inputs and the fault, before any copy or run ──
  const runId = (deps.runId ?? newRunId)();
  const runDir = join(paths.dir, "proof-runs", runId);
  if (existsSync(runDir)) throw new Error(`${runDir} already exists.`);
  mkdirSync(runDir, { recursive: true });
  writeFileAtomic(join(runDir, "target-record.json"), recordBytes(record));
  writeFileAtomic(join(runDir, "oracle.json"), recordBytes(oracle));
  writeFileAtomic(join(runDir, WITNESS_STORED), opts.witness_bytes);
  writeFileAtomic(join(runDir, "fixture-manifest.json"), opts.fixture_bytes);
  const faultRecord = faultRecordOf(plan, {
    target_record_sha256: recordSha,
    oracle_sha256: recordSha256(oracle),
    symbol_id: record.identity.symbol_id,
    file: record.identity.file,
    file_sha256: bound.target.file_sha256,
    function_sha256: bound.target.function_sha256,
    rationale: opts.rationale?.trim() || `${FAULT_OPERATORS[spec.operator].description}, inside ${record.identity.name}, in the computation the oracle's expected result depends on.`
  });
  writeFileAtomic(join(runDir, "diagnostic-fault.patch"), plan.diff);
  writeFileAtomic(join(runDir, "fault-record.json"), recordBytes(faultRecord));
  const faultRecordSha = recordSha256(faultRecord);

  const mochaHead = ["node", MOCHA_ENTRY, ...MOCHA_NO_REPO_CONFIG, ...fixture.mocha.options, "--reporter", REPORTER_TARGET];
  const selectedArgv = [...mochaHead, ...tests.map((test) => test.path)];
  const fullArgv = opts.full_suite ? [...mochaHead, ...fixture.mocha.operands] : null;
  const deadlineMs = Math.min(deps.stageDeadlineMs ?? DEFAULT_STAGE_DEADLINE_MS, fixture.shape.deadlineSeconds * 1000);
  const changedBy = fixture.prNumber !== null ? `PR #${fixture.prNumber}` : `the change ${record.selection.base_commit.slice(0, 12)}..${record.identity.merged_commit.slice(0, 12)}`;
  const statementCtx = {
    symbolName: record.identity.name,
    changedBy,
    operatorDescription: `${plan.original_text}${plan.replacement_text ? ` → ${plan.replacement_text}` : " removed"}`,
    line: plan.site.lines.start,
    selectedCount: 0,
    fullCount: null as number | null,
    assisted: oracle.assisted.flag
  };
  const stages: Partial<Record<StageName, StageObservation>> = {};
  const stageRefs: Classification["stages"] = [];
  const checkoutUnchanged = (): boolean =>
    sha256Hex(readFileSync(tsjs.targetAbs)) === bound.target.file_sha256 &&
    tests.every((test) => existsSync(join(sourceRoot, test.path)) && sha256Hex(readFileSync(join(sourceRoot, test.path))) === test.sha256) &&
    trackedStatus(sourceRoot) === statusBefore;

  const finish = (parses: boolean): ProbeFaultResult => {
    const out = classifyFaultRun({
      stages,
      parses,
      full_suite_requested: Boolean(opts.full_suite),
      checkout_unchanged: checkoutUnchanged(),
      selected_files: tests.map((test) => test.path),
      baseline_passing: fixture.baselinePassing
    });
    statementCtx.selectedCount = stages.original_selected?.tests?.executed ?? 0;
    statementCtx.fullCount = stages.fault_full_suite?.tests?.executed ?? null;
    const classification: Classification = {
      version: CLASSIFICATION_VERSION,
      classifier_version: FAULT_CLASSIFIER_VERSION,
      run_id: runId,
      fault_record_sha256: faultRecordSha,
      classification: out.classification,
      scope: out.scope,
      reason: out.reason,
      statement: statementFor(out, statementCtx),
      assisted: oracle.assisted.flag,
      reached_by_selected_tests: out.reached_by_selected_tests,
      behavioral_difference: out.behavioral_difference,
      caught_by: out.caught_by,
      stages: stageRefs
    };
    writeFileAtomic(join(runDir, "classification.json"), recordBytes(classification));
    writeRunManifest(runDir, runId, ORANGEPRO_VERSION);
    return { run_id: runId, run_dir: toWorkspaceRel(root, runDir), fault_record: faultRecord, classification };
  };

  if (!plan.parses) return finish(false);

  // ── the two copies, made by the proof script from the commit's own files ──
  const tmp = mkdtempSync(join(tmpdir(), "opro-probe-fault-"));
  try {
    const copyRoots = prepareFaultCopies({
      runner: deps.dynamicProofRunner ?? defaultDynamicProofRunner,
      sourceRoot,
      targetRel: symbolTarget.file,
      method: symbolTarget.method,
      targetAbs: tsjs.targetAbs,
      bound,
      plan,
      tmp,
      mustHold: tests
    });
    const mountsFor = makeMountsFor(copyRoots, realpathSync(nodeModules), join(runDir, WITNESS_STORED));
    const reportEnv = { OPRO_DYNAMIC_PROOF_REPORT: `${WORK_OUT}/report.json` };
    const coverageEnv = { NODE_V8_COVERAGE: `${WORK_OUT}/coverage` };

    const profile: RunProfile = {
      version: RUN_PROFILE_VERSION,
      run_id: runId,
      tool: { name: "@orangepro/orangepro-mcp", version: ORANGEPRO_VERSION },
      fixture_manifest_sha256: sha256Hex(opts.fixture_bytes),
      source_pr: fixture.prNumber,
      merged_commit: record.identity.merged_commit,
      target_record_sha256: recordSha,
      oracle_sha256: recordSha256(oracle),
      fault_record_sha256: faultRecordSha,
      witness_sha256: oracle.witness.sha256,
      selected_tests: tests,
      selected_argv: selectedArgv,
      full_suite_argv: fullArgv,
      runner: { name: "mocha", version: mochaVersion },
      container: containerProfile(fixture, mountsFor, { ...reportEnv, ...coverageEnv }),
      limits: { stage_deadline_ms: deadlineMs }
    };
    writeFileAtomic(join(runDir, "run-profile.json"), recordBytes(profile));
    const runner = createStageRunner({
      runDir,
      runId,
      profileSha: recordSha256(profile),
      faultRecordSha,
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
    const { runStage, held } = runner;

    const original = runStage("original_selected", "original", selectedArgv, { ...reportEnv, ...coverageEnv }, fileBytes);
    if (!held(original) || original.timed_out || !original.tests || original.tests.failed > 0 || original.tests.hook_failures > 0 || original.exit_code !== 0 || original.tests.executed === 0 || original.tests.pending > 0) {
      return finish(true);
    }
    const syntax = runStage("fault_syntax", "mutant", ["node", "--check", symbolTarget.file.split(sep).join("/")], {});
    if (!held(syntax) || syntax.exit_code !== 0) return finish(true);
    for (const [stage, copy] of [["witness_original", "original"], ["witness_original_repeat", "original"], ["witness_fault", "mutant"]] as const) {
      if (!held(runStage(stage, copy, ["node", WITNESS_TARGET], {}))) return finish(true);
    }
    if (!held(runStage("fault_selected", "mutant", selectedArgv, reportEnv))) return finish(true);
    if (fullArgv) {
      if (held(runStage("original_full_suite", "original", fullArgv, reportEnv))) runStage("fault_full_suite", "mutant", fullArgv, reportEnv);
    }
    return finish(true);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ── shared with verify-test (A3): the copies, the mounts and one stage ───────────

export type CopyRoots = { original: string; mutant: string };

/**
 * The original and the faulty copy, made by the proof script from the commit's own files
 * under `<tmp>/copies`, and checked: the target file holds the expected bytes in each, the
 * two copies differ in nothing else, and each file in `mustHold` is there with the checkout's bytes.
 */
export function prepareFaultCopies(args: {
  runner: DynamicProofRunner;
  sourceRoot: string;
  targetRel: string;
  method: string;
  targetAbs: string;
  bound: NonNullable<NonNullable<ReturnType<typeof proofPreflight>["tsjs"]>["bound"]>;
  plan: FaultPlan;
  tmp: string;
  mustHold: Array<{ path: string; sha256: string }>;
}): CopyRoots {
  const { bound, plan } = args;
  const copiesDir = join(args.tmp, "copies");
  mkdirSync(copiesDir);
  const spikeArgs = [
    "--root",
    args.sourceRoot,
    "--target",
    args.targetRel,
    "--method",
    args.method,
    "--prepare",
    copiesDir,
    "--json",
    ...bound.args,
    "--bound-edit-start",
    String(plan.site.bytes.start),
    "--bound-edit-end",
    String(plan.site.bytes.end),
    "--bound-edit-expect-sha256",
    plan.original_site_sha256,
    "--bound-edit-replacement",
    plan.replacement_text
  ];
  const prepared = runBoundSpike(args.runner, spikeArgs, args.sourceRoot, args.targetAbs, args.targetRel, bound.target.file_sha256, plan.site.bytes)
    .oracle as unknown as { status?: string; bound?: { mutatedSha256?: string }; copies?: { original?: { root?: string }; mutant?: { root?: string } } };
  if (prepared.status !== "prepared" || prepared.bound?.mutatedSha256 !== plan.mutated_file_sha256) {
    throw new ProbeFaultRefusal("prepare_failed", "the proof script did not prepare the copies with the planned fault.");
  }
  const copyRoots: CopyRoots = { original: prepared.copies?.original?.root ?? "", mutant: prepared.copies?.mutant?.root ?? "" };
  for (const copy of Object.values(copyRoots)) {
    if (!copy || !existsSync(copy) || relative(copiesDir, copy).startsWith("..") || isAbsolute(relative(copiesDir, copy))) {
      throw new ProbeFaultRefusal("prepare_failed", "the proof script did not put both copies inside the folder it was given.");
    }
  }
  // The two copies differ in the target file and nothing else, and both hold the named files as the checkout has them.
  const originalTree = treeHashes(copyRoots.original, new Set());
  const mutantTree = treeHashes(copyRoots.mutant, new Set());
  const targetPath = args.targetRel.split(sep).join("/");
  if (originalTree.get(targetPath) !== bound.target.file_sha256 || mutantTree.get(targetPath) !== plan.mutated_file_sha256) {
    throw new ProbeFaultRefusal("prepare_failed", "a prepared copy does not hold the expected bytes of the target file.");
  }
  const otherDiffers = originalTree.size !== mutantTree.size || [...originalTree].some(([path, hash]) => path !== targetPath && mutantTree.get(path) !== hash);
  if (otherDiffers) throw new ProbeFaultRefusal("prepare_failed", "the two copies differ in more than the target file.");
  for (const file of args.mustHold) {
    if (originalTree.get(file.path.split(sep).join("/")) !== file.sha256) {
      throw new ProbeFaultRefusal("tests_invalid", `${file.path} is not in the commit as it is in the checkout (missing, changed since the commit, or a symbolic link).`);
    }
  }
  // Mount points for the installed dependencies: the copies never contain them.
  for (const copy of Object.values(copyRoots)) mkdirSync(join(copy, "node_modules"), { recursive: true });
  return copyRoots;
}

/** The mounts of every stage: a copy, the installed dependencies, a fresh output folder, the reporter, and the witness when there is one. */
export function makeMountsFor(copyRoots: CopyRoots, nodeModulesReal: string, witnessFile: string | null): (copy: "original" | "mutant", out: string) => ContainerMount[] {
  return (copy, out) => [
    { source: copyRoots[copy], target: WORK_REPO, readonly: true, role: `<${copy}>` },
    { source: nodeModulesReal, target: `${WORK_REPO}/node_modules`, readonly: true, role: "<node_modules>" },
    { source: out, target: WORK_OUT, readonly: false, role: "<out>" },
    { source: reporterPath(), target: REPORTER_TARGET, readonly: true, role: "<reporter>" },
    ...(witnessFile ? [{ source: witnessFile, target: WITNESS_TARGET, readonly: true, role: "<witness>" }] : [])
  ];
}

export function containerProfile(fixture: FixtureProfile, mountsFor: ReturnType<typeof makeMountsFor>, env: Record<string, string>): RunProfile["container"] {
  return {
    image: fixture.shape.image,
    platform: fixture.shape.platform,
    user: "1000:1000",
    network: "none",
    read_only_root: true,
    capabilities: "none",
    memory: fixture.shape.memory,
    cpus: fixture.shape.cpus,
    processes: fixture.shape.processes,
    tmp_size: "2g",
    deadline_seconds: fixture.shape.deadlineSeconds,
    mounts: mountsFor("original", "<out>").map((mount) => ({ source: mount.role, target: mount.target, mode: mount.readonly ? "ro" : "rw" })),
    env_names: shapeEnvNames(env)
  };
}

export interface StageRunnerContext {
  runDir: string;
  runId: string;
  profileSha: string;
  faultRecordSha: string;
  fixture: FixtureProfile;
  deadlineMs: number;
  tmp: string;
  copyRoots: CopyRoots;
  mountsFor: ReturnType<typeof makeMountsFor>;
  targetRel: string;
  faultSpan: { start: number; end: number };
  executor: ContainerExecutor;
  clock: Clock;
  stages: Partial<Record<StageName, StageObservation>>;
  stageRefs: Classification["stages"];
}

export function createStageRunner(ctx: StageRunnerContext): {
  runStage: (stage: StageName, copy: "original" | "mutant", command: string[], env: Record<string, string>, coverageTarget?: Buffer, faultPresent?: boolean) => StageObservation;
  held: (stage: StageObservation) => boolean;
} {
  const { runDir, runId, fixture, deadlineMs, tmp, copyRoots, mountsFor, executor } = ctx;
  /** One stage: the boundary probe in the stage's own shape, then, only if it holds, the stage's command. */
  // `faultPresent` says whether the target bytes in the copy hold the fault; by default, in the faulty copy only.
  const runStage = (stage: StageName, copy: "original" | "mutant", command: string[], env: Record<string, string>, coverageTarget?: Buffer, faultPresent = copy === "mutant"): StageObservation => {
    // The probe and the stage each get a new, never-used output folder. A folder deleted and made again at
    // the same path is not the same folder to Docker Desktop's file sharing: the next container sees the
    // deleted one, and every write to it fails.
    const probeOut = mkdtempSync(join(tmp, `probe-${stage}-`));
    const out = mkdtempSync(join(tmp, `out-${stage}-`));
    const request: ContainerRequest = { shape: fixture.shape, mounts: mountsFor(copy, out), env, workdir: WORK_REPO, command, deadlineMs };
    const probeRequest: ContainerRequest = { ...request, mounts: mountsFor(copy, probeOut) };
    const copyTargetSha = sha256Hex(readFileSync(join(copyRoots[copy], ctx.targetRel)));
    const startedAt = ctx.clock();
    const probe = executor(boundaryProbeRequest(probeRequest));
    const probeReport = probe.exitCode === 0 ? lastJsonLine(probe.stdout) : null;
    const failures =
      probe.exitCode === 0
        ? boundaryFailures(probeReport, probeRequest, fixture.node)
        : [`the probe exited ${probe.exitCode}${probe.timedOut ? " (timeout)" : ""}${probe.stderr ? `: ${redactSecrets(probe.stderr).split("\n")[0]}` : ""}`];
    rmSync(probeOut, { recursive: true, force: true });
    const run = failures.length === 0 ? executor(request) : null;
    const stdout = fileRef(runDir, `logs/${stage}.stdout.log`, Buffer.from(redactSecrets(run?.stdout ?? ""), "utf8"));
    const stderr = fileRef(runDir, `logs/${stage}.stderr.log`, Buffer.from(redactSecrets(run?.stderr ?? ""), "utf8"));
    const outputProblems: string[] = [];
    let report: FileRef | null = null;
    let observedTests: StageObservation["tests"] = null;
    if (run && env.OPRO_DYNAMIC_PROOF_REPORT) {
      const read = readUntrustedFile(join(out, "report.json"), MAX_REPORT_BYTES);
      if ("bytes" in read) {
        report = fileRef(runDir, `reports/${stage}.json`, read.bytes);
        try {
          observedTests = testsFromReport(JSON.parse(read.bytes.toString("utf8")));
        } catch {
          outputProblems.push("report.json is not valid JSON");
        }
      } else if (read.problem !== "missing") {
        outputProblems.push(`report.json was not read: ${read.problem}`);
      }
    }
    let coverage: FileRef | null = null;
    let spanCount: number | null = null;
    if (run && coverageTarget) {
      const dir = join(out, "coverage");
      const dirStat = existsSync(dir) ? lstatSync(dir) : null;
      if (dirStat && !dirStat.isDirectory()) outputProblems.push("the coverage folder is not a folder");
      else if (dirStat) {
        const files: unknown[] = [];
        for (const name of readdirSync(dir).sort()) {
          if (!name.endsWith(".json")) continue;
          const read = readUntrustedFile(join(dir, name), MAX_COVERAGE_FILE_BYTES);
          if (!("bytes" in read)) {
            outputProblems.push(`coverage/${name} was not read: ${read.problem}`);
            continue;
          }
          try {
            files.push(JSON.parse(read.bytes.toString("utf8")));
          } catch {
            outputProblems.push(`coverage/${name} is not valid JSON`);
          }
        }
        const url = containerFileUrl(ctx.targetRel.split(sep).join("/"));
        spanCount = outputProblems.some((problem) => problem.startsWith("coverage")) ? null : faultSpanCount(files, url, coverageTarget, ctx.faultSpan);
        const kept = files.flatMap((file) => (Array.isArray((file as any)?.result) ? (file as any).result : []).filter((script: any) => script?.url === url));
        coverage = fileRef(runDir, `coverage/${stage}.json`, recordBytes({ url, scripts: kept }));
      }
    }
    const observation: StageObservation = {
      version: STAGE_OBSERVATION_VERSION,
      stage,
      run_id: runId,
      run_profile_sha256: ctx.profileSha,
      fault_record_sha256: faultPresent ? ctx.faultRecordSha : null,
      copy,
      copy_target_sha256: copyTargetSha,
      argv: command,
      docker_argv: (run ?? probe).dockerArgv.map((part) => (part === BOUNDARY_PROBE_SOURCE ? "<boundary probe>" : part)),
      boundary: { failures, report: probeReport },
      stopped: probe.stopped && (run?.stopped ?? true),
      output_problems: outputProblems,
      cwd: WORK_REPO,
      env_names: shapeEnvNames(env),
      started_at: startedAt,
      duration_ms: run?.durationMs ?? 0,
      exit_code: run?.exitCode ?? null,
      signal: run?.signal ?? null,
      timed_out: run?.timedOut ?? false,
      tests: observedTests,
      output: run && !env.OPRO_DYNAMIC_PROOF_REPORT ? lastJsonLine(run.stdout) : null,
      fault_span_count: coverageTarget ? spanCount : null,
      stdout,
      stderr,
      report,
      coverage
    };
    const rel = `stages/${stage}.json`;
    const bytes = recordBytes(observation);
    writeFileAtomic(join(runDir, rel), bytes);
    // Classified from the file as written, never from the object in memory.
    const readBack = JSON.parse(readFileSync(join(runDir, rel), "utf8")) as StageObservation;
    ctx.stages[stage] = readBack;
    ctx.stageRefs.push({ stage, path: rel, sha256: sha256Hex(bytes) });
    rmSync(out, { recursive: true, force: true });
    return readBack;
  };
  const held = (stage: StageObservation): boolean => stage.boundary.failures.length === 0 && stage.stopped;
  return { runStage, held };
}

/** Plain lines for the terminal. */
export function renderProbeFault(result: ProbeFaultResult): string[] {
  const c = result.classification;
  const lines = [
    `Result: ${c.classification}${c.scope ? ` (scope: ${c.scope === "full_suite" ? "the whole suite" : "the selected tests"})` : ""}${c.reason ? ` — ${c.reason}` : ""}`,
    c.statement,
    `Fault: ${result.fault_record.file} bytes [${result.fault_record.site.bytes.start}, ${result.fault_record.site.bytes.end}) line ${result.fault_record.site.lines.start}: ${result.fault_record.original_text} → ${result.fault_record.replacement_text || "(removed)"}`,
    `Behavior with the oracle's input: ${c.behavioral_difference.status}${c.behavioral_difference.status !== "unknown" ? ` (original ${JSON.stringify(c.behavioral_difference.original)}, fault ${JSON.stringify(c.behavioral_difference.fault)})` : ""}`,
    `Fault line run by the selected tests on the original: ${c.reached_by_selected_tests}`
  ];
  if (c.caught_by.length > 0) lines.push(...c.caught_by.map((test) => `  caught by: ${test.file} › ${test.full_title}${test.at_assertion ? "" : " (not at an assertion)"}`));
  lines.push(`Run folder: ${result.run_dir} (MANIFEST.json lists every file with its sha256)`);
  return lines;
}
