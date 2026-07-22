import { execFileSync } from "node:child_process";
import { LocalGraph, GraphNode } from "../graph/ontology.js";

export interface RiskGap {
  id: string;
  title: string;
  file: string;
  risk_score: number;
  incoming_refs: number;
  git_churn: number;
  entry_point: boolean;
  reasons: string[];
  /** OrangePro Risk Score decomposition (P × I × D). */
  probability?: number;
  impact?: number;
  detection_difficulty?: number;
  /** Structural context used by the model. */
  fan_out?: number;
  route_weight?: number;
  data_sensitivity?: number;
  flow_position?: number;
  complexity_proxy?: number;
  is_new_code?: boolean;
  integration_signal?: "associated" | "candidate" | "none";
}

export interface RiskGapOptions {
  limit?: number;
  /** Optional max gaps per file for an explicitly diversified portfolio. Omit for the true global ranking. */
  maxPerFile?: number;
  repoRoot?: string;
  churnWindow?: string;
  /** Use the legacy linear formula (incoming_refs × 0.4 + git_churn × 0.4 + entry-point bonus).
   *  Defaults to false (ORS). Kept for one release so callers can diff. */
  legacy?: boolean;
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

function confirmedBehaviorIds(graph: LocalGraph): Set<string> {
  const ids = new Set<string>();
  const nodeKinds = new Map(graph.nodes.map((n) => [n.external_id, n.kind]));
  for (const e of graph.edges) {
    if (e.evidence_strength !== "hard") continue;
    if (e.relationship_type !== "TESTED_BY" && e.relationship_type !== "COVERS") continue;
    if (nodeKinds.get(e.from_external_id) === "CodeSymbol" || nodeKinds.get(e.from_external_id) === "Requirement") ids.add(e.from_external_id);
    if (nodeKinds.get(e.to_external_id) === "CodeSymbol" || nodeKinds.get(e.to_external_id) === "Requirement") ids.add(e.to_external_id);
  }
  return ids;
}

const GIT_CHURN_BATCH = 200;

function gitChurn(root: string | undefined, files: string[], window: string): Map<string, number> {
  const out = new Map<string, number>();
  if (!root || files.length === 0) return out;
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
      continue;
    }
  }
  return out;
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
  const text = `${node.external_id} ${symbolFile(node)} ${symbolTitle(node)}`.toLowerCase();
  const tiers: [RegExp, number][] = [
    [/payment|stripe|refund|charge(?!r)|billing|payout|chargeback/, 10],
    [/auth(?!or\b)|token(?!iz)|session|password|credential|jwt|oauth/, 9],
    [/order|cart|checkout|invoice|transaction/, 7],
    [/customer|user|account|profile|pii|gdpr/, 6],
    [/notification|email|sms|webhook|push/, 3]
  ];
  for (const [re, weight] of tiers) {
    if (re.test(text)) return weight;
  }
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
}

function computeRawORS(
  node: GraphNode,
  depthCtx: FlowDepthContext,
  incomingRefs: number,
  gitChurn: number,
  fanOut: number,
  detectionTier: "associated" | "candidate" | "none",
  firstCommitTs: number,
  nowSec: number
): RawScores {
  const isNew = firstCommitTs > 0 && nowSec - firstCommitTs < NEW_CODE_SECONDS;
  const complexity = complexityProxy(node);
  const rawP = gitChurn * 0.35 + fanOut * 0.3 + (isNew ? 15 : 0) + complexity * 0.2;

  const routeWeight = deriveRouteWeight(node);
  const flowDepth = getFlowDepth(node, depthCtx);
  const flowPosition = Math.max(0, 5 - flowDepth);
  const dataSensitivity = deriveDataSensitivity(node);
  const rawI = incomingRefs * 0.3 + routeWeight * 0.3 + flowPosition * 0.2 + dataSensitivity * 0.2;

  const d = DETECTION_MAP[detectionTier];
  return { p: rawP, i: rawI, d };
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
  const confirmed = confirmedBehaviorIds(graph);
  const symbols = graph.nodes.filter((n) => n.kind === "CodeSymbol" && n.denominator_eligible === true && !n.stale && !confirmed.has(n.external_id));
  const symbolIds = new Set(symbols.map((s) => s.external_id));
  const symbolsByFile = new Map<string, GraphNode[]>();
  for (const s of symbols) {
    const file = symbolFile(s);
    const list = symbolsByFile.get(file);
    if (list) list.push(s);
    else symbolsByFile.set(file, [s]);
  }
  const files = [...new Set(symbols.map(symbolFile))];
  const churn = gitChurn(opts.repoRoot ?? graph.workspace.root, files, opts.churnWindow ?? "180 days ago");
  const firstCommitTs = gitFirstCommitBatch(opts.repoRoot ?? graph.workspace.root, files);
  const nowSec = Math.floor(Date.now() / 1000);

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
          `${git_churn} git churn line${git_churn === 1 ? "" : "s"} in 180 days${git_churn > 500 ? " (score capped at 500)" : ""}`
        ];
        if (isEntry) reasons.push("near an API/route/handler entry point");
        return { id: s.external_id, title: s.title || s.external_id, file, risk_score: score, incoming_refs, git_churn, entry_point: isEntry, reasons };
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
    return computeRawORS(s, depthCtx, incoming_refs, git_churn, fan_out, detectionFor(s.external_id), ts, nowSec);
  });

  const pScores = normalizeScores(rawScores.map((r) => r.p));
  const iScores = normalizeScores(rawScores.map((r) => r.i));

  const ranked = symbols
    .map((s, idx) => {
      const file = symbolFile(s);
      const incoming_refs = Math.round((incoming.get(s.external_id) ?? 0) * 10) / 10;
      const git_churn = Math.round(symbolChurn(s));
      const fan_out = fanOut.get(s.external_id) ?? 0;
      const isEntry = entryPoint.get(s.external_id) ?? false;
      const route_weight = deriveRouteWeight(s);
      const data_sensitivity = deriveDataSensitivity(s);
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
      const disconnected = (incoming.get(s.external_id) ?? 0) === 0 && fan_out === 0;
      if (disconnected) score = Math.round(score * 0.25 * 10) / 10;
      const reasons = [
        `ORS ${score} ≈ P${p} × I${i} × D${d}`,
        `${incoming_refs} incoming structural reference${incoming_refs === 1 ? "" : "s"} (method-attributed)`,
        `${git_churn} git churn line${git_churn === 1 ? "" : "s"} attributed to this symbol in 180 days`,
        `route weight ${route_weight}, data sensitivity ${data_sensitivity}, fan-out ${fan_out}`
      ];
      if (isEntry) reasons.push("near an API/route/handler entry point");
      if (is_new_code) reasons.push("new code (< 30 days)");
      if (disconnected) reasons.push("no callers and no callees — structurally disconnected, score dampened");
      if (detectionTier === "candidate") reasons.push("lexical candidate test match only — unconfirmed");
      return {
        id: s.external_id,
        title: s.title || s.external_id,
        file,
        risk_score: score,
        incoming_refs,
        git_churn,
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
  if (opts.maxPerFile === undefined) return ranked.slice(0, limit);
  const maxPerFile = Math.max(1, opts.maxPerFile);
  const perFile = new Map<string, number>();
  // Multi-program repos flood identical titles (76 x main) across files; the
  // per-FILE cap cannot see it. Same diversity principle, second axis.
  const maxPerTitle = 2;
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
  if (surfaced.length < limit) surfaced.push(...overflow.slice(0, limit - surfaced.length));
  // Guarantee: the surfaced list is ALWAYS highest-risk-first, even when the
  // per-file diversity backfill re-admits overflow items (which otherwise land
  // appended after lower-scored rows).
  return surfaced
    .sort((a, b) => b.risk_score - a.risk_score || b.incoming_refs - a.incoming_refs || b.git_churn - a.git_churn || a.id.localeCompare(b.id))
    .slice(0, limit);
}
