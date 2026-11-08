import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { credentialNames, deadlineExecutor, effectiveManifest, hostContainerPlatform, opActionsRun, type ActionsProfile, type ActionsResult, type ActionsRunDeps } from "../../src/local/actionsRun.js";
import { boundaryFailures, containerUser, dockerImageEnsurer, dockerRunArgs, WORK_REPO, type ContainerExecutor, type ContainerRequest, type ImageEnsurer } from "../../src/local/boundary.js";
import type { BuildCheck } from "../../src/local/buildInfo.js";
import { ASSERTION_RECORD_VERSION } from "../../src/local/contracts/candidate.js";
import { unifiedFileDiff } from "../../src/local/contracts/faultRecord.js";
import { ORANGEPRO_VERSION } from "../../src/local/version.js";
import { deps, git, hostExecutor, mochaPackage, OFFSETS, PASSING_TESTS, passingProbe, sha256, tempDir, trackedChanges, workspace, type Workspace } from "./support/probeWorkspace.js";

const BUILD = "b".repeat(64);
const BUILT: BuildCheck = { status: "build", build_sha256: BUILD, reason: null };
const ROUNDING = `rounding_floor_ceil@${OFFSETS.floorInSeconds}`;
const TEST_FILE = "test/api.test.js";
const TITLE = "should round a sub-second value down to whole seconds";
const ASSERT = "assert.strictEqual(api.seconds(1500), 1);";
const AFTER = (() => {
  const at = PASSING_TESTS.lastIndexOf("});");
  return `${PASSING_TESTS.slice(0, at)}  it('${TITLE}', function () {\n    ${ASSERT}\n  });\n${PASSING_TESTS.slice(at)}`;
})();

/** The profile folder for the synthetic workspace: its record, oracle, witness and fixture, and the replayed test. */
function profileFor(w: Workspace, change: Partial<ActionsProfile> = {}, files: Record<string, string | Buffer> = {}): string {
  const dir = tempDir("profile");
  const write = (name: string, bytes: string | Buffer) => writeFileSync(path.join(dir, name), bytes);
  write("fixture-manifest.json", w.fixture);
  write("target-record.json", `${JSON.stringify(w.record, null, 2)}\n`);
  write("oracle.json", `${JSON.stringify(w.oracle, null, 2)}\n`);
  write("witness.cjs", w.witness);
  write("candidate.patch", unifiedFileDiff(TEST_FILE, PASSING_TESTS, AFTER));
  write(
    "assertion-template.json",
    JSON.stringify({
      version: ASSERTION_RECORD_VERSION,
      generation_request_sha256: "<sha256 of generation-request.json>",
      fault_record_sha256: "<from the request>",
      candidate: { patch_sha256: "<sha256 of the patch>", files: [{ path: TEST_FILE, sha256_after: "<sha256 after>" }] },
      test: { file: TEST_FILE, full_title: `api.seconds ${TITLE}` },
      assertion: { file: TEST_FILE, line: AFTER.split("\n").findIndex((l) => l.includes(ASSERT)) + 1, text: ASSERT, condition: "seconds(1500) is 1, the oracle's value" },
      failure_recognition: "first_frame_at_declared_line",
      generation: { by: "host_agent", agent: "test agent", assisted: true, saw: ["the brief"], attempt: 1 }
    })
  );
  for (const [name, bytes] of Object.entries(files)) write(name, bytes);
  const profile: ActionsProfile = {
    version: "orangepro.actions_profile.v1",
    base_branch: "main",
    orangepro: { version: ORANGEPRO_VERSION, build_sha256: BUILD },
    fixture: { manifest: "fixture-manifest.json", lockfile: null },
    target_record: "target-record.json",
    oracle: "oracle.json",
    witness: "witness.cjs",
    fault: ROUNDING,
    tests: [TEST_FILE],
    full_suite: true,
    candidate: { patch: "candidate.patch", assertion: "assertion-template.json" },
    limits: { total_minutes: 20 },
    ...change
  };
  write("profile.json", JSON.stringify(profile, null, 2));
  return path.join(dir, "profile.json");
}

function pushEvent(before: string, after: string): string {
  const file = path.join(tempDir("event"), "event.json");
  writeFileSync(file, JSON.stringify({ before, after, forced: false }));
  return file;
}

// A stand-in that never reaches docker or a registry: the image is already "here".
const imageHere: ImageEnsurer = (image, platform) => ({ image, platform, present_before: true, pulled: false, present: true, exit_code: null, duration_ms: 0, detail: null });

let n = 0;
function run(w: Workspace, profile: string, event: string, more: Partial<ActionsRunDeps> = {}, eventName = "push"): ActionsResult & { out: string } {
  const out = path.join(tempDir("out"), "out");
  n += 1;
  let id = 0;
  const result = opActionsRun(
    { event_name: eventName, event_path: event, profile_path: profile, repo: w.repo, out, summary_path: path.join(path.dirname(out), "step-summary.md") },
    { clock: deps.clock, build: BUILT, env: {}, arch: "arm64", container: hostExecutor(), image: imageHere, runId: () => `run_actions_${n}_${++id}`, ...more }
  );
  return { ...result, out };
}

/** Commit one file only: the kit's own untracked workspace files stay out of the commit. */
function commitOnly(repo: string, file: string, message: string): string {
  git(repo, "add", file);
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

const commits = (w: Workspace) => ({ base: git(w.repo, "rev-parse", "HEAD~1"), merged: git(w.repo, "rev-parse", "HEAD") });

describe("opro actions-run — the post-merge step", { timeout: 300_000 }, () => {
  it("runs the chain on the profile's target and ends verified_gap, with the receipt, the summary and the run folders in --out", () => {
    const w = workspace();
    const { base, merged } = commits(w);
    const r = run(w, profileFor(w), pushEvent(base, merged));
    expect([r.status, r.reason]).toEqual(["verified_gap", null]);
    expect(r.event).toEqual({ name: "push", base, merged, mode: "first_parent", commits: [merged] });
    expect(r.fault_classification).toBe("survived_unverified");
    expect(r.verify_result).toBe("verified_gap");
    expect(r.receipt?.rows.every((row) => row.met)).toBe(true);
    expect(r.receipt?.rows.map((row) => row.row)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H"]);
    expect(r.install).toMatchObject({ ran: false, skipped: "already_installed" });
    expect(r.test_source).toMatchObject({ kind: "replayed_candidate", by: "host_agent", agent: "test agent", assisted: true });
    for (const id of Object.values(r.runs)) expect(existsSync(path.join(r.out, "runs", id!, "MANIFEST.json"))).toBe(true);
    const receipt = JSON.parse(readFileSync(path.join(r.out, r.receipt!.path), "utf8"));
    expect(receipt.tool.build_sha256).toBe(null); // the tests run from source: no stamp
    expect(JSON.parse(readFileSync(path.join(r.out, "result.json"), "utf8")).status).toBe("verified_gap");
    const summary = readFileSync(path.join(r.out, "summary.md"), "utf8");
    expect(summary).toContain("**Verified.** A new test catches a fault the whole suite missed");
    expect(summary).toContain("replayed, not written in this run: test agent wrote it earlier (a coding agent; assisted)");
    expect(summary).toContain("| Old tests on the fault | missed it: the selected tests, and the whole suite |");
    expect(summary).toContain("all eight rows (A–H) met");
    expect(summary.match(/catches a fault/g)).toHaveLength(1);
    expect(readFileSync(path.join(path.dirname(r.out), "step-summary.md"), "utf8")).toBe(summary);
    expect(r.fixture).toMatchObject({ frozen_platform: "linux/arm64", effective_platform: "linux/arm64" });
    expect(r.fixture!.effective_sha256).toBe(r.fixture!.frozen_sha256);
    expect(trackedChanges(w.repo)).toBe("");
  });

  it("stops as not_configured when the push changes another function, lists it, and starts no container (amendment 1)", () => {
    const w = workspace();
    const { merged } = commits(w);
    const lib = path.join(w.repo, "lib/api.js");
    writeFileSync(lib, readFileSync(lib, "utf8").replace("return a != b;", "return a !== b;"));
    const next = commitOnly(w.repo, "lib/api.js", "only differs");
    const executor = hostExecutor();
    const r = run(w, profileFor(w), pushEvent(merged, next), { container: executor });
    expect([r.status, r.reason]).toEqual(["not_configured", "not_configured_for_change"]);
    expect(r.changed_targets?.map((t) => t.symbol_id)).toEqual(["sym:lib/api.js#api.differs"]);
    expect(r.detail).toContain("api.differs");
    expect(executor.calls).toHaveLength(0);
    expect(r.runs).toEqual({ fault: null, brief: null, verify: null, export: null });
  });

  it("skips a push that only adds to allowed test files: its own test patch, merged, starts nothing", () => {
    const w = workspace();
    const { merged } = commits(w);
    writeFileSync(path.join(w.repo, TEST_FILE), AFTER);
    const next = commitOnly(w.repo, TEST_FILE, "the test patch");
    const analyze = { calls: 0 };
    const r = run(w, profileFor(w), pushEvent(merged, next), { analyze: (() => { analyze.calls += 1; throw new Error("no analysis expected"); }) as never });
    expect([r.status, r.reason]).toEqual(["skipped", "test_only_change"]);
    expect(analyze.calls).toBe(0);
  });

  it("refuses a credential in the environment before any container, and a build other than the profile's", () => {
    const w = workspace();
    const { base, merged } = commits(w);
    const executor = hostExecutor();
    const withToken = run(w, profileFor(w), pushEvent(base, merged), { env: { GITHUB_TOKEN: "sentinel-not-a-token" }, container: executor });
    expect([withToken.status, withToken.reason]).toEqual(["blocked", "credential_in_env"]);
    expect(withToken.detail).toContain("GITHUB_TOKEN");
    expect(withToken.detail).not.toContain("sentinel-not-a-token");
    expect(executor.calls).toHaveLength(0);
    const other = run(w, profileFor(w), pushEvent(base, merged), { build: { status: "build", build_sha256: "c".repeat(64), reason: null } });
    expect([other.status, other.reason]).toEqual(["blocked", "build_mismatch"]);
    const source = run(w, profileFor(w), pushEvent(base, merged), { build: { status: "source", build_sha256: null, reason: null } });
    expect([source.status, source.reason]).toEqual(["blocked", "build_mismatch"]);
    expect(credentialNames({ GITHUB_TOKEN: "x", NPM_TOKEN: "", ANTHROPIC_API_KEY: "k", PATH: "/bin", KEYCHAIN: "x", DB_PASSWORD: "p" })).toEqual(["ANTHROPIC_API_KEY", "DB_PASSWORD", "GITHUB_TOKEN"]);
  });

  it("ends inconclusive (deadline) when the total limit runs out mid-chain, and starts no container after it", () => {
    const w = workspace();
    const { base, merged } = commits(w);
    let now = 0;
    const executor = hostExecutor();
    const r = run(w, profileFor(w, { limits: { total_minutes: 1 } }), pushEvent(base, merged), {
      container: executor,
      // Every reading of the clock moves it 7 s on: the minute runs out partway through the fault run.
      nowMs: () => (now += 7_000)
    });
    expect([r.status, r.reason]).toEqual(["inconclusive", "deadline"]);
    expect(r.limits.deadline_reached).toBe(true);
    expect(r.receipt).toBeNull();
    const inner = { calls: 0 };
    const bounded = deadlineExecutor(() => {
      inner.calls += 1;
      throw new Error("must not start");
    }, 100, () => 100);
    const late = bounded({ shape: { image: "i", platform: "linux/arm64", memory: "1g", cpus: "1", processes: 64, deadlineSeconds: 10 }, mounts: [], env: {}, workdir: WORK_REPO, command: ["node"], deadlineMs: 10_000 });
    expect([late.timedOut, late.exitCode, inner.calls]).toEqual([true, null, 0]);
    const seen: number[] = [];
    deadlineExecutor((request) => (seen.push(request.deadlineMs), late), 1_000, () => 400)({ ...({} as ContainerRequest), deadlineMs: 10_000 });
    expect(seen).toEqual([600]);
  });

  it("runs the container on the runner's platform: an effective manifest, both recorded", () => {
    const w = workspace();
    const { base, merged } = commits(w);
    const r = run(w, profileFor(w, { full_suite: false, candidate: null }), pushEvent(base, merged), { arch: "x64" });
    expect([r.status, r.reason]).toEqual(["needs_test", "no_candidate"]);
    expect(r.fixture).toMatchObject({ frozen_platform: "linux/arm64", effective_platform: "linux/amd64", frozen_sha256: sha256(w.fixture) });
    expect(r.fixture!.effective_sha256).toBe(sha256(readFileSync(path.join(r.out, "fixture-manifest.effective.json"))));
    const profile = JSON.parse(readFileSync(path.join(r.out, "runs", r.runs.fault!, "run-profile.json"), "utf8"));
    expect(profile.container.platform).toBe("linux/amd64");
    expect(r.runs.brief).not.toBeNull();
    expect(existsSync(path.join(r.out, "runs", r.runs.brief!, "brief", "brief.md"))).toBe(true);
    expect(hostContainerPlatform("ia32")).toBeNull();
    const frozen = Buffer.from(JSON.stringify({ environment: { platform: "linux/arm64", image: "i" } }));
    expect(effectiveManifest(frozen, "linux/arm64")).toBe(frozen);
    expect(JSON.parse(effectiveManifest(frozen, "linux/amd64").toString())).toEqual({ environment: { platform: "linux/amd64", image: "i" } });
  });

  it("installs inside the boundary from the frozen lockfile when the checkout has no test runner, and refuses a different lockfile", () => {
    // Like Express: the repository ignores its lockfile, so the frozen one can be added without changing the checkout.
    const w = workspace(undefined, { gitignore: "node_modules\npackage-lock.json\n" });
    const { base, merged } = commits(w);
    rmSync(path.join(w.repo, "node_modules"), { recursive: true, force: true });
    const lock = Buffer.from(JSON.stringify({ name: "seconds-lib", lockfileVersion: 3, packages: {} }));
    const manifest = JSON.parse(w.fixture.toString());
    manifest.dependencies = { lockfile: "package-lock.json", lockfile_sha256: sha256(lock) };
    manifest.commands.install = ["npm", "ci", "--package-lock=true", "--no-audit", "--no-fund"];
    const fixture = Buffer.from(JSON.stringify(manifest));
    const host = hostExecutor();
    const shapes: string[] = [];
    const executor: ContainerExecutor = (request) => {
      if (request.command[0] === "npm") {
        shapes.push(`install:${request.network}:${request.mounts.map((m) => `${m.target}:${m.readonly ? "ro" : "rw"}`).join(",")}`);
        mkdirSync(path.join(w.repo, "node_modules"), { recursive: true });
        symlinkSync(mochaPackage, path.join(w.repo, "node_modules", "mocha"), "dir");
        return { exitCode: 0, signal: null, timedOut: false, stdout: "added 1 package", stderr: "", durationMs: 5, dockerArgv: ["docker", "run", "<double>"], stopped: true };
      }
      if (request.command[1] === "-e" && request.mounts.length === 1) shapes.push(`probe:${request.network ?? "none"}`);
      return host(request);
    };
    const profile = profileFor(w, { fixture: { manifest: "fixture-manifest.json", lockfile: "package-lock.json" } }, { "fixture-manifest.json": fixture, "package-lock.json": lock });
    const r = run(w, profile, pushEvent(base, merged), { container: executor });
    expect([r.status, r.reason]).toEqual(["verified_gap", null]);
    expect(shapes).toEqual(["probe:none", "probe:bridge", `install:bridge:${WORK_REPO}:rw`]);
    expect(r.install).toMatchObject({ ran: true, exit_code: 0, command: ["npm", "ci", "--package-lock=true", "--no-audit", "--no-fund"], lockfile: { path: "package-lock.json", added: true, unchanged_by_install: true } });
    expect(r.install!.boundary_checks.map((c) => [c.shape, c.held])).toEqual([["test", true], ["install", true]]);
    expect(readFileSync(path.join(w.repo, "package-lock.json"))).toEqual(lock);

    // A lockfile of the checkout's own that is not the frozen one is never replaced.
    const w2 = workspace(undefined, { gitignore: "node_modules\npackage-lock.json\n" });
    const c2 = commits(w2);
    rmSync(path.join(w2.repo, "node_modules"), { recursive: true, force: true });
    writeFileSync(path.join(w2.repo, "package-lock.json"), "{}\n");
    const conflict = run(w2, profileFor(w2, { fixture: { manifest: "fixture-manifest.json", lockfile: "package-lock.json" } }, { "fixture-manifest.json": fixture, "package-lock.json": lock }), pushEvent(c2.base, c2.merged));
    expect([conflict.status, conflict.reason]).toEqual(["blocked", "lockfile_conflict"]);
    expect(readFileSync(path.join(w2.repo, "package-lock.json"), "utf8")).toBe("{}\n");
  });

  it("fetches the pinned image by its digest when the machine has none, and blocks when it cannot", () => {
    const w = workspace();
    const { base, merged } = commits(w);
    const asked: string[] = [];
    const pulled: ImageEnsurer = (image, platform) => (asked.push(`${image} ${platform}`), { image, platform, present_before: false, pulled: true, present: true, exit_code: 0, duration_ms: 2_000, detail: null });
    const r = run(w, profileFor(w, { full_suite: false, candidate: null }), pushEvent(base, merged), { image: pulled, arch: "x64" });
    expect(r.status).toBe("needs_test");
    expect(asked).toEqual([`node@sha256:${"0".repeat(64)} linux/amd64`]);
    expect(readFileSync(path.join(r.out, "summary.md"), "utf8")).toContain("fetched by its digest for linux/amd64");
    const executor = hostExecutor();
    const none: ImageEnsurer = (image, platform) => ({ image, platform, present_before: false, pulled: false, present: false, exit_code: 1, duration_ms: 1, detail: "docker pull failed (exit 1): no route" });
    const blocked = run(w, profileFor(w), pushEvent(base, merged), { image: none, container: executor });
    expect([blocked.status, blocked.reason]).toEqual(["blocked", "image_unavailable"]);
    expect(executor.calls).toHaveLength(0);
    // The real one pulls only a digest, and reports a missing docker instead of passing it.
    expect(dockerImageEnsurer(null)("node@sha256:" + "1".repeat(64), "linux/amd64", 1000)).toMatchObject({ present: false, pulled: false });
    expect(dockerImageEnsurer("/bin/false")("node:22", "linux/amd64", 1000).detail).toContain("not pinned by digest");
  });

  it("refuses an --out folder that already holds files, or one inside the checkout", () => {
    const w = workspace();
    const { base, merged } = commits(w);
    const used = tempDir("used");
    writeFileSync(path.join(used, "x"), "x");
    const call = (out: string) => () =>
      opActionsRun({ event_name: "push", event_path: pushEvent(base, merged), profile_path: profileFor(w), repo: w.repo, out }, { clock: deps.clock, build: BUILT, env: {} });
    expect(call(used)).toThrow(/already holds files/);
    expect(call(path.join(w.repo, "out"))).toThrow(/inside the repository/);
  });
});

describe("the container user and the install shape (V12)", () => {
  it("runs as the host's uid:gid on Linux, never root, and 1000:1000 elsewhere", () => {
    expect(containerUser("linux", { uid: 1001, gid: 118 })).toBe("1001:118");
    expect(() => containerUser("linux", { uid: 0, gid: 0 })).toThrow(/as root/);
    expect(containerUser("darwin", { uid: 501, gid: 20 })).toBe("1000:1000");
    expect(containerUser("win32", null)).toBe("1000:1000");
  });

  it("gives the install shape the network and the checkout read-write, without the test stage's variables", () => {
    const shape = { image: "i", platform: "linux/amd64", memory: "4g", cpus: "4", processes: 512, deadlineSeconds: 900 };
    const install: ContainerRequest = { shape, mounts: [{ source: "/host/repo", target: WORK_REPO, readonly: false, role: "<checkout>" }], env: {}, workdir: WORK_REPO, command: ["npm", "ci"], deadlineMs: 1, network: "bridge" };
    const args = dockerRunArgs("n", install).join(" ");
    expect(args).toContain("--network bridge");
    expect(args).toContain(`--user ${containerUser()}`);
    expect(args).not.toContain("NODE_ENV=test");
    expect(args).not.toContain("CI=1");
    expect(args).toContain("--read-only");
    expect(args).toContain("--cap-drop ALL");
    const test = dockerRunArgs("n", { ...install, network: undefined }).join(" ");
    expect(test).toContain("--network none");
    expect(test).toContain("NODE_ENV=test");
    expect(boundaryFailures(passingProbe(install), install)).toEqual([]);
    const testShape = { ...install, network: "none" as const };
    expect(boundaryFailures({ ...passingProbe(testShape), network_reachable: true }, testShape)).toContain("the network is reachable");
    expect(boundaryFailures({ ...passingProbe(install), uid: 4242 }, install).join("\n")).toContain("runs as uid 4242");
  });
});
