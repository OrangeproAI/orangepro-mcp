import { loadRiskConfig, globToRegExp, type RiskOverride } from "./riskConfig.js";
import { execFileSync } from "node:child_process";
import { LocalGraph, GraphNode } from "../graph/ontology.js";

export interface RiskGap {
  id: string;
  title: string;
  file: string;
  risk_score: number;
  incoming_refs: number;
  git_churn: number;
  /** False means Git history was unavailable/incomplete; zero is not a measured value. */
  churn_available?: boolean;
  entry_point: boolean;
  reasons: string[];
  /** OrangePro Risk Score decomposition (P × I × D). */
  probability?: number;
  impact?: number;
  detection_difficulty?: number;
  /** Config override applied to this row (rendered so a tuned report never passes as clean). */
  override?: { action: RiskOverride["action"]; reason: string };
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

const GIT_CHURN_BATCH = 200;

export function inspectRiskInputHealth(root: string | undefined, churnWindow?: string): RiskInputHealth {
  const unavailableWindow = churnWindow ?? "180 days before HEAD";
  if (!root) return { sourceRoot: null, gitRoot: null, commit: null, commitDate: null, history: "unavailable", churnWindow: unavailableWindow, churnAvailable: false, reason: "source root unavailable" };
  try {
    const gitRoot = execFileSync("git", ["rev-parse", "--show-toplevel"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 4000 }).trim();
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
    const resolvedWindow = churnWindow ?? (Number.isFinite(commitMs) ? new Date(commitMs - 180 * 24 * 60 * 60 * 1000).toISOString() : unavailableWindow);
    return {
      sourceRoot: root,
      gitRoot,
      commit,
      commitDate,
      history: shallow ? "shallow" : partial ? "partial" : "full",
      churnWindow: resolvedWindow,
      churnAvailable: !shallow && !partial,
      reason: shallow
        ? "shallow Git history cannot support a complete churn window"
        : partial
          ? "partial-clone Git objects cannot guarantee a complete offline churn window"
          : undefined
    };
  } catch {
    return { sourceRoot: root, gitRoot: null, commit: null, commitDate: null, history: "unavailable", churnWindow: unavailableWindow, churnAvailable: false, reason: "Git history could not be read from the analyzed source root" };
  }
}

function gitChurn(root: string | undefined, files: string[], window: string): { values: Map<string, number>; complete: boolean } {
  const out = new Map<string, number>();
  if (!root || files.length === 0) return { values: out, complete: Boolean(root) };
  for (let i = 0; i < files.length; i += GIT_CHURN_BATCH) {
    const batch = files.slice(i, i + GIT_CHURN_BATCH);
    try {
      const stdout = execFileSync("git", ["log", `--since=${window}`, "--numstat", "--", ...batch], {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 4000,
        maxBuffer: 2_000_000
      });
      for (const line of stdout.split("\n")) {
        const m = line.match(/^(\d+|-)\s+(\d+|-)\s+(.+)$/);
        if (!m) continue;
        const adds = m[1] === "-" ? 0 : Number(m[1]);
        const dels = m[2] === "-" ? 0 : Number(m[2]);
        out.set(m[3], (out.get(m[3]) ?? 0) + adds + dels);
      }
    } catch {
      return { values: new Map(), complete: false };
    }
  }
  return { values: out, complete: true };
}

function gitFirstCommitBatch(root: string | undefined, files: string[]): Map<string, number> {
  const out = new Map<string, number>();
  if (!root || files.length === 0) return out;
  for (let i = 0; i < files.length; i += GIT_CHURN_BATCH) {
    const batch = files.slice(i, i + GIT_CHURN_BATCH);
    try {
      const stdout = execFileSync(
        "git",
        ["log", "--diff-filter=A", "--reverse", "--format=format:%ct", "--name-only", "--", ...batch],
        {
          cwd: root,
          encoding: "utf8",
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 4000,
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
        if (currentTs > 0 && !out.has(trimmed)) {
          out.set(trimmed, currentTs);
        }
      }
    } catch {
      continue;
    }
  }
  return out;
}

export function isEntryPoint(node: GraphNode): boolean {
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
}

/** Calls that make a defect irreversible: deletes, drops, purges. Matched on the
 *  LAST segment of a call name, so `t.adminClient.DeleteWorkflowExecution` and a
 *  local `purgeAll` both count; `deleteButtonLabel` (no call) does not. */
const DESTRUCTIVE_CALL_RE = /^(delete|drop|purge|truncate|remove|forcedelete|destroy)[A-Za-z0-9_]*$/i;
const SCHEDULED_ENTRY_NAME_RE = /(^|\.)(Run|Execute|Handle|Process|Tick|Scan)$/;
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
  const dataSensitivity = signals.sensitivityIgnored ? 0 : deriveDataSensitivity(node);
  // Irreversibility is impact: a bug on a path that reaches a delete/purge cannot be
  // rolled back. Bounded, additive, graph-derived (Fix C, signal 1).
  const rawI = incomingRefs * 0.3 + routeWeight * 0.3 + flowPosition * 0.2 + dataSensitivity * 0.2;
  // Silence lowers detectability: an unproven behavior that runs on a timer or a
  // queue fails where no request surfaces it (Fix C, signal 2). Proven stays proven.
  const silentFactor = signals.scheduledEntry && detectionTier !== "associated" ? 1.25 : 1;
  const d = DETECTION_MAP[detectionTier] * silentFactor;
  return { p: rawP, i: rawI, d, reachesDestructiveSink: signals.reachesDestructiveSink, scheduledEntry: signals.scheduledEntry, sensitivityIgnored: signals.sensitivityIgnored };
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
  const confirmed = confirmedBehaviorIds(graph, opts.provenIds);
  // Fix D: ranking hygiene. Test-support code, bare constants/variables, and trivial
  // accessors stay in the behavior DENOMINATOR but never compete for a risk slot.
  const TEST_SUPPORT_PATH_RE = /(^|\/)(testing|testutils?|testhelpers?|fixtures?|mocks?|fakes?)(\/|$)/i;
  const extraTestSupportRef: RegExp[] = loadRiskConfig(opts.repoRoot ?? graph.workspace.root).config.classification.test_support_paths.map(globToRegExp);
  const ACCESSOR_RE = /(^|\.)(Get|Set|Is|Has)[A-Z][A-Za-z0-9]*$/;
  const rankEligible = (n: GraphNode): boolean => {
    const props = (n.properties ?? {}) as { symbol_kind?: string; start_line?: number; end_line?: number };
    if (TEST_SUPPORT_PATH_RE.test(symbolFile(n))) return false;
    if (extraTestSupportRef.some((re) => re.test(symbolFile(n)))) return false;
    if (props.symbol_kind === "constant" || props.symbol_kind === "variable") return false;
    // Go `var x = ...` / `const` / `type` one-liners are minted as "class" with a
    // 0–2 line span and no body to test: declarations, not behaviors.
    if (props.symbol_kind === "class" && ((props.end_line ?? 0) - (props.start_line ?? 0)) <= 2) return false;
    const span = (props.end_line ?? 0) - (props.start_line ?? 0);
    if (ACCESSOR_RE.test(n.title || "") && span <= 3) return false;
    return true;
  };
  const suppressedRef = loadRiskConfig(opts.repoRoot ?? graph.workspace.root).config.overrides.filter((o) => o.action === "suppress");
  const isSuppressed = (id: string): boolean => suppressedRef.some((o) => o.symbol === id || globToRegExp(o.symbol).test(id));
  const symbols = graph.nodes.filter((n) => n.kind === "CodeSymbol" && n.denominator_eligible === true && !n.stale && !confirmed.has(n.external_id) && rankEligible(n) && !isSuppressed(n.external_id));
  const symbolIds = new Set(symbols.map((s) => s.external_id));
  const symbolsByFile = new Map<string, GraphNode[]>();
  for (const s of symbols) {
    const file = symbolFile(s);
    const list = symbolsByFile.get(file);
    if (list) list.push(s);
    else symbolsByFile.set(file, [s]);
  }
  const files = [...new Set(symbols.map(symbolFile))];
  const repoRoot = opts.repoRoot ?? graph.workspace.root;
  const loadedCfg = loadRiskConfig(repoRoot);
  const cfg = loadedCfg.config;
  const overrideFor = (id: string): RiskOverride | undefined => cfg.overrides.find((o) => o.symbol === id || globToRegExp(o.symbol).test(id));
  const extraTestSupport = cfg.classification.test_support_paths.map(globToRegExp);
  const extraScheduled = cfg.classification.scheduled_entry_paths.map(globToRegExp);
  const extraSinks = cfg.classification.destructive_sinks.map(globToRegExp);
  const sensitivityIgnore = cfg.classification.sensitivity_ignore.map(globToRegExp);
  const inputHealth = inspectRiskInputHealth(repoRoot, opts.churnWindow);
  const churnWindow = inputHealth.churnWindow;
  const churnResult = inputHealth.churnAvailable ? gitChurn(repoRoot, files, churnWindow) : { values: new Map<string, number>(), complete: false };
  const churn = churnResult.values;
  const churnAvailable = inputHealth.churnAvailable && churnResult.complete;
  const firstCommitTs = churnAvailable ? gitFirstCommitBatch(repoRoot, files) : new Map<string, number>();
  const commitMs = Date.parse(inputHealth.commitDate ?? "");
  const graphMs = Date.parse(graph.updated_at || graph.created_at || "");
  const nowSec = Math.floor((Number.isFinite(commitMs) ? commitMs : Number.isFinite(graphMs) ? graphMs : 0) / 1000);

  // Method-level attribution. CALLS edges are already symbol-granular and count
  // at full weight. IMPORTS edges are file-granular: previously every symbol in
  // an imported file inherited the file's full import count, which made all 17
  // methods of a hot service tie at the same "incoming refs" and saturated the
  // ranking. Split the file's import count across its eligible symbols instead.
  const incoming = new Map<string, number>();
  const fileImports = new Map<string, number>();
  for (const e of graph.edges) {
    if (e.relationship_type === "CALLS" && symbolIds.has(e.to_external_id)) {
      incoming.set(e.to_external_id, (incoming.get(e.to_external_id) ?? 0) + 1);
    } else if (e.relationship_type === "IMPORTS" && symbolsByFile.has(e.to_external_id)) {
      fileImports.set(e.to_external_id, (fileImports.get(e.to_external_id) ?? 0) + 1);
    }
  }
  for (const [file, count] of fileImports) {
    const syms = symbolsByFile.get(file) ?? [];
    if (syms.length === 0) continue;
    const share = count / syms.length;
    for (const s of syms) incoming.set(s.external_id, (incoming.get(s.external_id) ?? 0) + share);
  }
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

  const entryPoint = new Map(symbols.map((s) => [s.external_id, isEntryPoint(s)]));
  // Single pass over edges (was one full edge scan PER symbol).
  const fanOutTargets = new Map<string, Set<string>>();
  for (const e of graph.edges) {
    if (e.relationship_type !== "CALLS" || !symbolIds.has(e.from_external_id)) continue;
    const set = fanOutTargets.get(e.from_external_id) ?? new Set<string>();
    set.add(e.to_external_id);
    fanOutTargets.set(e.from_external_id, set);
  }
  const fanOut = new Map(symbols.map((s) => [s.external_id, fanOutTargets.get(s.external_id)?.size ?? 0]));
  // Fix C signals: destructive reach via CALLS (<=3 hops) to a sink; sinks are symbols
  // whose own name, or a retained external callee, is a destructive call.
  const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
  const lastSeg = (name: string): string => name.split(".").pop() ?? name;
  // A sink is a destructive call on an EXTERNAL surface — a persistence store, an
  // admin/service client, a database handle. In-repo methods named `delete` are
  // not sinks by name alone (CHASM's `Node.delete` is a tree op, not a data loss).
  const SINK_QUALIFIER_RE = /(client|store|manager|persistence|db|admin|repo|repository|dao|storage|bucket|index)/i;
  const isSink = (id: string): boolean => {
    const n = nodeById.get(id);
    if (!n) return false;
    const ext = (n.properties as { external_callees?: string[] } | undefined)?.external_callees ?? [];
    return ext.some((c) => (DESTRUCTIVE_CALL_RE.test(lastSeg(c)) && SINK_QUALIFIER_RE.test(c.slice(0, c.lastIndexOf(".")))) || extraSinks.some((re) => re.test(lastSeg(c))));
  };
  const reachesSinkFrom = (id: string, depth: number, seen: Set<string>): boolean => {
    if (isSink(id)) return true;
    if (depth === 0) return false;
    for (const t of fanOutTargets.get(id) ?? []) {
      if (seen.has(t)) continue;
      seen.add(t);
      if (reachesSinkFrom(t, depth - 1, seen)) return true;
    }
    return false;
  };
  const reachesSink = new Map(symbols.map((s) => [s.external_id, reachesSinkFrom(s.external_id, 2, new Set([s.external_id]))]));
  const depthCtx = buildFlowDepthContext(graph);
  const staticLinked = staticTestLinkedIds(graph, symbolIds);
  const candidateLinked = candidateSignalIds(graph, symbolIds);
  const detectionFor = (id: string): "associated" | "candidate" | "none" =>
    staticLinked.has(id) ? "associated" : candidateLinked.has(id) ? "candidate" : "none";

  if (opts.legacy) {
    return symbols
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
            ? `${git_churn} git churn line${git_churn === 1 ? "" : "s"} in 180 days${git_churn > 500 ? " (score capped at 500)" : ""}`
            : "Git churn unavailable — provisional static-only ranking"
        ];
        if (isEntry) reasons.push("near an API/route/handler entry point");
        return { id: s.external_id, title: s.title || s.external_id, file, risk_score: score, incoming_refs, git_churn, churn_available: churnAvailable, entry_point: isEntry, reasons };
      })
      .sort((a, b) => b.risk_score - a.risk_score || b.incoming_refs - a.incoming_refs || b.git_churn - a.git_churn || a.id.localeCompare(b.id))
      .slice(0, limit);
  }

  const rawScores = symbols.map((s) => {
    const file = symbolFile(s);
    const incoming_refs = incoming.get(s.external_id) ?? 0;
    const git_churn = symbolChurn(s);
    const fan_out = fanOut.get(s.external_id) ?? 0;
    const ts = firstCommitTs.get(file) ?? 0;
    return computeRawORS(s, depthCtx, incoming_refs, git_churn, fan_out, detectionFor(s.external_id), ts, nowSec, {
      reachesDestructiveSink: cfg.tuning.irreversibility_floor && (reachesSink.get(s.external_id) ?? false),
      scheduledEntry: cfg.tuning.silence_multiplier && (isScheduledEntry(s) || (SCHEDULED_ENTRY_NAME_RE.test(s.title || "") && extraScheduled.some((re) => re.test(symbolFile(s))))),
      sensitivityIgnored: sensitivityIgnore.some((re) => re.test(s.title || "") || re.test(s.external_id)) || overrideFor(s.external_id)?.action === "reclassify" && overrideFor(s.external_id)?.sensitivity === "none"
    });
  });

  const pinnedIds = new Set(symbols.filter((s) => overrideFor(s.external_id)?.action === "pin").map((s) => s.external_id));
  const pScores = normalizeScores(rawScores.map((r) => r.p));
  const iScoresRaw = normalizeScores(rawScores.map((r) => r.i));
  // Fix C: a path that can reach a delete/purge has irreversible consequences no
  // matter how few callers it has. Impact FLOORS at 5/10 for such paths (a floor,
  // not an increment — an additive bump vanishes under hub-dominated normalization).
  const iScores = iScoresRaw.map((v, idx) => (rawScores[idx].reachesDestructiveSink ? Math.max(v, 5) : v));

  const ranked = symbols
    .map((s, idx) => {
      const file = symbolFile(s);
      const incoming_refs = Math.round((incoming.get(s.external_id) ?? 0) * 10) / 10;
      const git_churn = Math.round(symbolChurn(s));
      const fan_out = fanOut.get(s.external_id) ?? 0;
      const isEntry = entryPoint.get(s.external_id) ?? false;
      const route_weight = deriveRouteWeight(s);
      const data_sensitivity = rawScores[idx].sensitivityIgnored ? 0 : deriveDataSensitivity(s);
      const flow_position = Math.max(0, 5 - getFlowDepth(s, depthCtx));
      const complexity_proxy = complexityProxy(s);
      const firstTs = firstCommitTs.get(file) ?? 0;
      const is_new_code = firstTs > 0 && nowSec - firstTs < NEW_CODE_SECONDS;
      // Score on the CONTINUOUS normalized values; rounding P and I to integers
      // before multiplying previously collapsed whole hot files into identical
      // P×I×D ties (seventeen ORS-100 rows from one service). Integers remain
      // display-only in the decomposition string.
      const pExact = pScores[idx];
      const iExact = iScores[idx];
      const p = Math.round(pExact);
      const i = Math.round(iExact);
      const d = rawScores[idx].d;
      const detectionTier = detectionFor(s.external_id);
      let score = Math.round(pExact * iExact * d * 10) / 10;
      const disconnected = incoming_refs === 0 && fan_out === 0;
      if (disconnected) score = Math.round(score * 0.25 * 10) / 10;
      const reasons = [
        `ORS ${score} ≈ P${p} × I${i} × D${d}`,
        `${incoming_refs} incoming structural reference${incoming_refs === 1 ? "" : "s"} (method-attributed)`,
        churnAvailable
          ? `${git_churn} git churn line${git_churn === 1 ? "" : "s"} attributed to this symbol in 180 days`
          : "Git churn unavailable — provisional static-only ranking",
        `route weight ${route_weight}, data sensitivity ${data_sensitivity}, flow position ${flow_position}, complexity ${complexity_proxy}, fan-out ${fan_out}`
      ];
      if (isEntry) reasons.push("near an API/route/handler entry point");
      if (is_new_code) reasons.push("new code (< 30 days)");
      if (disconnected) reasons.push("no callers and no callees — structurally disconnected, score dampened");
      if (detectionTier === "candidate") reasons.push("lexical candidate test match only — unconfirmed");
      // Reason chips for the two consequence signals — a reader can disagree with the
      // weight without doubting the fact, and the fact is what's shown.
      if (rawScores[idx].reachesDestructiveSink) reasons.push("reaches a destructive external call (delete/purge) within 2 hops — impact floored at 5");
      if (rawScores[idx].scheduledEntry) reasons.push("scheduled/queue-triggered entry with no proof — failures surface nowhere, detection ×1.25");
      const override = overrideFor(s.external_id);
      if (override && override.action !== "suppress") reasons.push(`config override (${override.action}): ${override.reason}`);
      return {
        ...(override && override.action !== "suppress" ? { override: { action: override.action, reason: override.reason } } : {}),
        id: s.external_id,
        title: s.title || s.external_id,
        file,
        risk_score: score,
        incoming_refs,
        git_churn,
        churn_available: churnAvailable,
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
