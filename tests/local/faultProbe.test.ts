import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { boundaryFailures, dockerExecutor, dockerRunArgs, resolveDocker, shapeEnvNames, WORK_OUT, WORK_REPO, type ContainerExecutor, type ContainerRequest } from "../../src/local/boundary.js";
import { opChangedTargets } from "../../src/local/changedTargets.js";
import { canonicalJson, recordBytes, recordSha256, verifyRunFolder, writeRunManifest } from "../../src/local/contracts/io.js";
import { checkOracle, type Oracle } from "../../src/local/contracts/oracle.js";
import { faultRecordOf, parseFaultSpec, planFault } from "../../src/local/contracts/faultRecord.js";
import { describeTarget, type TargetRecord } from "../../src/local/contracts/targetRecord.js";
import { classifyFaultRun, containerFileUrl, failedAtAssertion, faultSpanCount, mochaPlanOf, opProbeFault, ProbeFaultRefusal, type ProbeFaultOptions, type ProbeFaultResult } from "../../src/local/faultProbe.js";
import { opAnalyze, opInit, ProofRefusalError, type DynamicProofRunner } from "../../src/local/operations.js";

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, "scripts/spikes/dynamic-proof-spike.mjs");
const mochaPackage = path.dirname(require.resolve("mocha/package.json"));
const deps = { clock: () => "2026-10-21T00:00:00Z", env: {} as NodeJS.ProcessEnv };

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function tempDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `opro-a2-${label}-`));
  tempDirs.push(dir);
  return dir;
}

function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Sample Author", "-c", "user.email=author@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function commitAll(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

// ── a small CommonJS library whose exported-object method a change touched ────────

const API_BEFORE = `var api = module.exports = {};

api.seconds = function (ms) {
  return Math.floor(ms / 1000);
};
`;

const API_AFTER = `var api = module.exports = {};

// Math.floor in a comment is not code.
api.label = function (ms) {
  var text = "Math.floor";
  return text + ":" + Math.floor(ms);
};

api.seconds = function (ms) {
  var value = ms - 0;
  if (!isNaN(value)) {
    return Math.floor(value / 1000);
  }
  return null;
};

api.differs = function (a, b) {
  return a != b;
};
`;

const OFFSETS = {
  floorInSeconds: API_AFTER.indexOf("Math.floor(value"),
  bangInSeconds: API_AFTER.indexOf("!isNaN"),
  floorInLabel: API_AFTER.indexOf("Math.floor(ms)"),
  floorInComment: API_AFTER.indexOf("Math.floor in a comment"),
  floorInString: API_AFTER.indexOf('"Math.floor"') + 1,
  bangInEquality: API_AFTER.indexOf("!= b")
};

const PASSING_TESTS = `var assert = require('assert');
var api = require('../lib/api');

describe('api.seconds', function () {
  it('converts whole seconds', function () {
    assert.strictEqual(api.seconds(2000), 2);
  });
  it('returns null for a value that is not a number', function () {
    assert.strictEqual(api.seconds('soon'), null);
  });
});
`;

const WITNESS = `var api = require(process.cwd() + '/lib/api');
process.stdout.write(JSON.stringify({ seconds: api.seconds(1500) }) + '\\n');
`;

interface Workspace {
  repo: string;
  record: TargetRecord;
  oracle: Oracle;
  witness: Buffer;
  fixture: Buffer;
}

/** A checkout at the merged commit, analyzed, with Mocha "installed" and a real record for api.seconds. */
function workspace(tests: Record<string, string> = { "test/api.test.js": PASSING_TESTS }, opts: { witness?: string; mochaArgs?: string[] } = {}): Workspace {
  const repo = tempDir("ws");
  writeFiles(repo, { "package.json": JSON.stringify({ name: "seconds-lib", version: "1.0.0" }, null, 2), ".gitignore": "node_modules\n", "lib/api.js": API_BEFORE, ...tests });
  git(repo, "init", "-q");
  const base = commitAll(repo, "before");
  writeFileSync(path.join(repo, "lib/api.js"), API_AFTER);
  const merged = commitAll(repo, "after");
  mkdirSync(path.join(repo, "node_modules"));
  symlinkSync(mochaPackage, path.join(repo, "node_modules", "mocha"), "dir");
  opInit(repo, deps);
  opAnalyze(repo, { source: repo }, deps);
  const changed = opChangedTargets(repo, { base, merged, range: false, limit: 10 });
  if (changed.status !== "ok") throw new Error(`fixture error: changed-targets refused (${changed.refused})`);
  const record = changed.targets.find((target) => target.identity.symbol_id === "sym:lib/api.js#api.seconds");
  if (!record) throw new Error("fixture error: api.seconds is not a target");
  const witness = Buffer.from(opts.witness ?? WITNESS);
  const oracle: Oracle = {
    version: "orangepro.oracle.v1",
    target_record_sha256: recordSha256(record),
    symbol_id: "sym:lib/api.js#api.seconds",
    behavior: "api.seconds rounds a millisecond value down to whole seconds.",
    entry_point: "require('./lib/api').seconds(ms)",
    inputs: "ms = 1500",
    expected: "1",
    excluded_inputs: "values that are not numbers",
    why_observable: "the return value is what a caller reads",
    basis: [{ kind: "source_doc", ref: "lib/api.js", note: "whole seconds, rounded down" }],
    witness: { file: "witness.cjs", sha256: sha256(witness), input: "api.seconds(1500)" },
    assisted: { flag: false, visible_before: [] },
    approval: { status: "approved", by: "test", at: "2026-10-21", where: "this test" }
  };
  const fixture = Buffer.from(
    JSON.stringify({
      schema: "orangepro.fixture_manifest.v1",
      source: { merged_sha: merged, pr: { number: 7 } },
      environment: { image: `node@sha256:${"0".repeat(64)}`, platform: "linux/arm64" },
      limits: { memory: "1g", cpus: 1, processes: 64, container_deadline_seconds: 120 },
      commands: { full_suite_expanded: opts.mochaArgs ?? ["mocha", "--check-leaks", "--reporter", "spec", "test/"] },
      baseline: { passing: 2 }
    })
  );
  return { repo, record, oracle, witness, fixture };
}

function passingProbe(request: ContainerRequest): Record<string, unknown> {
  return {
    uid: 1000,
    effective_capabilities: "0000000000000000",
    no_new_privileges: "1",
    env_names: [...shapeEnvNames(request.env), "PATH"],
    host_users_dir_visible: false,
    docker_socket_visible: false,
    root_writable: false,
    tmp_writable: true,
    writable: Object.fromEntries(request.mounts.map((mount) => [mount.target, !mount.readonly])),
    host_backed_mounts: request.mounts.map((mount) => mount.target).sort(),
    network_reachable: false
  };
}

/**
 * A stand-in for the container, for synthetic projects only: it runs the same command
 * with Node on this machine, maps the container paths to the mounted folders, links
 * the copy's empty node_modules mount point to the installed one for the run, and
 * rewrites the copy's real path to /work/repo in the reports, as the container sees it.
 */
function hostExecutor(probe: (request: ContainerRequest) => unknown = passingProbe): ContainerExecutor & { calls: ContainerRequest[] } {
  const calls: ContainerRequest[] = [];
  const executor = ((request: ContainerRequest) => {
    calls.push(request);
    const started = Date.now();
    if (request.command[1] === "-e") {
      return { exitCode: 0, signal: null, timedOut: false, stdout: `${JSON.stringify(probe(request))}\n`, stderr: "", durationMs: 1, dockerArgv: ["docker", "run", "<host test double>"], stopped: true };
    }
    const sorted = [...request.mounts].sort((a, b) => b.target.length - a.target.length);
    const toHost = (value: string): string => {
      for (const mount of sorted) if (value === mount.target || value.startsWith(`${mount.target}/`)) return mount.source + value.slice(mount.target.length);
      return value;
    };
    const repo = request.mounts.find((mount) => mount.target === WORK_REPO)!.source;
    const installed = request.mounts.find((mount) => mount.target === `${WORK_REPO}/node_modules`)!.source;
    const out = request.mounts.find((mount) => mount.target === WORK_OUT)!.source;
    const mountPoint = path.join(repo, "node_modules");
    rmSync(mountPoint, { recursive: true, force: true });
    symlinkSync(installed, mountPoint, "dir");
    try {
      const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: tmpdir() };
      for (const [key, value] of Object.entries(request.env)) env[key] = toHost(value);
      const child = spawnSync(process.execPath, request.command.slice(1).map((arg) => (arg.startsWith("/") ? toHost(arg) : arg)), {
        cwd: toHost(request.workdir),
        env,
        encoding: "utf8",
        timeout: request.deadlineMs
      });
      // Longest first: on macOS the temp folder /var/… is really /private/var/…, which contains it.
      const names = [...new Set([repo, realpathSync(repo)])].sort((a, b) => b.length - a.length);
      const rewrite = (dir: string): void => {
        if (!existsSync(dir)) return;
        for (const name of readdirSync(dir)) {
          const abs = path.join(dir, name);
          if (statSync(abs).isDirectory()) rewrite(abs);
          else if (name.endsWith(".json")) {
            let text = readFileSync(abs, "utf8");
            for (const host of names) text = text.split(host).join(WORK_REPO);
            writeFileSync(abs, text);
          }
        }
      };
      rewrite(out);
      return {
        exitCode: child.status,
        signal: child.signal,
        timedOut: (child.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT",
        stdout: child.stdout ?? "",
        stderr: child.stderr ?? "",
        durationMs: Date.now() - started,
        dockerArgv: ["docker", "run", "<host test double>"],
        stopped: true
      };
    } finally {
      rmSync(mountPoint, { force: true });
      mkdirSync(mountPoint);
    }
  }) as ContainerExecutor & { calls: ContainerRequest[] };
  executor.calls = calls;
  return executor;
}

function probeOpts(w: Workspace, fault: string, extra: Partial<ProbeFaultOptions> = {}): ProbeFaultOptions {
  return {
    target_record: w.record,
    fault,
    oracle: w.oracle,
    fixture_bytes: w.fixture,
    tests: ["test/api.test.js"],
    witness_bytes: w.witness,
    ...extra
  };
}

let runCounter = 0;
function probe(w: Workspace, fault: string, extra: Partial<ProbeFaultOptions> = {}, executor: ContainerExecutor = hostExecutor(), more: { stageDeadlineMs?: number; dynamicProofRunner?: DynamicProofRunner } = {}): ProbeFaultResult {
  runCounter += 1;
  return opProbeFault(w.repo, probeOpts(w, fault, extra), { clock: deps.clock, container: executor, runId: () => `run_test_${runCounter}`, ...more });
}

function readRun(w: Workspace, result: ProbeFaultResult, rel: string): any {
  return JSON.parse(readFileSync(path.join(w.repo, result.run_dir, rel), "utf8"));
}

function trackedChanges(repo: string): string {
  return git(repo, "status", "--porcelain", "--untracked-files=no");
}

// ── the fault planner ────────────────────────────────────────────────────────────

describe("planFault — one exact fault inside the recorded body", () => {
  const bytes = Buffer.from(API_AFTER);
  const described = describeTarget(bytes, "api.seconds");
  if (!described.ok) throw new Error("fixture error");
  const target = described.target;

  it("plans Math.floor → Math.ceil at its exact position: one line changes, both hashes are recorded and the result parses", () => {
    const planned = planFault(bytes, target, "lib/api.js", "rounding_floor_ceil", OFFSETS.floorInSeconds);
    expect(planned.ok).toBe(true);
    if (!planned.ok) return;
    const plan = planned.plan;
    expect(plan.site.bytes).toEqual({ start: OFFSETS.floorInSeconds, end: OFFSETS.floorInSeconds + "Math.floor".length });
    expect(plan.original_text).toBe("Math.floor");
    expect(plan.replacement_text).toBe("Math.ceil");
    expect(plan.parses).toBe(true);
    expect(plan.mutated.toString()).toBe(API_AFTER.replace("Math.floor(value", "Math.ceil(value"));
    expect(plan.mutated_file_sha256).toBe(sha256(plan.mutated));
    expect(plan.diff.split("\n").filter((line) => /^[-+](?![-+])/.test(line))).toEqual(["-    return Math.floor(value / 1000);", "+    return Math.ceil(value / 1000);"]);
    expect(plan.diff.startsWith("diff --git a/lib/api.js b/lib/api.js\n")).toBe(true);
  });

  it("produces a diagnostic patch that git applies to the original file", () => {
    const planned = planFault(bytes, target, "lib/api.js", "rounding_floor_ceil", OFFSETS.floorInSeconds);
    if (!planned.ok) throw new Error("fixture error");
    const dir = tempDir("patch");
    writeFiles(dir, { "lib/api.js": API_AFTER, "fault.patch": planned.plan.diff });
    git(dir, "init", "-q");
    git(dir, "apply", "--check", "fault.patch");
    git(dir, "apply", "fault.patch");
    expect(readFileSync(path.join(dir, "lib/api.js"))).toEqual(planned.plan.mutated);
  });

  it("removes the ! of a unary negation and nothing else", () => {
    const planned = planFault(bytes, target, "lib/api.js", "negation_removal", OFFSETS.bangInSeconds);
    expect(planned.ok && planned.plan.mutated.toString()).toBe(API_AFTER.replace("!isNaN", "isNaN"));
  });

  it("gives the same fault record twice: the record holds no time, run id or path outside the repository", () => {
    const record = () => {
      const planned = planFault(bytes, target, "lib/api.js", "rounding_floor_ceil", OFFSETS.floorInSeconds);
      if (!planned.ok) throw new Error("fixture error");
      return recordBytes(
        faultRecordOf(planned.plan, {
          target_record_sha256: "a".repeat(64),
          oracle_sha256: "b".repeat(64),
          symbol_id: "sym:lib/api.js#api.seconds",
          file: "lib/api.js",
          file_sha256: target.file_sha256,
          function_sha256: target.function_sha256,
          rationale: "r"
        })
      );
    };
    expect(record().equals(record())).toBe(true);
  });

  it.each([
    ["one byte early", "rounding_floor_ceil", OFFSETS.floorInSeconds - 1, "edit_mismatch"],
    ["one byte late", "rounding_floor_ceil", OFFSETS.floorInSeconds + 1, "edit_mismatch"],
    ["the same text in another function", "rounding_floor_ceil", OFFSETS.floorInLabel, "edit_outside_body"],
    ["the same text in a comment", "rounding_floor_ceil", OFFSETS.floorInComment, "edit_mismatch"],
    ["the same text in a string", "rounding_floor_ceil", OFFSETS.floorInString, "edit_mismatch"],
    ["the ! of an inequality", "negation_removal", OFFSETS.bangInEquality, "edit_mismatch"],
    ["a ! the operator does not point at", "negation_removal", OFFSETS.floorInSeconds, "edit_mismatch"]
  ] as const)("refuses %s", (_label, operator, offset, refused) => {
    const planned = planFault(bytes, target, "lib/api.js", operator, offset);
    expect(planned.ok).toBe(false);
    if (!planned.ok) expect(planned.refused).toBe(refused);
  });

  it("refuses a file that is not the file the target was described from", () => {
    const stale = Buffer.from(API_AFTER.replace("1000", "1001"));
    const planned = planFault(stale, target, "lib/api.js", "rounding_floor_ceil", OFFSETS.floorInSeconds);
    expect(!planned.ok && planned.refused).toBe("edit_mismatch");
  });

  it("accepts only the operators in the closed table", () => {
    expect(parseFaultSpec(`rounding_floor_ceil@${OFFSETS.floorInSeconds}`)).toEqual({ operator: "rounding_floor_ceil", offset: OFFSETS.floorInSeconds });
    expect(parseFaultSpec("negation_removal@12")).toEqual({ operator: "negation_removal", offset: 12 });
    for (const bad of ["return_null@12", "rounding_floor_ceil", "rounding_floor_ceil@-1", "rounding_floor_ceil@1e3", "@12"]) expect(parseFaultSpec(bad)).toBeNull();
  });
});

// ── the proof script: prepared copies, exact edits, refusals ─────────────────────

function spike(args: string[]): { status: number | null; json: any } {
  const child = spawnSync(process.execPath, [script, ...args, "--json"], { encoding: "utf8" });
  return { status: child.status, json: child.stdout.trim() ? JSON.parse(child.stdout) : null };
}

function boundArgsFor(repo: string): { args: string[]; edit: (offset: number, length: number, replacement: string) => string[] } {
  const bytes = readFileSync(path.join(repo, "lib/api.js"));
  const described = describeTarget(bytes, "api.seconds");
  if (!described.ok || !described.target.body) throw new Error("fixture error");
  const t = described.target;
  return {
    args: [
      "--root",
      repo,
      "--target",
      "lib/api.js",
      "--method",
      "seconds",
      "--bound-file-sha256",
      t.file_sha256,
      "--bound-statement-start",
      String(t.statement.bytes.start),
      "--bound-function-start",
      String(t.function.bytes.start),
      "--bound-body-start",
      String(t.body!.bytes.start),
      "--bound-body-end",
      String(t.body!.bytes.end),
      "--bound-target",
      "api.seconds"
    ],
    edit: (offset, length, replacement) => [
      "--bound-edit-start",
      String(offset),
      "--bound-edit-end",
      String(offset + length),
      "--bound-edit-expect-sha256",
      sha256(bytes.subarray(offset, offset + length)),
      "--bound-edit-replacement",
      replacement
    ]
  };
}

describe("proof script — --prepare and exact edits", { timeout: 60_000 }, () => {
  const repo = tempDir("spike");
  writeFiles(repo, { "package.json": "{}", "lib/api.js": API_AFTER, "test/api.test.js": PASSING_TESTS });
  git(repo, "init", "-q");
  commitAll(repo, "snapshot");
  // Untracked: never part of the snapshot.
  writeFiles(repo, { ".env.provider.local": "ANTHROPIC_API_KEY=sentinel-not-a-key\n" });
  const { args, edit } = boundArgsFor(repo);

  it("prepares an original and a mutated copy side by side, changes only the edit span, and leaves the checkout alone", () => {
    const parent = tempDir("prepare");
    const run = spike([...args, ...edit(OFFSETS.floorInSeconds, 10, "Math.ceil"), "--prepare", parent]);
    expect(run.status).toBe(0);
    expect(run.json.status).toBe("prepared");
    expect(run.json.bound.changedBytes).toEqual({ start: OFFSETS.floorInSeconds, end: OFFSETS.floorInSeconds + 10 });
    const original = readFileSync(path.join(run.json.copies.original.root, "lib/api.js"), "utf8");
    const mutant = readFileSync(path.join(run.json.copies.mutant.root, "lib/api.js"), "utf8");
    expect(original).toBe(API_AFTER);
    expect(mutant).toBe(API_AFTER.replace("Math.floor(value", "Math.ceil(value"));
    expect(run.json.bound.mutatedSha256).toBe(sha256(mutant));
    expect(readFileSync(path.join(repo, "lib/api.js"), "utf8")).toBe(API_AFTER);
    expect(existsSync(path.join(run.json.copies.mutant.root, "node_modules"))).toBe(false);
    // The copies are the commit's files: an untracked secret file never reaches them.
    expect(existsSync(path.join(run.json.copies.original.root, ".env.provider.local"))).toBe(false);
    expect(readdirSync(run.json.copies.original.root).sort()).toEqual(["lib", "package.json", "test"]);
  });

  it.each([
    ["an edit outside the body", () => edit(OFFSETS.floorInLabel, 10, "Math.ceil"), "edit_outside_body"],
    ["an edit whose bytes are not the planned bytes", () => [...edit(OFFSETS.floorInSeconds, 10, "Math.ceil").slice(0, 5), "0".repeat(64), "--bound-edit-replacement", "Math.ceil"], "edit_mismatch"],
    ["a replacement outside the token table", () => edit(OFFSETS.floorInSeconds, 10, "Math.round"), "operator_not_allowed"],
    ["the ! of an inequality", () => edit(OFFSETS.bangInEquality, 1, ""), "edit_outside_body"]
  ] as const)("refuses %s, by name", (_label, editArgs, code) => {
    const parent = tempDir("prepare");
    const run = spike([...args, ...editArgs(), "--prepare", parent]);
    expect(run.status).toBe(2);
    expect(run.json).toMatchObject({ status: "refused", refusal: code });
  });

  it("refuses a non-empty --prepare folder and a --prepare inside the source root", () => {
    const busy = tempDir("prepare");
    writeFileSync(path.join(busy, "x"), "x");
    expect(spike([...args, ...edit(OFFSETS.floorInSeconds, 10, "Math.ceil"), "--prepare", busy]).json.refusal).toBe("invalid_binding");
    const inside = path.join(repo, "copies");
    mkdirSync(inside, { recursive: true });
    expect(spike([...args, ...edit(OFFSETS.floorInSeconds, 10, "Math.ceil"), "--prepare", inside]).json.refusal).toBe("write_outside_copy");
    rmSync(inside, { recursive: true, force: true });
  });

  it("refuses an exact edit or --prepare without the binding: the name search has neither", () => {
    const run = spike(["--root", repo, "--target", "lib/api.js", "--method", "seconds", "--replacement", "return 1;", "--prepare", tempDir("prepare")]);
    expect(run.json.refusal).toBe("preview_requires_bound");
  });
});

describe("proof script — a run in which no test executed is never a survivor", { timeout: 60_000 }, () => {
  it("classifies a Mocha file whose tests are all skipped as unrunnable, not associated_survived", () => {
    const repo = tempDir("zero");
    writeFiles(repo, {
      "package.json": JSON.stringify({ name: "zero", devDependencies: { mocha: "*" } }),
      "lib/api.js": API_AFTER,
      "test/api.test.js": "describe('api', function () { it.skip('is not run', function () {}); });\n"
    });
    const { args } = boundArgsFor(repo);
    const run = spike([...args, "--test", "test/api.test.js", "--replacement", "return 7;", "--runner", "mocha", "--mocha-bin", require.resolve("mocha/bin/mocha.js")]);
    expect(run.json.status).toBe("unrunnable");
    expect(run.json.reason).toBe("no test executed");
  });
});

// ── records, the container shape and the boundary check ─────────────────────────

describe("records and the boundary", () => {
  it("checks an oracle strictly: unknown fields, a missing approval and an assisted flag without disclosure are refused", () => {
    const w = { target_record_sha256: "a".repeat(64) };
    const good = {
      version: "orangepro.oracle.v1",
      ...w,
      symbol_id: "sym:a.js#a.b",
      behavior: "b",
      entry_point: "e",
      inputs: "i",
      expected: "x",
      excluded_inputs: "none",
      why_observable: "w",
      basis: [{ kind: "spec", ref: "RFC 1", note: "n" }],
      witness: { file: "witness.cjs", sha256: "c".repeat(64), input: "i" },
      assisted: { flag: true, visible_before: ["a memo"] },
      approval: { status: "approved", by: "a", at: "2026-10-21", where: "here" }
    };
    expect(checkOracle(good).ok).toBe(true);
    expect(checkOracle({ ...good, extra: 1 }).ok).toBe(false);
    expect(checkOracle({ ...good, approval: { status: "approved" } }).ok).toBe(false);
    expect(checkOracle({ ...good, assisted: { flag: true, visible_before: [] } }).ok).toBe(false);
    expect(checkOracle({ ...good, version: "orangepro.oracle.v2" }).ok).toBe(false);
  });

  it("takes only the repository's own run options from the fixture, replaces its reporter and keeps folder operands for the whole suite", () => {
    expect(mochaPlanOf(["mocha", "--require", "test/support/env", "--reporter", "spec", "--check-leaks", "test/", "test/acceptance/"])).toEqual({
      options: ["--require", "test/support/env", "--check-leaks"],
      operands: ["test/", "test/acceptance/"]
    });
    for (const bad of [
      ["mocha", "--require", "/etc/evil"],
      ["mocha", "--require", "../outside"],
      ["mocha", "--loader", "x"],
      ["mocha", "--grep", "x"],
      ["jest", "test/"],
      ["mocha", "../elsewhere/"]
    ]) {
      expect(() => mochaPlanOf(bad)).toThrow(ProbeFaultRefusal);
    }
  });

  it("builds V1's test shape: no network, read-only root and copies, no capabilities, uid 1000, the image pinned and never pulled", () => {
    const request: ContainerRequest = {
      shape: { image: `node@sha256:${"1".repeat(64)}`, platform: "linux/arm64", memory: "4g", cpus: "4", processes: 512, deadlineSeconds: 900 },
      mounts: [
        { source: "/host/copy", target: WORK_REPO, readonly: true, role: "<original>" },
        { source: "/host/out", target: WORK_OUT, readonly: false, role: "<out>" }
      ],
      env: { EXTRA: "1" },
      workdir: WORK_REPO,
      command: ["node", "x.js"],
      deadlineMs: 1000
    };
    const args = dockerRunArgs("n", request);
    const joined = args.join(" ");
    for (const part of ["--network none", "--read-only", "--cap-drop ALL", "--security-opt no-new-privileges", "--user 1000:1000", "--pull never", "--memory 4g --memory-swap 4g", "--pids-limit 512"]) {
      expect(joined).toContain(part);
    }
    expect(args).toContain(`type=bind,src=/host/copy,dst=${WORK_REPO},readonly`);
    expect(args).toContain(`type=bind,src=/host/out,dst=${WORK_OUT}`);
    expect(args.slice(-3)).toEqual([request.shape.image, "node", "x.js"]);
    expect(dockerRunArgs("n", request, true).join(" ")).not.toContain("/host/");
  });

  it("names every broken promise of the boundary", () => {
    const request: ContainerRequest = {
      shape: { image: "i", platform: "p", memory: "1g", cpus: "1", processes: 64, deadlineSeconds: 10 },
      mounts: [
        { source: "/a", target: WORK_REPO, readonly: true, role: "<original>" },
        { source: "/b", target: WORK_OUT, readonly: false, role: "<out>" }
      ],
      env: {},
      workdir: WORK_REPO,
      command: [],
      deadlineMs: 1
    };
    expect(boundaryFailures(passingProbe(request), request)).toEqual([]);
    const leaky = {
      ...passingProbe(request),
      network_reachable: true,
      writable: { [WORK_REPO]: true, [WORK_OUT]: true },
      host_backed_mounts: [WORK_OUT, WORK_REPO, "/Users/someone"],
      env_names: ["PATH", "GITHUB_TOKEN"]
    };
    const failures = boundaryFailures(leaky, request).join("\n");
    for (const part of ["network is reachable", `${WORK_REPO} is writable`, "host-backed mounts", "secret-looking variables are visible: GITHUB_TOKEN"]) expect(failures).toContain(part);
    expect(boundaryFailures(null, request)).toEqual(["the probe printed no report"]);
  });

  it("reports a docker that cannot be started instead of passing it", () => {
    const run = dockerExecutor(path.join(tempDir("nodocker"), "docker"))({
      shape: { image: "i", platform: "p", memory: "1g", cpus: "1", processes: 64, deadlineSeconds: 10 },
      mounts: [],
      env: {},
      workdir: WORK_REPO,
      command: ["node", "-v"],
      deadlineMs: 5000
    });
    expect(run.exitCode).toBeNull();
    expect(run.stderr).toContain("could not be started");
    expect(dockerExecutor(null)({ shape: { image: "i", platform: "p", memory: "1g", cpus: "1", processes: 64, deadlineSeconds: 10 }, mounts: [], env: {}, workdir: WORK_REPO, command: [], deadlineMs: 10 }).stderr).toContain("not found on a trusted PATH");
  });

  it("verifies a run folder only through its manifest: missing, altered or extra files fail", () => {
    const dir = tempDir("manifest");
    writeFiles(dir, { "a.json": "{}\n", "stages/b.json": "[]\n" });
    expect(verifyRunFolder(dir).ok).toBe(false);
    writeRunManifest(dir, "run_x", "0.0.0");
    expect(verifyRunFolder(dir).ok).toBe(true);
    expect(() => writeRunManifest(dir, "run_x", "0.0.0")).toThrow(/already exists/);
    writeFileSync(path.join(dir, "a.json"), "{ }\n");
    expect(verifyRunFolder(dir)).toMatchObject({ ok: false });
    writeFileSync(path.join(dir, "a.json"), "{}\n");
    writeFileSync(path.join(dir, "c.json"), "{}\n");
    expect(verifyRunFolder(dir)).toMatchObject({ ok: false });
  });

  it("canonical JSON sorts keys and drops undefined members", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: undefined, c: 3 }] })).toBe('{"a":[2,{"c":3}],"b":1}');
  });

  it("reads 'at an assertion' by the pre-registered rule, not by error class alone", () => {
    const testFile = "test/api.test.js";
    expect(failedAtAssertion({ name: "AssertionError", stack: "AssertionError: x" }, testFile)).toBe(true);
    expect(failedAtAssertion({ name: "Error", expected: 1, actual: 2 }, testFile)).toBe(true);
    // supertest restarts its stack at the .expect(…) call in the test file
    expect(failedAtAssertion({ name: "Error", stack: "Error: expected 200\n    at Context.<anonymous> (test/api.test.js:9:8)\n----" }, testFile)).toBe(true);
    expect(failedAtAssertion({ name: "TypeError", stack: "TypeError: x\n    at Context.<anonymous> (test/api.test.js:9:8)" }, testFile)).toBe(false);
    expect(failedAtAssertion({ name: "Error", stack: "Error: x\n    at seconds (lib/api.js:3:9)" }, testFile)).toBe(false);
  });
});

// ── the operation, end to end through the host stand-in ─────────────────────────

describe("opProbeFault — what a run concludes, and when it makes no claim", { timeout: 120_000 }, () => {
  it("a valid fault the selected tests miss: survived, with the selected scope, a witness difference and the fault line reached", () => {
    const w = workspace();
    const result = probe(w, `rounding_floor_ceil@${OFFSETS.floorInSeconds}`);
    expect(result.classification).toMatchObject({ classification: "survived_unverified", scope: "selected", reason: null, reached_by_selected_tests: "reached" });
    expect(result.classification.behavioral_difference).toMatchObject({ status: "differs", original: { seconds: 1 }, fault: { seconds: 2 } });
    expect(result.classification.statement).toContain("in api.seconds, which PR #7 changed");
    expect(result.classification.statement).toContain("the selected tests missed it");
    expect(result.classification.statement).not.toMatch(/caused/i);
    expect(verifyRunFolder(path.join(w.repo, result.run_dir)).ok).toBe(true);
    expect(trackedChanges(w.repo)).toBe("");
    const original = readRun(w, result, "stages/original_selected.json");
    expect(original.tests).toMatchObject({ executed: 2, passed: 2, failed: 0, pending: 0, hook_failures: 0 });
    expect(original.copy_target_sha256).toBe(w.record.identity.file_sha256);
    expect(readRun(w, result, "stages/fault_selected.json").copy_target_sha256).toBe(result.fault_record.mutated_file_sha256);
  });

  it("widens the claim to the whole suite only when the whole suite ran on both copies", () => {
    const w = workspace();
    const result = probe(w, `rounding_floor_ceil@${OFFSETS.floorInSeconds}`, { full_suite: true });
    expect(result.classification).toMatchObject({ classification: "survived_unverified", scope: "full_suite" });
    expect(result.classification.statement).toContain("The whole existing suite (2 tests)");
  });

  it("a fault the selected tests catch at an assertion: caught_by_existing, naming the tests", () => {
    const w = workspace();
    const result = probe(w, `negation_removal@${OFFSETS.bangInSeconds}`);
    expect(result.classification.classification).toBe("caught_by_existing");
    expect(result.classification.caught_by.map((test) => [test.full_title, test.at_assertion])).toEqual([
      ["api.seconds converts whole seconds", true],
      ["api.seconds returns null for a value that is not a number", true]
    ]);
  });

  it.each([
    ["no test executed", { "test/api.test.js": "describe('api', function () {});\n" }, "inconclusive", "no_tests_executed", "rounding_floor_ceil"],
    ["a selected test skipped", { "test/api.test.js": PASSING_TESTS.replace("it('returns null", "it.skip('returns null") }, "inconclusive", "selected_test_pending", "rounding_floor_ceil"],
    ["a failing before hook", { "test/api.test.js": PASSING_TESTS.replace("describe('api.seconds', function () {", "describe('api.seconds', function () {\n  before(function () { throw new Error('setup broke'); });") }, "inconclusive", "original_hook_failure", "rounding_floor_ceil"],
    ["a red original", { "test/api.test.js": PASSING_TESTS.replace("api.seconds(2000), 2", "api.seconds(2000), 3") }, "blocked", "red_baseline", "rounding_floor_ceil"],
    [
      "a test set that depends on the code",
      { "test/api.test.js": "var api = require('../lib/api');\ndescribe('api', function () {\n  it(api.seconds(1500) === 1 ? 'is one' : 'is not one', function () {});\n});\n" },
      "inconclusive",
      "test_set_differs",
      "rounding_floor_ceil"
    ],
    [
      "a TypeError thrown in the test file on the fault",
      { "test/api.test.js": "var assert = require('assert');\nvar api = require('../lib/api');\ndescribe('api', function () {\n  it('formats', function () {\n    assert.strictEqual(api.seconds(2000).toFixed(0), '2');\n  });\n});\n" },
      "inconclusive",
      "failed_off_assertion",
      "negation_removal"
    ]
  ] as const)("%s → %s (%s), never survived", (_label, tests, classification, reason, operator) => {
    const w = workspace(tests);
    const offset = operator === "negation_removal" ? OFFSETS.bangInSeconds : OFFSETS.floorInSeconds;
    const result = probe(w, `${operator}@${offset}`);
    expect(result.classification).toMatchObject({ classification, reason });
    expect(verifyRunFolder(path.join(w.repo, result.run_dir)).ok).toBe(true);
  });

  it("equal witness outputs: no behavioral difference shown, so no claim", () => {
    const w = workspace(undefined, { witness: "var api = require(process.cwd() + '/lib/api');\nprocess.stdout.write(JSON.stringify({ seconds: api.seconds(2000) }) + '\\n');\n" });
    const result = probe(w, `rounding_floor_ceil@${OFFSETS.floorInSeconds}`);
    expect(result.classification).toMatchObject({ classification: "inconclusive", reason: "no_behavioral_difference" });
    expect(result.classification.behavioral_difference.status).toBe("same");
  });

  it("a stage past its deadline is a timeout, never a result", () => {
    const w = workspace(
      { "test/api.test.js": "describe('api', function () {\n  it('waits', function (done) { setTimeout(done, 20000); });\n});\n" },
      { mochaArgs: ["mocha", "--timeout", "60000", "test/"] }
    );
    const result = probe(w, `rounding_floor_ceil@${OFFSETS.floorInSeconds}`, {}, hostExecutor(), { stageDeadlineMs: 2_000 });
    expect(result.classification).toMatchObject({ classification: "inconclusive", reason: "original_timeout" });
    expect(readRun(w, result, "stages/original_selected.json").timed_out).toBe(true);
  });

  it("a boundary that does not hold blocks the run before any of the project's code runs", () => {
    const w = workspace();
    const executor = hostExecutor((request) => ({ ...passingProbe(request), network_reachable: true }));
    const result = probe(w, `rounding_floor_ceil@${OFFSETS.floorInSeconds}`, {}, executor);
    expect(result.classification).toMatchObject({ classification: "blocked", reason: "boundary_check_failed" });
    expect(executor.calls.every((request) => request.command[1] === "-e")).toBe(true);
  });

  it("a runner that reports other changed bytes than planned is not credited", () => {
    const w = workspace();
    const lying: DynamicProofRunner = (args) => {
      const real = spawnSync(process.execPath, [script, ...args], { encoding: "utf8" });
      const json = JSON.parse(real.stdout);
      json.bound.changedBytes = { start: json.bound.changedBytes.start, end: json.bound.changedBytes.end + 1 };
      return { stdout: JSON.stringify(json), stderr: "", exitCode: 0 };
    };
    expect(() => probe(w, `rounding_floor_ceil@${OFFSETS.floorInSeconds}`, {}, hostExecutor(), { dynamicProofRunner: lying })).toThrow(ProofRefusalError);
    expect(trackedChanges(w.repo)).toBe("");
  });

  it.each([
    ["an oracle for another record", (w: Workspace) => ({ oracle: { ...w.oracle, target_record_sha256: "f".repeat(64) } }), "oracle_mismatch"],
    ["a witness the oracle does not name", () => ({ witness_bytes: Buffer.from("console.log(1)\n") }), "witness_mismatch"],
    ["a fixture frozen at another commit", (w: Workspace) => ({ fixture_bytes: Buffer.from(w.fixture.toString().replace(w.record.identity.merged_commit, "e".repeat(40))) }), "fixture_mismatch"],
    ["a fixture with a disallowed Mocha option", (w: Workspace) => ({ fixture_bytes: Buffer.from(w.fixture.toString().replace('"--check-leaks"', '"--loader","x"')) }), "profile_option_not_allowed"],
    ["a selected test that is the target file", () => ({ tests: ["lib/api.js"] }), "tests_invalid"],
    ["a selected test outside the source root", () => ({ tests: ["../outside.js"] }), "tests_invalid"]
  ] as const)("refuses %s before any copy is made", (_label, change, code) => {
    const w = workspace();
    const before = readdirSync(path.join(w.repo, ".orangepro"));
    let error: unknown;
    try {
      probe(w, `rounding_floor_ceil@${OFFSETS.floorInSeconds}`, change(w));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(ProbeFaultRefusal);
    expect((error as ProbeFaultRefusal).code).toBe(code);
    expect(readdirSync(path.join(w.repo, ".orangepro"))).toEqual(before);
  });

  it("a docker that cannot start blocks the run: the boundary check is never assumed", () => {
    const w = workspace();
    const result = probe(w, `rounding_floor_ceil@${OFFSETS.floorInSeconds}`, {}, dockerExecutor(path.join(tempDir("nodocker"), "docker")));
    expect(result.classification).toMatchObject({ classification: "blocked", reason: "boundary_check_failed" });
  });

  it("a fault that does not parse, or fails Node's syntax check, is an invalid mutation, never a result about the tests", () => {
    const w = workspace();
    const result = probe(w, `rounding_floor_ceil@${OFFSETS.floorInSeconds}`);
    const stages = Object.fromEntries(result.classification.stages.map((ref) => [ref.stage, readRun(w, result, ref.path)]));
    const base = { stages, parses: true, full_suite_requested: false, checkout_unchanged: true, selected_files: ["test/api.test.js"], baseline_passing: 2 };
    expect(classifyFaultRun({ ...base, parses: false })).toMatchObject({ classification: "invalid_mutation", reason: "does_not_parse" });
    const badSyntax = { ...stages, fault_syntax: { ...stages.fault_syntax, exit_code: 1 } };
    expect(classifyFaultRun({ ...base, stages: badSyntax })).toMatchObject({ classification: "invalid_mutation", reason: "syntax_check_failed" });
    expect(classifyFaultRun({ ...base, checkout_unchanged: false })).toMatchObject({ classification: "blocked", reason: "checkout_modified" });
    const unstopped = { ...stages, witness_fault: { ...stages.witness_fault, stopped: false } };
    expect(classifyFaultRun({ ...base, stages: unstopped })).toMatchObject({ classification: "blocked", reason: "container_not_stopped" });
  });

  it("refuses a checkout with no installed Mocha", () => {
    const w = workspace();
    rmSync(path.join(w.repo, "node_modules"), { recursive: true, force: true });
    expect(() => probe(w, `rounding_floor_ceil@${OFFSETS.floorInSeconds}`)).toThrow(/not_installed/);
  });

  it("refuses a fault outside the target's body, by name, before any copy is made", () => {
    const w = workspace();
    expect(() => probe(w, `rounding_floor_ceil@${OFFSETS.floorInLabel}`)).toThrow(/edit_outside_body/);
    expect(existsSync(path.join(w.repo, ".orangepro", "proof-runs"))).toBe(false);
  });
});

// ── what the independent review found (21 Oct), one test each ────────────────────

const NEGATION = `negation_removal@${OFFSETS.bangInSeconds}`;
const ROUNDING = `rounding_floor_ceil@${OFFSETS.floorInSeconds}`;

describe("review findings — no result the runs did not earn", { timeout: 120_000 }, () => {
  it("ignores the repository's own Mocha config: a .mocharc cannot add files to the selection or switch on dry-run", () => {
    const w = workspace({
      "test/api.test.js": PASSING_TESTS,
      "test/other.test.js": "describe('other', function () { it('runs only when not selected', function () {}); });\n",
      ".mocharc.json": JSON.stringify({ spec: ["test/other.test.js"], "dry-run": true })
    });
    const result = probe(w, NEGATION);
    expect(result.classification.classification).toBe("caught_by_existing");
    const original = readRun(w, result, "stages/original_selected.json");
    expect(new Set(original.tests.observed.map((test: { file: string }) => test.file))).toEqual(new Set(["test/api.test.js"]));
  });

  it("two tests with the same full name cannot be told apart: no claim", () => {
    const w = workspace({ "test/api.test.js": PASSING_TESTS.replace("returns null for a value that is not a number", "converts whole seconds") });
    expect(probe(w, ROUNDING).classification).toMatchObject({ classification: "inconclusive", reason: "duplicate_test_titles" });
  });

  it("a failure off an assertion beside one at an assertion makes the catch suspect: no claim", () => {
    const tests = `var assert = require('assert');
var api = require('../lib/api');
describe('api', function () {
  it('converts whole seconds', function () { assert.strictEqual(api.seconds(2000), 2); });
  it('formats', function () { assert.strictEqual(api.seconds(2000).toFixed(0), '2'); });
});
`;
    expect(probe(workspace({ "test/api.test.js": tests }), NEGATION).classification).toMatchObject({ classification: "inconclusive", reason: "failed_off_assertion" });
  });

  it("a witness that does not answer on the faulty copy shows nothing about the fault", () => {
    const witness = "var api = require(process.cwd() + '/lib/api');\nvar r = api.seconds(1500);\nif (r === 2) process.exit(3);\nprocess.stdout.write(JSON.stringify({ seconds: r }) + '\\n');\n";
    expect(probe(workspace(undefined, { witness }), ROUNDING).classification).toMatchObject({ classification: "inconclusive", reason: "witness_failed_on_fault" });
  });

  it("a witness that answers differently twice on the original is not evidence", () => {
    const witness = "var api = require(process.cwd() + '/lib/api');\nprocess.stdout.write(JSON.stringify({ seconds: api.seconds(1500), at: process.hrtime.bigint().toString() }) + '\\n');\n";
    expect(probe(workspace(undefined, { witness }), ROUNDING).classification).toMatchObject({ classification: "inconclusive", reason: "witness_not_deterministic" });
  });

  it("a test whose title starts with 'after' is a test, not a hook: its catch counts", () => {
    const w = workspace({ "test/api.test.js": PASSING_TESTS.replace("converts whole seconds", "after rounding, converts whole seconds") });
    const result = probe(w, NEGATION);
    expect(result.classification.classification).toBe("caught_by_existing");
    expect(result.classification.caught_by.map((test) => test.full_title)).toContain("api.seconds after rounding, converts whole seconds");
  });

  it("a selected file that runs no test is named, and the run makes no claim", () => {
    const w = workspace({ "test/api.test.js": PASSING_TESTS, "test/helpers.js": "module.exports = {};\n" });
    expect(probe(w, ROUNDING, { tests: ["test/api.test.js", "test/helpers.js"] }).classification).toMatchObject({ classification: "inconclusive", reason: "selected_file_not_run" });
  });

  it("refuses a selected test file that is a symbolic link: the copy would not hold it", () => {
    const w = workspace({ "test/api.test.js": PASSING_TESTS, "shared/strong.js": PASSING_TESTS.replace("'../lib/api'", "'../lib/api'") });
    symlinkSync(path.join(w.repo, "shared/strong.js"), path.join(w.repo, "test/strong.test.js"));
    expect(() => probe(w, ROUNDING, { tests: ["test/api.test.js", "test/strong.test.js"] })).toThrow(/tests_invalid/);
  });

  it("widens to the whole suite only when its count matches the fixture's baseline", () => {
    const w = workspace();
    const fixture = Buffer.from(w.fixture.toString().replace('"passing":2', '"passing":3'));
    const result = probe(w, ROUNDING, { full_suite: true, fixture_bytes: fixture });
    expect(result.classification).toMatchObject({ classification: "survived_unverified", scope: "selected", reason: "full_suite_count_differs" });
    const noBaseline = Buffer.from(w.fixture.toString().replace(',"baseline":{"passing":2}', ""));
    expect(() => probe(w, ROUNDING, { full_suite: true, fixture_bytes: noBaseline })).toThrow(/baseline\.passing/);
  });

  it("names records by the hash of the file they are stored as, the same hash MANIFEST.json gives", () => {
    const w = workspace();
    const result = probe(w, ROUNDING);
    const dir = path.join(w.repo, result.run_dir);
    expect(sha256(readFileSync(path.join(dir, "fault-record.json")))).toBe(result.classification.fault_record_sha256);
    const stage = readRun(w, result, "stages/original_selected.json");
    expect(sha256(readFileSync(path.join(dir, "run-profile.json")))).toBe(stage.run_profile_sha256);
    expect(sha256(readFileSync(path.join(dir, "target-record.json")))).toBe(w.oracle.target_record_sha256);
  });
});

describe("review findings — the boundary and what the host reads back", { timeout: 120_000 }, () => {
  it("never follows a link the container leaves in its output folder", () => {
    const w = workspace();
    const secret = path.join(tempDir("host-secret"), "secret.txt");
    writeFileSync(secret, "HOST-ONLY-SENTINEL\n");
    const inner = hostExecutor();
    const linking: ContainerExecutor = (request) => {
      const result = inner(request);
      const out = request.mounts.find((mount) => mount.target === WORK_OUT)!.source;
      if (request.command[1] !== "-e" && request.env.OPRO_DYNAMIC_PROOF_REPORT) {
        rmSync(path.join(out, "report.json"), { force: true });
        symlinkSync(secret, path.join(out, "report.json"));
      }
      return result;
    };
    const result = probe(w, ROUNDING, {}, linking);
    expect(result.classification).toMatchObject({ classification: "inconclusive", reason: "original_runner_error" });
    const stage = readRun(w, result, "stages/original_selected.json");
    expect(stage.output_problems).toEqual(["report.json was not read: a symbolic link"]);
    const files = readdirSync(path.join(w.repo, result.run_dir), { recursive: true }) as string[];
    for (const file of files) {
      const abs = path.join(w.repo, result.run_dir, file);
      if (statSync(abs).isFile()) expect(readFileSync(abs, "utf8")).not.toContain("HOST-ONLY-SENTINEL");
    }
  });

  it("a coverage file that is not JSON is named; the run still finishes with a result and a manifest", () => {
    const w = workspace();
    const inner = hostExecutor();
    const truncating: ContainerExecutor = (request) => {
      const result = inner(request);
      if (request.env.NODE_V8_COVERAGE) {
        const dir = path.join(request.mounts.find((mount) => mount.target === WORK_OUT)!.source, "coverage");
        mkdirSync(dir, { recursive: true });
        writeFileSync(path.join(dir, "coverage-999-1-0.json"), '{"result": [');
      }
      return result;
    };
    const result = probe(w, ROUNDING, {}, truncating);
    expect(result.classification).toMatchObject({ classification: "survived_unverified", reached_by_selected_tests: "unknown" });
    expect(readRun(w, result, "stages/original_selected.json").output_problems).toEqual(["coverage/coverage-999-1-0.json is not valid JSON"]);
    expect(verifyRunFolder(path.join(w.repo, result.run_dir)).ok).toBe(true);
  });

  it("runs the boundary probe before every stage, in that stage's own shape", () => {
    const w = workspace();
    const executor = hostExecutor();
    const result = probe(w, ROUNDING, { full_suite: true }, executor);
    const probes = executor.calls.filter((request) => request.command[1] === "-e").length;
    expect(probes).toBe(result.classification.stages.length);
    for (const ref of result.classification.stages) expect(readRun(w, result, ref.path).boundary.failures).toEqual([]);
  });

  it("an image that does not run the fixture's pinned Node version fails the boundary check", () => {
    const w = workspace();
    const fixture = Buffer.from(w.fixture.toString().replace('"platform":"linux/arm64"', '"platform":"linux/arm64","node":"v22.23.3"'));
    const executor = hostExecutor((request) => ({ ...passingProbe(request), node: "v18.0.0" }));
    expect(probe(w, ROUNDING, { fixture_bytes: fixture }, executor).classification).toMatchObject({ classification: "blocked", reason: "boundary_check_failed" });
  });

  it("refuses an image name docker would read as an option", () => {
    const w = workspace();
    const fixture = Buffer.from(w.fixture.toString().replace(/"image":"[^"]+"/, `"image":"-l@sha256:${"a".repeat(64)}"`));
    expect(() => probe(w, ROUNDING, { fixture_bytes: fixture })).toThrow(/fixture_invalid/);
  });

  it("refuses a node_modules that is a link to somewhere else on this machine", () => {
    const w = workspace();
    const elsewhere = tempDir("elsewhere");
    mkdirSync(path.join(elsewhere, "node_modules"));
    symlinkSync(mochaPackage, path.join(elsewhere, "node_modules", "mocha"), "dir");
    rmSync(path.join(w.repo, "node_modules"), { recursive: true, force: true });
    symlinkSync(path.join(elsewhere, "node_modules"), path.join(w.repo, "node_modules"), "dir");
    expect(() => probe(w, ROUNDING)).toThrow(/not_installed/);
  });

  it("never copies an untracked file of the checkout into the container's view", () => {
    const w = workspace();
    writeFileSync(path.join(w.repo, ".env.provider.local"), "ANTHROPIC_API_KEY=sentinel-not-a-key\n");
    const seen: boolean[] = [];
    const inner = hostExecutor();
    const watching: ContainerExecutor = (request) => {
      seen.push(existsSync(path.join(request.mounts.find((mount) => mount.target === WORK_REPO)!.source, ".env.provider.local")));
      return inner(request);
    };
    probe(w, ROUNDING, {}, watching);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((visible) => !visible)).toBe(true);
  });

  it("finds docker only on a trusted PATH: never in a node_modules folder or a relative entry", () => {
    const base = tempDir("path");
    const bad = path.join(base, "project", "node_modules", ".bin");
    const good = path.join(base, "usr-bin");
    for (const dir of [bad, good]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, "docker"), "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    }
    expect(resolveDocker({ PATH: [bad, "relative/bin", good].join(path.delimiter) })).toBe(path.join(good, "docker"));
    expect(resolveDocker({ PATH: bad })).toBeNull();
    expect(resolveDocker({ PATH: good, ORANGEPRO_DOCKER: "docker" })).toBeNull();
    expect(resolveDocker({ PATH: "", ORANGEPRO_DOCKER: path.join(good, "docker") })).toBe(path.join(good, "docker"));
  });

  it("stops a container that ignores the stop signal at its deadline, and says so when it cannot confirm it", () => {
    const dir = tempDir("fakedocker");
    const fake = path.join(dir, "docker");
    writeFileSync(
      fake,
      `#!${process.execPath}\nconst [cmd] = process.argv.slice(2);\nif (cmd === "run") { process.on("SIGTERM", () => {}); setInterval(() => {}, 1000); }\nelse if (cmd === "inspect") process.exit(Number(process.env.FAKE_INSPECT_STATUS || "1"));\nelse process.exit(0);\n`,
      { mode: 0o755 }
    );
    const request: ContainerRequest = { shape: { image: "i", platform: "p", memory: "1g", cpus: "1", processes: 64, deadlineSeconds: 10 }, mounts: [], env: {}, workdir: WORK_REPO, command: ["node"], deadlineMs: 500 };
    const started = Date.now();
    const gone = dockerExecutor(fake)(request);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(gone).toMatchObject({ timedOut: true, stopped: true });
    process.env.FAKE_INSPECT_STATUS = "0";
    try {
      expect(dockerExecutor(fake)(request)).toMatchObject({ timedOut: true, stopped: false });
    } finally {
      delete process.env.FAKE_INSPECT_STATUS;
    }
  });
});

describe("review findings — exact identity", () => {
  it("refuses removing a ! that would join two statements written without semicolons, or open a comment", () => {
    const source = `var api = module.exports = {}

api.check = function (ms) {
  var value = Number(ms)
  !(value >= 0) && api.odd.push(ms)
  return value /!/a/.test(ms)
}
`;
    const bytes = Buffer.from(source);
    const described = describeTarget(bytes, "api.check");
    if (!described.ok) throw new Error("fixture error");
    for (const at of [source.indexOf("!(value"), source.indexOf("!/a/")]) {
      const planned = planFault(bytes, described.target, "lib/api.js", "negation_removal", at);
      expect(!planned.ok && planned.refused).toBe("not_single_site");
    }
    const withSemicolon = Buffer.from(source.replace("Number(ms)\n", "Number(ms);\n"));
    const again = describeTarget(withSemicolon, "api.check");
    if (!again.ok) throw new Error("fixture error");
    expect(planFault(withSemicolon, again.target, "lib/api.js", "negation_removal", withSemicolon.toString().indexOf("!(value")).ok).toBe(true);
  });

  it("builds the coverage address the way Node does, and tells 'not loaded' from 'coverage did not work'", () => {
    expect(containerFileUrl("my lib/apí.js")).toBe("file:///work/repo/my%20lib/ap%C3%AD.js");
    const bytes = Buffer.from("var a = 1;\n");
    const other = { result: [{ url: "file:///work/repo/other.js", functions: [] }] };
    expect(faultSpanCount([other], containerFileUrl("a.js"), bytes, { start: 0, end: 3 })).toBe(0);
    expect(faultSpanCount([{ result: [] }], containerFileUrl("a.js"), bytes, { start: 0, end: 3 })).toBeNull();
    const loaded = { result: [{ url: containerFileUrl("a.js"), functions: [{ ranges: [{ startOffset: 0, endOffset: 11, count: 1 }] }] }] };
    expect(faultSpanCount([loaded], containerFileUrl("a.js"), bytes, { start: 0, end: 3 })).toBe(1);
  });

  it("refuses an oracle whose witness file name would collide with the run folder's own records", () => {
    const good = JSON.parse(JSON.stringify(workspaceOracleShape()));
    expect(checkOracle(good).ok).toBe(true);
    for (const name of ["oracle.json", "MANIFEST.json", "..", ".", "w.tmp", "stages"]) {
      expect(checkOracle({ ...good, witness: { ...good.witness, file: name } }).ok).toBe(false);
    }
  });
});

function workspaceOracleShape(): Oracle {
  return {
    version: "orangepro.oracle.v1",
    target_record_sha256: "a".repeat(64),
    symbol_id: "sym:a.js#a.b",
    behavior: "b",
    entry_point: "e",
    inputs: "i",
    expected: "x",
    excluded_inputs: "none",
    why_observable: "w",
    basis: [{ kind: "spec", ref: "RFC 1", note: "n" }],
    witness: { file: "witness.cjs", sha256: "c".repeat(64), input: "i" },
    assisted: { flag: false, visible_before: [] },
    approval: { status: "proposed" }
  };
}

describe("review findings — the existing proof route", { timeout: 60_000 }, () => {
  function spikeRepo(tests: string): { repo: string; args: string[] } {
    const repo = tempDir("route");
    writeFiles(repo, { "package.json": JSON.stringify({ name: "route", devDependencies: { mocha: "*" } }), "lib/api.js": API_AFTER, "test/api.test.js": tests });
    return { repo, args: [...boundArgsFor(repo).args, "--test", "test/api.test.js", "--replacement", "return 7;", "--runner", "mocha", "--mocha-bin", require.resolve("mocha/bin/mocha.js")] };
  }

  it("a run that ends before the reporter's last word (process.exit in a hook) is unrunnable, never survived", () => {
    const { args } = spikeRepo(PASSING_TESTS.replace("describe('api.seconds', function () {", "describe('api.seconds', function () {\n  after(function () { process.exit(0); });"));
    const run = spike(args);
    expect(run.json).toMatchObject({ status: "unrunnable", reason: "the test runner left no report" });
  });

  it("a skipped test sharing a passing test's full name makes the name ambiguous: no Proven (the #191 rule, now for Mocha too)", () => {
    const tests = `var assert = require('assert');
var api = require('../lib/api');
describe('seconds', function () {
  describe('when converting', function () { it.skip('works', function () {}); });
});
describe('seconds when', function () {
  it('converting works', function () { assert.strictEqual(api.seconds(2000), 2); });
});
`;
    const { args } = spikeRepo(tests);
    // The skipped twin could run on the mutant and fail; its failure must never be credited to the passing test.
    expect(spike(args).json).toMatchObject({ status: "associated_non_assertion_failure", proven: false });
  });
});
