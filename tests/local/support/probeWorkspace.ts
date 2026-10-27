// Shared by the probe-fault (A2) and verify-test (A3) tests: a small two-commit CommonJS library
// with a real target record, and a stand-in for the container that runs the same commands on this machine.
import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { boundaryFailures, dockerExecutor, dockerRunArgs, resolveDocker, shapeEnvNames, WORK_OUT, WORK_REPO, type ContainerExecutor, type ContainerRequest } from "../../../src/local/boundary.js";
import { opChangedTargets } from "../../../src/local/changedTargets.js";
import { canonicalJson, recordBytes, recordSha256, verifyRunFolder, writeRunManifest } from "../../../src/local/contracts/io.js";
import { checkOracle, type Oracle } from "../../../src/local/contracts/oracle.js";
import { faultRecordOf, parseFaultSpec, planFault } from "../../../src/local/contracts/faultRecord.js";
import { describeTarget, type TargetRecord } from "../../../src/local/contracts/targetRecord.js";
import { classifyFaultRun, containerFileUrl, failedAtAssertion, faultSpanCount, mochaPlanOf, opProbeFault, ProbeFaultRefusal, type ProbeFaultOptions, type ProbeFaultResult } from "../../../src/local/faultProbe.js";
import { opAnalyze, opInit, ProofRefusalError, type DynamicProofRunner } from "../../../src/local/operations.js";

const require = createRequire(import.meta.url);
export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
export const script = path.join(repoRoot, "scripts/spikes/dynamic-proof-spike.mjs");
export const mochaPackage = path.dirname(require.resolve("mocha/package.json"));
export const deps = { clock: () => "2026-10-21T00:00:00Z", env: {} as NodeJS.ProcessEnv };

export const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

export function sha256(bytes: Uint8Array | string): string {
  return createHash("sha256").update(bytes).digest("hex");
}

export function tempDir(label: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), `opro-a2-${label}-`));
  tempDirs.push(dir);
  return dir;
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), content);
  }
}

export function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Sample Author", "-c", "user.email=author@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

export function commitAll(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

// ── a small CommonJS library whose exported-object method a change touched ────────

export const API_BEFORE = `var api = module.exports = {};

api.seconds = function (ms) {
  return Math.floor(ms / 1000);
};
`;

export const API_AFTER = `var api = module.exports = {};

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

export const OFFSETS = {
  floorInSeconds: API_AFTER.indexOf("Math.floor(value"),
  bangInSeconds: API_AFTER.indexOf("!isNaN"),
  floorInLabel: API_AFTER.indexOf("Math.floor(ms)"),
  floorInComment: API_AFTER.indexOf("Math.floor in a comment"),
  floorInString: API_AFTER.indexOf('"Math.floor"') + 1,
  bangInEquality: API_AFTER.indexOf("!= b")
};

export const PASSING_TESTS = `var assert = require('assert');
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

export const WITNESS = `var api = require(process.cwd() + '/lib/api');
process.stdout.write(JSON.stringify({ seconds: api.seconds(1500) }) + '\\n');
`;

export interface Workspace {
  repo: string;
  record: TargetRecord;
  oracle: Oracle;
  witness: Buffer;
  fixture: Buffer;
}

/** A checkout at the merged commit, analyzed, with Mocha "installed" and a real record for api.seconds. */
export function workspace(tests: Record<string, string> = { "test/api.test.js": PASSING_TESTS }, opts: { witness?: string; mochaArgs?: string[]; baselinePassing?: number } = {}): Workspace {
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
      baseline: { passing: opts.baselinePassing ?? 2 },
      allowed_patch_paths: { patterns: ["test/*.js"], never: ["lib/**", "test/support/**"] }
    })
  );
  return { repo, record, oracle, witness, fixture };
}

export function passingProbe(request: ContainerRequest): Record<string, unknown> {
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
export function hostExecutor(probe: (request: ContainerRequest) => unknown = passingProbe): ContainerExecutor & { calls: ContainerRequest[] } {
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

export function probeOpts(w: Workspace, fault: string, extra: Partial<ProbeFaultOptions> = {}): ProbeFaultOptions {
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

export let runCounter = 0;
export function probe(w: Workspace, fault: string, extra: Partial<ProbeFaultOptions> = {}, executor: ContainerExecutor = hostExecutor(), more: { stageDeadlineMs?: number; dynamicProofRunner?: DynamicProofRunner } = {}): ProbeFaultResult {
  runCounter += 1;
  return opProbeFault(w.repo, probeOpts(w, fault, extra), { clock: deps.clock, container: executor, runId: () => `run_test_${runCounter}`, ...more });
}

export function readRun(w: Workspace, result: ProbeFaultResult, rel: string): any {
  return JSON.parse(readFileSync(path.join(w.repo, result.run_dir, rel), "utf8"));
}

export function trackedChanges(repo: string): string {
  return git(repo, "status", "--porcelain", "--untracked-files=no");
}
