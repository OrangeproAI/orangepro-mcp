import { gitBytes, type GitBytes } from "./changedTargets.js";
import { globMatches } from "./candidateTest.js";

// What `opro actions-run` (V2) proves, read from the GitHub event that started the job:
// a push to the base branch (`before` → `after`), or a manual run naming a merged commit
// and its previous base. Only full commit ids are taken, from the event file, never from
// a shell line. History that is unsafe to prove (a first push, a rewritten one) is
// reported, not proven; several commits in one push are one range, listed.

export const ACTIONS_EVENT_NAMES = ["push", "workflow_dispatch"] as const;
export type ActionsEventName = (typeof ACTIONS_EVENT_NAMES)[number];

export interface ActionsChange {
  ok: true;
  name: ActionsEventName;
  base: string;
  merged: string;
  /** first_parent: `base` is the merged commit's first parent; range: an ancestor further back. */
  mode: "first_parent" | "range";
  /** The base branch's commits in `base..merged`, oldest first (first parents only). */
  commits: string[];
}

export interface ActionsStop {
  ok: false;
  status: "skipped" | "blocked";
  reason: string;
  detail: string;
  base: string | null;
  merged: string | null;
}

export type ActionsEventDecision = ActionsChange | ActionsStop;

const FULL_SHA_RE = /^[0-9a-f]{40}$/;
const ZERO_SHA = "0".repeat(40);
const GIT_ARGS = ["--no-pager", "--no-optional-locks", "-c", "core.quotePath=false"];

const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export function readActionsEvent(name: string, payload: unknown, repo: string, git: GitBytes = gitBytes): ActionsEventDecision {
  const run = (args: string[]): Buffer | null => git(repo, [...GIT_ARGS, ...args]);
  const line = (args: string[]): string | null => {
    const out = run(args);
    return out === null ? null : out.toString("utf8").trim();
  };
  const stop = (status: ActionsStop["status"], reason: string, detail: string, base: string | null = null, merged: string | null = null): ActionsStop => ({
    ok: false,
    status,
    reason,
    detail,
    base,
    merged
  });
  const isCommit = (sha: string): boolean => line(["rev-parse", "--verify", "--quiet", `${sha}^{commit}`]) === sha;

  if (!(ACTIONS_EVENT_NAMES as readonly string[]).includes(name)) {
    return stop("blocked", "unsupported_event", `the workflow was started by "${name}"; only push and workflow_dispatch are proven.`);
  }
  if (!isPlain(payload)) return stop("blocked", "event_invalid", "the event file is not a JSON object.");

  let base: string;
  let merged: string;
  if (name === "push") {
    const before = payload.before;
    const after = payload.after;
    if (typeof before !== "string" || typeof after !== "string" || !FULL_SHA_RE.test(before) || !FULL_SHA_RE.test(after)) {
      return stop("blocked", "event_invalid", "the push event has no full before and after commit ids.");
    }
    if (before === ZERO_SHA) return stop("skipped", "initial_push", "this push created the branch: there is no previous base to compare with.", null, after);
    if (after === ZERO_SHA) return stop("skipped", "branch_deleted", "this push deleted the branch.", before, null);
    if (!isCommit(after)) return stop("blocked", "event_invalid", `the pushed commit ${after} is not in the checkout.`, before, after);
    if (payload.forced === true) return stop("blocked", "force_push", "the push rewrote the branch's history (forced): the previous base is not an ancestor to compare with.", before, after);
    if (!isCommit(before) || run(["merge-base", "--is-ancestor", before, after]) === null) {
      return stop("blocked", "force_push", `the previous base ${before} is not an ancestor of ${after}: the branch's history was rewritten.`, before, after);
    }
    base = before;
    merged = after;
  } else {
    const inputs = isPlain(payload.inputs) ? payload.inputs : {};
    const mergedSha = typeof inputs.merged_sha === "string" ? inputs.merged_sha.trim() : "";
    const previousBase = typeof inputs.previous_base === "string" ? inputs.previous_base.trim() : "";
    if (!FULL_SHA_RE.test(mergedSha) || !FULL_SHA_RE.test(previousBase)) {
      return stop("blocked", "event_invalid", "a manual run needs merged_sha and previous_base as full 40-character lowercase commit ids.");
    }
    if (mergedSha === previousBase) return stop("blocked", "event_invalid", "merged_sha and previous_base are the same commit.", previousBase, mergedSha);
    if (!isCommit(mergedSha) || !isCommit(previousBase)) {
      return stop("blocked", "event_invalid", "merged_sha or previous_base is not a commit in the checkout.", previousBase, mergedSha);
    }
    if (run(["merge-base", "--is-ancestor", previousBase, mergedSha]) === null) {
      return stop("blocked", "base_not_ancestor", `${previousBase} is not an ancestor of ${mergedSha}.`, previousBase, mergedSha);
    }
    base = previousBase;
    merged = mergedSha;
  }

  const head = line(["rev-parse", "--verify", "--quiet", "HEAD^{commit}"]);
  if (head !== merged) return stop("blocked", "head_mismatch", `the checkout is at ${head ?? "no commit"}, not the commit to prove (${merged}).`, base, merged);
  const firstParent = line(["rev-parse", "--verify", "--quiet", `${merged}^1^{commit}`]);
  const commits = (line(["rev-list", "--first-parent", "--reverse", `${base}..${merged}`]) ?? "").split("\n").filter(Boolean);
  return { ok: true, name: name as ActionsEventName, base, merged, mode: firstParent === base ? "first_parent" : "range", commits };
}

/** Files the change touches, as git names them (`--no-renames`: a rename is a removal and an addition). null when git fails. */
export function changedFiles(repo: string, base: string, merged: string, git: GitBytes = gitBytes): string[] | null {
  const out = git(repo, [...GIT_ARGS, "diff", "--name-only", "-z", "--no-renames", "--no-ext-diff", base, merged]);
  return out === null ? null : out.toString("utf8").split("\0").filter(Boolean).sort();
}

/**
 * True when every changed file is one the fixture allows a test patch to touch, and none is
 * on its never-list: OrangePro's own test patch, merged, must not start another proof. Read
 * from the changed files, never from a commit message. An empty change is not test-only.
 */
export function testOnlyChange(files: string[], allowed: { patterns: string[]; never: string[] }): boolean {
  if (files.length === 0 || allowed.patterns.length === 0) return false;
  return files.every((file) => allowed.patterns.some((pattern) => globMatches(pattern, file)) && !allowed.never.some((pattern) => globMatches(pattern, file)));
}
