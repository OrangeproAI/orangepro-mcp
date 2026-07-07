import { existsSync, readFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { runConfirmer, type ConfirmCandidate } from "../analyze/confirm.js";
import { isTestFile, languageOf } from "../analyze/classify.js";
import { classifyTestLayer } from "../analyze/testLayer.js";
import { extractTestNames } from "../analyze/symbols.js";
import { makeProofEdges, makeTestCaseNode } from "../graph/factories.js";
import type { LocalGraph, Provenance } from "../graph/ontology.js";
import { confirmedCoverageByLayer } from "../score/coverage.js";
import { hashString } from "../util/hash.js";
import { resolveContained, toWorkspaceRel } from "./paths.js";

export interface ScopedReproveInput {
  root: string;
  graph: LocalGraph;
  targetSymbol: string;
  preEdges: string[];
  testPath?: string;
  now: string;
}

export interface ScopedReproveResult {
  graph: LocalGraph;
  newEdges: string[];
  reason: string;
}

const DETECTOR = "repo_analyzer";

export function tryScopedReprove(input: ScopedReproveInput): ScopedReproveResult | null {
  if (!input.testPath) return null;
  const parsed = parseSymId(input.targetSymbol);
  if (!parsed) return null;

  const absRoot = resolve(input.root);
  const testAbs = resolveContained(absRoot, input.testPath);
  if (!existsSync(testAbs)) return null;

  const testRel = toWorkspaceRel(absRoot, testAbs);
  if (!isTestFile(testRel)) return null;
  const testLang = languageOf(testRel);
  if (testLang !== "typescript" && testLang !== "javascript") return null;
  if (!/\.([cm]?[tj]sx?)$/i.test(parsed.implRel)) return null;

  const implAbs = resolveContained(absRoot, parsed.implRel);
  if (!existsSync(implAbs)) return null;

  const symbolsByImpl = eligibleSymbolsByImpl(input.graph);
  const existingSymIds = new Set(input.graph.nodes.filter((n) => n.kind === "CodeSymbol").map((n) => n.external_id));
  const candidate: ConfirmCandidate = { testRel, testAbs, implRel: parsed.implRel, implAbs };

  let confirmations;
  try {
    confirmations = runConfirmer({ candidates: [candidate], symbolsByImpl, existingSymIds, anchorFile: absRoot }).confirmations;
  } catch {
    return null;
  }

  const matched = confirmations.filter((c) => c.symId === input.targetSymbol);
  if (matched.length === 0) return null;

  const next = patchGraph(input.graph, {
    testRel,
    testAbs,
    targetSymbol: input.targetSymbol,
    now: input.now
  });
  const newEdges = [`test:${testRel}->${input.targetSymbol}`].filter((edge) => !input.preEdges.includes(edge));
  return newEdges.length > 0
    ? { graph: next, newEdges, reason: "Scoped confirmer produced a static COVERS edge; full re-analysis skipped." }
    : null;
}

function patchGraph(
  graph: LocalGraph,
  input: { testRel: string; testAbs: string; targetSymbol: string; now: string }
): LocalGraph {
  const content = readFileSync(input.testAbs, "utf8");
  const testNames = extractTestNames(content);
  const layer = classifyTestLayer(input.testRel, content);
  const provenance = prov(graph, input.testRel, hashString(testNames.join("\n")));
  const lastVerified = Date.parse(input.now) || Date.now();
  const next: LocalGraph = {
    ...graph,
    updated_at: input.now,
    nodes: [...graph.nodes],
    edges: [...graph.edges],
    ...(graph.analysis ? { analysis: { ...graph.analysis } } : {})
  };

  const testExternalId = `test:${input.testRel}`;
  if (!next.nodes.some((n) => n.external_id === testExternalId)) {
    next.nodes.push(
      makeTestCaseNode({
        testRel: input.testRel,
        title: basename(input.testRel),
        testLayer: layer.layer,
        layerConfidence: layer.confidence,
        layerSignals: layer.signals,
        testNames,
        provenance,
        contentHash: hashString(content)
      })
    );
  }

  const edgeIds = new Set(next.edges.map((e) => e.id));
  const proofEdges = makeProofEdges({
    testRel: input.testRel,
    symId: input.targetSymbol,
    provenance: prov(graph, input.testRel, hashString(input.targetSymbol)),
    lastVerified
  });
  for (const edge of proofEdges) {
    if (!edgeIds.has(edge.id)) next.edges.push(edge);
  }

  if (next.analysis) {
    next.analysis = {
      ...next.analysis,
      confirmed_coverage: {
        confirmed_pairs:
          (next.analysis.confirmed_coverage?.confirmed_pairs ?? 0) +
          proofEdges.filter((e) => e.relationship_type === "COVERS").length,
        attempted: next.analysis.confirmed_coverage?.attempted ?? 0,
        capped_downgrades: next.analysis.confirmed_coverage?.capped_downgrades ?? 0,
        skipped_files_budget: next.analysis.confirmed_coverage?.skipped_files_budget ?? 0
      },
      confirmed_by_layer: confirmedCoverageByLayer(next)
    };
  }
  return next;
}

function eligibleSymbolsByImpl(graph: LocalGraph): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const node of graph.nodes) {
    if (node.kind !== "CodeSymbol" || node.denominator_eligible !== true || node.properties.member_of) continue;
    const parsed = parseSymId(node.external_id);
    if (!parsed) continue;
    const list = out.get(parsed.implRel);
    if (list) list.push(parsed.name);
    else out.set(parsed.implRel, [parsed.name]);
  }
  return out;
}

function parseSymId(symId: string): { implRel: string; name: string } | null {
  const m = symId.match(/^sym:(.+)#([^#]+)$/);
  return m ? { implRel: m[1], name: m[2] } : null;
}

function prov(graph: LocalGraph, ref: string, quote_hash?: string): Provenance {
  return {
    source_scope_id: graph.sources[0]?.source_scope_id ?? graph.workspace.name,
    source_ref: ref,
    quote_hash,
    detector: DETECTOR
  };
}
