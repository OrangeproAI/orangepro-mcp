import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { ACTIONS_PROFILE_VERSION, BRANCH_RE, checkActionsProfile, profilePathOk, type ActionsProfile } from "./actionsRun.js";
import { checkBuild } from "./buildInfo.js";
import { gitBytes, type GitBytes } from "./changedTargets.js";
import { canonicalJson, recordSha256, sha256Hex, writeFileAtomic } from "./contracts/io.js";
import { ORANGEPRO_VERSION } from "./version.js";

// `opro install-github-action` (V2): writes the post-merge workflow and the folder it reads
// (`.orangepro/actions/`: the profile and its inputs) into a repository, and only when asked.
// By default it shows what it would write and writes nothing. It never runs git commands that
// write, and never commits, pushes, creates a secret, grants a permission or opens a pull
// request. Every file it writes carries proof of authorship: the workflow its first line,
// the folder a list of each file's sha256. A file changed since then is the user's: install
// and uninstall both refuse rather than overwrite or remove it.

export const WORKFLOW_PATH = ".github/workflows/orangepro-proof.yml";
export const ACTIONS_DIR = ".orangepro/actions";
export const MANAGED_LIST = `${ACTIONS_DIR}/orangepro-managed.json`;
// The folder's own ignore file: a repository that ignores, say, every package-lock.json would otherwise keep
// the frozen lockfile out of git, and the workflow would not find it. A lower-level `!*` re-includes them all.
export const FOLDER_GITIGNORE = `${ACTIONS_DIR}/.gitignore`;
const FOLDER_GITIGNORE_TEXT = "# Written by OrangePro: the post-merge workflow reads every file in this folder,\n# so none of them is ignored here, whatever the repository's own ignore rules say.\n!*\n";
export const MARKER_PREFIX = "# Managed by OrangePro; sha256 of the rest: ";
export const HOST_NODE_VERSION = "22.23.4";
export const PINNED_ACTIONS = {
  checkout: { sha: "3d3c42e5aac5ba805825da76410c181273ba90b1", tag: "v7.0.1" },
  setupNode: { sha: "949feb2413d6458794dcd2491c4babbbce0c15c1", tag: "v7.1.0" },
  uploadArtifact: { sha: "cf430e030ddbb5b0abf93d22962f4752f3646cd9", tag: "v7.0.2" },
  // Released with upload-artifact v7.0.2 (7 Oct 2026); used only by the opt-in deliver job.
  downloadArtifact: { sha: "9000827ccba6bdab643e8b6fd33ac0654aef8333", tag: "v8.0.2" }
} as const;
export const DELIVER_JOB_MINUTES = 15;
export const JOB_MARGIN_MINUTES = 15;
const SOURCE_SHARING = "none: no model is called; the job uploads its artifacts to this repository's own Actions run and sends nothing anywhere else";

export interface InstallOptions {
  repo: string;
  /** A folder holding `profile.json` and the files it names. Needed to install, not to uninstall. */
  profile_from?: string;
  base?: string;
  version?: string;
  build_sha256?: string;
  /** false (the default): preview only, nothing is written. */
  apply: boolean;
  uninstall?: boolean;
  /** V3: add the separate deliver job that opens a draft test PR (opt-in; the only job with write permissions). */
  deliver?: "draft-pr";
}

export type FileAction = "create" | "unchanged" | "update" | "remove" | "conflict";

export interface InstallResult {
  mode: "install" | "uninstall";
  applied: boolean;
  status: "previewed" | "installed" | "unchanged" | "uninstalled" | "nothing_installed" | "conflict";
  files: Array<{ path: string; action: FileAction; reason: string | null }>;
  /** The files' text as they would be written (install only). */
  workflow: string | null;
  profile: string | null;
  diffs: Array<{ path: string; diff: string }>;
  base_branch: string | null;
  orangepro: { version: string; build_sha256: string } | null;
  permissions: string;
  commands: string[];
  time_limits: { total_minutes: number; job_minutes: number } | null;
  source_sharing: string;
  /** Written files git would still ignore (for example when all of `.orangepro/` is ignored): they must be added with `git add -f`. */
  ignored_by_git: string[];
  notes: string[];
}

interface DesiredFile {
  path: string;
  bytes: Buffer;
}

export class InstallError extends Error {}

/** True when the workflow's first line names the sha256 of everything after it. */
export function ownedWorkflow(bytes: Buffer): boolean {
  const text = bytes.toString("utf8");
  const newline = text.indexOf("\n");
  if (newline < 0 || !text.startsWith(MARKER_PREFIX)) return false;
  return text.slice(MARKER_PREFIX.length, newline) === sha256Hex(Buffer.from(text.slice(newline + 1), "utf8"));
}

export function workflowYaml(args: { base: string; version: string; totalMinutes: number; deliver?: boolean }): string {
  if (!BRANCH_RE.test(args.base)) throw new InstallError(`${args.base} is not a branch name the workflow can carry.`);
  const { checkout, setupNode, uploadArtifact, downloadArtifact } = PINNED_ACTIONS;
  // V3, opt-in: a separate job, after prove, that checks out nothing and runs no repository code.
  // It downloads this run's artifact and runs publish-tests, which checks the receipt and opens one draft PR.
  const deliverJob = !args.deliver ? [] : [
    "  deliver:",
    "    needs: prove",
    "    runs-on: ubuntu-24.04",
    `    timeout-minutes: ${DELIVER_JOB_MINUTES}`,
    "    permissions:",
    "      contents: write",
    "      pull-requests: write",
    "    steps:",
    "      - name: Set up Node",
    `        uses: actions/setup-node@${setupNode.sha} # ${setupNode.tag}`,
    "        with:",
    `          node-version: "${HOST_NODE_VERSION}"`,
    "      - name: Install OrangePro",
    `        run: 'npm install --no-audit --no-fund --prefix "$RUNNER_TEMP/opro" "@orangepro/orangepro-mcp@${args.version}"'`,
    "      - name: Download the proof artifacts",
    `        uses: actions/download-artifact@${downloadArtifact.sha} # ${downloadArtifact.tag}`,
    "        with:",
    "          name: orangepro-proof-${{ github.run_id }}-${{ github.run_attempt }}",
    "          path: ${{ runner.temp }}/orangepro-in",
    "      - name: Deliver a draft test PR",
    "        env:",
    "          GITHUB_TOKEN: ${{ github.token }}",
    "          MERGED_SHA: ${{ inputs.merged_sha || github.sha }}",
    `        run: '"$RUNNER_TEMP/opro/node_modules/.bin/opro" publish-tests --from-actions "$RUNNER_TEMP/orangepro-in" --repo "$GITHUB_REPOSITORY" --base ${JSON.stringify(args.base)} --merged "$MERGED_SHA" --yes --out "$RUNNER_TEMP/orangepro-delivery" --summary "$GITHUB_STEP_SUMMARY"'`,
    "      - name: Upload the delivery record",
    "        if: always()",
    `        uses: actions/upload-artifact@${uploadArtifact.sha} # ${uploadArtifact.tag}`,
    "        with:",
    "          name: orangepro-delivery-${{ github.run_id }}-${{ github.run_attempt }}",
    "          path: ${{ runner.temp }}/orangepro-delivery",
    "          if-no-files-found: warn",
    // The proof artifact with both reports re-rendered to carry the read-back PR (M2): the report to share.
    "      - name: Upload the report",
    "        if: always()",
    `        uses: actions/upload-artifact@${uploadArtifact.sha} # ${uploadArtifact.tag}`,
    "        with:",
    "          name: orangepro-report-${{ github.run_id }}-${{ github.run_attempt }}",
    "          path: ${{ runner.temp }}/orangepro-in",
    "          if-no-files-found: warn"
  ];
  const body = [
    "name: OrangePro proof after merge",
    "on:",
    "  push:",
    `    branches: [${JSON.stringify(args.base)}]`,
    "  workflow_dispatch:",
    "    inputs:",
    "      merged_sha:",
    '        description: "Merged commit to prove (its full 40-character id)"',
    "        required: true",
    "        type: string",
    "      previous_base:",
    '        description: "Its previous base (its full 40-character id)"',
    "        required: true",
    "        type: string",
    "permissions:",
    "  contents: read",
    "concurrency:",
    "  group: orangepro-proof-${{ github.sha }}",
    "  cancel-in-progress: false",
    "jobs:",
    "  prove:",
    "    runs-on: ubuntu-24.04",
    `    timeout-minutes: ${Math.ceil(args.totalMinutes) + JOB_MARGIN_MINUTES}`,
    "    steps:",
    "      - name: Check out the OrangePro profile",
    `        uses: actions/checkout@${checkout.sha} # ${checkout.tag}`,
    "        with:",
    "          path: orangepro-config",
    `          sparse-checkout: ${ACTIONS_DIR}`,
    "          persist-credentials: false",
    "      - name: Check out the commit to prove",
    `        uses: actions/checkout@${checkout.sha} # ${checkout.tag}`,
    "        with:",
    "          path: repo",
    "          ref: ${{ inputs.merged_sha || github.sha }}",
    "          fetch-depth: 0",
    "          persist-credentials: false",
    "      - name: Set up Node",
    `        uses: actions/setup-node@${setupNode.sha} # ${setupNode.tag}`,
    "        with:",
    `          node-version: "${HOST_NODE_VERSION}"`,
    "      - name: Install OrangePro",
    `        run: 'npm install --no-audit --no-fund --prefix "$RUNNER_TEMP/opro" "@orangepro/orangepro-mcp@${args.version}"'`,
    "      - name: Prove",
    `        run: '"$RUNNER_TEMP/opro/node_modules/.bin/opro" actions-run --event-name "$GITHUB_EVENT_NAME" --event "$GITHUB_EVENT_PATH" --profile orangepro-config/${ACTIONS_DIR}/profile.json --repo repo --out "$RUNNER_TEMP/orangepro-out" --summary "$GITHUB_STEP_SUMMARY"'`,
    "      - name: Upload the proof artifacts",
    "        if: always()",
    `        uses: actions/upload-artifact@${uploadArtifact.sha} # ${uploadArtifact.tag}`,
    "        with:",
    "          name: orangepro-proof-${{ github.run_id }}-${{ github.run_attempt }}",
    "          path: ${{ runner.temp }}/orangepro-out",
    "          if-no-files-found: warn",
    ...deliverJob,
    ""
  ].join("\n");
  return `${MARKER_PREFIX}${sha256Hex(Buffer.from(body, "utf8"))}\n${body}`;
}

interface ManagedList {
  managed_by: "OrangePro";
  note: string;
  files: Record<string, string>;
  sha256: string;
}

function managedListBytes(files: Record<string, string>): Buffer {
  const sorted = Object.fromEntries(Object.entries(files).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
  const list: ManagedList = {
    managed_by: "OrangePro",
    note: "Written by opro install-github-action. Each file's sha256 as written; a file that no longer matches is yours, and OrangePro will not overwrite or remove it.",
    files: sorted,
    sha256: sha256Hex(Buffer.from(canonicalJson(sorted), "utf8"))
  };
  return Buffer.from(`${JSON.stringify(list, null, 2)}\n`, "utf8");
}

/** The list's files when it is the list OrangePro wrote (its own sha256 holds), else null. */
function readManagedList(repo: string): Record<string, string> | null {
  const at = join(repo, MANAGED_LIST);
  if (!existsSync(at)) return null;
  try {
    const list = JSON.parse(readFileSync(at, "utf8")) as Partial<ManagedList>;
    if (list.managed_by !== "OrangePro" || typeof list.files !== "object" || list.files === null) return null;
    if (list.sha256 !== sha256Hex(Buffer.from(canonicalJson(list.files), "utf8"))) return null;
    return list.files as Record<string, string>;
  } catch {
    return null;
  }
}

function fileBytes(repo: string, rel: string): Buffer | null {
  const at = join(repo, rel);
  if (!existsSync(at)) return null;
  if (!lstatSync(at).isFile()) return Buffer.from([]);
  return readFileSync(at);
}

/** Everything in the actions folder, repository-relative. */
function folderFiles(repo: string): string[] {
  const found: string[] = [];
  const walk = (rel: string): void => {
    const abs = join(repo, rel);
    if (!existsSync(abs)) return;
    for (const name of readdirSync(abs)) {
      const child = `${rel}/${name}`;
      if (lstatSync(join(repo, child)).isDirectory()) walk(child);
      else found.push(child);
    }
  };
  walk(ACTIONS_DIR);
  return found.sort();
}

function lineDiff(path: string, before: string, after: string): string {
  const a = before.split("\n");
  const b = after.split("\n");
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) start++;
  let endA = a.length;
  let endB = b.length;
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
  }
  return [`--- a/${path}`, `+++ b/${path}`, `@@ -${start + 1},${endA - start} +${start + 1},${endB - start} @@`, ...a.slice(start, endA).map((l) => `-${l}`), ...b.slice(start, endB).map((l) => `+${l}`)].join("\n");
}

export function defaultBaseBranch(repo: string, git: GitBytes = gitBytes): string {
  const out = git(repo, ["--no-pager", "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  const ref = out?.toString("utf8").trim() ?? "";
  return ref.startsWith("origin/") && BRANCH_RE.test(ref.slice("origin/".length)) ? ref.slice("origin/".length) : "main";
}

function loadSourceProfile(from: string, base: string, version: string, build: string): { profile: ActionsProfile; inputs: DesiredFile[] } {
  const at = join(from, "profile.json");
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(readFileSync(at, "utf8")) as Record<string, unknown>;
  } catch (error) {
    throw new InstallError(`${at} could not be read as JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const checked = checkActionsProfile({ version: ACTIONS_PROFILE_VERSION, ...value, base_branch: base, orangepro: { version, build_sha256: build } });
  if (!checked.ok) throw new InstallError(`profile.json: ${checked.message}`);
  const profile = checked.profile;
  const names = [profile.fixture.manifest, profile.fixture.lockfile, profile.target_record, profile.oracle, profile.witness, profile.candidate?.patch, profile.candidate?.assertion].filter(
    (name): name is string => typeof name === "string"
  );
  const inputs: DesiredFile[] = [];
  for (const name of [...new Set(names)]) {
    if (!profilePathOk(name) || ["profile.json", "orangepro-managed.json", ".gitignore"].includes(name)) throw new InstallError(`${name} cannot be one of the profile's inputs.`);
    const abs = join(from, name);
    if (!existsSync(abs) || !lstatSync(abs).isFile()) throw new InstallError(`${name} is not a regular file in ${from} (a symbolic link is not taken).`);
    inputs.push({ path: `${ACTIONS_DIR}/${name}`, bytes: readFileSync(abs) });
  }
  // Inputs that cannot belong together are caught here, not on the runner.
  const read = (name: string) => inputs.find((input) => input.path === `${ACTIONS_DIR}/${name}`)!.bytes;
  try {
    const oracle = JSON.parse(read(profile.oracle).toString("utf8")) as { target_record_sha256?: unknown; witness?: { sha256?: unknown } };
    if (oracle.target_record_sha256 !== recordSha256(JSON.parse(read(profile.target_record).toString("utf8")))) throw new InstallError("the oracle is for another target record.");
    if (oracle.witness?.sha256 !== sha256Hex(read(profile.witness))) throw new InstallError("the witness is not the one the oracle names.");
    const manifest = JSON.parse(read(profile.fixture.manifest).toString("utf8")) as { dependencies?: { lockfile_sha256?: unknown } };
    if (profile.fixture.lockfile && manifest.dependencies?.lockfile_sha256 !== sha256Hex(read(profile.fixture.lockfile))) throw new InstallError("the lockfile is not the one the fixture manifest names.");
  } catch (error) {
    if (error instanceof InstallError) throw error;
    throw new InstallError(`the profile's inputs could not be read: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { profile, inputs };
}

export function opInstallGithubAction(opts: InstallOptions, deps: { git?: GitBytes } = {}): InstallResult {
  const repo = resolve(opts.repo);
  const git = deps.git ?? gitBytes;
  if (!existsSync(repo) || !lstatSync(repo).isDirectory()) throw new InstallError(`${opts.repo} is not a folder.`);
  const result: InstallResult = {
    mode: opts.uninstall ? "uninstall" : "install",
    applied: false,
    status: "previewed",
    files: [],
    workflow: null,
    profile: null,
    diffs: [],
    base_branch: null,
    orangepro: null,
    permissions: "contents: read (no write permission, no secrets; the checkouts keep no token)",
    commands: [],
    time_limits: null,
    source_sharing: SOURCE_SHARING,
    ignored_by_git: [],
    notes: []
  };
  const managed = readManagedList(repo);
  const present = folderFiles(repo);

  if (opts.uninstall) {
    const workflow = fileBytes(repo, WORKFLOW_PATH);
    if (workflow) result.files.push(ownedWorkflow(workflow) ? { path: WORKFLOW_PATH, action: "remove", reason: null } : { path: WORKFLOW_PATH, action: "conflict", reason: "changed since OrangePro wrote it, or not written by OrangePro: remove it by hand if you want it gone" });
    if (managed) {
      for (const [path, sha] of Object.entries(managed)) {
        const bytes = fileBytes(repo, path);
        if (bytes) result.files.push(sha256Hex(bytes) === sha ? { path, action: "remove", reason: null } : { path, action: "conflict", reason: "changed since OrangePro wrote it: remove it by hand if you want it gone" });
      }
      result.files.push({ path: MANAGED_LIST, action: "remove", reason: null });
    } else if (present.length > 0) {
      result.files.push({ path: ACTIONS_DIR, action: "conflict", reason: "its list of OrangePro's files is missing or was changed, so OrangePro cannot tell its own files from yours" });
    }
    for (const path of present) {
      if (!result.files.some((file) => file.path === path) && !(managed && path === MANAGED_LIST)) result.notes.push(`${path} was not written by OrangePro and stays.`);
    }
    if (result.files.some((file) => file.action === "conflict")) return { ...result, status: "conflict" };
    if (result.files.length === 0) return { ...result, status: "nothing_installed" };
    if (!opts.apply) return result;
    for (const file of result.files) rmSync(join(repo, file.path), { force: true });
    removeEmpty(join(repo, ACTIONS_DIR));
    return { ...result, applied: true, status: "uninstalled" };
  }

  if (!opts.profile_from) throw new InstallError("--profile-from <folder> is needed: the folder with profile.json and the files it names.");
  const base = opts.base ?? defaultBaseBranch(repo, git);
  const build = opts.build_sha256 ?? checkBuild().build_sha256;
  if (!build) throw new InstallError("this OrangePro has no build stamp (it runs from source): pass --build <sha256> and --version for the build the workflow installs.");
  const version = opts.version ?? ORANGEPRO_VERSION;
  const { profile, inputs } = loadSourceProfile(resolve(opts.profile_from), base, version, build);
  const profileText = `${JSON.stringify(profile, null, 2)}\n`;
  const deliver = opts.deliver === "draft-pr";
  const workflowText = workflowYaml({ base, version, totalMinutes: profile.limits.total_minutes, deliver });
  const folder: DesiredFile[] = [{ path: `${ACTIONS_DIR}/profile.json`, bytes: Buffer.from(profileText, "utf8") }, ...inputs, { path: FOLDER_GITIGNORE, bytes: Buffer.from(FOLDER_GITIGNORE_TEXT, "utf8") }];
  const desired: DesiredFile[] = [{ path: WORKFLOW_PATH, bytes: Buffer.from(workflowText, "utf8") }, ...folder, { path: MANAGED_LIST, bytes: managedListBytes(Object.fromEntries(folder.map((file) => [file.path, sha256Hex(file.bytes)]))) }];
  Object.assign(result, {
    workflow: workflowText,
    profile: profileText,
    base_branch: base,
    orangepro: { version, build_sha256: build },
    commands: [
      `npm install --no-audit --no-fund --prefix "$RUNNER_TEMP/opro" "@orangepro/orangepro-mcp@${version}"`,
      `opro actions-run --event-name "$GITHUB_EVENT_NAME" --event "$GITHUB_EVENT_PATH" --profile orangepro-config/${ACTIONS_DIR}/profile.json --repo repo --out "$RUNNER_TEMP/orangepro-out" --summary "$GITHUB_STEP_SUMMARY"`,
      ...(deliver ? [`opro publish-tests --from-actions "$RUNNER_TEMP/orangepro-in" --repo "$GITHUB_REPOSITORY" --base ${JSON.stringify(base)} --merged "$MERGED_SHA" --yes --out "$RUNNER_TEMP/orangepro-delivery" --summary "$GITHUB_STEP_SUMMARY"`] : [])
    ],
    ...(deliver
      ? {
          permissions: "prove: contents: read (no write permission, no secrets; the checkouts keep no token). deliver (opt-in): contents: write and pull-requests: write, in a job that checks out nothing and runs no repository code",
          notes: [
            ...result.notes,
            "The deliver job opens a draft PR with the workflow's own token. The repository must allow it: Settings → Actions → General → Workflow permissions → \"Allow GitHub Actions to create and approve pull requests\".",
            "Delivery happens only for a verified gap, only while the base branch still points at the proven commit, and only to orangepro/tests/<merged sha, 12>; nothing is force-pushed or merged."
          ]
        }
      : {}),
    time_limits: { total_minutes: profile.limits.total_minutes, job_minutes: Math.ceil(profile.limits.total_minutes) + JOB_MARGIN_MINUTES }
  });

  for (const file of desired) {
    const existing = fileBytes(repo, file.path);
    if (!existing) {
      result.files.push({ path: file.path, action: "create", reason: null });
      continue;
    }
    if (existing.equals(file.bytes)) {
      result.files.push({ path: file.path, action: "unchanged", reason: null });
      continue;
    }
    const ours = file.path === WORKFLOW_PATH ? ownedWorkflow(existing) : file.path === MANAGED_LIST ? managed !== null : managed?.[file.path] === sha256Hex(existing);
    if (!ours) {
      result.files.push({ path: file.path, action: "conflict", reason: file.path === MANAGED_LIST ? "the list of OrangePro's files was changed" : "changed since OrangePro wrote it, or not written by OrangePro" });
      continue;
    }
    result.files.push({ path: file.path, action: "update", reason: null });
    result.diffs.push({ path: file.path, diff: lineDiff(file.path, existing.toString("utf8"), file.bytes.toString("utf8")) });
  }
  // Files an earlier install wrote that this one no longer needs.
  for (const [path, sha] of Object.entries(managed ?? {})) {
    if (desired.some((file) => file.path === path)) continue;
    const bytes = fileBytes(repo, path);
    if (bytes) result.files.push(sha256Hex(bytes) === sha ? { path, action: "remove", reason: "no longer part of the profile" } : { path, action: "conflict", reason: "changed since OrangePro wrote it" });
  }
  for (const path of present) {
    if (!desired.some((file) => file.path === path) && !(managed && path in managed)) result.notes.push(`${path} was not written by OrangePro and stays.`);
  }
  if (result.files.some((file) => file.action === "conflict")) return { ...result, status: "conflict" };
  const ignoredNote = (paths: string[]): void => {
    result.ignored_by_git = paths;
    if (paths.length > 0) result.notes.push(`git ignores ${paths.join(", ")}, so the workflow would not see ${paths.length === 1 ? "it" : "them"}. Add them with: git add -f ${paths.join(" ")}`);
  };
  if (!opts.apply || result.files.every((file) => file.action === "unchanged")) {
    // Before writing, only a folder ignored as a whole can be told: the folder's own ignore file is not there yet.
    ignoredNote(ignoredPaths(repo, existsSync(join(repo, FOLDER_GITIGNORE)) ? desired.map((file) => file.path) : [WORKFLOW_PATH, `${ACTIONS_DIR}/`], git));
    return result.files.every((file) => file.action === "unchanged") ? { ...result, status: "unchanged" } : result;
  }
  for (const file of result.files) {
    const at = join(repo, file.path);
    if (file.action === "remove") rmSync(at, { force: true });
    if (file.action !== "create" && file.action !== "update") continue;
    mkdirSync(dirname(at), { recursive: true });
    writeFileAtomic(at, desired.find((d) => d.path === file.path)!.bytes);
  }
  ignoredNote(ignoredPaths(repo, desired.map((file) => file.path), git));
  return { ...result, applied: true, status: "installed" };
}

/** The given paths git's ignore rules exclude (read only: `git check-ignore`). */
function ignoredPaths(repo: string, paths: string[], git: GitBytes): string[] {
  const out = git(repo, ["--no-pager", "-c", "core.quotePath=false", "check-ignore", "--no-index", "--", ...paths]);
  return out === null ? [] : out.toString("utf8").split("\n").filter(Boolean);
}

function removeEmpty(dir: string): void {
  if (!existsSync(dir) || !lstatSync(dir).isDirectory()) return;
  for (const name of readdirSync(dir)) removeEmpty(join(dir, name));
  if (readdirSync(dir).length === 0) rmdirSync(dir);
}

const ACTION_WORDS: Record<FileAction, string> = { create: "create", unchanged: "unchanged", update: "update (OrangePro's own, unchanged since)", remove: "remove", conflict: "CONFLICT" };

export function renderInstall(r: InstallResult): string[] {
  const lines: string[] = [];
  const verb = r.mode === "uninstall" ? "uninstall" : "install";
  lines.push(
    r.status === "conflict"
      ? `Refused (conflict): nothing was written. OrangePro does not overwrite or remove a file it did not write, or one changed since.`
      : r.applied
        ? r.status === "uninstalled"
          ? "Uninstalled: the files OrangePro wrote are removed."
          : "Installed. Nothing was committed or pushed: review the files, then commit them yourself."
        : r.status === "unchanged"
          ? "Already installed: every file is as OrangePro would write it. Nothing was written."
          : r.status === "nothing_installed"
            ? "Nothing to uninstall: no file OrangePro wrote is here."
            : `Preview only: nothing was written. Run again with --yes to ${verb}.`
  );
  lines.push("");
  for (const file of r.files) lines.push(`  ${ACTION_WORDS[file.action].padEnd(10)} ${file.path}${file.reason ? ` — ${file.reason}` : ""}`);
  if (r.mode === "install" && r.base_branch && r.orangepro && r.time_limits) {
    lines.push(
      "",
      `Runs after each push to ${r.base_branch}, or by hand with a merged commit and its previous base.`,
      `Permissions: ${r.permissions}.`,
      `OrangePro: ${r.orangepro.version} (build ${r.orangepro.build_sha256.slice(0, 12)}); any other build is refused.`,
      `Time limits: ${r.time_limits.total_minutes} min for the proof, ${r.time_limits.job_minutes} min for the job.`,
      `Source sharing: ${r.source_sharing}.`,
      "Commands:",
      ...r.commands.map((command) => `  ${command}`)
    );
  }
  for (const diff of r.diffs) lines.push("", diff.diff);
  if (r.workflow && !r.applied && r.status === "previewed") lines.push("", `── ${WORKFLOW_PATH}`, r.workflow.trimEnd(), "", `── ${ACTIONS_DIR}/profile.json`, (r.profile ?? "").trimEnd());
  if (r.notes.length > 0) lines.push("", ...r.notes.map((note) => `Note: ${note}`));
  return lines;
}
