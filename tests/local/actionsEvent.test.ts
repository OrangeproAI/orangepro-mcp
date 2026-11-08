import { writeFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { changedFiles, readActionsEvent, testOnlyChange } from "../../src/local/actionsEvent.js";
import { commitAll, git, tempDir } from "./support/probeWorkspace.js";

/** A repository with a line of commits on main: returns their ids, oldest first. */
function history(count: number): { repo: string; commits: string[] } {
  const repo = tempDir("events");
  git(repo, "init", "-q", "-b", "main");
  const commits: string[] = [];
  for (let i = 0; i < count; i++) {
    writeFileSync(path.join(repo, `file${i}.js`), `module.exports = ${i};\n`);
    commits.push(commitAll(repo, `commit ${i}`));
  }
  return { repo, commits };
}

const ZERO = "0".repeat(40);

describe("actions-run events: what a push or a manual run asks to prove", () => {
  it("takes one commit pushed after its first parent as one change", () => {
    const { repo, commits } = history(2);
    const d = readActionsEvent("push", { before: commits[0], after: commits[1] }, repo);
    expect(d).toEqual({ ok: true, name: "push", base: commits[0], merged: commits[1], mode: "first_parent", commits: [commits[1]] });
  });

  it("takes two commits in one push as a range of 2, listed oldest first", () => {
    const { repo, commits } = history(3);
    const d = readActionsEvent("push", { before: commits[0], after: commits[2] }, repo);
    expect(d.ok && d.mode).toBe("range");
    expect(d.ok && d.commits).toEqual([commits[1], commits[2]]);
  });

  it("skips the push that created the branch", () => {
    const { repo, commits } = history(1);
    expect(readActionsEvent("push", { before: ZERO, after: commits[0] }, repo)).toMatchObject({ ok: false, status: "skipped", reason: "initial_push" });
  });

  it("blocks a forced push, and one whose previous base is not an ancestor", () => {
    const { repo, commits } = history(2);
    expect(readActionsEvent("push", { before: commits[0], after: commits[1], forced: true }, repo)).toMatchObject({ ok: false, status: "blocked", reason: "force_push" });
    // History rewritten: a sibling of the pushed commit, not its ancestor.
    git(repo, "checkout", "-q", "-b", "side", commits[0]);
    writeFileSync(path.join(repo, "side.js"), "module.exports = 'side';\n");
    const side = commitAll(repo, "side");
    git(repo, "checkout", "-q", "main");
    expect(readActionsEvent("push", { before: side, after: commits[1] }, repo)).toMatchObject({ ok: false, status: "blocked", reason: "force_push" });
    // A previous base that is not in the checkout at all.
    expect(readActionsEvent("push", { before: "a".repeat(40), after: commits[1] }, repo)).toMatchObject({ ok: false, status: "blocked", reason: "force_push" });
  });

  it("takes a manual run's commits from its inputs, full ids only, base an ancestor", () => {
    const { repo, commits } = history(3);
    git(repo, "checkout", "-q", commits[1]);
    expect(readActionsEvent("workflow_dispatch", { inputs: { merged_sha: commits[1], previous_base: commits[0] } }, repo)).toMatchObject({ ok: true, mode: "first_parent", base: commits[0], merged: commits[1] });
    expect(readActionsEvent("workflow_dispatch", { inputs: { merged_sha: commits[1], previous_base: commits[2] } }, repo)).toMatchObject({ ok: false, status: "blocked", reason: "base_not_ancestor" });
    expect(readActionsEvent("workflow_dispatch", { inputs: { merged_sha: commits[1].slice(0, 12), previous_base: commits[0] } }, repo)).toMatchObject({ ok: false, reason: "event_invalid" });
    expect(readActionsEvent("workflow_dispatch", { inputs: { merged_sha: "HEAD", previous_base: commits[0] } }, repo)).toMatchObject({ ok: false, reason: "event_invalid" });
  });

  it("blocks when the checkout is not at the commit to prove, and other events", () => {
    const { repo, commits } = history(3);
    expect(readActionsEvent("push", { before: commits[0], after: commits[1] }, repo)).toMatchObject({ ok: false, reason: "head_mismatch" });
    expect(readActionsEvent("pull_request_target", {}, repo)).toMatchObject({ ok: false, reason: "unsupported_event" });
    expect(readActionsEvent("push", { before: commits[1] }, repo)).toMatchObject({ ok: false, reason: "event_invalid" });
  });

  it("calls a change test-only when every file is an allowed test file and none is on the never-list", () => {
    const allowed = { patterns: ["test/*.js", "test/acceptance/*.js"], never: ["test/support/**"] };
    expect(testOnlyChange(["test/res.cookie.js"], allowed)).toBe(true);
    expect(testOnlyChange(["test/res.cookie.js", "lib/response.js"], allowed)).toBe(false);
    expect(testOnlyChange(["test/support/env.js"], { patterns: ["test/**"], never: ["test/support/**"] })).toBe(false);
    expect(testOnlyChange([], allowed)).toBe(false);
    const { repo, commits } = history(2);
    expect(changedFiles(repo, commits[0], commits[1])).toEqual(["file1.js"]);
  });
});
