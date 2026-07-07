import path from "node:path";
import { CandidateEdge, GraphEdge, GraphNode, StructuralClustersMeta } from "../graph/ontology.js";
import { shortHash } from "../util/hash.js";

const MAX_EMITTED_CLUSTERS = 50;
const MAX_CLUSTER_ITEMS = 8;
const MAX_COMPONENT_SIZE = 250;

type LinkKind = "hard_call" | "likely_call" | "import";

interface Link {
  from: string;
  to: string;
  kind: LinkKind;
}

export type CallsAdjacencyStrength = "hard" | "framework-derived";

export interface CallsAdjacencyEdge {
  from: string;
  to: string;
  evidence_strength: CallsAdjacencyStrength;
  resolution?: string;
}

export function buildCallsAdjacency(
  nodes: GraphNode[],
  edges: GraphEdge[],
  opts: { denominatorEligibleOnly?: boolean } = {}
): Map<string, CallsAdjacencyEdge[]> {
  const symbolIds = new Set(
    nodes
      .filter(
        (n) =>
          n.kind === "CodeSymbol" &&
          n.stale !== true &&
          (!opts.denominatorEligibleOnly || n.denominator_eligible === true)
      )
      .map((n) => n.external_id)
  );
  const adjacency = new Map<string, CallsAdjacencyEdge[]>();
  for (const e of edges) {
    if (e.relationship_type !== "CALLS") continue;
    if (e.evidence_strength !== "hard" && e.evidence_strength !== "framework-derived") continue;
    if (!symbolIds.has(e.from_external_id) || !symbolIds.has(e.to_external_id)) continue;
    const item: CallsAdjacencyEdge = {
      from: e.from_external_id,
      to: e.to_external_id,
      evidence_strength: e.evidence_strength,
      resolution: typeof e.properties?.resolution === "string" ? e.properties.resolution : undefined
    };
    const list = adjacency.get(item.from);
    if (list) list.push(item);
    else adjacency.set(item.from, [item]);
  }
  for (const list of adjacency.values()) {
    list.sort(
      (a, b) =>
        a.to.localeCompare(b.to) ||
        a.evidence_strength.localeCompare(b.evidence_strength) ||
        (a.resolution ?? "").localeCompare(b.resolution ?? "")
    );
  }
  return adjacency;
}

class DisjointSet {
  private parent = new Map<string, string>();
  private rank = new Map<string, number>();

  add(id: string): void {
    if (this.parent.has(id)) return;
    this.parent.set(id, id);
    this.rank.set(id, 0);
  }

  find(id: string): string {
    const p = this.parent.get(id);
    if (!p) {
      this.add(id);
      return id;
    }
    if (p === id) return id;
    const root = this.find(p);
    this.parent.set(id, root);
    return root;
  }

  union(a: string, b: string): void {
    let ra = this.find(a);
    let rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra) ?? 0;
    const rankB = this.rank.get(rb) ?? 0;
    if (rankA < rankB || (rankA === rankB && ra > rb)) {
      [ra, rb] = [rb, ra];
    }
    this.parent.set(rb, ra);
    if (rankA === rankB) this.rank.set(ra, rankA + 1);
  }
}

function fileOfSymbol(n: GraphNode): string | null {
  const f = n.properties.file;
  return typeof f === "string" ? f : null;
}

function languageOfFile(filesById: Map<string, GraphNode>, file: string): string {
  const lang = filesById.get(file)?.properties.language;
  return typeof lang === "string" ? lang : "unknown";
}

function dirOf(file: string): string {
  const d = path.posix.dirname(file);
  return d === "." ? "" : d;
}

function localImportPair(fromFile: string, toFile: string): boolean {
  const fromDir = dirOf(fromFile);
  const toDir = dirOf(toFile);
  if (!fromDir || !toDir) return fromDir === toDir;
  return fromDir === toDir || fromDir.startsWith(`${toDir}/`) || toDir.startsWith(`${fromDir}/`);
}

function titleFromFiles(files: string[]): string {
  const dirs = files.map(dirOf).filter(Boolean).sort();
  if (dirs.length === 0) return path.posix.basename(files[0] ?? "root");
  const split = dirs.map((d) => d.split("/"));
  const prefix: string[] = [];
  for (let i = 0; i < split[0].length; i++) {
    const part = split[0][i];
    if (split.every((s) => s[i] === part)) prefix.push(part);
    else break;
  }
  const labelPath = prefix.length > 0 ? prefix.join("/") : dirs[0];
  const last = labelPath.split("/").filter(Boolean).pop() ?? labelPath;
  return last === labelPath ? labelPath : `${last} (${labelPath})`;
}

function moduleKey(file: string): string {
  const dir = dirOf(file);
  if (!dir) return "(root)";
  const parts = dir.split("/").filter(Boolean);
  const srcIdx = parts.lastIndexOf("src");
  if (srcIdx >= 0) return parts.slice(0, Math.min(parts.length, srcIdx + 3)).join("/");
  const javaIdx = parts.lastIndexOf("java");
  if (javaIdx >= 0) return parts.slice(0, Math.min(parts.length, javaIdx + 3)).join("/");
  const pyIdx = parts.lastIndexOf("python");
  if (pyIdx >= 0) return parts.slice(0, Math.min(parts.length, pyIdx + 3)).join("/");
  return parts.slice(0, Math.min(parts.length, 4)).join("/");
}

function pathPrefix(file: string, depth: number): string {
  const dir = dirOf(file);
  if (!dir) return "(root)";
  const parts = dir.split("/").filter(Boolean);
  return parts.slice(0, Math.min(parts.length, depth)).join("/") || "(root)";
}

function splitOversizedGroup(ids: string[], symbolById: Map<string, GraphNode>, depth = 5): string[][] {
  if (ids.length <= MAX_COMPONENT_SIZE) return [ids];
  const byPrefix = new Map<string, string[]>();
  for (const id of ids) {
    const file = fileOfSymbol(symbolById.get(id)!);
    const key = file ? pathPrefix(file, depth) : "(unknown)";
    const list = byPrefix.get(key);
    if (list) list.push(id);
    else byPrefix.set(key, [id]);
  }
  if (byPrefix.size <= 1) {
    const maxDepth = Math.max(
      ...ids.map((id) => {
        const file = fileOfSymbol(symbolById.get(id)!);
        return file ? dirOf(file).split("/").filter(Boolean).length : 0;
      })
    );
    if (depth <= maxDepth) return splitOversizedGroup(ids, symbolById, depth + 1);
    const byFile = new Map<string, string[]>();
    for (const id of ids) {
      const key = fileOfSymbol(symbolById.get(id)!) ?? "(unknown)";
      const list = byFile.get(key);
      if (list) list.push(id);
      else byFile.set(key, [id]);
    }
    if (byFile.size > 1) return [...byFile.values()].map((chunk) => chunk.sort());
    return [ids];
  }
  return [...byPrefix.values()].flatMap((chunk) => splitOversizedGroup(chunk.sort(), symbolById, depth + 1));
}

function addCount(map: Map<string, number>, key: string, inc = 1): void {
  map.set(key, (map.get(key) ?? 0) + inc);
}

function sortedCounts(map: Map<string, number>): Record<string, number> {
  return Object.fromEntries([...map.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])));
}

function stableTop(items: Iterable<string>, limit = MAX_CLUSTER_ITEMS): string[] {
  return [...items].sort().slice(0, limit);
}

export function buildStructuralClusters(nodes: GraphNode[], edges: GraphEdge[], candidateEdges: CandidateEdge[]): StructuralClustersMeta {
  const filesById = new Map(nodes.filter((n) => n.kind === "File").map((n) => [n.external_id, n]));
  const symbols = nodes.filter((n) => n.kind === "CodeSymbol" && n.denominator_eligible === true && n.stale !== true);
  const symbolIds = new Set(symbols.map((n) => n.external_id));
  const symbolById = new Map(symbols.map((n) => [n.external_id, n]));
  const symbolsByFile = new Map<string, string[]>();
  for (const n of symbols) {
    const file = fileOfSymbol(n);
    if (!file) continue;
    const list = symbolsByFile.get(file);
    if (list) list.push(n.external_id);
    else symbolsByFile.set(file, [n.external_id]);
  }
  for (const ids of symbolsByFile.values()) ids.sort();

  const dsu = new DisjointSet();
  for (const id of symbolIds) dsu.add(id);

  // A file is the smallest structural container. Grouping its emitted behavior
  // symbols prevents one class/file from splintering before graph edges apply.
  for (const ids of symbolsByFile.values()) {
    const [first, ...rest] = ids;
    if (!first) continue;
    for (const id of rest) dsu.union(first, id);
  }

  const links: Link[] = [];
  let hardCallEdges = 0;
  let likelyCallEdges = 0;
  let importEdgesConsidered = 0;
  let importEdgesUsed = 0;
  const importFanIn = new Map<string, number>();
  for (const e of edges) {
    if (e.relationship_type !== "IMPORTS") continue;
    if (!symbolsByFile.has(e.from_external_id) || !symbolsByFile.has(e.to_external_id)) continue;
    addCount(importFanIn, e.to_external_id);
  }
  const productFiles = symbolsByFile.size;
  const importHubThreshold = Math.max(25, Math.ceil(productFiles * 0.02));

  for (const [, outgoing] of buildCallsAdjacency(nodes, edges, { denominatorEligibleOnly: true })) {
    for (const e of outgoing) {
      hardCallEdges++;
      links.push({ from: e.from, to: e.to, kind: "hard_call" });
      dsu.union(e.from, e.to);
    }
  }

  for (const e of edges) {
    if (e.relationship_type === "IMPORTS") {
      const fromSyms = symbolsByFile.get(e.from_external_id);
      const toSyms = symbolsByFile.get(e.to_external_id);
      if (!fromSyms || !toSyms || e.from_external_id === e.to_external_id) continue;
      importEdgesConsidered++;
      if ((importFanIn.get(e.to_external_id) ?? 0) > importHubThreshold) continue;
      if (!localImportPair(e.from_external_id, e.to_external_id)) continue;
      const from = fromSyms[0];
      const to = toSyms[0];
      if (!from || !to || from === to) continue;
      importEdgesUsed++;
      links.push({ from, to, kind: "import" });
      dsu.union(from, to);
    }
  }

  for (const e of candidateEdges) {
    if (e.relationship_type !== "MAY_CALL") continue;
    if (!symbolIds.has(e.from_external_id) || !symbolIds.has(e.to_external_id)) continue;
    likelyCallEdges++;
    links.push({ from: e.from_external_id, to: e.to_external_id, kind: "likely_call" });
    dsu.union(e.from_external_id, e.to_external_id);
  }

  const byRoot = new Map<string, string[]>();
  for (const id of symbolIds) {
    const root = dsu.find(id);
    const list = byRoot.get(root);
    if (list) list.push(id);
    else byRoot.set(root, [id]);
  }

  const groups: string[][] = [];
  for (const ids of byRoot.values()) {
    ids.sort();
    if (ids.length <= MAX_COMPONENT_SIZE) {
      groups.push(ids);
      continue;
    }
    const byModule = new Map<string, string[]>();
    for (const id of ids) {
      const file = fileOfSymbol(symbolById.get(id)!);
      const key = file ? moduleKey(file) : "(unknown)";
      const list = byModule.get(key);
      if (list) list.push(id);
      else byModule.set(key, [id]);
    }
    for (const chunk of byModule.values()) {
      chunk.sort();
      groups.push(...splitOversizedGroup(chunk, symbolById));
    }
  }

  const groupBySymbol = new Map<string, number>();
  groups.forEach((ids, i) => {
    for (const id of ids) groupBySymbol.set(id, i);
  });
  const linkCounts = new Map<number, { hard_calls: number; likely_calls: number; import_links: number }>();
  for (const l of links) {
    const a = groupBySymbol.get(l.from);
    const b = groupBySymbol.get(l.to);
    if (a == null || b == null || a !== b) continue;
    const counts = linkCounts.get(a) ?? { hard_calls: 0, likely_calls: 0, import_links: 0 };
    if (l.kind === "hard_call") counts.hard_calls++;
    else if (l.kind === "likely_call") counts.likely_calls++;
    else counts.import_links++;
    linkCounts.set(a, counts);
  }

  const rawClusters = groups
    .map((ids, groupIndex) => {
      ids.sort();
      const files = new Set<string>();
      const languages = new Map<string, number>();
      for (const id of ids) {
        const file = fileOfSymbol(symbolById.get(id)!);
        if (!file) continue;
        files.add(file);
        addCount(languages, languageOfFile(filesById, file));
      }
      const sortedFiles = stableTop(files);
      const counts = linkCounts.get(groupIndex) ?? { hard_calls: 0, likely_calls: 0, import_links: 0 };
      return {
        id: `cluster:${shortHash(ids.join("|"))}`,
        title: titleFromFiles([...files].sort()),
        size: ids.length,
        files: files.size,
        all_files: [...files].sort(),
        languages: sortedCounts(languages),
        top_files: sortedFiles,
        top_symbols: stableTop(ids),
        ...counts
      };
    })
    .filter((c) => c.size >= 2)
    .sort(
      (a, b) =>
        b.size - a.size ||
        b.hard_calls + b.likely_calls + b.import_links - (a.hard_calls + a.likely_calls + a.import_links) ||
        a.id.localeCompare(b.id)
    );

  const clusteredSymbols = rawClusters.reduce((sum, c) => sum + c.size, 0);
  const clusteredFiles = new Set(rawClusters.flatMap((c) => c.all_files)).size;
  const clusters = rawClusters.map(({ all_files, ...c }) => c);
  const emitted = clusters.slice(0, MAX_EMITTED_CLUSTERS);

  return {
    method: "deterministic_components_with_path_splits",
    total_clusters: clusters.length,
    emitted_clusters: emitted.length,
    clustered_symbols: clusteredSymbols,
    clustered_files: clusteredFiles,
    hard_call_edges: hardCallEdges,
    likely_call_edges: likelyCallEdges,
    import_edges_considered: importEdgesConsidered,
    import_edges_used: importEdgesUsed,
    import_hub_threshold: importHubThreshold,
    clusters: emitted
  };
}
