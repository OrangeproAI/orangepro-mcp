import { buildCallsAdjacency } from "../analyze/clustering.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, type BehaviorFlow, type CandidateEdge, type FlowAnalysisMeta, type FlowTier, type GraphEdge, type GraphNode, type LocalGraph } from "../graph/ontology.js";
import { rankRiskGaps } from "../score/risk.js";
import { stableId } from "../util/ids.js";

export interface FlowWalkerOptions {
  maxDepth?: number;
  maxFlowsPerEntry?: number;
  globalCap?: number;
}

export interface FlowGraphInput {
  nodes: GraphNode[];
  edges: GraphEdge[];
  candidate_edges?: CandidateEdge[];
  workspaceRoot?: string;
}

export interface FlowEntry {
  external_id: string;
  kind: "Endpoint" | "Behavior";
  title?: string;
  start: string;
}

interface InternalFlow extends BehaviorFlow {
  path: string[];
}

const DEFAULT_MAX_DEPTH = 8;
const DEFAULT_MAX_FLOWS_PER_ENTRY = 5;
const DEFAULT_GLOBAL_CAP = 500;
const HIGH_ROUTE_RE = /payment|refund|checkout|cart|order|auth|login|token|customer|user|tax|fulfillment|ship/i;
const MUTATION_METHOD_RE = /^(POST|PUT|PATCH|DELETE)\b/i;

function flowTier(hops: BehaviorFlow["hops"]): FlowTier {
  return hops.some((h) => h.evidence_strength === "framework-derived")
    ? "framework-derived: reachable"
    : "hard: reachable";
}

export function behaviorEntries(nodes: GraphNode[], edges: GraphEdge[]): FlowEntry[] {
  const endpointStarts = new Set(
    edges.filter((e) => e.relationship_type === "IMPLEMENTED_IN").map((e) => e.to_external_id)
  );
  const incomingEligibleCalls = new Set<string>();
  for (const [, outgoing] of buildCallsAdjacency(nodes, edges, { denominatorEligibleOnly: true })) {
    for (const edge of outgoing) incomingEligibleCalls.add(edge.to);
  }
  return nodes
    .filter(
      (n) =>
        n.kind === "CodeSymbol" &&
        n.denominator_eligible === true &&
        n.stale !== true &&
        !endpointStarts.has(n.external_id) &&
        !incomingEligibleCalls.has(n.external_id)
    )
    .map((n) => ({
      external_id: n.external_id,
      kind: "Behavior" as const,
      title: n.title,
      start: n.external_id
    }));
}

export function endpointEntries(nodes: GraphNode[], edges: GraphEdge[]): FlowEntry[] {
  const nodesById = new Map(nodes.map((n) => [n.external_id, n]));
  const codeSymbolIds = new Set(nodes.filter((n) => n.kind === "CodeSymbol" && n.stale !== true).map((n) => n.external_id));
  const entries: FlowEntry[] = [];
  for (const e of edges) {
    if (e.relationship_type !== "IMPLEMENTED_IN" || !codeSymbolIds.has(e.to_external_id)) continue;
    const endpoint = nodesById.get(e.from_external_id);
    if (!endpoint || endpoint.kind !== "Endpoint") continue;
    entries.push({
      external_id: endpoint.external_id,
      kind: "Endpoint",
      title: endpoint.title,
      start: e.to_external_id
    });
  }
  return entries.sort((a, b) => a.external_id.localeCompare(b.external_id) || a.start.localeCompare(b.start));
}

export function dedupeEntries(entries: FlowEntry[]): FlowEntry[] {
  const seen = new Set<string>();
  const out: FlowEntry[] = [];
  for (const e of entries) {
    const key = `${e.kind}|${e.external_id}|${e.start}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(e);
  }
  return out.sort((a, b) => a.kind.localeCompare(b.kind) || a.external_id.localeCompare(b.external_id) || a.start.localeCompare(b.start));
}

function minimalGraph(input: FlowGraphInput): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: {
      name: "flow-walker",
      root: input.workspaceRoot ?? "",
      root_hash: "",
      source_upload_policy: "metadata_only"
    },
    created_at: "",
    updated_at: "",
    sources: [],
    nodes: input.nodes,
    edges: input.edges,
    candidate_edges: input.candidate_edges ?? [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "", git: null, files: {} }
  };
}

function routeFallbackScore(entry: FlowEntry): number {
  if (entry.kind !== "Endpoint") return 0;
  const text = `${entry.title ?? ""} ${entry.external_id}`;
  let score = 500;
  if (MUTATION_METHOD_RE.test(text)) score += 250;
  if (HIGH_ROUTE_RE.test(text)) score += 250;
  return score;
}

function fallbackScore(entry: FlowEntry, adjacency: Map<string, unknown[]>): number {
  const fanOut = adjacency.get(entry.start)?.length ?? 0;
  return routeFallbackScore(entry) + fanOut * 10;
}

export function rankEntries(graph: FlowGraphInput, entries: FlowEntry[], adjacency: Map<string, unknown[]>): FlowEntry[] {
  const riskScores = new Map(
    rankRiskGaps(minimalGraph(graph), { repoRoot: graph.workspaceRoot, limit: Math.max(graph.nodes.length, entries.length) }).map((gap) => [
      gap.id,
      gap.risk_score
    ])
  );
  // Endpoint-anchored flows first. An Endpoint entry IS the definition of a
  // user-triggerable behavior (June 27 agreement); orphan call-graph roots are
  // useful but must never crowd endpoints out of the global cap — on Twenty,
  // saturated risk ties let ~25 internal orphan methods consume all 500 flow
  // slots while every HTTP/GraphQL entry point went unrendered.
  const score = (e: FlowEntry): number => Math.max(riskScores.get(e.start) ?? 0, fallbackScore(e, adjacency));
  const byScore = (a: FlowEntry, b: FlowEntry): number =>
    score(b) - score(a) || a.external_id.localeCompare(b.external_id) || a.start.localeCompare(b.start);
  const endpoints = entries.filter((e) => e.kind === "Endpoint").sort(byScore);
  const behaviors = entries.filter((e) => e.kind !== "Endpoint").sort(byScore);
  return [...endpoints, ...behaviors];
}

function prunePrefixSubsumed(flows: InternalFlow[]): InternalFlow[] {
  const sorted = [...flows].sort((a, b) => b.path.length - a.path.length || a.id.localeCompare(b.id));
  const kept: InternalFlow[] = [];
  for (const flow of sorted) {
    const subsumed = kept.some(
      (other) =>
        other.entry_point.external_id === flow.entry_point.external_id &&
        flow.path.length < other.path.length &&
        flow.path.every((part, idx) => other.path[idx] === part)
    );
    if (!subsumed) kept.push(flow);
  }
  return kept.sort((a, b) => a.entry_point.external_id.localeCompare(b.entry_point.external_id) || a.id.localeCompare(b.id));
}

export function enumerateFlows(graph: FlowGraphInput, opts: FlowWalkerOptions = {}): FlowAnalysisMeta {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxFlowsPerEntry = opts.maxFlowsPerEntry ?? DEFAULT_MAX_FLOWS_PER_ENTRY;
  const globalCap = opts.globalCap ?? DEFAULT_GLOBAL_CAP;
  const adjacency = buildCallsAdjacency(graph.nodes, graph.edges);
  const entries = rankEntries(graph, dedupeEntries([...endpointEntries(graph.nodes, graph.edges), ...behaviorEntries(graph.nodes, graph.edges)]), adjacency);
  const flows: BehaviorFlow[] = [];
  const dropped = { max_depth: 0, max_flows_per_entry: 0, global_cap: 0 };

  for (const entry of entries) {
    if (flows.length >= globalCap) {
      if ((adjacency.get(entry.start)?.length ?? 0) > 0) dropped.global_cap++;
      continue;
    }

    const entryFlows: InternalFlow[] = [];
    const seenPath = new Set<string>();

    const record = (path: string[], hops: BehaviorFlow["hops"], truncated: boolean): boolean => {
      if (hops.length === 0) return true;
      const key = path.join(">");
      if (seenPath.has(key)) return true;
      if (entryFlows.length >= maxFlowsPerEntry) {
        dropped.max_flows_per_entry++;
        return false;
      }
      seenPath.add(key);
      const tier = flowTier(hops);
      entryFlows.push({
        id: stableId("flow", `${entry.kind}|${entry.external_id}|${key}|${tier}`),
        entry_point: { external_id: entry.external_id, kind: entry.kind, title: entry.title },
        hops,
        terminal: path[path.length - 1] ?? entry.start,
        depth: hops.length,
        flow_tier: tier,
        ...(truncated ? { truncated: true } : {}),
        path
      });
      return true;
    };

    const walk = (current: string, path: string[], hops: BehaviorFlow["hops"], visited: Set<string>): boolean => {
      const outgoing = adjacency.get(current) ?? [];
      if (hops.length >= maxDepth) {
        dropped.max_depth++;
        return record(path, hops, true);
      }
      const nextEdges = outgoing.filter((edge) => !visited.has(edge.to));
      if (nextEdges.length === 0) return record(path, hops, false);
      for (const edge of nextEdges) {
        const nextVisited = new Set(visited);
        nextVisited.add(edge.to);
        const nextHops = [
          ...hops,
          {
            from: edge.from,
            to: edge.to,
            evidence_strength: edge.evidence_strength,
            ...(edge.resolution ? { resolution: edge.resolution } : {})
          }
        ];
        if (!walk(edge.to, [...path, edge.to], nextHops, nextVisited)) return false;
      }
      return true;
    };

    walk(entry.start, [entry.start], [], new Set([entry.start]));

    for (const flow of prunePrefixSubsumed(entryFlows)) {
      if (flows.length >= globalCap) {
        dropped.global_cap++;
        continue;
      }
      const { path: _path, ...publicFlow } = flow;
      flows.push(publicFlow);
    }
  }

  const by_tier: Record<FlowTier, number> = {
    "hard: reachable": 0,
    "framework-derived: reachable": 0
  };
  for (const flow of flows) by_tier[flow.flow_tier]++;

  return {
    method: "static_calls_weakest_link",
    total_flows: flows.length,
    by_tier,
    truncated_flows: flows.filter((f) => f.truncated === true).length,
    dropped,
    options: { max_depth: maxDepth, max_flows_per_entry: maxFlowsPerEntry, global_cap: globalCap },
    flows
  };
}
