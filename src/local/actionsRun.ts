import { appendFileSync, cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { changedFiles, readActionsEvent, testOnlyChange, type ActionsChange } from "./actionsEvent.js";
import {
  boundaryFailures,
  boundaryProbeRequest,
  containerUser,
  dockerExecutor,
  dockerImageEnsurer,
  dockerRunArgs,
  WORK_REPO,
  type ContainerExecutor,
  type ContainerRequest,
  type ContainerResult,
  type ImageCheck,
  type ImageEnsurer
} from "./boundary.js";
import { checkBuild, type BuildCheck } from "./buildInfo.js";
import { applyAdditivePatch, parseAdditivePatch } from "./candidatePatch.js";
import { allowedPaths, earlierAttempts, faultKeyOf, opTestBrief, opVerifyTest } from "./candidateTest.js";
import { gitBytes, opChangedTargets, type GitBytes } from "./changedTargets.js";
import { recordBytes, recordSha256, sha256Hex, writeFileAtomic } from "./contracts/io.js";
import type { TargetRecord } from "./contracts/targetRecord.js";
import { opExportTests } from "./exportTests.js";
import { MOCHA_ENTRY, opProbeFault, ProbeFaultRefusal, readFixture } from "./faultProbe.js";
import { opAnalyze, opBehaviorCoverageHtml, ProofRefusalError } from "./operations.js";
import { redactSecrets } from "./util/redact.js";
import type { Clock } from "./util/time.js";
import { ORANGEPRO_VERSION } from "./version.js";
import { workspacePaths } from "./workspace.js";

// `opro actions-run` (V2): the step a post-merge GitHub Actions job runs. It reads the
// event, decides whether this change is one the Actions profile was made for, and if so
// runs the existing chain on it — changed-targets → probe-fault → test-brief →
// verify-test → export-tests — under one total time limit, every command that runs the
// repository's code inside the container boundary. It writes one folder for the job to
// upload: result.json, the job summary and copies of the run folders. Every honest
// outcome exits 0, so the artifacts always upload; only an internal error does not.

export const ACTIONS_PROFILE_VERSION = "orangepro.actions_profile.v1" as const;
export const ACTIONS_RESULT_VERSION = "orangepro.actions_result.v1" as const;
export const DEFAULT_TOTAL_MINUTES = 20;
export const MAX_TOTAL_MINUTES = 360;

export interface ActionsProfile {
  version: typeof ACTIONS_PROFILE_VERSION;
  /** The branch whose pushes start the workflow. */
  base_branch: string;
  /** The OrangePro build the workflow installs; any other build is refused. */
  orangepro: { version: string; build_sha256: string };
  /** Paths below are relative to the profile's own folder. */
  fixture: { manifest: string; lockfile: string | null };
  target_record: string;
  oracle: string;
  witness: string;
  /** `<operator>@<byte offset>` in the target file. */
  fault: string;
  tests: string[];
  full_suite: boolean;
  /** The test to replay, written earlier (assisted) and kept as a patch and an assertion record template; null stops after the brief. */
  candidate: { patch: string; assertion: string } | null;
  limits: { total_minutes: number };
}

export type ActionsStatus = "verified_gap" | "not_verified" | "needs_test" | "not_configured" | "skipped" | "blocked" | "inconclusive" | "error";

export interface ActionsResult {
  version: typeof ACTIONS_RESULT_VERSION;
  status: ActionsStatus;
  reason: string | null;
  /** One plain sentence: what happened, or why it stopped. */
  detail: string;
  event: { name: string; base: string | null; merged: string | null; mode: "first_parent" | "range" | null; commits: string[] };
  changed_files: string[] | null;
  /** The functions changed-targets selected for this change; with not_configured, what the change touched instead. */
  changed_targets: Array<{ symbol_id: string; name: string; file: string; record_sha256: string }> | null;
  profile: { sha256: string | null; target: string | null; target_record_sha256: string | null };
  build: { version: string; build_sha256: string | null; profile_version: string | null; profile_build_sha256: string | null };
  fixture: { frozen_sha256: string; frozen_platform: string; effective_sha256: string; effective_platform: string } | null;
  container_user: string | null;
  /** The pinned image: already here, or pulled by its digest for the runner's platform. */
  image: ImageCheck | null;
  install: InstallRecord | null;
  runs: { fault: string | null; brief: string | null; verify: string | null; export: string | null };
  fault_classification: string | null;
  /** Which old tests ran on the fault: the selected ones, or the whole suite too. */
  fault_scope: "selected" | "full_suite" | null;
  verify_result: string | null;
  receipt: { path: string; fault: string; rows: Array<{ row: string; met: boolean }> } | null;
  /** Who wrote the replayed test, as its assertion record says; actions-run only replays it. */
  test_source: { kind: "replayed_candidate"; by: string; agent: string; assisted: boolean; note: string } | null;
  limits: { total_ms: number; used_ms: number; deadline_reached: boolean };
  started_at: string;
  finished_at: string;
}

export interface InstallRecord {
  ran: boolean;
  /** Why it did not run: the checkout already had its test runner installed. */
  skipped: "already_installed" | null;
  command: string[];
  lockfile: { path: string; sha256: string; added: boolean; unchanged_by_install: boolean | null } | null;
  boundary_checks: Array<{ shape: "test" | "install"; held: boolean; failures: string[] }>;
  exit_code: number | null;
  timed_out: boolean;
  duration_ms: number;
  log: string | null;
}

export interface ActionsRunOptions {
  event_name: string;
  event_path: string;
  profile_path: string;
  repo: string;
  out: string;
  summary_path?: string;
}

export interface ActionsRunDeps {
  clock: Clock;
  /** Milliseconds, for the total time limit. */
  nowMs?: () => number;
  container?: ContainerExecutor;
  image?: ImageEnsurer;
  git?: GitBytes;
  build?: BuildCheck;
  env?: NodeJS.ProcessEnv;
  /** The host CPU, as Node names it (`x64`, `arm64`): the container platform follows it. */
  arch?: string;
  runId?: () => string;
  analyze?: typeof opAnalyze;
}

// Names that hold a credential. The boundary passes only its own variables into a container;
// this is the second line: a job that has any of these set does not start one.
const CREDENTIAL_NAME_RE = /TOKEN|SECRET|PASSWORD|_KEY$/i;

export function credentialNames(env: NodeJS.ProcessEnv): string[] {
  return Object.keys(env)
    .filter((name) => CREDENTIAL_NAME_RE.test(name) && (env[name] ?? "") !== "")
    .sort();
}

export function hostContainerPlatform(arch: string): string | null {
  return arch === "x64" ? "linux/amd64" : arch === "arm64" ? "linux/arm64" : null;
}

/** The frozen manifest with only `environment.platform` set to the host's; the same bytes when they already agree. */
export function effectiveManifest(frozen: Buffer, platform: string): Buffer {
  const manifest = JSON.parse(frozen.toString("utf8")) as { environment?: { platform?: unknown } };
  if (manifest.environment?.platform === platform) return frozen;
  return Buffer.from(`${JSON.stringify({ ...manifest, environment: { ...manifest.environment, platform } }, null, 2)}\n`, "utf8");
}

// ── the profile ──────────────────────────────────────────────────────────────────

const PROFILE_PATH_RE = /^[\w.@+-]+(?:\/[\w.@+-]+)*$/;
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const SHA256_RE = /^[0-9a-f]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
export const BRANCH_RE = /^(?!-)(?!.*\.\.)[A-Za-z0-9._/-]{1,200}$/;

/** A path inside the profile's folder: relative, no `.` or `..` segment, no quoting needed. */
export function profilePathOk(path: unknown): path is string {
  return typeof path === "string" && PROFILE_PATH_RE.test(path) && path.split("/").every((part) => part !== "." && part !== "..");
}

export function checkActionsProfile(value: unknown): { ok: true; profile: ActionsProfile } | { ok: false; message: string } {
  const fail = (message: string) => ({ ok: false as const, message });
  if (!isPlain(value)) return fail("the profile is not a JSON object.");
  const keys = ["version", "base_branch", "orangepro", "fixture", "target_record", "oracle", "witness", "fault", "tests", "full_suite", "candidate", "limits"];
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  const missing = keys.filter((key) => !(key in value));
  if (unknown.length > 0 || missing.length > 0) return fail(`unknown field(s) [${unknown.join(", ")}], missing field(s) [${missing.join(", ")}].`);
  if (value.version !== ACTIONS_PROFILE_VERSION) return fail(`version must be ${ACTIONS_PROFILE_VERSION}.`);
  if (typeof value.base_branch !== "string" || !BRANCH_RE.test(value.base_branch)) return fail("base_branch must be a branch name.");
  const o = value.orangepro;
  if (!isPlain(o) || typeof o.version !== "string" || !VERSION_RE.test(o.version) || typeof o.build_sha256 !== "string" || !SHA256_RE.test(o.build_sha256)) {
    return fail("orangepro needs version (x.y.z) and build_sha256 (the build stamp's 64 hex).");
  }
  const f = value.fixture;
  if (!isPlain(f) || !profilePathOk(f.manifest) || (f.lockfile !== null && !profilePathOk(f.lockfile))) return fail("fixture needs manifest and lockfile (or null), as paths inside the profile's folder.");
  for (const key of ["target_record", "oracle", "witness"] as const) if (!profilePathOk(value[key])) return fail(`${key} must be a path inside the profile's folder.`);
  if (typeof value.fault !== "string" || !/^[a-z_]+@\d+$/.test(value.fault)) return fail("fault must be <operator>@<byte offset>.");
  if (!Array.isArray(value.tests) || value.tests.length === 0 || !value.tests.every((test) => typeof test === "string" && PROFILE_PATH_RE.test(test))) {
    return fail("tests must list at least one test file of the repository.");
  }
  if (typeof value.full_suite !== "boolean") return fail("full_suite must be true or false.");
  const c = value.candidate;
  if (c !== null && (!isPlain(c) || Object.keys(c).sort().join(",") !== "assertion,patch" || !profilePathOk(c.patch) || !profilePathOk(c.assertion))) {
    return fail("candidate must be null, or name a patch and an assertion record template inside the profile's folder.");
  }
  const l = value.limits;
  if (!isPlain(l) || typeof l.total_minutes !== "number" || !(l.total_minutes > 0) || l.total_minutes > MAX_TOTAL_MINUTES) {
    return fail(`limits.total_minutes must be more than 0 and at most ${MAX_TOTAL_MINUTES}.`);
  }
  return { ok: true, profile: value as unknown as ActionsProfile };
}

interface LoadedProfile {
  profile: ActionsProfile;
  sha256: string;
  manifest: Buffer;
  lockfile: Buffer | null;
  targetRecord: TargetRecord;
  oracle: unknown;
  witness: Buffer;
  candidate: { patch: Buffer; assertion: Record<string, unknown> } | null;
}

class ProfileError extends Error {}

function loadProfile(profilePath: string): LoadedProfile {
  let bytes: Buffer;
  let value: unknown;
  try {
    bytes = readFileSync(profilePath);
    value = JSON.parse(bytes.toString("utf8"));
  } catch (error) {
    throw new ProfileError(`${profilePath} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const checked = checkActionsProfile(value);
  if (!checked.ok) throw new ProfileError(checked.message);
  const dir = dirname(profilePath);
  const read = (rel: string): Buffer => {
    const abs = join(dir, rel);
    if (!existsSync(abs) || !lstatSync(abs).isFile()) throw new ProfileError(`${rel} is not a regular file in the profile's folder (a symbolic link is not taken).`);
    return readFileSync(abs);
  };
  const json = (rel: string): unknown => {
    try {
      return JSON.parse(read(rel).toString("utf8"));
    } catch (error) {
      if (error instanceof ProfileError) throw error;
      throw new ProfileError(`${rel} is not JSON.`);
    }
  };
  const p = checked.profile;
  const assertion = p.candidate ? json(p.candidate.assertion) : null;
  if (p.candidate && !isPlain(assertion)) throw new ProfileError(`${p.candidate.assertion} is not an assertion record template.`);
  return {
    profile: p,
    sha256: sha256Hex(bytes),
    manifest: read(p.fixture.manifest),
    lockfile: p.fixture.lockfile ? read(p.fixture.lockfile) : null,
    targetRecord: json(p.target_record) as TargetRecord,
    oracle: json(p.oracle),
    witness: read(p.witness),
    candidate: p.candidate ? { patch: read(p.candidate.patch), assertion: assertion as Record<string, unknown> } : null
  };
}

// ── the run ──────────────────────────────────────────────────────────────────────

/** The executor, bounded by the run's total limit: a stage gets at most what is left, and none starts after it. */
export function deadlineExecutor(inner: ContainerExecutor, deadlineAt: number, nowMs: () => number): ContainerExecutor {
  return (request) => {
    const remaining = deadlineAt - nowMs();
    if (remaining <= 0) {
      return {
        exitCode: null,
        signal: null,
        timedOut: true,
        stdout: "",
        stderr: "the run's total time limit was reached before this container started.",
        durationMs: 0,
        dockerArgv: ["docker", ...dockerRunArgs("<name>", request, true)],
        stopped: true
      };
    }
    return inner({ ...request, deadlineMs: Math.max(1, Math.min(request.deadlineMs, remaining)) });
  };
}

// The headline word; the sentence after it says what happened, so it is not repeated here.
const STATUS_WORDS: Record<ActionsStatus, string> = {
  verified_gap: "Verified",
  not_verified: "Not verified",
  needs_test: "A gap with no test to replay yet",
  not_configured: "Not configured for this change",
  skipped: "Skipped",
  blocked: "Blocked",
  inconclusive: "No result (inconclusive)",
  error: "OrangePro failed (internal error)"
};

const MAX_LOG_BYTES = 256 * 1024;

function lastJsonLine(text: string): unknown {
  for (const line of text.trim().split("\n").reverse()) {
    try {
      return JSON.parse(line);
    } catch {
      // not the report line
    }
  }
  return null;
}

function logText(result: ContainerResult): string {
  const text = redactSecrets(`$ ${result.dockerArgv.join(" ")}\n# exit ${result.exitCode}${result.timedOut ? " (timed out)" : ""}, ${result.durationMs} ms\n${result.stdout}\n${result.stderr}`);
  return text.length > MAX_LOG_BYTES ? `${text.slice(0, MAX_LOG_BYTES)}\n… (cut at ${MAX_LOG_BYTES} bytes)\n` : text;
}

/** Inside `parent`, by real path (both must exist). */
function inside(parent: string, child: string): boolean {
  const rel = relative(realpathSync(parent), realpathSync(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export function opActionsRun(opts: ActionsRunOptions, deps: ActionsRunDeps): ActionsResult {
  const nowMs = deps.nowMs ?? Date.now;
  const env = deps.env ?? process.env;
  const git = deps.git ?? gitBytes;
  const startedMs = nowMs();
  const repo = resolve(opts.repo);
  const out = resolve(opts.out);
  if (!existsSync(repo) || !lstatSync(repo).isDirectory()) throw new Error(`--repo ${opts.repo} is not a folder.`);
  if (existsSync(out) && readdirSync(out).length > 0) throw new Error(`--out ${opts.out} already holds files: give it a new or empty folder.`);
  mkdirSync(out, { recursive: true });
  if (inside(repo, out)) throw new Error(`--out ${opts.out} is inside the repository: it would change the checkout being proven.`);

  const build = deps.build ?? checkBuild();
  const result: ActionsResult = {
    version: ACTIONS_RESULT_VERSION,
    status: "error",
    reason: "internal_error",
    detail: "",
    event: { name: opts.event_name, base: null, merged: null, mode: null, commits: [] },
    changed_files: null,
    changed_targets: null,
    profile: { sha256: null, target: null, target_record_sha256: null },
    build: { version: ORANGEPRO_VERSION, build_sha256: build.build_sha256, profile_version: null, profile_build_sha256: null },
    fixture: null,
    container_user: null,
    image: null,
    install: null,
    runs: { fault: null, brief: null, verify: null, export: null },
    fault_classification: null,
    fault_scope: null,
    verify_result: null,
    receipt: null,
    test_source: null,
    limits: { total_ms: 0, used_ms: 0, deadline_reached: false },
    started_at: deps.clock(),
    finished_at: ""
  };
  const end = (status: ActionsStatus, reason: string | null, detail: string): ActionsResult => {
    result.status = status;
    result.reason = reason;
    result.detail = detail;
    return result;
  };

  try {
    runChain();
  } catch (error) {
    if (error instanceof ProbeFaultRefusal || error instanceof ProofRefusalError) end("blocked", error.code, error.message);
    else if (error instanceof ProfileError) end("blocked", "profile_invalid", error.message);
    else end("error", "internal_error", redactSecrets(error instanceof Error ? error.message : String(error)));
  }
  finish();
  return result;

  function runChain(): void {
    // 1. The build: only the stamped build the profile names runs.
    const loaded = loadProfile(resolve(opts.profile_path));
    const profile = loaded.profile;
    result.profile = { sha256: loaded.sha256, target: loaded.targetRecord?.identity?.symbol_id ?? null, target_record_sha256: recordSha256(loaded.targetRecord) };
    result.build.profile_version = profile.orangepro.version;
    result.build.profile_build_sha256 = profile.orangepro.build_sha256;
    const totalMs = Math.round(profile.limits.total_minutes * 60_000);
    result.limits.total_ms = totalMs;
    const deadlineAt = startedMs + totalMs;
    if (build.status !== "build" || build.build_sha256 !== profile.orangepro.build_sha256 || ORANGEPRO_VERSION !== profile.orangepro.version) {
      end(
        "blocked",
        "build_mismatch",
        build.status === "build"
          ? `this is OrangePro ${ORANGEPRO_VERSION} (build ${build.build_sha256?.slice(0, 12)}); the profile names ${profile.orangepro.version} (build ${profile.orangepro.build_sha256.slice(0, 12)}).`
          : `this OrangePro has no valid build stamp (${build.status}${build.reason ? `: ${build.reason}` : ""}); the profile names build ${profile.orangepro.build_sha256.slice(0, 12)}.`
      );
      return;
    }

    // 2. Credentials: none may be in the environment of a job that starts containers.
    const credentials = credentialNames(env);
    if (credentials.length > 0) {
      end("blocked", "credential_in_env", `the environment holds ${credentials.join(", ")}; OrangePro starts no container while a credential is set. Remove it from this job.`);
      return;
    }

    // 3. The event: what changed, and whether that history is safe to prove.
    let payload: unknown;
    try {
      payload = JSON.parse(readFileSync(resolve(opts.event_path), "utf8"));
    } catch {
      end("blocked", "event_invalid", `the event file ${opts.event_path} could not be read as JSON.`);
      return;
    }
    const decision = readActionsEvent(opts.event_name, payload, repo, git);
    result.event.base = decision.base;
    result.event.merged = decision.merged;
    if (!decision.ok) {
      end(decision.status, decision.reason, decision.detail);
      return;
    }
    const change: ActionsChange = decision;
    result.event.mode = change.mode;
    result.event.commits = change.commits;

    // 4. A change to allowed test files only (OrangePro's own patch, merged) starts no proof.
    const files = changedFiles(repo, change.base, change.merged, git);
    if (files === null) {
      end("blocked", "git_failed", "git could not list the files the change touches.");
      return;
    }
    result.changed_files = files;
    let allowed: { patterns: string[]; never: string[] };
    try {
      allowed = allowedPaths(loaded.manifest);
    } catch {
      throw new ProfileError("the fixture manifest has no allowed_patch_paths.patterns.");
    }
    if (testOnlyChange(files, allowed)) {
      end("skipped", "test_only_change", `every file this change touches is a test file a test patch may add to (${files.join(", ")}): no proof is started for it.`);
      return;
    }

    // 5. The container platform follows the runner; the image digest stays the frozen one.
    const frozen = readFixture(loaded.manifest);
    const platform = hostContainerPlatform(deps.arch ?? process.arch);
    if (!platform) {
      end("blocked", "unsupported_platform", `the host CPU (${deps.arch ?? process.arch}) has no matching image platform; linux/amd64 and linux/arm64 are supported.`);
      return;
    }
    const manifest = effectiveManifest(loaded.manifest, platform);
    const fixture = readFixture(manifest);
    result.fixture = { frozen_sha256: sha256Hex(loaded.manifest), frozen_platform: frozen.shape.platform, effective_sha256: sha256Hex(manifest), effective_platform: platform };
    writeFileAtomic(join(out, "fixture-manifest.effective.json"), manifest);
    try {
      result.container_user = containerUser();
    } catch (error) {
      end("blocked", "container_user", error instanceof Error ? error.message : String(error));
      return;
    }

    // 6. The graph at the merged commit, then the functions this change touched.
    (deps.analyze ?? opAnalyze)(repo, { source: repo, suppressProgress: true }, { clock: deps.clock, env });
    const changed = opChangedTargets(repo, { base: change.base, merged: change.merged, range: change.mode === "range" }, { git });
    if (changed.status !== "ok") {
      end("blocked", changed.refused, changed.message);
      return;
    }
    result.changed_targets = changed.targets.map((target) => ({ symbol_id: target.identity.symbol_id, name: target.identity.name, file: target.identity.file, record_sha256: recordSha256(target) }));
    const wanted = result.profile.target;
    const record = changed.targets.find((target) => target.identity.symbol_id === wanted);
    if (!record || recordSha256(record) !== result.profile.target_record_sha256) {
      const names = changed.targets.map((target) => target.identity.name);
      end(
        "not_configured",
        "not_configured_for_change",
        !record
          ? `this change does not change ${wanted}, the function the profile was made for${changed.listed.some((l) => l.symbol_id === wanted) ? " (it is listed, but not among the selected targets)" : ""}. It changed: ${names.length > 0 ? names.join(", ") : "no function OrangePro selects"}. No test is replayed for a change it was not made for.`
          : `this change changes ${wanted}, but not as the profile records it (its target record differs): the profile's oracle and test were made for another change of it. No test is replayed.`
      );
      return;
    }

    // 7. The pinned image (a fresh runner has none), then the install inside the boundary, from the
    // frozen lockfile, unless the test runner is already there.
    const image = (deps.image ?? dockerImageEnsurer())(fixture.shape.image, fixture.shape.platform, Math.max(1, deadlineAt - nowMs()));
    result.image = image;
    if (!image.present) {
      if (deadlinePassed(deadlineAt)) return;
      end("blocked", "image_unavailable", `the pinned image is not on this machine and could not be fetched by its digest: ${image.detail ?? "unknown cause"}`);
      return;
    }
    const executor = deadlineExecutor(deps.container ?? dockerExecutor(), deadlineAt, nowMs);
    const installed = installStage(loaded, fixture.shape, executor, deadlineAt);
    if (installed) return;

    // 8. The fault, run against the selected old tests.
    if (deadlinePassed(deadlineAt)) return;
    const stageDeps = { clock: deps.clock, container: executor, ...(deps.runId ? { runId: deps.runId } : {}) };
    const fault = opProbeFault(
      repo,
      { target_record: record, fault: profile.fault, oracle: loaded.oracle, fixture_bytes: manifest, tests: profile.tests, witness_bytes: loaded.witness, full_suite: profile.full_suite },
      stageDeps
    );
    result.runs.fault = fault.run_id;
    result.fault_classification = fault.classification.classification;
    result.fault_scope = fault.classification.scope;
    if (fault.classification.classification !== "survived_unverified") {
      if (deadlinePassed(deadlineAt)) return;
      const c = fault.classification;
      if (c.classification === "caught_by_existing") end("skipped", "caught_by_existing", c.statement);
      else end(c.classification === "inconclusive" ? "inconclusive" : "blocked", c.reason ?? c.classification, c.statement);
      return;
    }

    // 9. The brief; without a test to replay, the run stops here.
    const brief = opTestBrief(repo, { from_run: fault.run_dir }, stageDeps);
    result.runs.brief = brief.run_id;
    if (!loaded.candidate) {
      end("needs_test", "no_candidate", `${fault.classification.statement} The profile names no test to replay; the brief is in the artifacts, for one to be written.`);
      return;
    }

    // 10. The replayed test: its assertion record, filled in from this brief, then verified.
    if (deadlinePassed(deadlineAt)) return;
    const assertion = assertionFor(loaded.candidate, join(repo, brief.run_dir), fault.fault_record);
    const generation = assertion.generation as { by: string; agent: string; assisted: boolean };
    result.test_source = {
      kind: "replayed_candidate",
      by: generation.by,
      agent: generation.agent,
      assisted: generation.assisted,
      note: "The test was written before this run and is replayed unchanged from the Actions profile; OrangePro did not write it here."
    };
    const verify = opVerifyTest(repo, { from_run: fault.run_dir, brief: brief.run_dir, candidate_bytes: loaded.candidate.patch, assertion }, stageDeps);
    result.runs.verify = verify.run_id;
    result.verify_result = verify.verdict.result;
    if (verify.verdict.result !== "verified_gap") {
      if (deadlinePassed(deadlineAt)) return;
      const v = verify.verdict;
      end(v.result === "inconclusive" ? "inconclusive" : v.result === "blocked" ? "blocked" : "not_verified", v.reason ?? v.result, v.statement);
      return;
    }

    // 11. The test-only patch, the fresh replay and the receipt.
    if (deadlinePassed(deadlineAt)) return;
    const exported = opExportTests(repo, { from_run: verify.run_dir }, stageDeps);
    result.runs.export = exported.run_id;
    const receipt = exported.receipt;
    result.receipt = { path: `runs/${exported.run_id}/verification-receipt.json`, fault: receipt.classification.fault, rows: receipt.rows.map((row) => ({ row: row.row, met: row.met })) };
    if (receipt.classification.fault === "verified_gap") {
      end("verified_gap", null, `${verify.verdict.statement} All eight rows of the receipt (A–H) are met. The test-only patch is in the artifacts; it is not delivered (no pull request is opened).`);
      return;
    }
    if (deadlinePassed(deadlineAt)) return;
    end(receipt.classification.fault === "inconclusive" ? "inconclusive" : "blocked", receipt.classification.reason ?? receipt.classification.fault, "the fresh replay did not meet every row of the receipt; see the receipt in the artifacts.");
  }

  function deadlinePassed(deadlineAt: number): boolean {
    if (nowMs() < deadlineAt) return false;
    result.limits.deadline_reached = true;
    end("inconclusive", "deadline", `the run reached its total time limit (${Math.round(result.limits.total_ms / 1000)} s) before it finished; no result is claimed.`);
    return true;
  }

  /** The install stage. Returns true when the run stops here. */
  function installStage(loaded: LoadedProfile, shape: ContainerRequest["shape"], executor: ContainerExecutor, deadlineAt: number): boolean {
    const raw = JSON.parse(loaded.manifest.toString("utf8")) as { dependencies?: { lockfile?: unknown; lockfile_sha256?: unknown }; commands?: { install?: unknown } };
    const command = Array.isArray(raw.commands?.install) ? raw.commands.install : ["npm", "ci", "--no-audit", "--no-fund"];
    if (command.length < 2 || command[0] !== "npm" || command[1] !== "ci" || !command.slice(2).every((arg) => typeof arg === "string" && /^--[a-z-]+(=[\w.-]+)?$/.test(arg))) {
      throw new ProfileError("the fixture's commands.install must be npm ci with flags only.");
    }
    const record: InstallRecord = { ran: false, skipped: null, command: command as string[], lockfile: null, boundary_checks: [], exit_code: null, timed_out: false, duration_ms: 0, log: null };
    result.install = record;
    if (existsSync(join(repo, "node_modules")) && lstatSync(join(repo, "node_modules")).isDirectory() && existsSync(join(repo, MOCHA_ENTRY))) {
      record.skipped = "already_installed";
      return false;
    }
    if (loaded.lockfile) {
      const name = typeof raw.dependencies?.lockfile === "string" ? raw.dependencies.lockfile : "package-lock.json";
      if (!/^[\w.-]+$/.test(name)) throw new ProfileError("the fixture's dependencies.lockfile must be a file name at the package root.");
      const sha = sha256Hex(loaded.lockfile);
      if (raw.dependencies?.lockfile_sha256 !== sha) throw new ProfileError(`the profile's lockfile is not the one the fixture manifest names (sha256 ${sha}).`);
      const at = join(repo, name);
      let added = false;
      if (existsSync(at)) {
        if (!lstatSync(at).isFile() || sha256Hex(readFileSync(at)) !== sha) {
          end("blocked", "lockfile_conflict", `the checkout already has a ${name} that is not the fixture's frozen one: OrangePro does not replace it.`);
          return true;
        }
      } else {
        writeFileSync(at, loaded.lockfile);
        added = true;
      }
      record.lockfile = { path: name, sha256: sha, added, unchanged_by_install: null };
    }
    // The boundary, checked in both shapes before anything of the repository runs.
    const base = { shape, env: {}, workdir: WORK_REPO, deadlineMs: Math.min(shape.deadlineSeconds * 1000, 120_000) };
    for (const kind of ["test", "install"] as const) {
      const request: ContainerRequest = { ...base, mounts: [{ source: repo, target: WORK_REPO, readonly: kind === "test", role: "<checkout>" }], network: kind === "install" ? "bridge" : "none", command: [] };
      const probe = executor(boundaryProbeRequest(request));
      const failures = probe.exitCode === 0 ? boundaryFailures(lastJsonLine(probe.stdout), request, readFixture(loaded.manifest).node) : [`the probe exited ${probe.exitCode}${probe.timedOut ? " (timed out)" : ""}`];
      record.boundary_checks.push({ shape: kind, held: failures.length === 0, failures });
      writeFileAtomic(join(out, "install", `boundary-${kind}.log`), logText(probe));
      if (failures.length > 0) {
        if (deadlinePassed(deadlineAt)) return true;
        end("blocked", "boundary_failed", `the container boundary does not hold in the ${kind} shape: ${failures.join("; ")}.`);
        return true;
      }
    }
    const run = executor({ ...base, deadlineMs: shape.deadlineSeconds * 1000, mounts: [{ source: repo, target: WORK_REPO, readonly: false, role: "<checkout>" }], network: "bridge", command: command as string[] });
    record.ran = true;
    record.exit_code = run.exitCode;
    record.timed_out = run.timedOut;
    record.duration_ms = run.durationMs;
    record.log = "install/install.log";
    writeFileAtomic(join(out, "install", "install.log"), logText(run));
    if (record.lockfile) record.lockfile.unchanged_by_install = existsSync(join(repo, record.lockfile.path)) && sha256Hex(readFileSync(join(repo, record.lockfile.path))) === record.lockfile.sha256;
    if (run.timedOut || run.exitCode !== 0 || !run.stopped || !existsSync(join(repo, MOCHA_ENTRY))) {
      if (deadlinePassed(deadlineAt)) return true;
      end("blocked", "install_failed", `the install inside the boundary ${run.timedOut ? "timed out" : `exited ${run.exitCode}`}${existsSync(join(repo, MOCHA_ENTRY)) ? "" : ", and Mocha is not installed"}; see install/install.log.`);
      return true;
    }
    if (record.lockfile && !record.lockfile.unchanged_by_install) {
      end("blocked", "install_failed", "the install changed the frozen lockfile; nothing installed from it is trusted.");
      return true;
    }
    return false;
  }

  function finish(): void {
    result.finished_at = deps.clock();
    result.limits.used_ms = Math.max(0, nowMs() - startedMs);
    const runsDir = workspacePaths(repo).dir;
    for (const id of Object.values(result.runs)) {
      if (!id) continue;
      const from = join(runsDir, "proof-runs", id);
      if (existsSync(from)) cpSync(from, join(out, "runs", id), { recursive: true });
    }
    // M2: both reports in the artifact, beside the run folders they link (runs/<id>/…), with the
    // export run's patch status. Only when the change was analysed; a report never fails the run.
    if (existsSync(workspacePaths(repo).graphPath)) {
      try {
        opBehaviorCoverageHtml(repo, join(out, "behavior-coverage.html"), undefined, {
          persistBaseline: false,
          feedbackInvite: false,
          proofRunsDir: join(out, "runs"),
          csvPath: join(out, "tests.csv"),
          dataPath: join(out, "report-data.json")
        });
      } catch {
        // the reports are a convenience in the artifact; result.json is the result
      }
    }
    writeFileAtomic(join(out, "result.json"), recordBytes(result));
    const summary = actionsSummary(result);
    writeFileAtomic(join(out, "summary.md"), summary);
    if (opts.summary_path) appendFileSync(opts.summary_path, summary);
  }

  function assertionFor(candidate: NonNullable<LoadedProfile["candidate"]>, briefDir: string, faultRecord: Parameters<typeof faultKeyOf>[0]): Record<string, unknown> {
    const template = candidate.assertion;
    const requestBytes = readFileSync(join(briefDir, "brief", "generation-request.json"));
    const request = JSON.parse(requestBytes.toString("utf8")) as { fault_record_sha256?: unknown };
    const patch = parseAdditivePatch(candidate.patch);
    const original = join(repo, patch.path);
    if (!existsSync(original)) throw new ProfileError(`the candidate patch adds to ${patch.path}, which is not in the checkout.`);
    const applied = applyAdditivePatch(readFileSync(original), patch);
    const generation = isPlain(template.generation) ? template.generation : {};
    const attempt = earlierAttempts(join(workspacePaths(repo).dir, "proof-runs"), faultKeyOf(faultRecord)).length + 1;
    return {
      ...template,
      generation_request_sha256: sha256Hex(requestBytes),
      fault_record_sha256: request.fault_record_sha256,
      candidate: { patch_sha256: sha256Hex(candidate.patch), files: [{ path: patch.path, sha256_after: sha256Hex(applied.bytes) }] },
      generation: { ...generation, attempt }
    };
  }
}

// ── the job summary ──────────────────────────────────────────────────────────────

const short = (sha: string | null): string => (sha ? sha.slice(0, 12) : "none");
const words = (code: string): string => code.replace(/_/g, " ");
const WRITER_WORDS: Record<string, string> = { host_agent: "a coding agent", provider: "a model", person: "a person" };

function oldTestWords(r: ActionsResult): string {
  if (r.fault_classification === "caught_by_existing") return r.fault_scope === "full_suite" ? "caught it (the whole suite ran)" : "the selected tests caught it";
  if (r.fault_classification === "survived_unverified") return r.fault_scope === "full_suite" ? "missed it: the selected tests, and the whole suite" : "the selected tests missed it";
  return words(r.fault_classification ?? "");
}

export function actionsSummary(r: ActionsResult): string {
  const lines = [`## OrangePro proof after merge`, "", `**${STATUS_WORDS[r.status]}.** ${r.detail}`, ""];
  const rows: Array<[string, string]> = [];
  if (r.event.merged) {
    const span = r.event.mode === "range" ? `a range of ${r.event.commits.length} commits` : "one commit";
    rows.push(["Change", `\`${short(r.event.base)}\` → \`${short(r.event.merged)}\` (${r.event.name === "push" ? "push" : "manual run"}, ${span})`]);
  }
  if (r.changed_targets) rows.push(["Functions it changed", r.changed_targets.length > 0 ? r.changed_targets.map((t) => `\`${t.name}\` in \`${t.file}\``).join(", ") : "none OrangePro selects"]);
  if (r.profile.target) rows.push(["Profile's target", `\`${r.profile.target}\``]);
  if (r.fault_classification) rows.push(["Old tests on the fault", oldTestWords(r)]);
  if (r.test_source) {
    const outcome = r.verify_result === "verified_gap" ? "; it passes without the fault and fails at its own assertion with it" : r.verify_result ? `; result: ${words(r.verify_result)}` : "";
    rows.push(["New test", `replayed, not written in this run: ${r.test_source.agent} wrote it earlier (${WRITER_WORDS[r.test_source.by] ?? words(r.test_source.by)}${r.test_source.assisted ? "; assisted" : ""})${outcome}`]);
  }
  if (r.receipt) {
    const unmet = r.receipt.rows.filter((row) => !row.met).map((row) => row.row);
    rows.push(["Receipt", `${unmet.length === 0 ? "all eight rows (A–H) met" : `rows not met: ${unmet.join(", ")}`}: \`${r.receipt.path}\``]);
  }
  if (r.install) rows.push(["Install", r.install.ran ? `\`${r.install.command.join(" ")}\` inside the container, exit ${r.install.exit_code}` : "not needed: the test runner was already installed"]);
  if (r.image?.pulled) rows.push(["Image", `fetched by its digest for ${r.image.platform} (${Math.round(r.image.duration_ms / 1000)} s); it was not on this machine`]);
  if (r.fixture) {
    const platform = r.fixture.effective_platform === r.fixture.frozen_platform ? r.fixture.effective_platform : `${r.fixture.effective_platform} (the fixture was frozen on ${r.fixture.frozen_platform}; the same image digest)`;
    rows.push(["Container", `${platform}, user ${r.container_user ?? "unknown"}; network off for every test stage`]);
  }
  rows.push(["OrangePro", `${r.build.version} (build ${short(r.build.build_sha256)})`]);
  rows.push(["Time", `${Math.round(r.limits.used_ms / 1000)} s (limit ${Math.round(r.limits.total_ms / 60_000)} min)${r.limits.deadline_reached ? ": the limit was reached" : ""}`]);
  lines.push("| | |", "|---|---|", ...rows.map(([k, v]) => `| ${k} | ${v.replace(/\|/g, "\\|")} |`), "");
  lines.push("This job only reads the repository and uploads its artifacts: it opens no pull request and needs no write permission.", "");
  return `${lines.join("\n")}\n`;
}

export function renderActionsRun(r: ActionsResult): string[] {
  return actionsSummary(r).trimEnd().split("\n");
}
