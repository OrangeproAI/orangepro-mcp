import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { buildCallsAdjacency } from "../analyze/clustering.js";
import { stripFence } from "../aiGraph/links.js";
import {
  AnalysisMeta,
  CandidateFlow,
  CandidateFlowMeta,
  CandidateFlowRejections,
  LocalGraph
} from "../graph/ontology.js";
import { ModelProvider } from "../types.js";
import { stableId } from "../util/ids.js";
import { hashString, shortHash } from "../util/hash.js";
import { reportProgress } from "../util/progress.js";
import { Clock } from "../util/time.js";
import { workspacePaths } from "../workspace.js";
import { behaviorEntries, dedupeEntries, endpointEntries, rankEntries, FlowEntry } from "./flowWalker.js";

export const AI_FLOWS_VERSION = "orangepro.ai_flows.v1" as const;
export const AI_FLOWS_PROMPT_VERSION = "orangepro.ai.flows.v1" as const;
/** ≤ 25 stored flows, ≤ 8 hops/flow (spec caps — over-cap proposals are rejected + counted). */
export const MAX_CANDIDATE_FLOWS = 25;
export const MAX_CANDIDATE_FLOW_HOPS = 8;
// Prompt-size bounds: the closed sets shown to the model stay deterministic
// and bounded so a monorepo cannot blow the context window. Entries are ranked
// endpoints-first; symbols come from the shown entries' CALLS neighborhoods.
const MAX_PROMPT_ENTRIES = 60;
const MAX_PROMPT_SYMBOLS = 300;
const MAX_COMPLETION_TOKENS = 3000;

export interface AiFlowSuggestion {
  entry_id: string;
  hop_ids: string[];
  title?: string;
  rationale?: string;
  confidence: number;
}

export interface DroppedAiFlow {
  entry_id?: string;
  reason: string;
}

/**
 * One entry point exactly as shown to the model. `prompt_id` is unique within
 * the prompt (external_id, disambiguated with `#start` when one endpoint slug
 * maps to several handler starts) so generate and apply resolve the SAME entry.
 */
export interface ShownEntry {
  prompt_id: string;
  external_id: string;
  kind: "Endpoint" | "Behavior";
  title?: string;
  start: string;
}

export interface AiFlowsArtifact {
  schema_version: typeof AI_FLOWS_VERSION;
  generated_at: string;
  workspace_root_hash: string;
  model_provider: string;
  model_name: string;
  prompt_version: typeof AI_FLOWS_PROMPT_VERSION;
  cache_key: string;
  node_set_hash: string;
  entry_count: number;
  anchor_count: number;
  /** The exact closed sets shown to the model; apply validates against their intersection with the current graph. */
  shown_entries: ShownEntry[];
  shown_symbol_ids: string[];
  rejections: CandidateFlowRejections;
  flows: AiFlowSuggestion[];
  dropped_flows: DroppedAiFlow[];
  warnings: string[];
}

export interface AiFlowsGenerateResult {
  mode: "generate";
  ai_flows_path: string;
  cache_hit: boolean;
  model_provider: string;
  model_name: string;
  cache_key: string;
  entry_points: number;
  anchor_symbols: number;
  flows: number;
  rejections: CandidateFlowRejections;
  warnings: string[];
}

export interface AiFlowsApplyResult {
  mode: "apply";
  ai_flows_path: string;
  cache_key: string;
  applied_flows: number;
  rejections: CandidateFlowRejections;
  behavior_coverage_path?: string;
  warnings: string[];
}

export type AiFlowsResult = AiFlowsGenerateResult | AiFlowsApplyResult;

export function aiFlowsPath(root: string): string {
  return join(workspacePaths(root).dir, "flows.json");
}

function legacyAiFlowsPath(root: string): string {
  return join(workspacePaths(root).dir, "ai", "flows.json");
}

function readAiFlowsArtifact(root: string): ReturnType<typeof readArtifact> & { path: string } {
  const path = aiFlowsPath(root);
  const current = readArtifact(path);
  if (current.artifact || current.invalid) return { ...current, path };
  const legacy = legacyAiFlowsPath(root);
  const fallback = readArtifact(legacy);
  return { ...fallback, path: fallback.artifact || fallback.invalid ? legacy : path };
}

interface AnchorContext {
  entries: FlowEntry[];
  /** Every id a hop may target: entry starts + all hard/framework CALLS endpoints. */
  anchorIds: Set<string>;
  /** "from->to" keys of existing hard/framework CALLS edges (hop_status only). */
  knownEdges: Set<string>;
  adjacency: ReturnType<typeof buildCallsAdjacency>;
}

function buildAnchorContext(graph: LocalGraph): AnchorContext {
  const entries = dedupeEntries([
    ...endpointEntries(graph.nodes, graph.edges),
    ...behaviorEntries(graph.nodes, graph.edges)
  ]);
  const adjacency = buildCallsAdjacency(graph.nodes, graph.edges);
  const anchorIds = new Set<string>(entries.map((e) => e.start));
  const knownEdges = new Set<string>();
  for (const [from, outgoing] of adjacency) {
    anchorIds.add(from);
    for (const edge of outgoing) {
      anchorIds.add(edge.to);
      knownEdges.add(`${from}->${edge.to}`);
    }
  }
  return { entries, anchorIds, knownEdges, adjacency };
}

export function emptyRejections(proposed = 0): CandidateFlowRejections {
  return {
    proposed,
    accepted: 0,
    rejected_missing_anchor: 0,
    rejected_unresolved_hop: 0,
    rejected_cycle: 0,
    rejected_over_cap: 0,
    rejected_duplicate: 0,
    rejected_malformed: 0
  };
}

const REJECTION_BUCKETS = [
  "rejected_missing_anchor",
  "rejected_unresolved_hop",
  "rejected_cycle",
  "rejected_over_cap",
  "rejected_duplicate",
  "rejected_malformed"
] as const;

type RejectionBucket = (typeof REJECTION_BUCKETS)[number];

/**
 * Merge a re-validation pass into prior accounting: earlier rejections stay,
 * every flow dropped by the new pass moves from `accepted` into its bucket, so
 * `proposed === accepted + Σ rejected_*` keeps holding at every stage.
 */
function combineRejections(base: CandidateFlowRejections, reval: CandidateFlowRejections): CandidateFlowRejections {
  const out: CandidateFlowRejections = { ...base, accepted: reval.accepted };
  for (const bucket of REJECTION_BUCKETS) out[bucket] = base[bucket] + reval[bucket];
  return out;
}

type Classified =
  | { ok: true; flow: AiFlowSuggestion }
  | { ok: false; bucket: RejectionBucket; reason: string; entry_id?: string };

function flowKey(entryId: string, hopIds: string[]): string {
  return `${entryId}|${hopIds.join(">")}`;
}

/**
 * Exclusive per-flow disposition: a proposed flow is either accepted or lands in
 * exactly one rejection bucket, so `proposed === accepted + Σ rejected_*` holds
 * by construction. Used identically by generate (closed prompt sets), apply
 * (intersection of the recorded shown set with the current graph), and the
 * re-analysis preservation path.
 */
function classifyFlow(
  raw: unknown,
  ctx: { entriesById: Map<string, FlowEntry>; validHopIds: Set<string> },
  acceptedKeys: Set<string>,
  acceptedCount: number
): Classified {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, bucket: "rejected_malformed", reason: "flow item is not an object" };
  }
  const obj = raw as Record<string, unknown>;
  const entryId = typeof obj.entry_id === "string" ? obj.entry_id : "";
  const hopIds = Array.isArray(obj.hop_ids) && obj.hop_ids.every((h) => typeof h === "string") ? (obj.hop_ids as string[]) : null;
  if (!entryId || !hopIds || hopIds.length === 0) {
    return { ok: false, bucket: "rejected_malformed", reason: "flow is missing entry_id or a non-empty hop_ids list", entry_id: entryId };
  }
  const entry = ctx.entriesById.get(entryId);
  if (!entry) {
    return { ok: false, bucket: "rejected_missing_anchor", reason: `entry_id "${entryId}" is not a real entry point`, entry_id: entryId };
  }
  const unresolved = hopIds.find((h) => !ctx.validHopIds.has(h));
  if (unresolved !== undefined) {
    return { ok: false, bucket: "rejected_unresolved_hop", reason: `hop id "${unresolved}" is not in the closed anchor set`, entry_id: entryId };
  }
  const path = [entry.start, ...hopIds];
  if (new Set(path).size !== path.length) {
    return { ok: false, bucket: "rejected_cycle", reason: "hop chain revisits a node", entry_id: entryId };
  }
  if (hopIds.length > MAX_CANDIDATE_FLOW_HOPS) {
    return { ok: false, bucket: "rejected_over_cap", reason: `hop chain exceeds the ${MAX_CANDIDATE_FLOW_HOPS}-hop cap`, entry_id: entryId };
  }
  if (acceptedKeys.has(flowKey(entryId, hopIds))) {
    return { ok: false, bucket: "rejected_duplicate", reason: "duplicate of an already-accepted flow", entry_id: entryId };
  }
  if (acceptedCount >= MAX_CANDIDATE_FLOWS) {
    return { ok: false, bucket: "rejected_over_cap", reason: `flow count exceeds the ${MAX_CANDIDATE_FLOWS}-flow cap`, entry_id: entryId };
  }
  return {
    ok: true,
    flow: {
      entry_id: entryId,
      hop_ids: hopIds,
      confidence: clampConfidence(typeof obj.confidence === "number" ? obj.confidence : 0.5),
      ...(typeof obj.title === "string" && obj.title.trim() ? { title: obj.title.trim().slice(0, 120) } : {}),
      ...(typeof obj.rationale === "string" && obj.rationale.trim() ? { rationale: obj.rationale.trim().slice(0, 300) } : {})
    }
  };
}

function validateProposals(
  items: unknown[],
  ctx: { entriesById: Map<string, FlowEntry>; validHopIds: Set<string> }
): { flows: AiFlowSuggestion[]; rejections: CandidateFlowRejections; dropped: DroppedAiFlow[] } {
  const rejections = emptyRejections(items.length);
  const flows: AiFlowSuggestion[] = [];
  const dropped: DroppedAiFlow[] = [];
  const acceptedKeys = new Set<string>();
  for (const item of items) {
    const verdict = classifyFlow(item, ctx, acceptedKeys, flows.length);
    if (verdict.ok) {
      flows.push(verdict.flow);
      acceptedKeys.add(flowKey(verdict.flow.entry_id, verdict.flow.hop_ids));
      rejections.accepted++;
    } else {
      rejections[verdict.bucket]++;
      dropped.push({ ...(verdict.entry_id ? { entry_id: verdict.entry_id } : {}), reason: verdict.reason });
    }
  }
  return { flows, rejections, dropped };
}

/** Endpoints first (they are the flow anchors), then behaviors — both risk-ranked via flowWalker's rankEntries. */
function selectShownEntries(graph: LocalGraph, anchors: AnchorContext): { shown: ShownEntry[]; byPromptId: Map<string, FlowEntry> } {
  const ranked = rankEntries(
    { nodes: graph.nodes, edges: graph.edges, candidate_edges: graph.candidate_edges, workspaceRoot: graph.workspace.root },
    anchors.entries,
    anchors.adjacency
  );
  const ordered = [...ranked.filter((e) => e.kind === "Endpoint"), ...ranked.filter((e) => e.kind === "Behavior")].slice(
    0,
    MAX_PROMPT_ENTRIES
  );
  const counts = new Map<string, number>();
  for (const e of ordered) counts.set(e.external_id, (counts.get(e.external_id) ?? 0) + 1);
  const shown: ShownEntry[] = ordered.map((e) => ({
    prompt_id: (counts.get(e.external_id) ?? 0) > 1 ? `${e.external_id}#${e.start}` : e.external_id,
    external_id: e.external_id,
    kind: e.kind,
    ...(e.title ? { title: e.title } : {}),
    start: e.start
  }));
  const byPromptId = new Map(shown.map((se, i) => [se.prompt_id, ordered[i]]));
  return { shown, byPromptId };
}

/** BFS over CALLS from the shown entry starts — the flow-relevant neighborhood, not an alphabetical slice. */
function selectShownSymbols(
  starts: string[],
  adjacency: AnchorContext["adjacency"],
  cap: number
): { ids: string[]; truncated: boolean } {
  const queue = [...new Set(starts)].sort((a, b) => a.localeCompare(b));
  const seen = new Set(queue);
  const ids: string[] = [];
  let truncated = false;
  while (queue.length) {
    const id = queue.shift() as string;
    if (ids.length >= cap) {
      truncated = true;
      break;
    }
    ids.push(id);
    const next = (adjacency.get(id) ?? [])
      .map((e) => e.to)
      .filter((to) => !seen.has(to))
      .sort((a, b) => a.localeCompare(b));
    for (const to of next) {
      seen.add(to);
      queue.push(to);
    }
  }
  return { ids, truncated };
}

export async function generateAiFlows(
  root: string,
  graph: LocalGraph,
  provider: ModelProvider,
  clock: Clock
): Promise<AiFlowsGenerateResult> {
  const anchors = buildAnchorContext(graph);
  const nodesById = new Map(graph.nodes.map((n) => [n.external_id, n]));

  const { shown: shownEntries, byPromptId } = selectShownEntries(graph, anchors);
  const symbolSelection = selectShownSymbols(
    shownEntries.map((e) => e.start),
    anchors.adjacency,
    MAX_PROMPT_SYMBOLS
  );
  const shownSymbols = symbolSelection.ids.map((id) => {
    const node = nodesById.get(id);
    return {
      id,
      ...(node?.title ? { title: node.title } : {}),
      ...(typeof node?.properties.file === "string" ? { file: node.properties.file } : {})
    };
  });
  const validHopIds = new Set(symbolSelection.ids);

  const promptEntries = shownEntries.map((e) => ({
    id: e.prompt_id,
    kind: e.kind,
    ...(e.title ? { title: e.title } : {}),
    start: e.start
  }));
  const nodeSetHash = hashString(JSON.stringify({ entries: promptEntries, symbols: shownSymbols }));
  const cacheKey = shortHash(
    JSON.stringify({
      version: AI_FLOWS_VERSION,
      prompt_version: AI_FLOWS_PROMPT_VERSION,
      provider: provider.providerName,
      model: provider.modelName,
      node_set_hash: nodeSetHash
    })
  );
  const path = aiFlowsPath(root);
  const cached = readAiFlowsArtifact(root);
  if (cached.artifact?.cache_key === cacheKey) {
    const hit = cached.artifact;
    return {
      mode: "generate",
      ai_flows_path: cached.path,
      cache_hit: true,
      model_provider: hit.model_provider,
      model_name: hit.model_name,
      cache_key: hit.cache_key,
      entry_points: hit.entry_count,
      anchor_symbols: hit.anchor_count,
      flows: hit.flows.length,
      rejections: hit.rejections,
      warnings: hit.warnings
    };
  }

  const warnings: string[] = [];
  if (cached.invalid) warnings.push("Existing AI flows artifact was invalid and is being regenerated.");
  if (!shownEntries.length) warnings.push("No entry points found for AI flow discovery.");
  if (anchors.entries.length > MAX_PROMPT_ENTRIES) {
    warnings.push(`Entry list capped at ${MAX_PROMPT_ENTRIES} of ${anchors.entries.length} for the prompt (endpoints first, risk-ranked).`);
  }
  if (symbolSelection.truncated) {
    warnings.push(`Anchor symbol neighborhood capped at ${MAX_PROMPT_SYMBOLS} symbol(s) for the prompt.`);
  }

  reportProgress(
    `ai-flows: closed anchor set has ${shownEntries.length} entry point(s) and ${shownSymbols.length} symbol(s)`
  );

  let items: unknown[] = [];
  let uncacheable = false;
  if (shownEntries.length) {
    const req = buildAiFlowsPrompt(promptEntries, shownSymbols);
    const completion = await provider.complete({
      system: req.system,
      user: req.user,
      temperature: 0,
      maxTokens: MAX_COMPLETION_TOKENS
    });
    const parsed = parseAiFlowItems(completion);
    if (parsed === null || parsed.length === 0) {
      // Wrong envelope / prose / empty list: warn and DO NOT cache, so a retry
      // re-asks the model instead of replaying a sticky zero forever.
      uncacheable = true;
      warnings.push("Provider returned no parseable AI flow proposals; nothing staged or cached — re-run `opro ai-flows` to retry.");
    } else {
      items = parsed;
    }
  }

  const validated = validateProposals(items, { entriesById: byPromptId, validHopIds });
  if (!uncacheable) {
    writeArtifact(path, {
      schema_version: AI_FLOWS_VERSION,
      generated_at: clock(),
      workspace_root_hash: graph.workspace.root_hash,
      model_provider: provider.providerName,
      model_name: provider.modelName,
      prompt_version: AI_FLOWS_PROMPT_VERSION,
      cache_key: cacheKey,
      node_set_hash: nodeSetHash,
      entry_count: shownEntries.length,
      anchor_count: shownSymbols.length,
      shown_entries: shownEntries,
      shown_symbol_ids: symbolSelection.ids,
      rejections: validated.rejections,
      flows: validated.flows,
      dropped_flows: validated.dropped,
      warnings
    });
  }
  reportProgress(
    `ai-flows: model proposed ${validated.rejections.proposed} flow(s), accepted ${validated.rejections.accepted}`
  );
  return {
    mode: "generate",
    ai_flows_path: path,
    cache_hit: false,
    model_provider: provider.providerName,
    model_name: provider.modelName,
    cache_key: cacheKey,
    entry_points: shownEntries.length,
    anchor_symbols: shownSymbols.length,
    flows: validated.flows.length,
    rejections: validated.rejections,
    warnings
  };
}

/**
 * Apply the staged artifact: reject a stale workspace outright (root_hash
 * mismatch), then re-validate every flow against the INTERSECTION of the
 * recorded shown set and the current graph (same exclusive rejection buckets —
 * a generate-accepted flow that no longer resolves moves from accepted into
 * the matching rejected_* counter), then store the survivors under
 * `analysis.candidate_flows`. This writer never touches
 * edges/candidate_edges/nodes/analysis.flows.
 */
export function applyAiFlows(root: string, graph: LocalGraph): { result: AiFlowsApplyResult; graph: LocalGraph } {
  const { path, artifact, invalid } = readAiFlowsArtifact(root);
  if (invalid) {
    throw new Error(`AI flows artifact at ${path} is invalid or corrupted; re-run \`opro ai-flows\` to regenerate it.`);
  }
  if (!artifact) throw new Error(`No AI flows artifact found at ${path}. Run \`opro ai-flows\` first.`);
  if (artifact.workspace_root_hash !== graph.workspace.root_hash) {
    throw new Error(
      "AI flows artifact was generated for a different workspace state (root hash mismatch); re-run `opro ai-flows` against the current graph."
    );
  }

  const anchors = buildAnchorContext(graph);
  // Closed set at apply: only entries/symbols that were SHOWN to the model AND
  // still exist in the current graph are valid.
  const currentEntryKeys = new Set(anchors.entries.map((e) => `${e.external_id}|${e.start}`));
  const entriesById = new Map<string, FlowEntry>(
    artifact.shown_entries
      .filter((se) => currentEntryKeys.has(`${se.external_id}|${se.start}`))
      .map((se) => [se.prompt_id, { external_id: se.external_id, kind: se.kind, ...(se.title ? { title: se.title } : {}), start: se.start }])
  );
  const validHopIds = new Set(artifact.shown_symbol_ids.filter((id) => anchors.anchorIds.has(id)));

  const revalidated = validateProposals(artifact.flows, { entriesById, validHopIds });
  const rejections = combineRejections(artifact.rejections, revalidated.rejections);
  const provenance = {
    model_provider: artifact.model_provider,
    model_name: artifact.model_name,
    prompt_version: artifact.prompt_version,
    cache_key: artifact.cache_key
  };
  const flows = revalidated.flows.map((flow) => toCandidateFlow(flow, entriesById, anchors.knownEdges, provenance));
  const meta: CandidateFlowMeta = {
    method: "llm_closed_anchor_proposal",
    rejections,
    options: { max_flows: MAX_CANDIDATE_FLOWS, max_hops: MAX_CANDIDATE_FLOW_HOPS },
    provenance,
    flows
  };
  const analysis: AnalysisMeta = { ...(graph.analysis ?? emptyAnalysis()), candidate_flows: meta };
  const warnings = [...artifact.warnings, ...revalidated.dropped.map((d) => `Skipped stale AI flow: ${d.reason}`)];
  return {
    graph: { ...graph, analysis },
    result: {
      mode: "apply",
      ai_flows_path: path,
      cache_key: artifact.cache_key,
      applied_flows: flows.length,
      rejections,
      warnings
    }
  };
}

/**
 * Re-validate previously applied candidate flows against a freshly rebuilt
 * graph so they SURVIVE re-analysis (without this, every `analyze`/`start`
 * re-run silently dropped the lane's output). Same exclusive rejection
 * buckets: a stored flow whose entry vanished → rejected_missing_anchor; a
 * stored flow with an unresolvable hop → rejected_unresolved_hop. hop_status
 * is recomputed against the new graph's known CALLS edges.
 */
export function revalidateCandidateFlowMeta(meta: CandidateFlowMeta, graph: LocalGraph): CandidateFlowMeta {
  const anchors = buildAnchorContext(graph);
  const entryByKey = new Map(anchors.entries.map((e) => [`${e.external_id}|${e.start}`, e]));
  const entriesById = new Map<string, FlowEntry>();
  const items = meta.flows.map((flow) => {
    const start = flow.hops[0]?.from ?? "";
    const key = `${flow.entry_point.external_id}|${start}`;
    const entry = entryByKey.get(key);
    if (entry) entriesById.set(key, entry);
    return {
      entry_id: key,
      hop_ids: flow.hops.map((h) => h.to),
      ...(flow.title ? { title: flow.title } : {}),
      ...(flow.rationale ? { rationale: flow.rationale } : {}),
      confidence: flow.confidence
    };
  });
  const revalidated = validateProposals(items, { entriesById, validHopIds: anchors.anchorIds });
  return {
    ...meta,
    rejections: combineRejections(meta.rejections, revalidated.rejections),
    flows: revalidated.flows.map((flow) => toCandidateFlow(flow, entriesById, anchors.knownEdges, meta.provenance))
  };
}

function emptyAnalysis(): AnalysisMeta {
  return { test_files: 0, inferred_flows: 0, flows_truncated: 0, max_inferred_flows: 0, symbol_cap_hit: false };
}

function toCandidateFlow(
  flow: AiFlowSuggestion,
  entriesById: Map<string, FlowEntry>,
  knownEdges: Set<string>,
  provenance: CandidateFlowMeta["provenance"]
): CandidateFlow {
  const entry = entriesById.get(flow.entry_id);
  if (!entry) throw new Error(`AI flow entry "${flow.entry_id}" vanished between validation and apply.`);
  const path = [entry.start, ...flow.hop_ids];
  const hops = flow.hop_ids.map((to, i) => ({
    from: path[i],
    to,
    evidence_strength: "candidate" as const,
    hop_status: knownEdges.has(`${path[i]}->${to}`) ? ("matches_known_edge" as const) : ("unverified" as const)
  }));
  return {
    id: stableId("candidateflow", `${entry.kind}|${entry.external_id}|${path.join(">")}`),
    entry_point: { external_id: entry.external_id, kind: entry.kind, ...(entry.title ? { title: entry.title } : {}) },
    hops,
    terminal: path[path.length - 1],
    depth: hops.length,
    review_status: "ai_suggested",
    confidence: flow.confidence,
    ...(flow.title ? { title: flow.title } : {}),
    ...(flow.rationale ? { rationale: flow.rationale } : {}),
    provenance: {
      source_scope_id: `ai:${provenance.cache_key}`,
      source_ref: ".orangepro/flows.json",
      detector: "ai_flows",
      model_provider: provenance.model_provider,
      model_name: provenance.model_name,
      prompt_version: provenance.prompt_version,
      cache_key: provenance.cache_key
    }
  };
}

function buildAiFlowsPrompt(
  entries: Array<{ id: string; kind: string; title?: string; start: string }>,
  symbols: Array<{ id: string; title?: string; file?: string }>
): { system: string; user: string } {
  return {
    system:
      "You propose CANDIDATE behavior flows over existing OrangePro graph ids. Return JSON only. Never invent ids. Never claim proof, coverage, or evidence — candidates are a worklist to verify.",
    user: [
      `TASK: Propose up to ${MAX_CANDIDATE_FLOWS} candidate flows. Each flow starts at one ENTRY id and chains up to ${MAX_CANDIDATE_FLOW_HOPS} SYMBOL ids in plausible call order.`,
      'Return JSON: {"flows":[{"entry_id":"...","hop_ids":["..."],"title":"short name","rationale":"short metadata-only reason","confidence":0.0}]}',
      "Use only ids listed below. If unsure, omit the flow. Do not quote or infer source-code bodies.",
      "",
      "ENTRY_POINTS:",
      JSON.stringify(entries, null, 2),
      "",
      "SYMBOLS:",
      JSON.stringify(symbols, null, 2)
    ].join("\n")
  };
}

/** Parse the model output into raw flow items; null when the body is not JSON. */
function parseAiFlowItems(text: string): unknown[] | null {
  const body = stripFence(text);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return null;
  }
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object" && Array.isArray((raw as { flows?: unknown }).flows)) {
    return (raw as { flows: unknown[] }).flows;
  }
  return [];
}

function isNonNegativeInt(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === "string");
}

/**
 * A rejection ledger is valid only when every counter is a non-negative integer
 * AND the exclusive-bucket invariant holds: proposed === accepted + Σ rejected_*.
 * A tampered/stale artifact with e.g. accepted > proposed is impossible and must
 * be refused so the report's "model proposed N → accepted M" line can't lie.
 */
function rejectionsAreValid(r: unknown): r is CandidateFlowRejections {
  if (!r || typeof r !== "object") return false;
  const rec = r as Record<string, unknown>;
  for (const key of ["proposed", "accepted", ...REJECTION_BUCKETS]) {
    if (!isNonNegativeInt(rec[key])) return false;
  }
  const bucketSum = REJECTION_BUCKETS.reduce((sum, key) => sum + (rec[key] as number), 0);
  return (rec.proposed as number) === (rec.accepted as number) + bucketSum;
}

/**
 * Stored `analysis.candidate_flows` is also untrusted (any process can rewrite
 * graph.json): shape- + invariant-check it before re-validation so a malformed
 * lane is dropped rather than crashing `analyze`.
 */
export function isValidStoredCandidateFlowMeta(meta: unknown): meta is CandidateFlowMeta {
  if (!meta || typeof meta !== "object") return false;
  const m = meta as Record<string, unknown>;
  return m.method === "llm_closed_anchor_proposal" && Array.isArray(m.flows) && rejectionsAreValid(m.rejections);
}

/**
 * The artifact is UNTRUSTED input (a model produced its contents and any local
 * process can rewrite the file): schema-validate every field before use so no
 * unchecked value reaches the graph, the accounting, or the report.
 */
function isValidArtifact(raw: unknown): raw is AiFlowsArtifact {
  if (!raw || typeof raw !== "object") return false;
  const a = raw as Record<string, unknown>;
  if (a.schema_version !== AI_FLOWS_VERSION || a.prompt_version !== AI_FLOWS_PROMPT_VERSION) return false;
  for (const key of ["generated_at", "workspace_root_hash", "model_provider", "model_name", "cache_key", "node_set_hash"]) {
    if (typeof a[key] !== "string") return false;
  }
  if (!isNonNegativeInt(a.entry_count) || !isNonNegativeInt(a.anchor_count)) return false;
  if (!rejectionsAreValid(a.rejections)) return false;
  const r = a.rejections as CandidateFlowRejections;
  if (!Array.isArray(a.flows) || !Array.isArray(a.dropped_flows) || !isStringArray(a.warnings)) return false;
  if (a.flows.length !== r.accepted) return false;
  for (const item of a.flows) {
    if (!item || typeof item !== "object") return false;
    const f = item as Record<string, unknown>;
    if (typeof f.entry_id !== "string" || !isStringArray(f.hop_ids) || f.hop_ids.length === 0) return false;
    if (typeof f.confidence !== "number" || !Number.isFinite(f.confidence)) return false;
    if (f.title !== undefined && typeof f.title !== "string") return false;
    if (f.rationale !== undefined && typeof f.rationale !== "string") return false;
  }
  if (!Array.isArray(a.shown_entries) || !isStringArray(a.shown_symbol_ids)) return false;
  for (const item of a.shown_entries) {
    if (!item || typeof item !== "object") return false;
    const se = item as Record<string, unknown>;
    if (typeof se.prompt_id !== "string" || typeof se.external_id !== "string" || typeof se.start !== "string") return false;
    if (se.kind !== "Endpoint" && se.kind !== "Behavior") return false;
    if (se.title !== undefined && typeof se.title !== "string") return false;
  }
  return true;
}

function readArtifact(path: string): { artifact: AiFlowsArtifact | null; invalid: boolean } {
  if (!existsSync(path)) return { artifact: null, invalid: false };
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (isValidArtifact(raw)) return { artifact: raw, invalid: false };
    return { artifact: null, invalid: true };
  } catch {
    return { artifact: null, invalid: true };
  }
}

function writeArtifact(path: string, artifact: AiFlowsArtifact): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}
