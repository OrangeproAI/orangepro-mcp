import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { makeCandidateEdge } from "../graph/factories.js";
import { CandidateEdge, GraphNode, LocalGraph } from "../graph/ontology.js";
import { ModelProvider } from "../types.js";
import { hashString, shortHash } from "../util/hash.js";
import { reportProgress } from "../util/progress.js";
import { Clock } from "../util/time.js";
import { workspacePaths } from "../workspace.js";

export const AI_LINKS_VERSION = "orangepro.ai_links.v2" as const;
export const AI_LINKS_PROMPT_VERSION = "orangepro.ai.links.v2" as const;
const DEFAULT_SYMBOLS_PER_BEHAVIOR = 40;
const DEFAULT_MAX_PROMPT_TOKENS = 18_000;
const DEFAULT_MAX_BEHAVIORS = 80;
const CHARS_PER_TOKEN = 4;
const PER_BEHAVIOR_PROMPT_OVERHEAD_TOKENS = 80;
const MAX_RATE_LIMIT_ATTEMPTS = 8;
const STOP_WORDS = new Set([
  "and",
  "are",
  "behavior",
  "code",
  "criteria",
  "expected",
  "file",
  "for",
  "from",
  "has",
  "have",
  "into",
  "not",
  "the",
  "this",
  "that",
  "test",
  "tests",
  "with"
]);

export interface AiLinkSuggestion {
  behavior_id: string;
  symbol_id: string;
  confidence: number;
  rationale?: string;
}

export interface DroppedAiLink {
  behavior_id?: string;
  symbol_id?: string;
  reason: string;
}

export interface AiLinkedSummary {
  links: number;
  behaviors: number;
  symbols: number;
}

export interface AiLinksArtifact {
  schema_version: typeof AI_LINKS_VERSION;
  generated_at: string;
  workspace_root_hash: string;
  model_provider: string;
  model_name: string;
  prompt_version: typeof AI_LINKS_PROMPT_VERSION;
  cache_key: string;
  scope: "gaps" | "all";
  node_set_hash: string;
  behavior_count: number;
  symbol_count: number;
  total_symbol_count?: number;
  symbols_per_behavior?: number;
  max_prompt_tokens?: number;
  batch_count?: number;
  completed_batches?: number;
  skipped_behaviors?: number;
  links: AiLinkSuggestion[];
  dropped_links: DroppedAiLink[];
  warnings: string[];
}

export interface AiLinksGenerateResult {
  mode: "generate";
  ai_links_path: string;
  cache_hit: boolean;
  model_provider: string;
  model_name: string;
  cache_key: string;
  selected_behaviors: number;
  candidate_symbols: number;
  total_symbols?: number;
  batch_count?: number;
  completed_batches?: number;
  skipped_behaviors?: number;
  links: number;
  dropped_links: number;
  warnings: string[];
}

export interface AiLinksApplyResult {
  mode: "apply";
  ai_links_path: string;
  cache_key: string;
  applied_links: number;
  skipped_links: number;
  candidate_edges_before: number;
  candidate_edges_after: number;
  ai_linked: AiLinkedSummary;
  warnings: string[];
}

export type AiLinksResult = AiLinksGenerateResult | AiLinksApplyResult;

interface AiLinkContext {
  behaviorCandidates: BehaviorCandidatePayload[];
  totalSymbolCount: number;
  candidateSymbolCount: number;
  skippedBehaviors: number;
  batchCount: number;
  batches: AiLinkBatch[];
  nodeSetHash: string;
  cacheKey: string;
  options: ResolvedAiLinkOptions;
}

interface BehaviorPayload {
  id: string;
  title: string;
  kind: string;
  source_ref?: string;
  acceptance_criteria: string[];
}

interface BehaviorCandidatePayload {
  behavior: BehaviorPayload;
  code_symbols: SymbolPayload[];
}

interface SymbolPayload {
  id: string;
  title: string;
  file: string;
  symbol_kind?: string;
  signature?: string;
}

interface AiLinkBatch {
  index: number;
  behaviors: BehaviorCandidatePayload[];
  estimated_tokens: number;
  batch_key: string;
}

interface ResolvedAiLinkOptions {
  scope: "gaps" | "all";
  symbolsPerBehavior: number;
  maxPromptTokens: number;
  maxBehaviors: number;
}

export interface AiLinkGenerationOptions {
  all?: boolean;
  symbolsPerBehavior?: number;
  maxPromptTokens?: number;
  maxBehaviors?: number;
  /** Internal progress mapping for parent workflows such as `opro start`. */
  progressRange?: { start: number; end: number };
}

export function aiLinksPath(root: string): string {
  return join(workspacePaths(root).dir, "ai", "links.json");
}

export async function generateAiLinks(
  root: string,
  graph: LocalGraph,
  provider: ModelProvider,
  opts: AiLinkGenerationOptions,
  clock: Clock
): Promise<AiLinksGenerateResult> {
  const context = buildAiLinkContext(graph, provider, resolveAiLinkOptions(opts));
  const batchProgress = (current: number): { current: number; total: number } => {
    if (!opts.progressRange) return { current, total: Math.max(1, context.batchCount) };
    const start = opts.progressRange.start;
    const span = Math.max(0, opts.progressRange.end - opts.progressRange.start);
    const fraction = context.batchCount > 0 ? current / context.batchCount : 1;
    return { current: Math.round(start + span * fraction), total: 100 };
  };
  const path = aiLinksPath(root);
  const cached = readArtifact(path);
  const cachedCompleted = cached?.cache_key === context.cacheKey ? cached.completed_batches ?? context.batchCount : 0;
  if (cached?.cache_key === context.cacheKey && cachedCompleted >= context.batchCount) {
    return {
      mode: "generate",
      ai_links_path: path,
      cache_hit: true,
      model_provider: cached.model_provider,
      model_name: cached.model_name,
      cache_key: cached.cache_key,
      selected_behaviors: cached.behavior_count,
      candidate_symbols: cached.symbol_count,
      total_symbols: cached.total_symbol_count,
      batch_count: cached.batch_count,
      completed_batches: cached.completed_batches,
      skipped_behaviors: cached.skipped_behaviors,
      links: cached.links.length,
      dropped_links: cached.dropped_links.length,
      warnings: retainedWarnings(cached.warnings)
    };
  }

  const resume = cached?.cache_key === context.cacheKey ? cached : null;
  const warnings: string[] = resume ? retainedWarnings(resume.warnings) : [];
  reportProgress(
    `ai-links: selected ${context.behaviorCandidates.length} behavior(s), ${context.candidateSymbolCount}/${context.totalSymbolCount} CodeSymbol candidate(s), ${context.options.symbolsPerBehavior} symbol(s) per behavior, ${context.batchCount} batch(es)`,
    batchProgress(0)
  );
  if (!resume) {
    if (!context.behaviorCandidates.length) warnings.push("No behavior targets selected for AI linking.");
    if (!context.totalSymbolCount) warnings.push("No CodeSymbol targets available for AI linking.");
    if (context.skippedBehaviors) {
      warnings.push(
        `${context.skippedBehaviors} behavior target(s) skipped by the AI link budget; increase ORANGEPRO_AI_LINK_MAX_BEHAVIORS or run \`opro ai-links --max-behaviors <n>\` to widen it.`
      );
    }
  }

  let suggestions: AiLinkSuggestion[] = resume ? [...resume.links] : [];
  let dropped: DroppedAiLink[] = resume ? [...resume.dropped_links] : [];
  let completed = resume ? Math.min(resume.completed_batches ?? 0, context.batchCount) : 0;

  const writeCurrent = (): void => {
    writeArtifact(path, {
      schema_version: AI_LINKS_VERSION,
      generated_at: clock(),
      workspace_root_hash: graph.workspace.root_hash,
      model_provider: provider.providerName,
      model_name: provider.modelName,
      prompt_version: AI_LINKS_PROMPT_VERSION,
      cache_key: context.cacheKey,
      scope: context.options.scope,
      node_set_hash: context.nodeSetHash,
      behavior_count: context.behaviorCandidates.length,
      symbol_count: context.candidateSymbolCount,
      total_symbol_count: context.totalSymbolCount,
      symbols_per_behavior: context.options.symbolsPerBehavior,
      max_prompt_tokens: context.options.maxPromptTokens,
      batch_count: context.batchCount,
      completed_batches: completed,
      skipped_behaviors: context.skippedBehaviors,
      links: suggestions,
      dropped_links: dropped,
      warnings
    });
  };

  if (!context.behaviorCandidates.length || !context.totalSymbolCount) {
    writeCurrent();
  }

  for (let i = completed; context.behaviorCandidates.length && context.totalSymbolCount && i < context.batches.length; i++) {
    const batch = context.batches[i];
    try {
      reportProgress(`ai-links: requesting batch ${i + 1}/${context.batchCount} (${batch.behaviors.length} behavior target(s))`, {
        ...batchProgress(i)
      });
      const parsed = await completeBatchWithBackoff(provider, batch);
      const validated = validateSuggestions(parsed.links, graph, allowedPairs(batch));
      suggestions = dedupeSuggestions([...suggestions, ...validated.links]);
      dropped = [...dropped, ...parsed.dropped, ...validated.dropped];
      completed = i + 1;
      writeCurrent();
      reportProgress(`ai-links: completed batch ${completed}/${context.batchCount}; ${suggestions.length} accepted, ${dropped.length} dropped`, {
        ...batchProgress(completed)
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      warnings.push(`AI link batch ${i + 1}/${context.batchCount} failed: ${message}`);
      writeCurrent();
      break;
    }
  }

  if (!context.batches.length) writeCurrent();
  return {
    mode: "generate",
    ai_links_path: path,
    cache_hit: false,
    model_provider: provider.providerName,
    model_name: provider.modelName,
    cache_key: context.cacheKey,
    selected_behaviors: context.behaviorCandidates.length,
    candidate_symbols: context.candidateSymbolCount,
    total_symbols: context.totalSymbolCount,
    batch_count: context.batchCount,
    completed_batches: completed,
    skipped_behaviors: context.skippedBehaviors,
    links: suggestions.length,
    dropped_links: dropped.length,
    warnings
  };
}

export function applyAiLinks(root: string, graph: LocalGraph): { result: AiLinksApplyResult; graph: LocalGraph } {
  const path = aiLinksPath(root);
  const artifact = readArtifact(path);
  if (!artifact) throw new Error(`No AI links artifact found at ${path}. Run \`opro ai-links\` first.`);

  const validated = validateSuggestions(artifact.links, graph);
  const applied = validated.links.map((link) => toCandidateEdge(link, artifact));
  const before = graph.candidate_edges.length;
  const merged = dedupeCandidateEdges([...graph.candidate_edges, ...applied]);
  const after = merged.length;
  const next: LocalGraph = { ...graph, candidate_edges: merged };
  const warnings = [...retainedWarnings(artifact.warnings), ...validated.dropped.map((d) => `Skipped AI link: ${d.reason}`)];
  return {
    graph: next,
    result: {
      mode: "apply",
      ai_links_path: path,
      cache_key: artifact.cache_key,
      applied_links: after - before,
      skipped_links: validated.dropped.length,
      candidate_edges_before: before,
      candidate_edges_after: after,
      ai_linked: summarizeAiLinks(next),
      warnings
    }
  };
}

export function summarizeAiLinks(graph: LocalGraph): AiLinkedSummary {
  const links = graph.candidate_edges.filter(
    (edge) =>
      edge.review_status === "ai_suggested" &&
      edge.evidence_strength === "weak" &&
      edge.relationship_type === "MAY_RELATE_TO"
  );
  return {
    links: links.length,
    behaviors: new Set(links.map((edge) => edge.from_external_id)).size,
    symbols: new Set(links.map((edge) => edge.to_external_id)).size
  };
}

function resolveAiLinkOptions(opts: AiLinkGenerationOptions): ResolvedAiLinkOptions {
  return {
    scope: opts.all ? "all" : "gaps",
    symbolsPerBehavior: clampPositiveInt(opts.symbolsPerBehavior, DEFAULT_SYMBOLS_PER_BEHAVIOR),
    maxPromptTokens: clampPositiveInt(opts.maxPromptTokens, DEFAULT_MAX_PROMPT_TOKENS),
    maxBehaviors: clampPositiveInt(opts.maxBehaviors, DEFAULT_MAX_BEHAVIORS)
  };
}

function buildAiLinkContext(graph: LocalGraph, provider: ModelProvider, options: ResolvedAiLinkOptions): AiLinkContext {
  const allBehaviors = graph.nodes
    .filter((n) => isBehaviorNode(n))
    .filter((n) => options.scope === "all" || isAiLinkGap(graph, n))
    .sort((a, b) => a.external_id.localeCompare(b.external_id))
    .map((n) => behaviorPayload(graph, n));
  const selectedBehaviors = allBehaviors.slice(0, options.maxBehaviors);
  const allSymbols = graph.nodes
    .filter((n) => n.kind === "CodeSymbol" && n.stale !== true && n.denominator_eligible !== false)
    .sort((a, b) => a.external_id.localeCompare(b.external_id))
    .map(symbolPayload);
  const behaviorCandidates = selectedBehaviors.map((behavior) => ({
    behavior,
    code_symbols: shortlistSymbols(behavior, allSymbols, options.symbolsPerBehavior)
  }));
  const candidateSymbolIds = new Set(behaviorCandidates.flatMap((b) => b.code_symbols.map((s) => s.id)));
  const nodeSet = JSON.stringify({ behavior_candidates: behaviorCandidates, options });
  const nodeSetHash = hashString(nodeSet);
  const cacheKey = shortHash(
    JSON.stringify({
      version: AI_LINKS_VERSION,
      prompt_version: AI_LINKS_PROMPT_VERSION,
      provider: provider.providerName,
      model: provider.modelName,
      scope: options.scope,
      node_set_hash: nodeSetHash
    })
  );
  const batches = buildBatches(behaviorCandidates, options.maxPromptTokens, cacheKey);
  return {
    behaviorCandidates,
    totalSymbolCount: allSymbols.length,
    candidateSymbolCount: candidateSymbolIds.size,
    skippedBehaviors: Math.max(0, allBehaviors.length - selectedBehaviors.length),
    batchCount: batches.length,
    batches,
    nodeSetHash,
    cacheKey,
    options
  };
}

function isBehaviorNode(n: GraphNode): boolean {
  return n.kind === "Requirement" || n.kind === "UserFlow" || n.kind === "BusinessRule";
}

function isAiLinkGap(graph: LocalGraph, behavior: GraphNode): boolean {
  const hasHardProof = graph.edges.some(
    (e) =>
      e.evidence_strength === "hard" &&
      (e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS") &&
      (e.from_external_id === behavior.external_id || e.to_external_id === behavior.external_id)
  );
  if (hasHardProof) return false;
  const symbolIds = new Set(graph.nodes.filter((n) => n.kind === "CodeSymbol").map((n) => n.external_id));
  const hasHardCodeSymbolLink = graph.edges.some(
    (e) =>
      e.evidence_strength === "hard" &&
      e.from_external_id === behavior.external_id &&
      symbolIds.has(e.to_external_id)
  );
  return !hasHardCodeSymbolLink;
}

function behaviorPayload(graph: LocalGraph, n: GraphNode): BehaviorPayload {
  return {
    id: n.external_id,
    title: n.title ?? n.external_id,
    kind: n.kind,
    ...(typeof n.provenance.source_ref === "string" ? { source_ref: n.provenance.source_ref } : {}),
    acceptance_criteria: acceptanceCriteria(graph, n)
  };
}

function acceptanceCriteria(graph: LocalGraph, n: GraphNode): string[] {
  const direct = asStringArray(n.properties.acceptance_criteria);
  const linked = graph.edges
    .filter((e) => e.relationship_type === "HAS_ACCEPTANCE_CRITERION" && e.from_external_id === n.external_id)
    .map((e) => graph.nodes.find((x) => x.external_id === e.to_external_id))
    .filter((x): x is GraphNode => Boolean(x))
    .flatMap((x) => asStringArray(x.properties.text).concat(x.title ? [x.title] : []));
  return [...new Set([...direct, ...linked])].slice(0, 8);
}

function symbolPayload(n: GraphNode): SymbolPayload {
  return {
    id: n.external_id,
    title: n.title ?? n.external_id,
    file: typeof n.properties.file === "string" ? n.properties.file : "",
    ...(typeof n.properties.symbol_kind === "string" ? { symbol_kind: n.properties.symbol_kind } : {}),
    ...(typeof n.properties.signature === "string" ? { signature: n.properties.signature } : {})
  };
}

function shortlistSymbols(behavior: BehaviorPayload, symbols: SymbolPayload[], limit: number): SymbolPayload[] {
  return symbols
    .map((symbol) => ({ symbol, score: scoreSymbolForBehavior(behavior, symbol) }))
    .sort((a, b) => b.score - a.score || a.symbol.file.localeCompare(b.symbol.file) || a.symbol.id.localeCompare(b.symbol.id))
    .slice(0, limit)
    .map((x) => x.symbol);
}

function scoreSymbolForBehavior(behavior: BehaviorPayload, symbol: SymbolPayload): number {
  const behaviorTokens = tokenSet([
    behavior.id,
    behavior.title,
    behavior.kind,
    behavior.source_ref ?? "",
    ...behavior.acceptance_criteria
  ]);
  const symbolTokens = tokenSet([symbol.id, symbol.title, symbol.file, symbol.symbol_kind ?? "", symbol.signature ?? ""]);
  const pathTokens = tokenSet([behavior.source_ref ?? ""]);
  const fileTokens = tokenSet([symbol.file]);
  let score = 0;
  for (const token of behaviorTokens) if (symbolTokens.has(token)) score += 10;
  for (const token of pathTokens) if (fileTokens.has(token)) score += 6;
  const behaviorText = `${behavior.title} ${behavior.acceptance_criteria.join(" ")}`.toLowerCase();
  const symbolTitle = symbol.title.toLowerCase();
  if (symbolTitle && behaviorText.includes(symbolTitle)) score += 25;
  if (symbol.file && behavior.source_ref && sharedPathPrefixDepth(symbol.file, behavior.source_ref) > 0) {
    score += sharedPathPrefixDepth(symbol.file, behavior.source_ref) * 3;
  }
  return score;
}

async function completeBatchWithBackoff(
  provider: ModelProvider,
  batch: AiLinkBatch
): Promise<{ links: AiLinkSuggestion[]; dropped: DroppedAiLink[] }> {
  let lastError: unknown = null;
  for (let attempt = 0; attempt < MAX_RATE_LIMIT_ATTEMPTS; attempt++) {
    try {
      const req = buildAiLinkPrompt(batch);
      const completion = await provider.complete({ system: req.system, user: req.user, temperature: 0, maxTokens: 2000 });
      return await parseOrRepairAiLinkSuggestions(provider, batch, completion);
    } catch (error) {
      lastError = error;
      const retryMs = rateLimitRetryMs(error);
      if (retryMs === null || attempt >= MAX_RATE_LIMIT_ATTEMPTS - 1) break;
      reportProgress(`ai-links: rate limited on batch ${batch.index + 1}; retrying in ${Math.round(retryMs / 1000)}s`);
      await sleep(retryMs);
    }
  }
  throw lastError instanceof Error ? lastError : new Error(String(lastError));
}

function rateLimitRetryMs(error: unknown): number | null {
  const message = error instanceof Error ? error.message : String(error);
  const lower = message.toLowerCase();
  if (!lower.includes("429") && !lower.includes("rate limit") && !lower.includes("tpm")) return null;
  const match = message.match(/try again in\s+([0-9.]+)s/i);
  const seconds = match ? Number.parseFloat(match[1]) : 10;
  if (!Number.isFinite(seconds) || seconds < 0) return 10_000;
  return Math.min(60_000, Math.max(1_000, Math.ceil(seconds * 1000) + 250));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function tokenSet(values: string[]): Set<string> {
  const out = new Set<string>();
  for (const value of values) {
    const spaced = value.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase();
    for (const token of spaced.split(/[^a-z0-9]+/)) {
      if (token.length < 3 || STOP_WORDS.has(token)) continue;
      out.add(token);
    }
  }
  return out;
}

function sharedPathPrefixDepth(a: string, b: string): number {
  const left = a.split(/[\\/]+/).filter(Boolean);
  const right = b.split(/[\\/]+/).filter(Boolean);
  let depth = 0;
  while (left[depth] && left[depth] === right[depth]) depth++;
  return depth;
}

function buildBatches(
  behaviorCandidates: BehaviorCandidatePayload[],
  maxPromptTokens: number,
  cacheKey: string
): AiLinkBatch[] {
  const batches: AiLinkBatch[] = [];
  let current: BehaviorCandidatePayload[] = [];
  let currentTokens = 0;
  for (const candidate of behaviorCandidates) {
    const candidateTokens = estimateTokens(JSON.stringify(candidate, null, 2)) + PER_BEHAVIOR_PROMPT_OVERHEAD_TOKENS;
    if (current.length && currentTokens + candidateTokens > maxPromptTokens) {
      batches.push(makeBatch(batches.length, current, cacheKey));
      current = [];
      currentTokens = 0;
    }
    current.push(candidate);
    currentTokens += candidateTokens;
  }
  if (current.length) batches.push(makeBatch(batches.length, current, cacheKey));
  return batches;
}

function makeBatch(index: number, behaviors: BehaviorCandidatePayload[], cacheKey: string): AiLinkBatch {
  const body = JSON.stringify({ behavior_candidates: behaviors });
  return {
    index,
    behaviors,
    estimated_tokens: estimateTokens(body),
    batch_key: shortHash(JSON.stringify({ cacheKey, index, ids: behaviors.map((b) => b.behavior.id) }))
  };
}

function buildAiLinkPrompt(batch: AiLinkBatch): { system: string; user: string } {
  return {
    system:
      "You propose weak candidate links between existing OrangePro graph node ids. Return JSON only. Never invent ids. Never claim proof or coverage.",
    user: [
      "TASK: Link behavior ids to related CodeSymbol ids from the per-behavior closed sets below.",
      "Return JSON: {\"links\":[{\"behavior_id\":\"...\",\"symbol_id\":\"...\",\"confidence\":0.0,\"rationale\":\"short metadata-only reason\"}]}",
      "Use only CodeSymbol ids listed under the same behavior. If unsure, omit the link. Do not quote or infer source-code bodies.",
      `Batch ${batch.index + 1}; estimated prompt tokens ${batch.estimated_tokens}; batch key ${batch.batch_key}.`,
      "",
      "BEHAVIOR_CANDIDATES:",
      JSON.stringify(batch.behaviors, null, 2)
    ].join("\n")
  };
}

function buildAiLinkRepairPrompt(batch: AiLinkBatch, invalidOutput: string): { system: string; user: string } {
  return {
    system:
      "You repair an AI-link response into valid JSON only. Return no markdown, no prose, and no ids outside the provided closed sets.",
    user: [
      "The previous response was not valid JSON for this schema:",
      "{\"links\":[{\"behavior_id\":\"...\",\"symbol_id\":\"...\",\"confidence\":0.0,\"rationale\":\"short metadata-only reason\"}]}",
      "",
      "Rules:",
      "- Use only CodeSymbol ids listed under the same behavior.",
      "- If a relation is unclear, omit it.",
      "- Return JSON only.",
      "",
      `Batch ${batch.index + 1}; batch key ${batch.batch_key}.`,
      "BEHAVIOR_CANDIDATES:",
      JSON.stringify(batch.behaviors, null, 2),
      "",
      "INVALID_RESPONSE_SNIPPET:",
      invalidOutput.slice(0, 4000)
    ].join("\n")
  };
}

interface ParsedAiLinkSuggestions {
  links: AiLinkSuggestion[];
  dropped: DroppedAiLink[];
  retryable_non_json: boolean;
}

async function parseOrRepairAiLinkSuggestions(
  provider: ModelProvider,
  batch: AiLinkBatch,
  completion: string
): Promise<{ links: AiLinkSuggestion[]; dropped: DroppedAiLink[] }> {
  const parsed = parseAiLinkSuggestions(completion);
  if (!parsed.retryable_non_json) return { links: parsed.links, dropped: parsed.dropped };

  reportProgress(`ai-links: retrying batch ${batch.index + 1} with strict JSON repair`);
  const req = buildAiLinkRepairPrompt(batch, completion);
  const repaired = parseAiLinkSuggestions(
    await provider.complete({ system: req.system, user: req.user, temperature: 0, maxTokens: 2000 })
  );
  if (!repaired.retryable_non_json) return { links: repaired.links, dropped: repaired.dropped };
  return { links: [], dropped: [{ reason: "provider returned non-JSON AI link output after retry" }] };
}

function parseAiLinkSuggestions(text: string): ParsedAiLinkSuggestions {
  const body = stripFence(text);
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return { links: [], dropped: [{ reason: "provider returned non-JSON AI link output" }], retryable_non_json: true };
  }
  if (!raw || typeof raw !== "object") {
    return { links: [], dropped: [{ reason: "provider returned JSON that was not an object or array" }], retryable_non_json: false };
  }
  const items = Array.isArray(raw) ? raw : Array.isArray((raw as { links?: unknown }).links) ? (raw as { links: unknown[] }).links : [];
  if (!items.length) return { links: [], dropped: [], retryable_non_json: false };
  const links: AiLinkSuggestion[] = [];
  const dropped: DroppedAiLink[] = [];
  for (const item of items) {
    if (!item || typeof item !== "object") {
      dropped.push({ reason: "AI link item is not an object" });
      continue;
    }
    const obj = item as Record<string, unknown>;
    const behavior_id = typeof obj.behavior_id === "string" ? obj.behavior_id : "";
    const symbol_id = typeof obj.symbol_id === "string" ? obj.symbol_id : "";
    if (!behavior_id || !symbol_id) {
      dropped.push({ behavior_id, symbol_id, reason: "AI link missing behavior_id or symbol_id" });
      continue;
    }
    links.push({
      behavior_id,
      symbol_id,
      confidence: clampConfidence(typeof obj.confidence === "number" ? obj.confidence : 0.5),
      ...(typeof obj.rationale === "string" && obj.rationale.trim() ? { rationale: obj.rationale.trim().slice(0, 300) } : {})
    });
  }
  return { links, dropped, retryable_non_json: false };
}

function validateSuggestions(
  links: AiLinkSuggestion[],
  graph: LocalGraph,
  allowed?: Set<string>
): { links: AiLinkSuggestion[]; dropped: DroppedAiLink[] } {
  const ids = new Map(graph.nodes.map((n) => [n.external_id, n]));
  const out: AiLinkSuggestion[] = [];
  const dropped: DroppedAiLink[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    const behavior = ids.get(link.behavior_id);
    const symbol = ids.get(link.symbol_id);
    if (!behavior || !isBehaviorNode(behavior)) {
      dropped.push({ behavior_id: link.behavior_id, symbol_id: link.symbol_id, reason: "behavior_id is not an existing behavior node" });
      continue;
    }
    if (!symbol || symbol.kind !== "CodeSymbol") {
      dropped.push({ behavior_id: link.behavior_id, symbol_id: link.symbol_id, reason: "symbol_id is not an existing CodeSymbol node" });
      continue;
    }
    const key = `${link.behavior_id}->${link.symbol_id}`;
    if (allowed && !allowed.has(key)) {
      dropped.push({
        behavior_id: link.behavior_id,
        symbol_id: link.symbol_id,
        reason: "symbol_id was not in the provided candidate set for behavior_id"
      });
      continue;
    }
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return { links: out, dropped };
}

function allowedPairs(batch: AiLinkBatch): Set<string> {
  return new Set(batch.behaviors.flatMap((b) => b.code_symbols.map((s) => `${b.behavior.id}->${s.id}`)));
}

function dedupeSuggestions(links: AiLinkSuggestion[]): AiLinkSuggestion[] {
  const seen = new Set<string>();
  const out: AiLinkSuggestion[] = [];
  for (const link of links) {
    const key = `${link.behavior_id}->${link.symbol_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(link);
  }
  return out;
}

function toCandidateEdge(link: AiLinkSuggestion, artifact: AiLinksArtifact): CandidateEdge {
  return makeCandidateEdge({
    from_external_id: link.behavior_id,
    to_external_id: link.symbol_id,
    relationship_type: "MAY_RELATE_TO",
    evidence_strength: "weak",
    review_status: "ai_suggested",
    reason: link.rationale || "AI-suggested closed-set behavior/code relation.",
    confidence: link.confidence,
    provenance: {
      source_scope_id: `ai:${artifact.cache_key}`,
      source_ref: ".orangepro/ai/links.json",
      detector: "ai_links",
      model_provider: artifact.model_provider,
      model_name: artifact.model_name,
      prompt_version: artifact.prompt_version,
      cache_key: artifact.cache_key
    }
  });
}

function readArtifact(path: string): AiLinksArtifact | null {
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as AiLinksArtifact;
    return raw.schema_version === AI_LINKS_VERSION ? raw : null;
  } catch {
    return null;
  }
}

function writeArtifact(path: string, artifact: AiLinksArtifact): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(artifact, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

function dedupeCandidateEdges(edges: CandidateEdge[]): CandidateEdge[] {
  const seen = new Map<string, CandidateEdge>();
  for (const edge of edges) if (!seen.has(edge.id)) seen.set(edge.id, edge);
  return [...seen.values()];
}

function retainedWarnings(warnings: string[]): string[] {
  return warnings.filter((warning) => !/^AI link batch \d+\/\d+ failed:/.test(warning));
}

function asStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map((v) => String(v)).filter(Boolean);
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return [];
}

function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / CHARS_PER_TOKEN));
}

function clampPositiveInt(value: number | undefined, fallback: number): number {
  if (value === undefined || !Number.isFinite(value)) return fallback;
  return Math.max(1, Math.floor(value));
}

/** Hardened model-output cleanup: fence-strip, then balanced JSON-slice extraction. Shared with the ai-flows lane. */
export function stripFence(text: string): string {
  const match = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = (match ? match[1] : text).trim();
  if (body.startsWith("{") || body.startsWith("[")) return body;
  return extractJsonSlice(body) ?? body;
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.max(0, Math.min(1, value));
}

function extractJsonSlice(text: string): string | null {
  const starts = [text.indexOf("{"), text.indexOf("[")].filter((i) => i >= 0).sort((a, b) => a - b);
  for (const start of starts) {
    const open = text[start];
    const close = open === "{" ? "}" : "]";
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === "\\") escaped = true;
        else if (ch === "\"") inString = false;
        continue;
      }
      if (ch === "\"") {
        inString = true;
        continue;
      }
      if (ch === open) depth++;
      else if (ch === close) {
        depth--;
        if (depth === 0) return text.slice(start, i + 1);
      }
    }
  }
  return null;
}
