import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { opInit, opAnalyze, opChanged, opScore, opStatus, opGaps, resolveDiffTargets } from "../../src/local/operations.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const DEPS = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t.io", "-c", "user.name=t", ...args], {
    cwd,
    stdio: ["ignore", "ignore", "ignore"]
  });
}

/** A workspace whose analyzed source is a real git repo with one commit. */
function gitWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-changed-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
  writeFileSync(join(root, "src", "card.ts"), "export function saveCard(){ return 1 }\n");
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  // .orangepro is created AFTER the commit, so it stays untracked (not a diff).
  opInit(root, DEPS);
  opAnalyze(root, { source: root }, DEPS);
  return root;
}

/** A workspace whose analyzed source is NOT a git repo. */
function nonGitWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-nogit-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
  writeFileSync(join(root, "src", "card.ts"), "export function saveCard(){ return 1 }\n");
  opInit(root, DEPS);
  opAnalyze(root, { source: root }, DEPS);
  return root;
}

describe("baseline tools (no diff/PR required)", () => {
  it("status / score / gaps work with no git diff", () => {
    const root = gitWorkspace(); // clean repo, zero changed files
    expect(opStatus(root).workspace_initialized).toBe(true);
    const score = opScore(root);
    expect(score.overall).toBeGreaterThanOrEqual(0);
    expect(score.overall).toBeLessThanOrEqual(100);
    expect(Array.isArray(opGaps(root).gaps)).toBe(true);
    // And the diff/PR tool on the very same clean repo reports no_diff, not impact.
    expect(opChanged(root, "HEAD").status).toBe("no_diff");
  });

  it("baseline tools also work in a non-git workspace", () => {
    const root = nonGitWorkspace();
    expect(opStatus(root).workspace_initialized).toBe(true);
    expect(typeof opScore(root).overall).toBe("number");
    expect(Array.isArray(opGaps(root).gaps)).toBe(true);
  });
});

describe("diff/PR tool contract (orangepro_changed_impact)", () => {
  it("returns no_diff with guidance when there are no changes", () => {
    const root = gitWorkspace();
    const res = opChanged(root, "HEAD");
    expect(res.status).toBe("no_diff");
    expect(res.changed_files).toEqual([]);
    expect(res.affected_behaviors).toEqual([]);
    expect(res.guidance).toContain("No changed files found");
    expect(res.guidance).toContain("orangepro_find_test_gaps");
  });

  it("returns missing_base_ref when the base ref does not exist", () => {
    const root = gitWorkspace();
    const res = opChanged(root, "no-such-ref-xyz-123");
    expect(res.status).toBe("missing_base_ref");
    expect(res.base_ref).toBe("no-such-ref-xyz-123");
    expect(res.changed_files).toEqual([]);
    expect(res.guidance).toContain("was not found");
  });

  it("returns not_a_git_repo when the checkout is not a git repository", () => {
    const root = nonGitWorkspace();
    const res = opChanged(root);
    expect(res.status).toBe("not_a_git_repo");
    expect(res.guidance).toContain("not a git repository");
  });

  it("returns ok with the change set when a real changed file exists", () => {
    const root = gitWorkspace();
    // Modify a tracked source file → a real diff vs HEAD.
    writeFileSync(join(root, "src", "card.ts"), "export function saveCard(){ return 2 }\n");
    const res = opChanged(root, "HEAD");
    expect(res.status).toBe("ok");
    expect(res.changed_files).toContain("src/card.ts");
    expect(res.guidance).toBeUndefined();
  });

  it("returns no_code_changes when the diff only touches docs", () => {
    const root = mkdtempSync(join(tmpdir(), "oplocal-changed-docs-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
    writeFileSync(join(root, "src", "card.ts"), "export function saveCard(){ return 1 }\n");
    writeFileSync(join(root, "README.md"), "# docs\n");
    git(root, ["init", "-q"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "init"]);
    opInit(root, DEPS);
    opAnalyze(root, { source: root }, DEPS);
    // Touch ONLY the docs file → real diff, but no code change to test.
    writeFileSync(join(root, "README.md"), "# docs changed\n");
    const res = opChanged(root, "HEAD");
    expect(res.status).toBe("no_code_changes");
    expect(res.changed_files).toEqual([]);
    expect(res.guidance).toMatch(/doc/i);
    // resolveDiffTargets surfaces the same status with no targets.
    const dt = resolveDiffTargets(root, "HEAD");
    expect(dt.status).toBe("no_code_changes");
    expect(dt.target_ids).toEqual([]);
  });

  it("autodetects the default branch (master) when no base ref is given", () => {
    const root = mkdtempSync(join(tmpdir(), "oplocal-master-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
    writeFileSync(join(root, "src", "card.ts"), "export function saveCard(){ return 1 }\n");
    git(root, ["init", "-q"]);
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "init"]);
    git(root, ["branch", "-M", "master"]); // force the default branch to master
    opInit(root, DEPS);
    opAnalyze(root, { source: root }, DEPS);
    // No base passed → autodetect 'master' instead of the literal 'main' (which would
    // otherwise return missing_base_ref on a master-default repo like Mattermost).
    const res = opChanged(root);
    expect(res.base_ref).toBe("master");
    expect(res.status).not.toBe("missing_base_ref");
  });

  it("filters ignored paths (e.g. dist/) out of the change set", () => {
    const root = mkdtempSync(join(tmpdir(), "oplocal-changed-ign-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    mkdirSync(join(root, "dist"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
    writeFileSync(join(root, "src", "card.ts"), "export function saveCard(){ return 1 }\n");
    writeFileSync(join(root, "dist", "bundle.js"), "module.exports = 1\n");
    git(root, ["init", "-q"]);
    git(root, ["add", "-f", "."]); // -f so dist/ is tracked even under a global gitignore
    git(root, ["commit", "-q", "-m", "init"]);
    opInit(root, DEPS);
    opAnalyze(root, { source: root }, DEPS);
    writeFileSync(join(root, "src", "card.ts"), "export function saveCard(){ return 2 }\n");
    writeFileSync(join(root, "dist", "bundle.js"), "module.exports = 2\n");
    const res = opChanged(root, "HEAD");
    expect(res.status).toBe("ok");
    expect(res.changed_files).toContain("src/card.ts");
    expect(res.changed_files).not.toContain("dist/bundle.js");
  });

  it("diffs from the MERGE-BASE: upstream churn on the base branch is never 'changed'", () => {
    const root = gitWorkspace();
    git(root, ["branch", "-M", "main"]); // deterministic base name
    git(root, ["checkout", "-q", "-b", "feature"]);
    writeFileSync(join(root, "src", "feature.ts"), "export function feat(){ return 1 }\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "feature change"]);
    // The base advances AFTER the branch point (someone else's merge) — a
    // base-TIP diff would report src/upstream.ts as changed by this branch
    // (the Mattermost dogfood flood: 513 "changed" files for a 5-file PR).
    git(root, ["checkout", "-q", "main"]);
    writeFileSync(join(root, "src", "upstream.ts"), "export function upstream(){ return 1 }\n");
    git(root, ["add", "."]);
    git(root, ["commit", "-q", "-m", "upstream churn"]);
    git(root, ["checkout", "-q", "feature"]);

    const res = opChanged(root, "main");
    expect(res.status).toBe("ok");
    expect(res.changed_files).toContain("src/feature.ts");
    expect(res.changed_files).not.toContain("src/upstream.ts");
  });
});

describe("resolveDiffTargets (PR-scoped generation)", () => {
  it("not a git repo → guidance, no targets (never throws)", () => {
    const dt = resolveDiffTargets(nonGitWorkspace(), undefined);
    expect(dt.status).toBe("not_a_git_repo");
    expect(dt.target_ids).toEqual([]);
    expect(dt.guidance).toContain("not a git repository");
  });

  it("no diff → guidance, no targets", () => {
    const dt = resolveDiffTargets(gitWorkspace(), "HEAD");
    expect(dt.status).toBe("no_diff");
    expect(dt.target_ids).toEqual([]);
    expect(dt.guidance).toContain("No changed files");
  });

  it("real diff but no tracked behaviors → ok with guidance, no targets", () => {
    const root = gitWorkspace();
    writeFileSync(join(root, "src", "card.ts"), "export function saveCard(){ return 2 }\n");
    const dt = resolveDiffTargets(root, "HEAD");
    expect(dt.status).toBe("ok");
    expect(dt.target_ids).toEqual([]); // fixture has no test files → no behavior anchors
    expect(dt.guidance).toContain("touched no tracked behaviors");
  });
});
