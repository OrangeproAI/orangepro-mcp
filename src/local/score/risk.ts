import { loadRiskConfig, globToRegExp, type RiskOverride } from "./riskConfig.js";
import { execFileSync } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { LocalGraph, GraphNode } from "../graph/ontology.js";
import { hashString } from "../util/hash.js";
import { builtInRankExclusion } from "./rankEligibility.js";

/** Explicit scorer identity. Formula changes require a new value. */
export const ORS_VERSION = "orangepro.ors.stable_population.v2" as const;

export interface RiskGap {
  id: string;
  title: string;
  file: string;
  risk_score: number;
  incoming_refs: number;
  git_churn: number;
  /** False means Git history was unavailable/incomplete; zero is not a measured value. */
  churn_available?: boolean;
  /** Acquisition truth for this row's Git-derived inputs. Partial values are retained. */
  churn_state?: "complete" | "partial" | "unavailable";
  /** Why a partial/unavailable acquisition is provisional. */
  churn_reason?: string;
  /** Non-merge commits parsed before completion or a bounded stop. */
  commits_scanned?: number;
  entry_point: boolean;
  reasons: string[];
  /** OrangePro Risk Score decomposition (P × I × D). */
  probability?: number;
  impact?: number;
  detection_difficulty?: number;
  /** Config override applied to this row (rendered so a tuned report never passes as clean). */
  override?: { action: RiskOverride["action"]; reason: string };
  /** The destructive callee this path reaches (≤2 calls), when it does — shown by name on the row. */
  sink_callee?: string;
  /** Symbol that makes the destructive call (itself, or the callee it reaches). Display grouping only. */
  sink_owner?: string;
  scheduled_entry?: boolean;
  /** Evidence tier behind D: associated | candidate | none. */
  detection_tier?: "associated" | "candidate" | "none";
  /** Structural context used by the model. */
  fan_out?: number;
  route_weight?: number;
  data_sensitivity?: number;
  flow_position?: number;
  complexity_proxy?: number;
  is_new_code?: boolean;
  integration_signal?: "associated" | "candidate" | "none";
}

export interface RiskInputHealth {
  sourceRoot: string | null;
  gitRoot: string | null;
  commit: string | null;
  commitDate: string | null;
  history: "full" | "shallow" | "partial" | "unavailable";
  churnWindow: string;
  /** Preflight state; a shallow/partial clone is usable but cannot be complete. */
  churnState: "complete" | "partial" | "unavailable";
  churnAvailable: boolean;
  reason?: string;
}

export interface RiskGapOptions {
  limit?: number;
  /** Optional max gaps per file for an explicitly diversified portfolio. Omit for the true global ranking. */
  maxPerFile?: number;
  /** Optional max gaps sharing the same normalized title. Only used with maxPerFile. */
  maxPerTitle?: number;
  repoRoot?: string;
  churnWindow?: string;
  /** Use the legacy linear formula (incoming_refs × 0.4 + git_churn × 0.4 + entry-point bonus).
   *  Defaults to false (ORS). Kept for one release so callers can diff. */
  legacy?: boolean;
  /**
   * CodeSymbol ids carrying a CURRENT valid dynamic-proof ledger cert (see
   * `provenSymbolIds` in rtm.ts). Proof lives in the ledger, not in the graph's
   * hard TESTED_BY/COVERS edges, and a proven method is frequently OUTSIDE the
   * static denominator — so without this set, container suppression cannot see
   * that every child of a type is already proven and the container outranks its
   * own proven methods.
   */
  provenIds?: Set<string>;
  /**
   * Consequence worklists may need to show statically Associated behaviors that
   * are still unproven. The main priority-gap list leaves this false so its
   * existing semantics and ordering remain unchanged.
   */
  includeAssociated?: boolean;
}

const ENTRY_PATH_RE = /(^|\/)(routes?|controllers?|handlers?|jobs?|workers?|processors?|queues?|consumers?|subscribers?|listeners?|server|cmd)\//i;
const ENTRY_FILE_RE = /(^|\/)[^/]*(controller|handler|route|router|job|processor|worker|queue|consumer|subscriber|listener|command|gateway)\.[^.\/]+$/i;
const API_HANDLER_NAME_RE = /^(GET|POST|PUT|PATCH|DELETE|handle.*|handler|route|controller|endpoint)$/i;
const ENTRY_NAME_RE = /(^|[.#])(main|serve|request|endpoint)/i;

function symbolFile(n: GraphNode): string {
  if (typeof n.properties.file === "string") return n.properties.file;
  return n.external_id.replace(/^sym:/, "").split("#")[0];
}

function symbolTitle(n: GraphNode): string {
  return n.title ?? n.external_id.split("#")[1] ?? n.external_id;
}

/**
 * Structural container → member children, read from the analyzer's own
 * `properties.member_of` (the same signal src/local/reprove/scoped.ts uses).
 * Id-prefix matching cannot do this job: `sym:f.ts#a.b` is a child of
 * `sym:f.ts#a` only by string luck, and a dotted symbol name with no container
 * node would be mis-parented. A container is resolved inside the child's OWN
 * file: a same-named symbol elsewhere is a different thing, and mis-parenting
 * here would suppress a genuine gap.
 */
function containerChildren(graph: LocalGraph): Map<string, string[]> {
  const symbols = graph.nodes.filter((n) => n.kind === "CodeSymbol");
  const idByFileTitle = new Map<string, string>();
  for (const n of symbols) idByFileTitle.set(`${symbolFile(n)}#${symbolTitle(n)}`, n.external_id);
  const out = new Map<string, string[]>();
  for (const n of symbols) {
    const memberOf = n.properties.member_of;
    if (typeof memberOf !== "string" || memberOf === "") continue;
    const containerId = idByFileTitle.get(`${symbolFile(n)}#${memberOf}`);
    if (!containerId || containerId === n.external_id) continue;
    const list = out.get(containerId);
    if (list) list.push(n.external_id);
    else out.set(containerId, [n.external_id]);
  }
  return out;
}

function confirmedBehaviorIds(graph: LocalGraph, provenIds?: Set<string>): Set<string> {
  const ids = new Set<string>();
  const nodeKinds = new Map(graph.nodes.map((n) => [n.external_id, n.kind]));
  for (const e of graph.edges) {
    if (e.evidence_strength !== "hard") continue;
    if (e.relationship_type !== "TESTED_BY" && e.relationship_type !== "COVERS") continue;
    if (nodeKinds.get(e.from_external_id) === "CodeSymbol" || nodeKinds.get(e.from_external_id) === "Requirement") ids.add(e.from_external_id);
    if (nodeKinds.get(e.to_external_id) === "CodeSymbol" || nodeKinds.get(e.to_external_id) === "Requirement") ids.add(e.to_external_id);
  }
  // A container type whose every method child is confirmed has no distinct
  // untested surface left — suppress it from the gap ranking rather than
  // listing it as an unlinked candidate above its own proven methods.
  // "Confirmed" here means a hard static link OR a current ledger proof: the
  // proof lane leaves no graph edge and usually sits outside the denominator,
  // so a hard-edge-only check never fires for a dynamically proven type.
  const eligible = new Set(
    graph.nodes.filter((n) => n.kind === "CodeSymbol" && n.denominator_eligible === true).map((n) => n.external_id)
  );
  for (const [containerId, children] of containerChildren(graph)) {
    if (ids.has(containerId) || !eligible.has(containerId)) continue;
    if (children.every((c) => ids.has(c) || provenIds?.has(c) === true)) ids.add(containerId);
  }
  return ids;
}

/** Default bounds for repository-wide history acquisition (overridable via
 *  tuning.churn_max_commits / tuning.churn_timeout_seconds, always disclosed).
 *  Sized so an active monorepo's full 180-day window completes (a 5,000-commit /
 *  60 s bound truncated windows that 0.2.44 scanned completely). */
export const GIT_CHURN_MAX_COMMITS = 20_000;
export const GIT_CHURN_TIMEOUT_MS = 300_000;
const GIT_FIRST_COMMIT_BATCH = 200;

export interface RiskChurnMetadata {
  state: "complete" | "partial" | "unavailable";
  reason?: string;
  commitsScanned: number;
}

interface GitChurnResult extends RiskChurnMetadata {
  values: Map<string, number>;
}

/**
 * This worker intentionally uses spawn, not execFileSync: stdout is parsed as it
 * arrives, so a time bound returns the values already observed instead of erasing
 * completed chunks. It keeps one counter per path the window touched (bounded by
 * the window, not by total history) so a single scan serves every caller. The scoring API
 * is synchronous, therefore the worker signals only after writing its result file.
 */
const GIT_CHURN_WORKER_SOURCE = String.raw`
const { spawn } = require("node:child_process");
const { writeFileSync } = require("node:fs");
const { workerData } = require("node:worker_threads");
const state = new Int32Array(workerData.signal);
const values = new Map();
const trackedFiles = Array.isArray(workerData.files) ? new Set(workerData.files) : null;
let commitsScanned = 0;
let commitLimitReached = false;
let expectingTimestamp = false;
let renameRecord = null;
let renameOldPath = null;
let remainder = "";
let stderr = "";
let done = false;
let timedOut = false;
let timer;
let child;
let childClosed = false;
const firstLine = (text) => String(text || "").split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "";
const add = (path, adds, dels) => {
  if (!path || commitLimitReached || (trackedFiles && !trackedFiles.has(path))) return;
  values.set(path, (values.get(path) || 0) + adds + dels);
};
const consume = (token) => {
  if (renameRecord) {
    // Git numstat -z represents a rename as an empty-path record followed by
    // the old path and then the new path. Attribute churn to the current path.
    if (renameOldPath === null) {
      renameOldPath = token;
      return;
    }
    add(token, renameRecord.adds, renameRecord.dels);
    renameRecord = null;
    renameOldPath = null;
    return;
  }
  if (/^[0-9a-f]{40}$/i.test(token)) { expectingTimestamp = true; return; }
  if (expectingTimestamp && /^\d+$/.test(token)) {
    expectingTimestamp = false;
    if (commitsScanned >= workerData.maxCommits) {
      commitLimitReached = true;
      if (child) child.kill("SIGTERM");
      return;
    }
    commitsScanned++;
    return;
  }
  const match = token.replace(/^\n/, "").match(/^(-|\d+)\t(-|\d+)\t([\s\S]*)$/);
  if (!match) return;
  const adds = match[1] === "-" ? 0 : Number(match[1]);
  const dels = match[2] === "-" ? 0 : Number(match[2]);
  if (match[3] === "") { renameRecord = { adds, dels }; renameOldPath = null; return; }
  add(match[3], adds, dels);
};
const finish = (stateName, reason) => {
  if (done) return;
  done = true;
  if (timer) clearTimeout(timer);
  try {
    writeFileSync(workerData.resultPath, JSON.stringify({ state: stateName, reason, commitsScanned, values: [...values].sort(([a], [b]) => a.localeCompare(b)) }));
  } finally {
    Atomics.store(state, 0, 1);
    Atomics.notify(state, 0);
  }
};
const stopChild = (signal) => {
  if (!child || childClosed) return;
  try { child.kill(signal); } catch {}
};
// The parent terminates this worker after consuming the bounded handoff. Make
// sure an unresponsive git child cannot survive that termination.
process.on("exit", () => stopChild("SIGKILL"));
try {
  child = spawn("git", ["log", "--no-merges", "--numstat", "--format=%H%x00%ct", "-z", "--since=" + workerData.window, "--max-count=" + (workerData.maxCommits + 1)], {
    cwd: workerData.root,
    stdio: ["ignore", "pipe", "pipe"]
  });
} catch (error) {
  finish("unavailable", error && error.code === "ENOENT" ? "git_missing" : "error:" + firstLine(error && error.message));
}
timer = setTimeout(() => {
  timedOut = true;
  stopChild("SIGTERM");
  setTimeout(() => finish("partial", "timeout"), 100).unref();
}, workerData.timeoutMs);
if (child) {
  child.stdout.on("data", (chunk) => {
    remainder += chunk.toString("utf8");
    let nul;
    while ((nul = remainder.indexOf("\0")) >= 0) {
      consume(remainder.slice(0, nul));
      remainder = remainder.slice(nul + 1);
    }
  });
  child.stderr.on("data", (chunk) => { if (stderr.length < 4096) stderr += chunk.toString("utf8"); });
  child.on("error", (error) => finish("unavailable", error && error.code === "ENOENT" ? "git_missing" : "error:" + firstLine(error && error.message)));
  child.on("close", (code) => {
    childClosed = true;
    if (remainder) consume(remainder);
    if (timedOut) return finish("partial", "timeout");
    if (commitLimitReached) return finish("partial", "commit_limit");
    if (code === 0) return finish(workerData.cloneState === "full" ? "complete" : "partial", workerData.cloneState === "shallow" ? "shallow clone: churn based on " + commitsScanned + " commits" : workerData.cloneState === "partial" ? "partial clone: churn based on " + commitsScanned + " commits" : undefined);
    finish(commitsScanned > 0 ? "partial" : "unavailable", "error:" + (firstLine(stderr) || "git log exited " + code));
  });
}
`;

const historyCache = new Map<string, GitChurnResult>();

function firstErrorLine(error: unknown): string {
  const e = error as NodeJS.ErrnoException & { stderr?: Buffer | string };
  const raw = e.stderr ? String(e.stderr) : e.message;
  return raw.split(/\r?\n/).map((line) => line.trim()).find(Boolean) || "unknown Git error";
}

function unavailableHealth(root: string | undefined, churnWindow: string, error: unknown): RiskInputHealth {
  const e = error as NodeJS.ErrnoException & { stderr?: Buffer | string };
  const line = firstErrorLine(error);
  const reason = e.code === "ENOENT"
    ? "git_missing"
    : /not a git repository/i.test(line)
      ? "not_a_git_repo"
      : `error:${line}`;
  return { sourceRoot: root ?? null, gitRoot: null, commit: null, commitDate: null, history: "unavailable", churnWindow, churnState: "unavailable", churnAvailable: false, reason };
}

export function inspectRiskInputHealth(root: string | undefined, churnWindow?: string): RiskInputHealth {
  const configuredDays = loadRiskConfig(root ?? "").config.tuning.churn_window_days;
  const unavailableWindow = churnWindow ?? `${configuredDays} days before HEAD`;
  if (!root) return { sourceRoot: null, gitRoot: null, commit: null, commitDate: null, history: "unavailable", churnWindow: unavailableWindow, churnState: "unavailable", churnAvailable: false, reason: "not_a_git_repo" };
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 4000 }).trim();
    const commit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).trim();
    const commitDate = execFileSync("git", ["show", "-s", "--format=%cI", "HEAD"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).trim();
    const shallow = execFileSync("git", ["rev-parse", "--is-shallow-repository"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).trim() === "true";
    let partial = false;
    try {
      partial = execFileSync("git", ["config", "--get-regexp", "^remote\\..*\\.promisor$"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 })
        .split(/\r?\n/)
        .some((line) => /\btrue$/i.test(line.trim()));
    } catch {
      // A normal full clone has no promisor-remote configuration.
    }
    const commitMs = Date.parse(commitDate);
    const resolvedWindow = churnWindow ?? (Number.isFinite(commitMs) ? new Date(commitMs - configuredDays * 24 * 60 * 60 * 1000).toISOString() : unavailableWindow);
    return {
      sourceRoot: root,
      gitRoot,
      commit,
      commitDate,
      history: shallow ? "shallow" : partial ? "partial" : "full",
      churnWindow: resolvedWindow,
      churnState: shallow || partial ? "partial" : "complete",
      churnAvailable: !shallow && !partial,
      reason: shallow
        ? "shallow clone: churn based on available history"
        : partial
          ? "partial clone: churn based on available history"
          : undefined
    };
  } catch (error) {
    return unavailableHealth(root, unavailableWindow, error);
  }
}

function gitChurn(root: string | undefined, files: string[], window: string, health = inspectRiskInputHealth(root, window)): GitChurnResult {
  const empty: GitChurnResult = { values: new Map(), state: "unavailable", commitsScanned: 0, reason: health.reason };
  if (!root || health.churnState === "unavailable") return empty;
  // Values are retained only for the requested paths, so that set and clone
  // state are part of cache identity. A checkout can be marked partial at an
  // unchanged HEAD and must then remain truthfully provisional.
  const requested = new Set(files);
  const tuning = loadRiskConfig(root).config.tuning;
  const maxCommits = tuning.churn_max_commits ?? GIT_CHURN_MAX_COMMITS;
  const timeoutMs = (tuning.churn_timeout_seconds ?? GIT_CHURN_TIMEOUT_MS / 1000) * 1000;
  // ONE bounded scan per repository state: values are kept for every path the
  // window touched and filtered per caller, so the ranking, the report header and
  // the static snapshot never each pay for (and each time out on) the same scan.
  const key = `${health.gitRoot ?? root}\0${health.commit ?? ""}\0${health.history}\0${window}\0${maxCommits}\0${timeoutMs}`;
  const cached = historyCache.get(key);
  if (cached) return { ...cached, values: new Map([...cached.values].filter(([file]) => requested.has(file))) };
  const dir = mkdtempSync(join(tmpdir(), "orangepro-churn-"));
  const resultPath = join(dir, "result.json");
  const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
  const state = new Int32Array(signal);
  let parsed: { state: GitChurnResult["state"]; reason?: string; commitsScanned: number; values: Array<[string, number]> } | undefined;
  try {
    const worker = new Worker(GIT_CHURN_WORKER_SOURCE, {
      eval: true,
      workerData: {
        root,
        window,
        files: null,
        maxCommits,
        timeoutMs,
        cloneState: health.history,
        resultPath,
        signal
      }
    });
    // The worker publishes a partial result 100ms after its child timeout; leave
    // explicit scheduling room before the synchronous API forces it down.
    Atomics.wait(state, 0, 0, timeoutMs + 2_000);
    if (Atomics.load(state, 0) === 1) parsed = JSON.parse(readFileSync(resultPath, "utf8")) as typeof parsed;
    void worker.terminate().catch(() => undefined);
  } catch (error) {
    parsed = { state: "unavailable", reason: `error:${firstErrorLine(error)}`, commitsScanned: 0, values: [] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const full: GitChurnResult = parsed
    ? { state: parsed.state, reason: parsed.reason, commitsScanned: parsed.commitsScanned, values: new Map(parsed.values) }
    : { state: "partial", reason: "timeout", commitsScanned: 0, values: new Map() };
  historyCache.set(key, full);
  // Defense in depth: a malformed worker payload may never score an unrequested path.
  return { ...full, values: new Map([...full.values].filter(([file]) => requested.has(file))) };
}

/** Preserve the released ORS `is_new_code` input. This is separate from the
 * recent-churn window because a file's first add may predate that window. */
function gitFirstCommitBatch(root: string | undefined, files: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!root || files.length === 0) return out;
  for (let i = 0; i < files.length; i += GIT_FIRST_COMMIT_BATCH) {
    const batch = files.slice(i, i + GIT_FIRST_COMMIT_BATCH);
    try {
      const stdout = execFileSync(
        "git",
        ["log", "--diff-filter=A", "--reverse", "--format=format:%ct", "--name-only", "--", ...batch],
        {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 4_000,
          maxBuffer: 2_000_000
        }
      );
      let currentTs = 0;
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (trimmed === "") {
          currentTs = 0;
          continue;
        }
        const ts = Number(trimmed);
        if (!Number.isNaN(ts) && String(ts) === trimmed) {
          currentTs = ts;
          continue;
        }
        if (currentTs > 0 && !out.has(trimmed)) out.set(trimmed, currentTs);
      }
    } catch {
      // Preserve the released fail-closed behavior for this optional ORS signal.
    }
  }
  return out;
}

/** Repository-level acquisition metadata for report/provenance callers. */
export function inspectRiskChurn(root: string | undefined, files: string[], churnWindow?: string): RiskChurnMetadata {
  const health = inspectRiskInputHealth(root, churnWindow);
  const result = gitChurn(root, files, health.churnWindow, health);
  return { state: result.state, reason: result.reason, commitsScanned: result.commitsScanned };
}

/** Exact deterministic identity of the Git-derived inputs consumed by ORS. */
export function riskHistoryFingerprint(root: string | undefined, files: string[], churnWindow?: string): string {
  const health = inspectRiskInputHealth(root, churnWindow);
  const sortedFiles = [...new Set(files)].sort();
  const churn = gitChurn(root, sortedFiles, health.churnWindow, health);
  const first = churn.state === "complete" ? gitFirstCommitBatch(root, sortedFiles) : new Map<string, number>();
  return hashString(JSON.stringify({
    state: churn.state,
    window: health.churnWindow,
    reason: churn.reason,
    commits_scanned: churn.commitsScanned,
    churn: sortedFiles.map((file) => [file, churn.values.get(file) ?? 0]),
    first_commit: sortedFiles.map((file) => [file, first.get(file) ?? 0])
  }));
}

export function isEntryPoint(node: GraphNode): boolean {
  if (node.properties.cli_entrypoint === true) return true;
  const file = symbolFile(node);
  const title = symbolTitle(node);
  if (API_HANDLER_NAME_RE.test(title) && /(^|\/)api(s)?\//i.test(file)) return true;
  return ENTRY_PATH_RE.test(file) || ENTRY_FILE_RE.test(file) || ENTRY_NAME_RE.test(`${file}#${title}`);
}

function isHttpRouteSymbol(node: GraphNode): boolean {
  return /^(GET|POST|PUT|PATCH|DELETE)$/i.test(symbolTitle(node)) && /(^|\/)api(s)?\//i.test(symbolFile(node));
}

function deriveRouteWeight(node: GraphNode): number {
  const file = symbolFile(node);
  const title = symbolTitle(node);
  const text = `${file} ${title}`;
  const methodMatch = text.match(/\b(POST|GET|PUT|DELETE|PATCH)\b/i);
  const method = methodMatch?.[1].toUpperCase() ?? "";
  const isStore = /\/store\//i.test(file) || /\/store\b/i.test(file);
  const isAdmin = /\/admin\//i.test(file) || /\/admin\b/i.test(file);

  if (node.properties.cli_entrypoint === true) return 6;

  if (isHttpRouteSymbol(node) && isStore) {
    if (method === "POST") return 10;
    if (method === "DELETE") return 9;
    if (method === "PUT") return 8;
    if (method === "GET") return 5;
    // default store route mutation-ish weight
    return 7;
  }
  if (isHttpRouteSymbol(node) && isAdmin) {
    if (method === "POST") return 6;
    if (method === "GET") return 3;
    return 5;
  }
  if (isEntryPoint(node)) return 4;
  if (/(^|\/)(services?|controllers?|handlers?|modules?)\//i.test(file)) return 4;
  return 2;
}

function deriveDataSensitivity(node: GraphNode): number {
  const raw = `${node.external_id} ${symbolFile(node)} ${symbolTitle(node)}`;
  const tokens = new Set(
    raw
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter(Boolean)
  );
  const has = (...values: string[]): boolean => values.some((value) => tokens.has(value));
  // `capture` alone is not a payment signal (for example CapturePanic). It is
  // payment-sensitive only when the same symbol/path also contains payment context.
  if (has("payment", "stripe", "refund", "charge", "billing", "payout", "chargeback") || (has("capture") && has("payment", "stripe", "transaction"))) return 10;
  if (has("auth", "token", "session", "password", "credential", "jwt", "oauth")) return 9;
  if (has("order", "cart", "checkout", "invoice", "transaction")) return 7;
  if (has("customer", "user", "account", "profile", "pii", "gdpr")) return 6;
  if (has("notification", "email", "sms", "webhook", "push")) return 3;
  return 1;
}

/** Prebuilt inputs for flow-depth queries — construct ONCE per ranking run.
 *  Building the entry set (all-nodes scan) and reverse-call adjacency
 *  (all-edges scan) inside every getFlowDepth call made risk ranking
 *  quadratic: ~1.5B scans on a Twenty-sized repo (10.6k symbols × 2 calls
 *  each × 72k nodes+edges). Semantics of the per-node BFS are unchanged. */
export interface FlowDepthContext {
  entryIds: Set<string>;
  callers: Map<string, Set<string>>;
  cache: Map<string, number>;
}

export function buildFlowDepthContext(graph: LocalGraph): FlowDepthContext {
  const entryIds = new Set(
    graph.nodes.filter((n) => n.kind === "CodeSymbol" && isEntryPoint(n)).map((n) => n.external_id)
  );
  const callers = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.relationship_type === "CALLS") {
      const set = callers.get(e.to_external_id) ?? new Set<string>();
      set.add(e.from_external_id);
      callers.set(e.to_external_id, set);
    }
  }
  return { entryIds, callers, cache: new Map() };
}

function getFlowDepth(node: GraphNode, ctx: FlowDepthContext): number {
  const cached = ctx.cache.get(node.external_id);
  if (cached !== undefined) return cached;
  const { entryIds, callers } = ctx;
  if (entryIds.has(node.external_id)) {
    ctx.cache.set(node.external_id, 0);
    return 0;
  }

  let depth = 0;
  let frontier = new Set(callers.get(node.external_id) ?? []);
  const seen = new Set<string>(frontier);
  while (frontier.size > 0 && depth < 6) {
    depth++;
    for (const id of frontier) {
      if (entryIds.has(id)) {
        ctx.cache.set(node.external_id, depth);
        return depth;
      }
    }
    const next = new Set<string>();
    for (const id of frontier) {
      for (const caller of callers.get(id) ?? []) {
        if (!seen.has(caller)) {
          seen.add(caller);
          next.add(caller);
        }
      }
    }
    frontier = next;
  }
  const out = depth >= 6 ? 6 : depth;
  ctx.cache.set(node.external_id, out);
  return out;
}

function complexityProxy(node: GraphNode): number {
  const start = typeof node.properties.start_line === "number" ? node.properties.start_line : 0;
  const end = typeof node.properties.end_line === "number" ? node.properties.end_line : 0;
  if (start > 0 && end >= start) return end - start + 1;
  return 0;
}

function normalizeScores(values: number[]): number[] {
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) {
    return values.map(() => 5);
  }
  return values.map((v) => 1 + ((v - min) / (max - min)) * 9);
}

const DETECTION_MAP: Record<string, number> = {
  proven: 1,
  associated: 5,
  // A lexical/Jaccard candidate is a lead, not evidence — detection stays hard.
  candidate: 8,
  none: 10
};

const NEW_CODE_DAYS = 30;
const NEW_CODE_SECONDS = NEW_CODE_DAYS * 24 * 60 * 60;

interface RawScores {
  p: number;
  i: number;
  d: number;
  reachesDestructiveSink?: boolean;
  scheduledEntry?: boolean;
  sensitivityIgnored?: boolean;
  /** Config reclassification: an explicit sensitivity value that replaces the name-derived one. */
  sensitivityOverride?: number;
}

/** Calls that make a defect irreversible: deletes, drops, purges. Matched on the
 *  LAST segment of a call name, so `t.adminClient.DeleteWorkflowExecution` and a
 *  local `purgeAll` both count; `deleteButtonLabel` (no call) does not. */
// `truncate` dropped (time.Truncate is common; DB truncation is rare in app code);
// `remove` kept but not for listener/handler/attribute/child tails — those detach,
// they don't destroy data.
const DESTRUCTIVE_CALL_RE = /^(?:delete(?!d)|purge|drop|forcedelete|destroy)[A-Za-z0-9_]*$/i;
// Replacement can overwrite a remote collection, but the verb is too broad to
// treat by name alone. It is a sink only when the analyzer proves the receiver
// is a runtime binding imported from an external module.
const IMPORTED_REPLACEMENT_CALL_RE = /^replace[A-Za-z0-9_]*$/i;
// `remove*` is only a data sink through a persistence-shaped field; in-memory
// removals (`pollers.Remove`, `RemoveSpeculativeWorkflowTaskTimeout`) are not.
const REMOVE_CALL_RE = /^remove(?![A-Za-z0-9_]*(?:listener|handler|observer|callback|attribute|attr|class|child|style|hook|timeout|timer)$)[A-Za-z0-9_]*$/i;
const PERSISTENCE_FIELD_RE = /(store|client|db|repo|repository|persistence|manager|queue|bucket|index|table|storage|dao)/i;
// The browser Web Storage API (`sessionStorage` / `localStorage`, optionally via
// `window.`) is a per-tab/per-device client cache, not a durable data store. Its
// `removeItem` matches the persistence vocabulary ("storage") by name only.
const BROWSER_WEB_STORAGE_FIELD_RE = /(^|\.)(sessionStorage|localStorage)$/;
const SCHEDULED_ENTRY_NAME_RE = /(^|\.)(run|execute|handle|process|tick|scan)$/i;
const SCHEDULED_ENTRY_PATH_RE = /(^|\/)(jobs?|workers?|scanners?|scavengers?|cron|schedulers?|processors?|consumers?|reconcil\w*)(\/|$)/i;

/** A time- or queue-triggered entry: nothing calls it synchronously, nobody waits
 *  for a response, so a failure is far less likely to be NOTICED. Graph facts only. */
export function isScheduledEntry(node: GraphNode): boolean {
  return SCHEDULED_ENTRY_NAME_RE.test(node.title || "") && SCHEDULED_ENTRY_PATH_RE.test(symbolFile(node));
}

export interface RiskSignals {
  /** Reaches (<=3 CALLS hops) a destructive sink: a retained external callee or a symbol named like one. */
  reachesDestructiveSink: boolean;
  scheduledEntry: boolean;
  /** Config said this symbol's name-derived sensitivity is a false positive. */
  sensitivityIgnored?: boolean;
  /** Config reclassification: explicit sensitivity value replacing the name-derived one. */
  sensitivityOverride?: number;
}

function computeRawORS(
  node: GraphNode,
  depthCtx: FlowDepthContext,
  incomingRefs: number,
  gitChurn: number,
  fanOut: number,
  detectionTier: "associated" | "candidate" | "none",
  firstCommitTs: number,
  nowSec: number,
  signals: RiskSignals = { reachesDestructiveSink: false, scheduledEntry: false }
): RawScores {
  const isNew = firstCommitTs > 0 && nowSec - firstCommitTs < NEW_CODE_SECONDS;
  const complexity = complexityProxy(node);
  const rawP = gitChurn * 0.35 + fanOut * 0.3 + (isNew ? 15 : 0) + complexity * 0.2;

  const routeWeight = deriveRouteWeight(node);
  const flowDepth = getFlowDepth(node, depthCtx);
  const flowPosition = Math.max(0, 5 - flowDepth);
  const dataSensitivity = signals.sensitivityOverride !== undefined ? signals.sensitivityOverride : signals.sensitivityIgnored ? 0 : deriveDataSensitivity(node);
  // Irreversibility is impact: a bug on a path that reaches a delete/purge cannot be
  // rolled back. Bounded, additive, graph-derived (Fix C, signal 1).
  const rawI = incomingRefs * 0.3 + routeWeight * 0.3 + flowPosition * 0.2 + dataSensitivity * 0.2;
  // Silence lowers detectability: an unproven behavior that runs on a timer or a
  // queue fails where no request surfaces it (Fix C, signal 2). Proven stays proven.
  const silentFactor = signals.scheduledEntry && detectionTier !== "associated" ? 1.25 : 1;
  const d = DETECTION_MAP[detectionTier] * silentFactor;
  return { p: rawP, i: rawI, d, reachesDestructiveSink: signals.reachesDestructiveSink, scheduledEntry: signals.scheduledEntry, sensitivityIgnored: signals.sensitivityIgnored, sensitivityOverride: signals.sensitivityOverride };
}

function staticTestLinkedIds(graph: LocalGraph, candidateIds: Set<string>): Set<string> {
  const ids = new Set<string>();
  const kinds = new Map(graph.nodes.map((n) => [n.external_id, n.kind]));
  for (const e of graph.edges) {
    if (e.evidence_strength !== "hard") continue;
    if (e.relationship_type !== "TESTED_BY" && e.relationship_type !== "COVERS") continue;
    if (kinds.get(e.from_external_id) === "TestCase" && candidateIds.has(e.to_external_id)) ids.add(e.to_external_id);
    if (kinds.get(e.to_external_id) === "TestCase" && candidateIds.has(e.from_external_id)) ids.add(e.from_external_id);
  }
  return ids;
}

function candidateSignalIds(graph: LocalGraph, candidateIds: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const e of graph.candidate_edges ?? []) {
    if (e.relationship_type !== "MAY_BE_TESTED_BY" && e.relationship_type !== "MAY_COVER" && e.relationship_type !== "MAY_RELATE_TO") {
      continue;
    }
    // AI suggestions are useful prompts, but they are never evidence. Do not let them
    // lower detection difficulty in "what to test first" rankings.
    if (e.review_status === "ai_suggested") continue;
    if (candidateIds.has(e.from_external_id)) ids.add(e.from_external_id);
    if (candidateIds.has(e.to_external_id)) ids.add(e.to_external_id);
  }
  return ids;
}

export function rankRiskGaps(graph: LocalGraph, opts: RiskGapOptions = {}): RiskGap[] {
  const limit = opts.limit ?? 20;
  const repoRoot = opts.repoRoot ?? graph.workspace.root;
  const confirmed = opts.includeAssociated
    ? new Set(opts.provenIds ?? [])
    : confirmedBehaviorIds(graph, opts.provenIds);
  // Fix D: ranking hygiene. Test-support code, bare constants/variables, and trivial
  // accessors stay in the behavior DENOMINATOR but never compete for a risk slot.
  const cfgEarly = loadRiskConfig(repoRoot).config.classification;
  const extraTestSupportRef: RegExp[] = cfgEarly.test_support_paths.map(globToRegExp);
  const rankExcludeRef: RegExp[] = cfgEarly.rank_exclude_paths.map(globToRegExp);
  const ACCESSOR_RE = /(^|\.)(Get|Set|Is|Has)[A-Z][A-Za-z0-9]*$/;
  const rankEligible = (n: GraphNode): boolean => {
    const props = (n.properties ?? {}) as { symbol_kind?: string; start_line?: number; end_line?: number };
    if (builtInRankExclusion(symbolFile(n))) return false;
    if (extraTestSupportRef.some((re) => re.test(symbolFile(n)))) return false;
    if (props.symbol_kind === "constant" || props.symbol_kind === "variable") return false;
    // Go `var x = ...` / `const` / `type` one-liners are minted as "class" with a
    // 0–2 line span and no body to test: declarations, not behaviors.
    if (props.symbol_kind === "class" && ((props.end_line ?? 0) - (props.start_line ?? 0)) <= 2) return false;
    const span = (props.end_line ?? 0) - (props.start_line ?? 0);
    if (ACCESSOR_RE.test(n.title || "") && span <= 3) return false;
    if (rankExcludeRef.some((re) => re.test(symbolFile(n)))) return false;
    return true;
  };
  const suppressedRef = loadRiskConfig(repoRoot).config.overrides.filter((o) => o.action === "suppress");
  const isSuppressed = (id: string): boolean => suppressedRef.some((o) => o.symbol === id || globToRegExp(o.symbol).test(id));
  // ORS v2 computes structural inputs and normalizes P/I over the stable
  // denominator-eligible production population. Evidence changes filter the
  // worklist but do not rescale an unchanged peer.
  const normalizationSymbols = graph.nodes.filter((n) => n.kind === "CodeSymbol" && n.denominator_eligible === true && !n.stale && rankEligible(n) && !isSuppressed(n.external_id));
  const symbols = normalizationSymbols.filter((n) => !confirmed.has(n.external_id));
  const symbolIds = new Set(normalizationSymbols.map((s) => s.external_id));
  const fileBySymbolId = new Map(normalizationSymbols.map((s) => [s.external_id, symbolFile(s)]));
  const symbolsByFile = new Map<string, GraphNode[]>();
  for (const s of normalizationSymbols) {
    const file = symbolFile(s);
    const list = symbolsByFile.get(file);
    if (list) list.push(s);
    else symbolsByFile.set(file, [s]);
  }
  const files = [...new Set(normalizationSymbols.map(symbolFile))];
  const loadedCfg = loadRiskConfig(repoRoot);
  const cfg = loadedCfg.config;
  const overrideFor = (id: string): RiskOverride | undefined => cfg.overrides.find((o) => o.symbol === id || globToRegExp(o.symbol).test(id));
  const extraTestSupport = cfg.classification.test_support_paths.map(globToRegExp);
  const extraScheduled = cfg.classification.scheduled_entry_paths.map(globToRegExp);
  const extraSinks = cfg.classification.destructive_sinks.map(globToRegExp);
  const sensitivityIgnore = cfg.classification.sensitivity_ignore.map(globToRegExp);
  const inputHealth = inspectRiskInputHealth(repoRoot, opts.churnWindow);
  const churnWindow = inputHealth.churnWindow;
  const churnResult = gitChurn(repoRoot, files, churnWindow, inputHealth);
  const churn = churnResult.values;
  const churnAvailable = churnResult.state === "complete";
  const firstCommitTs = churnAvailable ? gitFirstCommitBatch(repoRoot, files) : new Map<string, number>();
  const commitMs = Date.parse(inputHealth.commitDate ?? "");
  const graphMs = Date.parse(graph.updated_at || graph.created_at || "");
  const nowSec = Math.floor((Number.isFinite(commitMs) ? commitMs : Number.isFinite(graphMs) ? graphMs : 0) / 1000);

  // A file-level IMPORTS edge does not reference any particular symbol. Only its
  // AST-resolved named imports and non-call module.attribute references may be
  // attributed; CALLS already has an exact symbol target. Older graphs without
  // these metadata facts fail closed instead of redistributing imports.
  const incoming = new Map<string, number>();
  // Display-only breakdown of the same total, so a reader can reconcile the
  // number against the graph: CALLS edges + named imports + module.attr references.
  const incomingParts = new Map<string, { calls: number; named: number; attrs: number }>();
  const addIncoming = (id: string, kind: "calls" | "named" | "attrs", n: number): void => {
    incoming.set(id, (incoming.get(id) ?? 0) + n);
    const parts = incomingParts.get(id) ?? { calls: 0, named: 0, attrs: 0 };
    parts[kind] += n;
    incomingParts.set(id, parts);
  };
  for (const e of graph.edges) {
    if (e.relationship_type === "CALLS" && symbolIds.has(e.to_external_id)) {
      addIncoming(e.to_external_id, "calls", 1);
    } else if (e.relationship_type === "IMPORTS") {
      const named = e.properties?.symbol_imports;
      if (Array.isArray(named)) for (const id of new Set(named)) {
        if (typeof id === "string" && symbolIds.has(id) && fileBySymbolId.get(id) === e.to_external_id) {
          addIncoming(id, "named", 1);
        }
      }
      const refs = e.properties?.symbol_references;
      if (refs && typeof refs === "object" && !Array.isArray(refs)) {
        for (const [id, count] of Object.entries(refs)) {
          if (symbolIds.has(id) && typeof count === "number" && Number.isSafeInteger(count) && count > 0 && fileBySymbolId.get(id) === e.to_external_id) {
            addIncoming(id, "attrs", count);
          }
        }
      }
    }
  }
  const incomingBreakdown = (id: string): string => {
    const parts = incomingParts.get(id);
    if (!parts || (parts.named === 0 && parts.attrs === 0)) return "";
    const bits = [`${parts.calls} call${parts.calls === 1 ? "" : "s"}`];
    if (parts.named > 0) bits.push(`${parts.named} named import${parts.named === 1 ? "" : "s"}`);
    if (parts.attrs > 0) bits.push(`${parts.attrs} module.attribute reference${parts.attrs === 1 ? "" : "s"}`);
    return ` (${bits.join(" + ")})`;
  };
  // Per-symbol churn share: file churn weighted by the symbol's line span so one
  // hot file no longer awards its full churn to every method it contains.
  const fileComplexityTotals = new Map<string, number>();
  for (const [file, syms] of symbolsByFile) {
    fileComplexityTotals.set(file, syms.reduce((acc, s) => acc + Math.max(complexityProxy(s), 1), 0));
  }
  const symbolChurn = (s: GraphNode): number => {
    const file = symbolFile(s);
    const fileChurn = churn.get(file) ?? 0;
    if (fileChurn === 0) return 0;
    const total = fileComplexityTotals.get(file) ?? 1;
    return fileChurn * (Math.max(complexityProxy(s), 1) / Math.max(total, 1));
  };

  const entryPoint = new Map(normalizationSymbols.map((s) => [s.external_id, isEntryPoint(s)]));
  // Single pass over edges (was one full edge scan PER symbol).
  const fanOutTargets = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.relationship_type !== "CALLS" || !symbolIds.has(e.from_external_id)) continue;
    const set = fanOutTargets.get(e.from_external_id) ?? new Set<string>();
    set.add(e.to_external_id);
    fanOutTargets.set(e.from_external_id, set);
  }
  const fanOut = new Map(normalizationSymbols.map((s) => [s.external_id, fanOutTargets.get(s.external_id)?.size ?? 0]));
  // Fix C signals: destructive reach via CALLS (<=3 hops) to a sink; sinks are symbols
  // whose own name, or a retained external callee, is a destructive call.
  const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
  const lastSeg = (name: string): string => name.split(".").pop() ?? name;
  const isDestructiveTerminal = (name: string): boolean =>
    DESTRUCTIVE_CALL_RE.test(name) && !/^(?:deleted|purged|dropped|destroyed)[A-Za-z0-9_]*$/i.test(name);
  // A sink is a destructive call on an EXTERNAL surface — a persistence store, an
  // admin/service client, a database handle. In-repo methods named `delete` are
  // not sinks by name alone (CHASM's `Node.delete` is a tree op, not a data loss).
  // A retained callee is by construction a call through a receiver FIELD to code
  // the graph could not resolve — i.e. an external surface. That structural fact is
  // the test; the qualifier's NAME is not (round one's store/client/db vocabulary was
  // Temporal-shaped and hid inngest's `w.q.DeleteOldQueueSnapshots`).
  const sinkCallee = (id: string): string | undefined => {
    const n = nodeById.get(id);
    if (!n) return undefined;
    const ext = (n.properties as { external_callees?: string[] } | undefined)?.external_callees ?? [];
    const importedStatic = (n.properties as { imported_static_callees?: string[] } | undefined)?.imported_static_callees ?? [];
    const constructorChains = (n.properties as { constructor_chain_sinks?: unknown } | undefined)?.constructor_chain_sinks;
    if (Array.isArray(constructorChains)) {
      const retained = constructorChains.find((entry) => {
        if (!entry || typeof entry !== "object") return false;
        const fact = entry as { callee?: unknown; constructor_symbol?: unknown };
        return typeof fact.callee === "string" && typeof fact.constructor_symbol === "string" && nodeById.has(fact.constructor_symbol);
      }) as { callee: string; constructor_symbol: string } | undefined;
      if (retained) return retained.callee;
    }
    // A receiver FIELD path is `x.field.Method` — no call parentheses before the last
    // segment. `q.Clock().Now().Truncate` is a chain of return values, not a surface.
    const viaField = (c: string): boolean => !c.slice(0, c.lastIndexOf(".")).includes("(");
    const fieldOf = (c: string): string => c.slice(0, c.lastIndexOf("."));
    const persistentRemove = (c: string): boolean =>
      REMOVE_CALL_RE.test(lastSeg(c)) && PERSISTENCE_FIELD_RE.test(fieldOf(c)) && !BROWSER_WEB_STORAGE_FIELD_RE.test(fieldOf(c));
    const destructive = ext.find((c) => viaField(c) && (
      isDestructiveTerminal(lastSeg(c)) ||
      persistentRemove(c) ||
      extraSinks.some((re) => re.test(lastSeg(c)))));
    if (destructive) return destructive;
    return importedStatic.find((c) => viaField(c) && (
      isDestructiveTerminal(lastSeg(c)) ||
      IMPORTED_REPLACEMENT_CALL_RE.test(lastSeg(c)) ||
      persistentRemove(c) ||
      extraSinks.some((re) => re.test(lastSeg(c)))));
  };
  const reachedSinkFrom = (id: string, depth: number, seen: Set<string>): { callee: string; owner: string } | undefined => {
    const own = sinkCallee(id);
    if (own) return { callee: own, owner: id };
    if (depth === 0) return undefined;
    for (const t of fanOutTargets.get(id) ?? []) {
      if (seen.has(t)) continue;
      seen.add(t);
      const hit = reachedSinkFrom(t, depth - 1, seen);
      if (hit) return hit;
    }
    return undefined;
  };
  const endpointHandlers = new Set(
    graph.edges
      .filter((e) => e.relationship_type === "IMPLEMENTED_IN" && nodeById.get(e.from_external_id)?.kind === "Endpoint")
      .map((e) => e.to_external_id)
  );
  const frameworkInvoked = (node: GraphNode): boolean =>
    node.properties.cli_entrypoint === true || endpointHandlers.has(node.external_id);
  const sinkHits = new Map(normalizationSymbols.map((s) => [s.external_id, reachedSinkFrom(s.external_id, 2, new Set([s.external_id]))]));
  const sinkReached = new Map([...sinkHits].map(([k, v]) => [k, v?.callee]));
  const reachesSink = new Map([...sinkReached].map(([k, v]) => [k, v !== undefined]));
  const depthCtx = buildFlowDepthContext(graph);
  const staticLinked = staticTestLinkedIds(graph, symbolIds);
  const candidateLinked = candidateSignalIds(graph, symbolIds);
  const detectionFor = (id: string): "associated" | "candidate" | "none" =>
    staticLinked.has(id) ? "associated" : candidateLinked.has(id) ? "candidate" : "none";
  // R7 ranking-only hygiene happens AFTER the stable ORS normalization population is
  // chosen. These declaration/delegate exclusions therefore remove only worklist
  // slots: they never change graph facts, denominator membership, evidence, or a
  // peer's P/I normalization.
  const postNormalizationExcluded = (node: GraphNode): boolean => {
    if (node.properties.ranking_exclusion_code === "python_class_with_methods" || node.properties.ranking_exclusion_code === "python_structural_container" || node.properties.ranking_exclusion_reason === "python_structural_container") return true;
    const code = node.properties.ranking_exclusion_reason_code;
    if (
      node.properties.ranking_exclusion_code === "trivial_constructor" ||
      node.properties.ranking_exclusion_code === "enum_declaration" ||
      node.properties.ranking_exclusion_code === "data_shape_declaration" ||
      code === "python_trivial_thread_local_initializer" ||
      code === "python_trivial_constructor" ||
      code === "python_stdlib_enum_declaration" ||
      code === "python_data_shape_declaration"
    ) return true;
    return (node.properties.ranking_exclusion_code === "thin_external_delegate" || code === "python_thin_external_delegate")
      && deriveDataSensitivity(node) <= 1
      && sinkCallee(node.external_id) === undefined;
  };
  const worklistSymbols = symbols.filter((node) => !postNormalizationExcluded(node));

  if (opts.legacy) {
    // The formula remains available; neither lane may invent sibling references.
    return worklistSymbols
      .map((s) => {
        const file = symbolFile(s);
        const incoming_refs = incoming.get(s.external_id) ?? 0;
        const git_churn = churn.get(file) ?? 0;
        const isEntry = entryPoint.get(s.external_id) ?? false;
        const churnForScore = Math.min(git_churn, 500);
        const score = Math.round((incoming_refs * 0.4 + churnForScore * 0.4 + (isEntry ? 20 : 0)) * 10) / 10;
        const reasons = [
          `${incoming_refs} incoming structural reference${incoming_refs === 1 ? "" : "s"}`,
          churnAvailable
            ? `${git_churn} git churn line${git_churn === 1 ? "" : "s"} in recent history${git_churn > 500 ? " (score capped at 500)" : ""}`
            : churnResult.state === "partial"
              ? `${git_churn} partial git churn line${git_churn === 1 ? "" : "s"} retained from ${churnResult.commitsScanned} commit${churnResult.commitsScanned === 1 ? "" : "s"} — ${churnResult.reason ?? "bounded acquisition incomplete"}`
              : "Git churn unavailable — provisional static-only ranking"
        ];
        if (isEntry) reasons.push("near an API/route/handler entry point");
        return { id: s.external_id, title: s.title || s.external_id, file, risk_score: score, incoming_refs, git_churn, churn_available: churnAvailable, churn_state: churnResult.state, ...(churnResult.reason ? { churn_reason: churnResult.reason } : {}), commits_scanned: churnResult.commitsScanned, entry_point: isEntry, reasons };
      })
      .sort((a, b) => b.risk_score - a.risk_score || b.incoming_refs - a.incoming_refs || b.git_churn - a.git_churn || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  const rawScores = normalizationSymbols.map((s) => {
    const file = symbolFile(s);
    const incoming_refs = incoming.get(s.external_id) ?? 0;
    const git_churn = symbolChurn(s);
    const fan_out = fanOut.get(s.external_id) ?? 0;
    const ts = firstCommitTs.get(file) ?? 0;
    return computeRawORS(s, depthCtx, incoming_refs, git_churn, fan_out, detectionFor(s.external_id), ts, nowSec, {
      reachesDestructiveSink: cfg.tuning.irreversibility_floor && (reachesSink.get(s.external_id) ?? false),
      scheduledEntry: cfg.tuning.silence_multiplier && (isScheduledEntry(s) || (SCHEDULED_ENTRY_NAME_RE.test(s.title || "") && extraScheduled.some((re) => re.test(symbolFile(s))))),
      sensitivityIgnored: sensitivityIgnore.some((re) => re.test(s.title || "") || re.test(s.external_id)) || overrideFor(s.external_id)?.action === "reclassify" && overrideFor(s.external_id)?.sensitivity === "none",
      // reclassify to a named class uses the SAME values deriveDataSensitivity assigns (payment 10, auth 9, pii 8)
      sensitivityOverride: (() => { const o = overrideFor(s.external_id); if (!o || o.action !== "reclassify") return undefined; return o.sensitivity === "payment" ? 10 : o.sensitivity === "auth" ? 9 : o.sensitivity === "pii" ? 8 : o.sensitivity === "none" ? 0 : undefined; })()
    });
  });

  const pinnedIds = new Set(symbols.filter((s) => overrideFor(s.external_id)?.action === "pin").map((s) => s.external_id));
  const pScores = normalizeScores(rawScores.map((r) => r.p));
  const iScoresRaw = normalizeScores(rawScores.map((r) => r.i));
  // Fix C: a path that can reach a delete/purge has irreversible consequences no
  // matter how few callers it has. Impact FLOORS at 5/10 for such paths (a floor,
  // not an increment — an additive bump vanishes under hub-dominated normalization).
  const iScores = iScoresRaw.map((v, idx) => (rawScores[idx].reachesDestructiveSink ? Math.max(v, 5) : v));
  const rawById = new Map(normalizationSymbols.map((s, idx) => [s.external_id, rawScores[idx]]));
  const pById = new Map(normalizationSymbols.map((s, idx) => [s.external_id, pScores[idx]]));
  const iById = new Map(normalizationSymbols.map((s, idx) => [s.external_id, iScores[idx]]));

  const ranked = worklistSymbols
    .map((s) => {
      const file = symbolFile(s);
      const incoming_refs = Math.round((incoming.get(s.external_id) ?? 0) * 10) / 10;
      const git_churn = Math.round(symbolChurn(s));
      const fan_out = fanOut.get(s.external_id) ?? 0;
      const isEntry = entryPoint.get(s.external_id) ?? false;
      const route_weight = deriveRouteWeight(s);
      const raw = rawById.get(s.external_id)!;
      const data_sensitivity = raw.sensitivityOverride !== undefined ? raw.sensitivityOverride : raw.sensitivityIgnored ? 0 : deriveDataSensitivity(s);
      const flow_position = Math.max(0, 5 - getFlowDepth(s, depthCtx));
      const complexity_proxy = complexityProxy(s);
      const firstTs = firstCommitTs.get(file) ?? 0;
      const is_new_code = firstTs > 0 && nowSec - firstTs < NEW_CODE_SECONDS;
      // Score on the CONTINUOUS normalized values; rounding P and I to integers
      // before multiplying previously collapsed whole hot files into identical
      // P×I×D ties (seventeen ORS-100 rows from one service). Integers remain
      // display-only in the decomposition string.
      const pExact = pById.get(s.external_id)!;
      const iExact = iById.get(s.external_id)!;
      const p = Math.round(pExact);
      const i = Math.round(iExact);
      const d = raw.d;
      const detectionTier = detectionFor(s.external_id);
      let score = Math.round(pExact * iExact * d * 10) / 10;
      // A framework-invoked entry (a registered CLI command, or a handler bound to an
      // Endpoint) has no static caller BY CONSTRUCTION; "disconnected" means dead-code
      // shaped, which an entry the framework calls is not. Before per-symbol fan-in,
      // such entries escaped this dampener only through file-split import counts.
      const disconnected = incoming_refs === 0 && fan_out === 0 && !frameworkInvoked(s);
      if (disconnected) score = Math.round(score * 0.25 * 10) / 10;
      const reasons = [
        `ORS ${score} ≈ P${p} × I${i} × D${d}`,
        `${incoming_refs} incoming symbol-specific structural reference${incoming_refs === 1 ? "" : "s"}${incomingBreakdown(s.external_id)}`,
        churnAvailable
          ? `${git_churn} git churn line${git_churn === 1 ? "" : "s"} attributed to this symbol in recent history`
          : churnResult.state === "partial"
            ? `${git_churn} partial git churn line${git_churn === 1 ? "" : "s"} retained from ${churnResult.commitsScanned} commit${churnResult.commitsScanned === 1 ? "" : "s"} — ${churnResult.reason ?? "bounded acquisition incomplete"}`
            : "Git churn unavailable — provisional static-only ranking",
        `route weight ${route_weight}, data sensitivity ${data_sensitivity}, flow position ${flow_position}, complexity ${complexity_proxy}, fan-out ${fan_out}`
      ];
      if (isEntry) reasons.push("near an API/route/handler entry point");
      if (is_new_code) reasons.push("new code (< 30 days)");
      if (disconnected) reasons.push("no callers and no callees — structurally disconnected, score dampened");
      if (detectionTier === "candidate") reasons.push("lexical candidate test match only — unconfirmed");
      // Reason chips for the two consequence signals — a reader can disagree with the
      // weight without doubting the fact, and the fact is what's shown.
      if (raw.reachesDestructiveSink) reasons.push("reaches a destructive external call (delete/purge) within 2 hops — impact floored at 5");
      if (raw.scheduledEntry) reasons.push("scheduled/queue-triggered entry with no proof — failures surface nowhere, detection ×1.25");
      const override = overrideFor(s.external_id);
      if (override && override.action !== "suppress") reasons.push(`config override (${override.action}): ${override.reason}`);
      return {
        ...(override && override.action !== "suppress" ? { override: { action: override.action, reason: override.reason } } : {}),
        ...(sinkHits.get(s.external_id) ? { sink_callee: sinkHits.get(s.external_id)!.callee, sink_owner: sinkHits.get(s.external_id)!.owner } : {}),
        ...(raw.scheduledEntry ? { scheduled_entry: true } : {}),
        detection_tier: detectionTier,
        id: s.external_id,
        title: s.title || s.external_id,
        file,
        risk_score: score,
        incoming_refs,
        git_churn,
        churn_available: churnAvailable,
        churn_state: churnResult.state,
        ...(churnResult.reason ? { churn_reason: churnResult.reason } : {}),
        commits_scanned: churnResult.commitsScanned,
        entry_point: isEntry,
        reasons,
        probability: p,
        impact: i,
        detection_difficulty: d,
        fan_out,
        route_weight,
        data_sensitivity,
        flow_position,
        complexity_proxy,
        is_new_code,
        integration_signal: detectionTier
      };
    })
    .sort((a, b) => b.risk_score - a.risk_score || b.incoming_refs - a.incoming_refs || b.git_churn - a.git_churn || a.id.localeCompare(b.id));

  // The default API is the true global ranking because reports call this list
  // "top risks". Callers may explicitly request a diversified portfolio, but
  // that presentation policy must never silently redefine rank.
  const withPins = (list: RiskGap[]): RiskGap[] => {
    if (pinnedIds.size === 0) return list;
    const have = new Set(list.map((r) => r.id));
    const extra = ranked.filter((r) => pinnedIds.has(r.id) && !have.has(r.id));
    return extra.length ? [...list, ...extra] : list;
  };
  if (opts.maxPerFile === undefined) return withPins(ranked.slice(0, limit));
  const maxPerFile = Math.max(1, opts.maxPerFile);
  const perFile = new Map<string, number>();
  // Multi-program repos flood identical titles (76 x main) across files; the
  // per-FILE cap cannot see it. Same diversity principle, second axis.
  const maxPerTitle = Math.max(1, opts.maxPerTitle ?? 2);
  const perTitle = new Map<string, number>();
  const surfaced: RiskGap[] = [];
  const overflow: RiskGap[] = [];
  for (const gap of ranked) {
    const used = perFile.get(gap.file) ?? 0;
    const tKey = (gap.title || "").split("(")[0].trim();
    const tUsed = perTitle.get(tKey) ?? 0;
    if (used < maxPerFile && tUsed < maxPerTitle) {
      perTitle.set(tKey, tUsed + 1);
      perFile.set(gap.file, used + 1);
      surfaced.push(gap);
    } else {
      overflow.push(gap);
    }
    if (surfaced.length >= limit) break;
  }
  // A report-level title cap is a hard product constraint: relaxing it during
  // backfill recreates duplicate Invoke/Config cards. We may relax only the
  // per-file cap to fill remaining slots with distinct behavior titles.
  if (surfaced.length < limit) {
    for (const gap of overflow) {
      const tKey = (gap.title || "").split("(")[0].trim();
      const tUsed = perTitle.get(tKey) ?? 0;
      if (tUsed >= maxPerTitle) continue;
      perTitle.set(tKey, tUsed + 1);
      surfaced.push(gap);
      if (surfaced.length >= limit) break;
    }
  }
  // Guarantee: the surfaced list is ALWAYS highest-risk-first, even when the
  // per-file diversity backfill re-admits overflow items (which otherwise land
  // appended after lower-scored rows).
  return withPins(surfaced
    .sort((a, b) => b.risk_score - a.risk_score || b.incoming_refs - a.incoming_refs || b.git_churn - a.git_churn || a.id.localeCompare(b.id))
    .slice(0, limit));
}

/**
 * Canonical priority-gap portfolio shown to a local user and used for automatic
 * generation. Keeping this policy in one function prevents `opro start` from
 * generating for a different "top N" than behavior-coverage.html displays.
 */
export function rankPriorityGaps(
  graph: LocalGraph,
  opts: Omit<RiskGapOptions, "maxPerFile" | "maxPerTitle"> = {}
): RiskGap[] {
  return rankRiskGaps(graph, { ...opts, maxPerFile: 3, maxPerTitle: 1 });
}

/** What the per-repo config DID to this ranking — for visible disclosure in the report.
 *  A tuned report must never pass as clean: every suppression is listed with its reason. */
export function configDisclosureFor(graph: LocalGraph, repoRoot: string): {
  hash: string;
  warnings: string[];
  overridesActive: number;
  suppressed: Array<{ symbol: string; reason: string }>;
  rankExcludePaths: string[];
  floor: boolean;
  silence: boolean;
  tuning: { churn_window_days: number; churn_max_commits: number; churn_timeout_seconds: number };
  proof: { python_runner: string; attempt_limit: number; baseline_green_target: number };
  /** Every other ranking-changing classification setting, listed when set. */
  classification: { test_support_paths: string[]; scheduled_entry_paths: string[]; destructive_sinks: string[]; sensitivity_ignore: string[] };
  /** Symbols whose sensitivity was zeroed by a sensitivity_ignore glob (score changed — say so). */
  sensitivityIgnored: string[];
} {
  const loaded = loadRiskConfig(repoRoot);
  const cfg = loaded.config;
  const symbols = graph.nodes.filter((n) => n.kind === "CodeSymbol" && n.denominator_eligible === true && !n.stale);
  const suppressed: Array<{ symbol: string; reason: string }> = [];
  for (const o of cfg.overrides) {
    if (o.action !== "suppress") continue;
    const re = globToRegExp(o.symbol);
    for (const n of symbols) if (n.external_id === o.symbol || re.test(n.external_id)) suppressed.push({ symbol: n.title || n.external_id, reason: o.reason });
  }
  const ignoreRes = cfg.classification.sensitivity_ignore.map(globToRegExp);
  const sensitivityIgnored = ignoreRes.length
    ? symbols.filter((n) => ignoreRes.some((re) => re.test(n.title || "") || re.test(n.external_id))).map((n) => n.title || n.external_id).slice(0, 50)
    : [];
  return {
    hash: loaded.hash,
    warnings: loaded.warnings,
    overridesActive: cfg.overrides.length,
    suppressed,
    rankExcludePaths: cfg.classification.rank_exclude_paths,
    floor: cfg.tuning.irreversibility_floor,
    silence: cfg.tuning.silence_multiplier,
    tuning: { churn_window_days: cfg.tuning.churn_window_days, churn_max_commits: cfg.tuning.churn_max_commits, churn_timeout_seconds: cfg.tuning.churn_timeout_seconds },
    proof: cfg.proof,
    classification: {
      test_support_paths: cfg.classification.test_support_paths,
      scheduled_entry_paths: cfg.classification.scheduled_entry_paths,
      destructive_sinks: cfg.classification.destructive_sinks,
      sensitivity_ignore: cfg.classification.sensitivity_ignore
    },
    sensitivityIgnored
  };
}
