// V3: `opro publish-tests`, the trusted draft-PR publisher. It runs no repository code and uses no
// git: it checks a finished export run (its manifest, its receipt, its patch, the fault run the
// receipt names and that run's allowlist), checks that the base branch still points at the proven
// commit, and only then, with --yes, writes one commit through the GitHub REST API on
// `orangepro/tests/<merged sha, 12>` and opens (or finds) one draft PR. It reads the PR back and
// records what GitHub says. Without --yes it writes nothing. The token is read from GITHUB_TOKEN or
// GH_TOKEN and never written or printed.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { testOnlyChange } from "./actionsEvent.js";
import { allowedPaths } from "./candidateTest.js";
import { newRunId, recordBytes, sha256Hex, verifyRunFolder, writeFileAtomic, writeRunManifest } from "./contracts/io.js";
import { checkBuild } from "./buildInfo.js";
import { ORANGEPRO_VERSION } from "./version.js";
import { DELIVERY_RECORD_VERSION, readExportRun, type DeliveryRecord, type DeliveryStatus } from "./proofRuns.js";
import { applyTestPatch, TestPatchError } from "./testPatch.js";
import type { VerificationReceipt } from "./contracts/verificationReceipt.js";

export interface PublishTestsOptions {
  /** An export-tests run folder. */
  from_run?: string;
  /** An actions-run output folder: its result.json names the export run under runs/. */
  from_actions?: string;
  /** `owner/name` on github.com. */
  repo: string;
  base: string;
  /** The merged commit the caller expects the receipt to be about (the workflow's). */
  merged?: string;
  yes?: boolean;
  /** Where the delivery run folder goes (default: the export run's parent folder). */
  out?: string;
  summary_path?: string;
}

export interface PublishTestsDeps {
  fetch?: typeof fetch;
  env?: NodeJS.ProcessEnv;
  now?: () => number;
  /** The running build's stamp; defaults to this install's. */
  build_sha256?: string | null;
}

export interface PublishTestsResult {
  status: DeliveryStatus;
  reason: string | null;
  detail: string;
  plan: { repository: string; base: string; branch: string; merged_commit: string; file: string; title: string; body_sha256: string } | null;
  record: DeliveryRecord | null;
  record_path: string | null;
}

const REPO_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
const BRANCH_RE = /^[A-Za-z0-9._/-]{1,200}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const MAX_FILE_BYTES = 1_000_000;

class Stop extends Error {
  constructor(readonly status: DeliveryStatus, readonly reason: string, message: string) {
    super(message);
  }
}

/** The API root: github.com, or a loopback address for local tests (never another host, so a token cannot be sent elsewhere). */
function apiRoot(env: NodeJS.ProcessEnv): string {
  const override = env.ORANGEPRO_GITHUB_API_URL;
  if (!override) return "https://api.github.com";
  let url: URL;
  try {
    url = new URL(override);
  } catch {
    throw new Stop("refused", "api_url", "ORANGEPRO_GITHUB_API_URL is not a URL.");
  }
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)) {
    throw new Stop("refused", "api_url", "ORANGEPRO_GITHUB_API_URL may only name a loopback address (for local tests).");
  }
  return override.replace(/\/+$/, "");
}

interface Api {
  get(path: string): Promise<{ status: number; body: any }>;
  send(method: "POST" | "PATCH", path: string, body: unknown): Promise<{ status: number; body: any }>;
  writes: number;
}

function makeApi(root: string, token: string | null, fetchImpl: typeof fetch): Api {
  const headers = (): Record<string, string> => ({
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
    "User-Agent": "orangepro-publish-tests",
    ...(token ? { Authorization: `Bearer ${token}` } : {})
  });
  const call = async (method: string, path: string, body?: unknown): Promise<{ status: number; body: any }> => {
    let res: Response;
    try {
      res = await fetchImpl(`${root}${path}`, { method, headers: { ...headers(), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    } catch (error) {
      throw new Stop("blocked", "api_unreachable", `GitHub could not be reached (${method} ${path.split("?")[0]}): ${String((error as Error)?.message ?? error).replace(token ?? "\u0000", "<token>")}`);
    }
    const text = await res.text();
    let parsed: any = null;
    try {
      parsed = text ? JSON.parse(text) : null;
    } catch {
      parsed = null;
    }
    return { status: res.status, body: parsed };
  };
  const api: Api = {
    writes: 0,
    get: (path) => call("GET", path),
    send: async (method, path, body) => {
      api.writes += 1;
      return call(method, path, body);
    }
  };
  return api;
}

function expect(res: { status: number; body: any }, ok: number[], what: string): any {
  if (!ok.includes(res.status)) {
    const message = typeof res.body?.message === "string" ? `: ${res.body.message.slice(0, 200)}` : "";
    throw new Stop("blocked", "api_error", `GitHub refused ${what} (HTTP ${res.status}${message}).`);
  }
  return res.body;
}

const encodePath = (p: string): string => p.split("/").map(encodeURIComponent).join("/");

/** Plain text for the PR body: no HTML, no Markdown control characters that could change the page. */
const md = (text: unknown): string => String(text ?? "").replace(/[<>&`*_[\]|]/g, (c) => `\\${c}`).replace(/\r?\n/g, " ");

export function prTitle(r: VerificationReceipt): string {
  const name = r.selection.symbol_id.replace(/^sym:[^#]*#/, "");
  return `OrangePro: a test for ${name} (${r.source.merged_commit.slice(0, 12)})`;
}

/** The PR body, from the receipt and the oracle only. Deterministic for the same inputs. */
export function prBody(r: VerificationReceipt, receiptSha: string, oracle: { behavior?: string; expected?: string } | null, links: { run_url?: string | null } = {}): string {
  const rows = r.rows.map((row) => `| ${row.row} | ${md(row.meaning)} | ${row.met ? "met" : "not met"} |`).join("\n");
  const who = r.generation.by === "provider"
    ? `OrangePro drafted the test with the repository owner's model key (${md(r.generation.agent)}) from its brief, and verified it.`
    : `A coding agent (${md(r.generation.agent)}) wrote the test from OrangePro's brief, and OrangePro verified it.`;
  return [
    `**A new test that catches a fault the existing tests missed**, on \`${r.source.merged_commit}\`.`,
    "",
    `- **Function:** \`${md(r.selection.symbol_id)}\`, which the merged change touched.`,
    oracle?.behavior ? `- **Expected behavior (approved):** ${md(oracle.behavior)}` : "",
    `- **Old tests:** ${md(r.mutation.old_tests.classification)} (scope: ${md(r.mutation.old_tests.scope ?? "selected")}).`,
    `- **New test:** \`${md(r.generation.new_test.file)}\`, "${md(r.generation.new_test.full_title)}". It passes on the merged code and fails at its declared assertion (line ${r.generation.declared_assertion.line}) on the fault.`,
    `- **Who wrote it:** ${who}${r.selection.assisted || r.generation.assisted ? " Assisted: disclosed in the receipt." : ""}`,
    "",
    "| Row | What it shows | Result |",
    "|---|---|---|",
    rows,
    "",
    "**This PR changes one test file and adds lines only.** It is a draft: review it like any other test. OrangePro does not merge it.",
    "",
    "**Not established:**",
    ...r.limitations.map((l) => `- ${md(l)}`),
    "",
    links.run_url ? `Evidence: ${links.run_url} (the run's artifact holds the receipt, the logs and the diagnostic fault).` : "Evidence: the export run's folder holds the receipt, the logs and the diagnostic fault.",
    "",
    `<!-- orangepro-delivery merged=${r.source.merged_commit} receipt=${receiptSha} -->`
  ].filter((line, i, all) => !(line === "" && all[i - 1] === "")).join("\n");
}

function exportDirFromActions(dir: string): string {
  const resultPath = join(dir, "result.json");
  if (!existsSync(resultPath)) throw new Stop("refused", "no_result", `${resultPath} is missing: not an actions-run output folder.`);
  let result: { status?: string; runs?: { export?: string | null } };
  try {
    result = JSON.parse(readFileSync(resultPath, "utf8"));
  } catch {
    throw new Stop("refused", "no_result", "result.json is not valid JSON.");
  }
  if (result.status !== "verified_gap" || !result.runs?.export) {
    throw new Stop("not_deliverable", "not_verified", `the run's result is ${result.status ?? "unknown"}: only a verified gap is delivered.`);
  }
  if (!/^run_[0-9a-z]+_[0-9a-f]+$/.test(result.runs.export)) throw new Stop("refused", "no_result", "result.json names an export run that is not a run id.");
  return join(dir, "runs", result.runs.export);
}

/** Everything checked before any request: the run, the receipt, the patch, the allowlist and the build. */
function validate(exportDir: string, opts: PublishTestsOptions, deps: PublishTestsDeps) {
  const runId = basename(exportDir);
  const run = readExportRun(exportDir, runId);
  if (!run.ok) throw new Stop("refused", "export_run_invalid", `the export run does not check: ${run.reason}`);
  const r = run.receipt;
  if (r.classification.fault !== "verified_gap") throw new Stop("not_deliverable", "not_verified", `the receipt is ${r.classification.fault}: only a verified gap is delivered.`);
  if (r.rows.length !== 8 || !r.rows.every((row) => row.met === true)) throw new Stop("refused", "rows_not_met", "not every proof row A–H is met.");
  if (!SHA_RE.test(r.source.merged_commit)) throw new Stop("refused", "receipt_invalid", "the receipt's merged commit is not a full commit id.");
  if (opts.merged && opts.merged !== r.source.merged_commit) throw new Stop("refused", "commit_mismatch", `the receipt is about ${r.source.merged_commit.slice(0, 12)}, not ${opts.merged.slice(0, 12)}.`);
  const tp = r.deliverables.test_patch;
  if (tp.removed_lines !== 0 || run.patch.added !== tp.added_lines) throw new Stop("refused", "patch_invalid", "the patch does not add exactly the lines the receipt names, and only adds.");
  // The fault run the receipt names: its folder, its manifest hash, and the fixture's allowlist in it.
  const faultDir = join(dirname(exportDir), r.run_ids.fault);
  const faultCheck = verifyRunFolder(faultDir);
  if (!faultCheck.ok) throw new Stop("refused", "fault_run_invalid", `the fault run ${r.run_ids.fault} does not check: ${faultCheck.message}`);
  const named = r.run_manifests.find((m) => m.run_id === r.run_ids.fault)?.sha256;
  if (!named || sha256Hex(readFileSync(join(faultDir, "MANIFEST.json"))) !== named) throw new Stop("refused", "fault_run_invalid", "the fault run's manifest is not the one the receipt names.");
  let allowed: { patterns: string[]; never: string[] };
  try {
    allowed = allowedPaths(readFileSync(join(faultDir, "fixture-manifest.json")));
  } catch (error) {
    throw new Stop("refused", "allowlist", `the fixture's allowlist cannot be read: ${(error as Error).message}`);
  }
  if (!testOnlyChange([run.patch.file], allowed)) throw new Stop("refused", "not_test_only", `${run.patch.file} is not a path a test patch may change.`);
  const faultPatch = existsSync(join(exportDir, "diagnostic-fault.patch")) ? readFileSync(join(exportDir, "diagnostic-fault.patch"), "utf8") : "";
  const faultAdded = faultPatch.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1).trim()).filter((l) => l.length > 8);
  if (faultAdded.some((line) => run.patchText.includes(line))) throw new Stop("refused", "fault_in_patch", "the test patch carries a line of the diagnostic fault.");
  const build = deps.build_sha256 === undefined ? checkBuild().build_sha256 : deps.build_sha256;
  if (!build || r.tool.build_sha256 !== build) throw new Stop("refused", "build_mismatch", `the receipt was made by build ${String(r.tool.build_sha256).slice(0, 12)}, and this is build ${String(build).slice(0, 12)}: deliver with the build that proved it.`);
  let oracle: { behavior?: string; expected?: string } | null = null;
  try {
    oracle = JSON.parse(readFileSync(join(faultDir, "oracle.json"), "utf8"));
  } catch {
    oracle = null;
  }
  return { run, receipt: r, oracle };
}

export async function opPublishTests(opts: PublishTestsOptions, deps: PublishTestsDeps = {}): Promise<PublishTestsResult> {
  const env = deps.env ?? process.env;
  const now = deps.now ?? Date.now;
  let plan: PublishTestsResult["plan"] = null;
  let api: Api | null = null;
  let exportDir: string | null = null;
  let receiptSha = "";
  const finish = (status: DeliveryStatus, reason: string | null, detail: string, extra: Partial<DeliveryRecord> = {}): PublishTestsResult => {
    let record: DeliveryRecord | null = null;
    let recordPath: string | null = null;
    if (opts.yes && exportDir && plan) {
      const runId = newRunId(now);
      const outDir = resolve(opts.out ?? dirname(exportDir));
      const dir = join(outDir, runId);
      mkdirSync(dir, { recursive: true });
      record = {
        version: DELIVERY_RECORD_VERSION,
        run_id: runId,
        export_run_id: basename(exportDir),
        receipt_sha256: receiptSha,
        repository: plan.repository,
        base: plan.base,
        merged_commit: plan.merged_commit,
        branch: plan.branch,
        status,
        reason,
        commit: null,
        pr: null,
        checked_at: new Date(now()).toISOString(),
        ...extra
      };
      writeFileAtomic(join(dir, "delivery-record.json"), recordBytes(record));
      writeFileAtomic(join(dir, "delivery.md"), `${deliveryLine(status, detail, record)}\n`);
      writeRunManifest(dir, runId, ORANGEPRO_VERSION);
      recordPath = join(dir, "delivery-record.json");
    }
    const result: PublishTestsResult = { status, reason, detail, plan, record, record_path: recordPath };
    if (opts.summary_path) {
      try {
        writeFileAtomic(opts.summary_path, `${existsSync(opts.summary_path) ? readFileSync(opts.summary_path, "utf8") : ""}\n### OrangePro delivery\n\n${deliveryLine(status, detail, record)}\n`);
      } catch {
        // the job summary is a convenience; the record is the result
      }
    }
    return result;
  };
  try {
    if (!REPO_RE.test(opts.repo)) throw new Stop("refused", "bad_repo", `${opts.repo} is not owner/name.`);
    if (!BRANCH_RE.test(opts.base) || opts.base.includes("..")) throw new Stop("refused", "bad_base", `${opts.base} is not a branch name.`);
    if (opts.merged !== undefined && !SHA_RE.test(opts.merged)) throw new Stop("refused", "bad_merged", "--merged must be a full 40-character commit id.");
    if (!!opts.from_run === !!opts.from_actions) throw new Stop("refused", "bad_args", "give exactly one of --from-run and --from-actions.");
    exportDir = resolve(opts.from_run ?? exportDirFromActions(resolve(opts.from_actions!)));
    const { run, receipt: r, oracle } = validate(exportDir, opts, deps);
    receiptSha = run.receiptSha256;
    const branch = `orangepro/tests/${r.source.merged_commit.slice(0, 12)}`;
    const runUrl = env.GITHUB_SERVER_URL === "https://github.com" && env.GITHUB_REPOSITORY === opts.repo && /^\d+$/.test(env.GITHUB_RUN_ID ?? "") ? `https://github.com/${opts.repo}/actions/runs/${env.GITHUB_RUN_ID}` : null;
    const body = prBody(r, receiptSha, oracle, { run_url: runUrl });
    plan = { repository: opts.repo, base: opts.base, branch, merged_commit: r.source.merged_commit, file: run.patch.file, title: prTitle(r), body_sha256: sha256Hex(Buffer.from(body, "utf8")) };

    const token = env.GITHUB_TOKEN || env.GH_TOKEN || null;
    if (!opts.yes) {
      return finish("dry_run", null, `Would open a draft PR on ${opts.repo} from ${branch} into ${opts.base}, changing ${run.patch.file} only. Nothing was written (add --yes).`);
    }
    if (!token) throw new Stop("blocked", "no_token", "no GITHUB_TOKEN or GH_TOKEN: nothing was delivered; the artifacts stay.");
    api = makeApi(apiRoot(env), token, deps.fetch ?? fetch);
    const repoPath = `/repos/${opts.repo}`;

    // Freshness (AD-5): the base must still point at the proven commit.
    const baseHead = async (): Promise<string> => expect(await api!.get(`${repoPath}/git/ref/heads/${encodePath(opts.base)}`), [200], `reading ${opts.base}`)?.object?.sha;
    const head0 = await baseHead();
    if (head0 !== r.source.merged_commit) throw new Stop("stale_base", "base_moved", `${opts.base} is at ${String(head0).slice(0, 12)}, not the proven ${r.source.merged_commit.slice(0, 12)}: nothing delivered. The next run proves the new head.`);

    // The file the patch leaves, from the file at the merged commit.
    const contents = await api.get(`${repoPath}/contents/${encodePath(run.patch.file)}?ref=${r.source.merged_commit}`);
    let original: Buffer | null = null;
    if (contents.status === 200) {
      if (contents.body?.type !== "file" || contents.body?.encoding !== "base64" || typeof contents.body?.content !== "string") throw new Stop("refused", "file_unreadable", `${run.patch.file} is not a plain file GitHub returns whole.`);
      original = Buffer.from(contents.body.content, "base64");
      if (original.length > MAX_FILE_BYTES) throw new Stop("refused", "file_too_large", `${run.patch.file} is larger than ${MAX_FILE_BYTES} bytes.`);
    } else if (contents.status !== 404) expect(contents, [200], `reading ${run.patch.file}`);
    let patched: Buffer;
    try {
      patched = applyTestPatch(run.patch, original);
    } catch (error) {
      if (error instanceof TestPatchError) throw new Stop("refused", "patch_does_not_apply", `the patch does not apply to ${run.patch.file} at the merged commit: ${error.message}`);
      throw error;
    }
    const blobSha = gitBlobSha(patched);
    const trailer = `OrangePro-Receipt: ${receiptSha}`;

    // The branch: absent, ours (a commit with our trailer on the proven commit's line), or someone else's.
    const branchRef = await api.get(`${repoPath}/git/ref/heads/${encodePath(branch)}`);
    let parent = r.source.merged_commit;
    let reuse: string | null = null;
    if (branchRef.status === 200) {
      const tip = branchRef.body?.object?.sha as string;
      const tipCommit = expect(await api.get(`${repoPath}/git/commits/${tip}`), [200], "reading the branch's commit");
      const ours = typeof tipCommit?.message === "string" && /\nOrangePro-Receipt: [0-9a-f]{64}\b/.test(tipCommit.message) && tipCommit.message.includes(`OrangePro-Merged-Commit: ${r.source.merged_commit}`);
      if (!ours) throw new Stop("diverged", "branch_not_ours", `${branch} has a commit OrangePro did not write: nothing changed.`);
      const tipFile = await api.get(`${repoPath}/contents/${encodePath(run.patch.file)}?ref=${tip}`);
      if (tipFile.status === 200 && tipFile.body?.sha === blobSha && tipCommit.message.includes(trailer)) reuse = tip;
      else parent = tip;
    } else if (branchRef.status !== 404) expect(branchRef, [200], `reading ${branch}`);

    let commit = reuse;
    if (!commit) {
      const blob = expect(await api.send("POST", `${repoPath}/git/blobs`, { content: patched.toString("base64"), encoding: "base64" }), [201], "creating the test file");
      if (blob?.sha !== blobSha) throw new Stop("blocked", "readback_mismatch", "GitHub stored different bytes than the patched file.");
      const parentCommit = expect(await api.get(`${repoPath}/git/commits/${parent}`), [200], "reading the parent commit");
      const tree = expect(await api.send("POST", `${repoPath}/git/trees`, { base_tree: parentCommit.tree.sha, tree: [{ path: run.patch.file, mode: "100644", type: "blob", sha: blobSha }] }), [201], "creating the tree");
      const message = `${prTitle(r)}\n\nOne test that catches a fault the existing tests missed, verified by OrangePro ${ORANGEPRO_VERSION}.\n\nOrangePro-Merged-Commit: ${r.source.merged_commit}\n${trailer}\n`;
      const created = expect(await api.send("POST", `${repoPath}/git/commits`, { message, tree: tree.sha, parents: [parent] }), [201], "creating the commit");
      commit = created.sha as string;
      if (branchRef.status === 404) expect(await api.send("POST", `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit }), [201], `creating ${branch}`);
      else expect(await api.send("PATCH", `${repoPath}/git/refs/heads/${encodePath(branch)}`, { sha: commit, force: false }), [200], `updating ${branch}`);
    }

    // Recheck the base just before the PR (it may have moved while we wrote the branch).
    const head1 = await baseHead();
    if (head1 !== r.source.merged_commit) throw new Stop("stale_base", "base_moved", `${opts.base} moved to ${String(head1).slice(0, 12)} during delivery: no PR opened. The branch ${branch} stays.`);

    const owner = opts.repo.split("/")[0];
    const listed = expect(await api.get(`${repoPath}/pulls?head=${encodeURIComponent(`${owner}:${branch}`)}&base=${encodeURIComponent(opts.base)}&state=all&per_page=10`), [200], "listing pull requests");
    const existing = Array.isArray(listed) ? listed.find((p: any) => p?.head?.ref === branch) : undefined;
    let status: DeliveryStatus;
    let number: number;
    if (existing && existing.state === "closed") {
      number = existing.number;
      status = "unchanged";
    } else if (existing) {
      number = existing.number;
      if (existing.body !== body) expect(await api.send("PATCH", `${repoPath}/pulls/${number}`, { body }), [200], "updating the PR's description");
      status = reuse ? "unchanged" : "updated";
    } else {
      const pr = expect(await api.send("POST", `${repoPath}/pulls`, { title: plan.title, head: branch, base: opts.base, body, draft: true, maintainer_can_modify: false }), [201], "opening the draft PR");
      number = pr.number;
      status = "delivered";
    }

    // Read back what GitHub holds now.
    const pr = expect(await api.get(`${repoPath}/pulls/${number}`), [200], "reading the PR back");
    const files = expect(await api.get(`${repoPath}/pulls/${number}/files?per_page=100`), [200], "reading the PR's files");
    const names: string[] = Array.isArray(files) ? files.map((f: any) => String(f?.filename)) : [];
    const readBack = {
      number,
      url: String(pr.html_url),
      draft: pr.draft === true,
      state: pr.state === "closed" ? ("closed" as const) : ("open" as const),
      merged: pr.merged === true,
      base_ref: String(pr.base?.ref),
      head_sha: String(pr.head?.sha),
      files: names
    };
    if (!/^https:\/\/github\.com\/[^\s"<>]+\/pull\/\d+$/.test(readBack.url) && !env.ORANGEPRO_GITHUB_API_URL) throw new Stop("blocked", "readback_mismatch", "GitHub returned a PR address that is not a github.com pull request.");
    if (readBack.state === "open") {
      const problems = [
        readBack.draft ? null : "it is not a draft",
        readBack.base_ref === opts.base ? null : `its base is ${readBack.base_ref}`,
        readBack.head_sha === commit ? null : "its head is not the delivered commit",
        names.length === 1 && names[0] === run.patch.file ? null : `it changes ${names.join(", ") || "no file"}`
      ].filter(Boolean);
      if (problems.length) return finish("blocked", "readback_mismatch", `PR #${number} does not read back as delivered: ${problems.join("; ")}.`, { commit, pr: readBack });
    }
    const detail = readBack.merged
      ? `PR #${number} was merged (read back): ${readBack.url}`
      : readBack.state === "closed"
        ? `PR #${number} was closed without merging; it is not reopened: ${readBack.url}`
        : `${status === "delivered" ? "Opened" : status === "updated" ? "Updated" : "Already open, unchanged:"} draft PR #${number}: ${readBack.url}`;
    return finish(status, null, detail, { commit, pr: readBack });
  } catch (error) {
    if (error instanceof Stop) return finish(error.status, error.reason, error.message);
    throw error;
  }
}

/** The git blob id of some bytes, as GitHub computes it. */
export function gitBlobSha(bytes: Buffer): string {
  // sha1("blob <len>\0" + bytes), checked against GitHub's answer.
  return createHash("sha1").update(Buffer.concat([Buffer.from(`blob ${bytes.length}\0`, "utf8"), bytes])).digest("hex");
}

function deliveryLine(status: DeliveryStatus, detail: string, record: DeliveryRecord | null): string {
  const word: Record<DeliveryStatus, string> = {
    delivered: "Delivered as a draft PR",
    updated: "Draft PR updated",
    unchanged: "Nothing to change",
    dry_run: "Dry run",
    stale_base: "Not delivered: the base moved",
    diverged: "Not delivered: the branch has someone else's commit",
    blocked: "Not delivered: blocked",
    refused: "Not delivered: refused",
    not_deliverable: "Nothing to deliver"
  };
  return `**${word[status]}.** ${detail}${record?.pr ? ` (draft: ${record.pr.draft ? "yes" : "no"}, files: ${record.pr.files.join(", ")})` : ""}`;
}

/** Plain lines for the terminal. */
export function renderPublishTests(result: PublishTestsResult): string[] {
  const lines = [`publish-tests: ${result.status}${result.reason ? ` (${result.reason})` : ""}`, result.detail];
  if (result.plan) lines.push(`  ${result.plan.repository}: ${result.plan.branch} → ${result.plan.base}, ${result.plan.file} only; title "${result.plan.title}"; body sha256 ${result.plan.body_sha256.slice(0, 16)}`);
  if (result.record_path) lines.push(`  record: ${result.record_path}`);
  return lines;
}
