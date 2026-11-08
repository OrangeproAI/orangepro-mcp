import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { ACTIONS_DIR, MANAGED_LIST, opInstallGithubAction, ownedWorkflow, renderInstall, WORKFLOW_PATH, workflowYaml } from "../../src/local/actionsInstall.js";
import { checkActionsProfile } from "../../src/local/actionsRun.js";
import { recordSha256 } from "../../src/local/contracts/io.js";
import { createLocalServer } from "../../src/local/mcp.js";
import { commitAll, git, sha256, tempDir, writeFiles } from "./support/probeWorkspace.js";

// js-yaml comes with Mocha, a pinned dev dependency; it is used here only to read the generated YAML back.
const yaml = createRequire(import.meta.url)("js-yaml") as { load: (text: string) => any };

const BUILD = "d".repeat(64);
const RECORD = { version: "orangepro.target_record.v1", identity: { symbol_id: "sym:lib/a.js#a.f" } };
const WITNESS = "process.stdout.write('1\\n');\n";
const LOCK = '{"lockfileVersion":3}\n';

function repo(): string {
  const dir = tempDir("install-repo");
  git(dir, "init", "-q", "-b", "main");
  writeFiles(dir, { "README.md": "a repository\n" });
  commitAll(dir, "first");
  return dir;
}

function source(change: Record<string, unknown> = {}): string {
  const dir = tempDir("install-from");
  writeFiles(dir, {
    "fixture-manifest.json": JSON.stringify({ dependencies: { lockfile_sha256: sha256(LOCK) } }),
    "package-lock.json": LOCK,
    "target-record.json": JSON.stringify(RECORD),
    "oracle.json": JSON.stringify({ target_record_sha256: recordSha256(RECORD), witness: { sha256: sha256(WITNESS) } }),
    "witness.cjs": WITNESS,
    "candidate.patch": "--- a/test/a.js\n+++ b/test/a.js\n",
    "assertion-template.json": "{}",
    "profile.json": JSON.stringify({
      fixture: { manifest: "fixture-manifest.json", lockfile: "package-lock.json" },
      target_record: "target-record.json",
      oracle: "oracle.json",
      witness: "witness.cjs",
      fault: "rounding_floor_ceil@100",
      tests: ["test/a.js"],
      full_suite: true,
      candidate: { patch: "candidate.patch", assertion: "assertion-template.json" },
      limits: { total_minutes: 20 },
      ...change
    })
  });
  return dir;
}

const install = (dir: string, from: string, apply: boolean) => opInstallGithubAction({ repo: dir, profile_from: from, version: "0.2.59-demo.11", build_sha256: BUILD, apply });
const status = (dir: string) => git(dir, "status", "--porcelain", "--untracked-files=all");
const WRITTEN = [
  WORKFLOW_PATH,
  `${ACTIONS_DIR}/profile.json`,
  `${ACTIONS_DIR}/fixture-manifest.json`,
  `${ACTIONS_DIR}/package-lock.json`,
  `${ACTIONS_DIR}/target-record.json`,
  `${ACTIONS_DIR}/oracle.json`,
  `${ACTIONS_DIR}/witness.cjs`,
  `${ACTIONS_DIR}/candidate.patch`,
  `${ACTIONS_DIR}/assertion-template.json`,
  `${ACTIONS_DIR}/.gitignore`,
  MANAGED_LIST
];

describe("opro install-github-action (V1, V2)", () => {
  it("previews without writing, writes exactly its files with --yes, and changes nothing the second time", () => {
    const dir = repo();
    const from = source();
    const preview = install(dir, from, false);
    expect(preview.status).toBe("previewed");
    expect(preview.files.map((f) => [f.path, f.action])).toEqual(WRITTEN.map((p) => [p, "create"]));
    expect(status(dir)).toBe("");
    expect(renderInstall(preview).join("\n")).toContain("Preview only: nothing was written.");
    expect(preview.source_sharing).toContain("no model is called");

    const done = install(dir, from, true);
    expect([done.status, done.applied]).toEqual(["installed", true]);
    expect(status(dir).split("\n").map((l) => l.slice(3)).sort()).toEqual([...WRITTEN].sort());
    for (const p of WRITTEN) expect(existsSync(path.join(dir, p))).toBe(true);
    expect(readFileSync(path.join(dir, `${ACTIONS_DIR}/witness.cjs`), "utf8")).toBe(WITNESS);
    const profile = JSON.parse(readFileSync(path.join(dir, `${ACTIONS_DIR}/profile.json`), "utf8"));
    expect(checkActionsProfile(profile).ok).toBe(true);
    expect(profile).toMatchObject({ base_branch: "main", orangepro: { version: "0.2.59-demo.11", build_sha256: BUILD } });

    const before = WRITTEN.map((p) => [readFileSync(path.join(dir, p)), statSync(path.join(dir, p)).mtimeMs]);
    const again = install(dir, from, true);
    expect([again.status, again.applied]).toEqual(["unchanged", false]);
    expect(again.files.every((f) => f.action === "unchanged")).toBe(true);
    expect(WRITTEN.map((p) => [readFileSync(path.join(dir, p)), statSync(path.join(dir, p)).mtimeMs])).toEqual(before);
  });

  it("refuses to install over, or uninstall, a workflow that was edited or has no marker, and writes nothing", () => {
    const dir = repo();
    const from = source();
    install(dir, from, true);
    const wf = path.join(dir, WORKFLOW_PATH);
    const edited = `${readFileSync(wf, "utf8")}# my own line\n`;
    writeFileSync(wf, edited);
    for (const r of [install(dir, from, true), opInstallGithubAction({ repo: dir, uninstall: true, apply: true })]) {
      expect([r.status, r.applied]).toEqual(["conflict", false]);
      expect(r.files.find((f) => f.path === WORKFLOW_PATH)?.action).toBe("conflict");
    }
    expect(readFileSync(wf, "utf8")).toBe(edited);
    for (const p of WRITTEN) expect(existsSync(path.join(dir, p))).toBe(true);

    const fresh = repo();
    writeFiles(fresh, { [WORKFLOW_PATH]: "name: mine\non: push\n" });
    const r = install(fresh, from, true);
    expect(r.status).toBe("conflict");
    expect(readFileSync(path.join(fresh, WORKFLOW_PATH), "utf8")).toBe("name: mine\non: push\n");
    expect(existsSync(path.join(fresh, ACTIONS_DIR))).toBe(false);
  });

  it("refuses when a file in its folder was edited, and uninstall removes exactly what it wrote", () => {
    const dir = repo();
    const from = source();
    install(dir, from, true);
    const oracle = path.join(dir, `${ACTIONS_DIR}/oracle.json`);
    writeFileSync(oracle, "{}\n");
    expect(install(dir, from, true).files.find((f) => f.path === `${ACTIONS_DIR}/oracle.json`)?.action).toBe("conflict");
    expect(opInstallGithubAction({ repo: dir, uninstall: true, apply: true }).status).toBe("conflict");
    expect(readFileSync(oracle, "utf8")).toBe("{}\n");

    const clean = repo();
    install(clean, from, true);
    const preview = opInstallGithubAction({ repo: clean, uninstall: true, apply: false });
    expect(preview.files.map((f) => f.action).every((a) => a === "remove")).toBe(true);
    expect(status(clean)).not.toBe("");
    const gone = opInstallGithubAction({ repo: clean, uninstall: true, apply: true });
    expect(gone.status).toBe("uninstalled");
    expect(gone.files.map((f) => f.path).sort()).toEqual([...WRITTEN].sort());
    expect(status(clean)).toBe("");
    expect(opInstallGithubAction({ repo: clean, uninstall: true, apply: true }).status).toBe("nothing_installed");
  });

  it("keeps every file of its folder in git when the repository ignores one of them, and names what git would still ignore", () => {
    // Like Express: package-lock.json is ignored in every folder.
    const dir = repo();
    writeFiles(dir, { ".gitignore": "node_modules\npackage-lock.json\n" });
    commitAll(dir, "ignore lockfiles");
    const done = install(dir, source(), true);
    expect(done.ignored_by_git).toEqual([]);
    expect(status(dir).split("\n").map((l) => l.slice(3)).sort()).toEqual([...WRITTEN].sort());
    // A repository that ignores all of .orangepro/: the folder's own rule cannot reach inside an ignored folder.
    const hidden = repo();
    writeFiles(hidden, { ".gitignore": ".orangepro/\n" });
    commitAll(hidden, "ignore the workspace");
    expect(install(hidden, source(), false).ignored_by_git).toEqual([`${ACTIONS_DIR}/`]);
    const written = install(hidden, source(), true);
    expect(written.ignored_by_git).toEqual(WRITTEN.filter((p) => p.startsWith(`${ACTIONS_DIR}/`)).sort((a, b) => WRITTEN.indexOf(a) - WRITTEN.indexOf(b)));
    expect(renderInstall(written).join("\n")).toContain("git add -f");
  });

  it("refuses inputs that do not belong together, before writing anything", () => {
    const dir = repo();
    const from = source();
    writeFileSync(path.join(from, "witness.cjs"), "another witness\n");
    expect(() => install(dir, from, true)).toThrow(/witness is not the one the oracle names/);
    expect(() => install(dir, source({ oracle: "../oracle.json" }), true)).toThrow(/profile.json/);
    expect(() => opInstallGithubAction({ repo: dir, profile_from: source(), version: "0.2.59", build_sha256: BUILD, base: "--force", apply: true })).toThrow(/base_branch/);
    expect(status(dir)).toBe("");
  });
});

describe("the generated workflow (V3)", () => {
  const text = workflowYaml({ base: "master", version: "0.2.59-demo.11", totalMinutes: 20 });
  const doc = yaml.load(text);
  const steps: any[] = doc.jobs.prove.steps;

  it("parses, carries its own marker, and starts on a push to the base branch or by hand", () => {
    expect(ownedWorkflow(Buffer.from(text))).toBe(true);
    expect(ownedWorkflow(Buffer.from(`${text}#`))).toBe(false);
    expect(doc.on.push.branches).toEqual(["master"]);
    expect(Object.keys(doc.on.workflow_dispatch.inputs)).toEqual(["merged_sha", "previous_base"]);
    expect(Object.keys(doc.on)).toEqual(["push", "workflow_dispatch"]);
    expect(doc.jobs.prove["timeout-minutes"]).toBe(35);
  });

  it("asks for read access only, uses no secret, keeps no token, and pins every action to a commit", () => {
    expect(doc.permissions).toEqual({ contents: "read" });
    expect(Object.keys(doc.jobs.prove)).not.toContain("permissions");
    expect(text).not.toMatch(/secrets\./);
    expect(text).not.toMatch(/pull_request_target/);
    const uses = steps.filter((s) => s.uses).map((s) => s.uses as string);
    expect(uses).toHaveLength(4);
    for (const u of uses) expect(u).toMatch(/^actions\/[a-z-]+@[0-9a-f]{40}$/);
    for (const s of steps.filter((s) => String(s.uses).startsWith("actions/checkout@"))) expect(s.with["persist-credentials"]).toBe(false);
    for (const s of steps.filter((s) => s.run)) expect(s.run).not.toMatch(/\$\{\{/);
    expect(steps.at(-1)).toMatchObject({ if: "always()" });
  });

  it("checks out the profile's branch and the commit to prove side by side, the commit id in a with: value only", () => {
    expect(steps[0].with).toMatchObject({ path: "orangepro-config", "sparse-checkout": ACTIONS_DIR });
    expect(steps[1].with).toMatchObject({ path: "repo", ref: "${{ inputs.merged_sha || github.sha }}", "fetch-depth": 0 });
    expect(steps.find((s) => s.name === "Prove").run).toContain(`--profile orangepro-config/${ACTIONS_DIR}/profile.json --repo repo`);
    expect(steps.find((s) => s.name === "Install OrangePro").run).toContain('"@orangepro/orangepro-mcp@0.2.59-demo.11"');
  });
});

describe("the MCP installer tool", () => {
  it("previews by default and writes only with dry_run: false and the matching confirm", async () => {
    const dir = repo();
    const from = source();
    const tool = (createLocalServer() as any)._registeredTools.orangepro_install_github_action;
    const preview = await tool.handler({ workspace: dir, profile_from: from, opro_version: "0.2.59-demo.11", build_sha256: BUILD }, {});
    expect(JSON.parse(preview.content[0].text).status).toBe("previewed");
    expect(status(dir)).toBe("");
    const refused = await tool.handler({ workspace: dir, profile_from: from, opro_version: "0.2.59-demo.11", build_sha256: BUILD, dry_run: false }, {});
    expect(refused.isError).toBe(true);
    expect(status(dir)).toBe("");
    const done = await tool.handler({ workspace: dir, profile_from: from, opro_version: "0.2.59-demo.11", build_sha256: BUILD, dry_run: false, confirm: "install" }, {});
    expect(JSON.parse(done.content[0].text).status).toBe("installed");
  });
});
