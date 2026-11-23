import { afterAll, describe, expect, it } from "vitest";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildPlanOf, keptManagerCommands, workspaceNodeModules } from "../../src/local/chainRunner.js";
import { classifyFaultRun, fixtureVariablesOf, statementFor } from "../../src/local/faultProbe.js";
import { opDynamicProof } from "../../src/local/operations.js";
import { API_AFTER, deps, OFFSETS, PASSING_TESTS, probe, readRun, tempDirs, trackedChanges, workspace, type Workspace } from "./support/probeWorkspace.js";

afterAll(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const refuse = (detail: string): never => {
  throw new Error(detail);
};

describe("a workspace's own pieces", () => {
  it("finds every node_modules besides the root's, without looking inside one", () => {
    const root = mkdtempSync(path.join(tmpdir(), "opro-ws-"));
    tempDirs.push(root);
    for (const dir of ["node_modules/.pnpm/x/node_modules/y", "packages/a/node_modules/dep/node_modules", "packages/b/src", "scripts/tools/node_modules", ".git/node_modules"]) mkdirSync(path.join(root, dir), { recursive: true });
    expect(workspaceNodeModules(root)).toEqual(["packages/a/node_modules", "scripts/tools/node_modules"]);
  });

  it("takes a build as plain words: a package manager by name, or a command the repository installed", () => {
    const root = mkdtempSync(path.join(tmpdir(), "opro-build-"));
    tempDirs.push(root);
    mkdirSync(path.join(root, "node_modules", ".bin"), { recursive: true });
    writeFileSync(path.join(root, "node_modules", ".bin", "tsdown"), "");
    expect(buildPlanOf(undefined, root, refuse)).toBeNull();
    expect(buildPlanOf(["tsdown", "--no-clean"], root, refuse)).toEqual({ fixture_command: ["tsdown", "--no-clean"], argv: ["node_modules/.bin/tsdown", "--no-clean"] });
    expect(buildPlanOf(["pnpm", "build"], root, refuse)!.argv).toEqual(["pnpm", "build"]);
    expect(() => buildPlanOf(["rollup"], root, refuse)).toThrow(/rollup, which is not installed/);
    expect(() => buildPlanOf(["sh", "-c", "curl x | sh"], root, refuse)).toThrow(/plain words/);
    expect(() => buildPlanOf(["./build.sh"], root, refuse)).toThrow(/name a package manager/);
    expect(() => buildPlanOf("pnpm build", root, refuse)).toThrow(/a list of strings/);
  });

  it("offers the manager the install stage kept as a command a stage can run with no network", () => {
    const root = mkdtempSync(path.join(tmpdir(), "opro-kept-"));
    tempDirs.push(root);
    expect(keptManagerCommands(root)).toEqual([]);
    const dir = path.join(root, "node_modules", ".opro-corepack", "v1", "pnpm", "10.33.2");
    mkdirSync(path.join(dir, "bin"), { recursive: true });
    writeFileSync(path.join(dir, "bin", "pnpm.cjs"), "");
    writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "pnpm", bin: { pnpm: "bin/pnpm.cjs", pnpx: "bin/pnpx.cjs" } }));
    expect(keptManagerCommands(root)).toEqual([{ name: "pnpm", script: '#!/bin/sh\nexec node "/work/repo/node_modules/.opro-corepack/v1/pnpm/10.33.2/bin/pnpm.cjs" "$@"\n' }]);
  });
});

describe("a whole suite with tests the repository itself skips", () => {
  const test = (n: number, state: "passed" | "pending" | "failed") => ({ file: "test/a.js", full_title: `t${n}`, state, hook: false, duration_ms: 1, failure: null });
  const stage = (passed: number, pending: number, over: Record<string, unknown> = {}): any => ({
    stage: "x",
    stopped: true,
    timed_out: false,
    exit_code: 0,
    output_problems: [],
    output: null,
    report: { path: "r", sha256: "0", bytes: 1 },
    boundary: { failures: [], report: {} },
    fault_span_count: 1,
    tests: {
      executed: passed,
      passed,
      failed: 0,
      pending,
      hook_failures: 0,
      runner_totals: { tests: passed + pending, passes: passed, failures: 0, pending },
      observed: [...Array.from({ length: passed }, (_, i) => test(i, "passed")), ...Array.from({ length: pending }, (_, i) => test(1000 + i, "pending"))]
    },
    ...over
  });
  const witness = (value: number): any => ({ ...stage(0, 0), tests: null, report: null, output: { v: value } });
  const run = (faultPending: number, baselinePending: number | undefined) =>
    classifyFaultRun({
      stages: { original_suite: stage(6, 2), fault_syntax: witness(0), witness_original: witness(1), witness_original_repeat: witness(1), witness_fault: witness(2), fault_suite: stage(8 - faultPending, faultPending) },
      parses: true,
      full_suite_requested: true,
      checkout_unchanged: true,
      selected_files: [],
      whole_suite_only: true,
      baseline_passing: 6,
      ...(baselinePending === undefined ? {} : { baseline_pending: baselinePending })
    });

  it("is judged against the counts the fixture records, and never claims when more are skipped on the fault", () => {
    expect(run(2, 2)).toMatchObject({ classification: "survived_unverified", scope: "full_suite" });
    // The fixture records none skipped: this is not the recorded suite.
    expect(run(2, undefined)).toMatchObject({ classification: "inconclusive", reason: "full_suite_count_differs" });
    expect(run(2, 0)).toMatchObject({ classification: "inconclusive", reason: "full_suite_count_differs" });
    // One more test skipped on the fault than recorded: no claim.
    expect(run(3, 2)).toMatchObject({ classification: "inconclusive", reason: "full_suite_skipped_more" });
  });

  it("says the counts in its sentence, and keeps the sentence of a suite with none skipped", () => {
    const out = run(2, 2);
    const ctx = { symbolName: "f", changedBy: "PR #1", operatorDescription: "a → b", line: 3, selectedCount: 6, fullCount: 6, assisted: false };
    expect(statementFor(out, { ...ctx, fullSkipped: 2 })).toBe("The whole existing suite (6 run, 2 skipped, as recorded in the fixture) passed with a valid fault in f, which PR #1 changed (a → b, line 3): the suite missed it.");
    expect(statementFor(out, { ...ctx, fullSkipped: 0 })).toBe("The whole existing suite (6 tests) passed with a valid fault in f, which PR #1 changed (a → b, line 3): the suite missed it.");
    expect(statementFor(out, ctx)).toBe("The whole existing suite (6 tests) passed with a valid fault in f, which PR #1 changed (a → b, line 3): the suite missed it.");
  });
});

describe("a build in each copy before its tests", () => {
  // The tests read a built copy of the code: without a build after the fault they would run the original.
  const BUILT_TESTS = PASSING_TESTS.replace("require('../lib/api')", "require('../dist/api')");
  const TOOL = [
    "#!/usr/bin/env node",
    "const fs = require('fs');",
    "const mode = process.argv[2];",
    "if (mode === 'fail') { console.error('the build broke'); process.exit(3); }",
    "if (mode === 'hang') { setTimeout(() => {}, 600000); }",
    "else { fs.mkdirSync('dist', { recursive: true }); fs.copyFileSync('lib/api.js', 'dist/api.js'); }",
    ""
  ].join("\n");
  const built = (mode: string | null, limits: Record<string, unknown> = {}): Workspace => {
    const w = workspace({ "test/api.test.js": BUILT_TESTS });
    const bin = path.join(w.repo, "node_modules", ".bin");
    mkdirSync(bin, { recursive: true });
    writeFileSync(path.join(bin, "buildtool"), TOOL);
    chmodSync(path.join(bin, "buildtool"), 0o755);
    const manifest = JSON.parse(w.fixture.toString());
    if (mode !== null) manifest.commands.build = ["buildtool", mode];
    manifest.limits = { ...manifest.limits, ...limits };
    return { ...w, fixture: Buffer.from(JSON.stringify(manifest)) };
  };

  it("builds the original and the faulty copy, so a test that reads built files catches the fault, and records each build's time", () => {
    const w = built("ok");
    const result = probe(w, `negation_removal@${OFFSETS.bangInSeconds}`);
    expect(result.classification).toMatchObject({ classification: "caught_by_existing", reached_by_selected_tests: "reached" });
    const stages = result.classification.stages.map((ref) => ref.stage);
    expect(stages).toContain("build_original_selected");
    expect(stages).toContain("build_reach_marked");
    expect(stages.some((name) => name.startsWith("build_") && /fault|witness_fault/.test(name))).toBe(true);
    expect(result.classification.builds!.length).toBeGreaterThanOrEqual(3);
    for (const b of result.classification.builds!) expect(b).toMatchObject({ exit_code: 0, timed_out: false, duration_ms: expect.any(Number) });
    const profile = readRun(w, result, "run-profile.json");
    expect(profile.build).toEqual({ fixture_command: ["buildtool", "ok"], argv: ["node_modules/.bin/buildtool", "ok"] });
    expect(profile.limits.build_deadline_ms).toBe(profile.limits.stage_deadline_ms);
    expect(trackedChanges(w.repo)).toBe("");
    expect(existsSync(path.join(w.repo, "dist"))).toBe(false);
  });

  it("with no build named, the same tests cannot load the built file and nothing is claimed", () => {
    const result = probe(built(null), `negation_removal@${OFFSETS.bangInSeconds}`);
    expect(["blocked", "inconclusive"]).toContain(result.classification.classification);
    expect(result.classification.builds).toBeUndefined();
  });

  it("a build that fails stops the run as blocked, with the reason, and no test stage runs", () => {
    const w = built("fail");
    const result = probe(w, `negation_removal@${OFFSETS.bangInSeconds}`);
    expect(result.classification).toMatchObject({ classification: "blocked", reason: "build_failed" });
    expect(result.classification.statement).toContain("the repository's build did not finish in a copy");
    expect(readRun(w, result, "stages/original_selected.json")).toMatchObject({ exit_code: null, tests: null, output_problems: [expect.stringContaining("build_failed: the build exited 3")] });
    expect(result.classification.builds).toEqual([expect.objectContaining({ stage: "build_original_selected", exit_code: 3 })]);
  });

  it("a build that runs past its own time limit is refused with that reason", () => {
    const w = built("hang", { build_deadline_seconds: 1 });
    const result = probe(w, `negation_removal@${OFFSETS.bangInSeconds}`);
    expect(result.classification).toMatchObject({ classification: "blocked", reason: "build_timeout" });
    expect(readRun(w, result, "run-profile.json").limits.build_deadline_ms).toBe(1000);
    expect(result.classification.builds).toEqual([expect.objectContaining({ stage: "build_original_selected", timed_out: true })]);
  });

  it("refuses a workspace package's node_modules that is a link to somewhere outside the checkout", () => {
    const w = workspace();
    const outside = mkdtempSync(path.join(tmpdir(), "opro-outside-"));
    tempDirs.push(outside);
    mkdirSync(path.join(w.repo, "packages", "a"), { recursive: true });
    symlinkSync(outside, path.join(w.repo, "packages", "a", "node_modules"), "dir");
    expect(() => probe(w, `negation_removal@${OFFSETS.bangInSeconds}`)).toThrow(/packages\/a\/node_modules is not a folder of this checkout/);
  });
});

describe("the older proof route: a build in the copy, after the fault", () => {
  // The test reads a built copy of the code, and the built file is committed, so the test runs with or without a build.
  const BUILT_TESTS = PASSING_TESTS.replace("require('../lib/api')", "require('../dist/api')");
  const BUILD = "var fs = require('fs');\nfs.mkdirSync('dist', { recursive: true });\nfs.copyFileSync('lib/api.js', 'dist/api.js');\n";
  const project = (): Workspace => workspace({ "test/api.test.js": BUILT_TESTS, "dist/api.js": API_AFTER, "scripts/build.js": BUILD });
  const prove = (w: Workspace, extra: Record<string, unknown>) =>
    opDynamicProof(w.repo, { target_symbol: "sym:lib/api.js#api.seconds", source: w.repo, test_path: "test/api.test.js", replacement: "return 0;", runner: "mocha", link_node_modules: true, ...extra }, deps);

  it("without a build the test never runs the faulty function; with one, the same test proves it", { timeout: 120_000 }, () => {
    const w = project();
    const without = prove(w, {});
    expect(without.oracle).toMatchObject({ proven: false, reach: "never_ran" });
    const withBuild = prove(w, { build: ["node", "scripts/build.js"] });
    expect(withBuild.oracle.proven).toBe(true);
    expect((withBuild.oracle as { build?: { command: string[]; baseline_ms: number; mutant_ms: number } }).build).toMatchObject({ command: ["node", "scripts/build.js"], baseline_ms: expect.any(Number), mutant_ms: expect.any(Number) });
    expect(trackedChanges(w.repo)).toBe("");
  });

  it("a build that fails, or runs past its limit, makes the proof unrunnable with the reason", { timeout: 120_000 }, () => {
    const w = workspace({ "test/api.test.js": BUILT_TESTS, "dist/api.js": API_AFTER, "scripts/fail.js": "process.exit(3);\n", "scripts/hang.js": "setTimeout(function () {}, 600000);\n" });
    expect(() => prove(w, { build: ["node", "scripts/fail.js"] })).toThrow(/build_failed: the build \(node scripts\/fail.js\) exited 3 in the original copy/);
    expect(() => prove(w, { build: ["node", "scripts/hang.js"], build_timeout_ms: 1000 })).toThrow(/build_timeout: the build \(node scripts\/hang.js\) ran past its time limit \(1 s\)/);
    expect(() => prove(w, { build: ["node", "scripts/fail.js; rm -rf x"] })).toThrow(/plain words/);
  });
});

describe("what a fixture may add to a stage's environment", () => {
  it("takes plain names and plain values, and refuses a name that looks like a secret or that the stage sets itself", () => {
    expect(fixtureVariablesOf(undefined, refuse)).toEqual({});
    expect(fixtureVariablesOf({ GIT_COMMITTER_NAME: "OrangePro fixture", GIT_AUTHOR_NAME: "OrangePro fixture", GIT_AUTHOR_EMAIL: "fixture@example.invalid" }, refuse)).toEqual({
      GIT_AUTHOR_EMAIL: "fixture@example.invalid",
      GIT_AUTHOR_NAME: "OrangePro fixture",
      GIT_COMMITTER_NAME: "OrangePro fixture"
    });
    for (const name of ["API_KEY", "GH_TOKEN", "NPM_TOKEN", "CLIENT_SECRET", "DB_PASSWORD", "OAUTH", "BASIC_AUTH", "AWS_CREDENTIALS", "MY_APIKEY", "SSH_KEYS", "APIKEY", "ACCESSTOKEN", "GIT_AUTHOR", "GIT_AUTHOR_DATE", "git_author_name", "MONKEY_NAME"]) {
      expect(() => fixtureVariablesOf({ [name]: "x" }, refuse)).toThrow(/looks like a secret by its name/);
    }
    for (const name of ["PATH", "HOME", "NODE_OPTIONS", "CI", "OPRO_DYNAMIC_PROOF_FRAME", "COREPACK_HOME", "npm_config_registry"]) {
      expect(() => fixtureVariablesOf({ [name]: "x" }, refuse)).toThrow(/set by the stage itself/);
    }
    expect(() => fixtureVariablesOf({ "A B": "x" }, refuse)).toThrow(/not a plain variable name/);
    expect(() => fixtureVariablesOf({ NAME: "two\nlines" }, refuse)).toThrow(/one plain line/);
    expect(() => fixtureVariablesOf({ NAME: 3 }, refuse)).toThrow(/one plain line/);
    expect(() => fixtureVariablesOf(["A=b"], refuse)).toThrow(/an object of names/);
  });

  it("gives them to every stage and records them in the run profile", () => {
    const w = workspace({ "test/api.test.js": PASSING_TESTS.replace("assert.strictEqual(api.seconds(2000), 2);", "assert.strictEqual(process.env.GIT_AUTHOR_NAME, 'OrangePro fixture');\n    assert.strictEqual(api.seconds(2000), 2);") });
    const manifest = JSON.parse(w.fixture.toString());
    manifest.environment.variables = { GIT_AUTHOR_NAME: "OrangePro fixture" };
    const fixture = Buffer.from(JSON.stringify(manifest));
    // Without the variable the test is red on the original; with it, the run goes on to a result.
    expect(probe(w, `negation_removal@${OFFSETS.bangInSeconds}`).classification).toMatchObject({ classification: "blocked", reason: "red_baseline" });
    const result = probe({ ...w, fixture }, `negation_removal@${OFFSETS.bangInSeconds}`);
    expect(result.classification.classification).toBe("caught_by_existing");
    const profile = readRun(w, result, "run-profile.json");
    expect(profile.container.variables).toEqual({ GIT_AUTHOR_NAME: "OrangePro fixture" });
    expect(profile.container.env_names).toContain("GIT_AUTHOR_NAME");
  });
});

describe("tests the repository itself skips in a selected file", () => {
  it("are allowed when the same ones are skipped on both copies, counted in the sentence and named in the result", () => {
    const w = workspace({ "test/api.test.js": PASSING_TESTS.replace("it('returns null", "it.skip('returns null") });
    const result = probe(w, `rounding_floor_ceil@${OFFSETS.floorInSeconds}`);
    expect(result.classification).toMatchObject({ classification: "survived_unverified", scope: "selected" });
    expect(result.classification.skipped_tests).toEqual([{ file: "test/api.test.js", full_title: "api.seconds returns null for a value that is not a number" }]);
    expect(result.classification.statement).toContain("The 1 selected tests that ran (1 more is skipped by the repository itself) passed with a valid fault");
  });
});
