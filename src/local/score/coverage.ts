import { ConfirmedCoverageByLayer, DenominatorComposition, GraphNode, LocalGraph, TestLayer } from "../graph/ontology.js";
import { denominatorComposition, isDenominatorEligible } from "../graph/factories.js";

/**
 * Phase 5.1 — static assertion-candidate coverage over the DENOMINATOR
 * behaviors (CodeSymbols + Requirements), split by the test layer that links
 * each one.
 *
 * Carry-over #3: the graph.html headline counted only UserFlows (test-inferred),
 * so it read ~0% on real repos even when the confirmer proved many CodeSymbols.
 * This computes the metric over `denominatorBehaviors` instead.
 *
 * A behavior has a static candidate iff it has a hard TESTED_BY/COVERS edge.
 * Public Proven is stricter and comes only from a dynamic targeted-proof ledger
 * record. This module remains as a diagnostic/static-association helper.
 */

// Most-informative structural layer first. A behavior confirmed by both a unit
// and an e2e test is reported as `unit` (the structural confirmation); an
// e2e-only-confirmed behavior buckets as `e2e`.
const LAYER_PRECEDENCE: TestLayer[] = ["unit", "component", "integration", "api", "e2e", "manual", "unknown"];

const emptyByLayer = (): Record<TestLayer, number> => ({
  unit: 0,
  component: 0,
  integration: 0,
  api: 0,
  e2e: 0,
  manual: 0,
  unknown: 0
});

const layerOf = (n: GraphNode | undefined): TestLayer => {
  const l = n && typeof n.properties.test_layer === "string" ? (n.properties.test_layer as string) : "";
  return (LAYER_PRECEDENCE as string[]).includes(l) ? (l as TestLayer) : "unknown";
};

export function confirmedCoverageByLayer(graph: Pick<LocalGraph, "nodes" | "edges">): ConfirmedCoverageByLayer {
  const byId = new Map<string, GraphNode>();
  for (const n of graph.nodes) byId.set(n.external_id, n);

  // behavior external_id -> the layers of the tests that confirm it (hard edges only).
  const confirmingLayers = new Map<string, Set<TestLayer>>();
  const record = (behaviorId: string, testNode: GraphNode | undefined): void => {
    let set = confirmingLayers.get(behaviorId);
    if (!set) {
      set = new Set<TestLayer>();
      confirmingLayers.set(behaviorId, set);
    }
    set.add(layerOf(testNode));
  };
  for (const e of graph.edges) {
    if (e.relationship_type !== "TESTED_BY" && e.relationship_type !== "COVERS") continue;
    // Only HARD edges count as static assertion candidates. A weaker/reviewed
    // edge must not inflate the diagnostic metric.
    if (e.evidence_strength !== "hard") continue;
    const from = byId.get(e.from_external_id);
    const to = byId.get(e.to_external_id);
    // The test endpoint is the TestCase; the other endpoint is the behavior.
    if (from?.kind === "TestCase") record(e.to_external_id, from);
    else if (to?.kind === "TestCase") record(e.from_external_id, to);
  }

  const behaviors = graph.nodes.filter(isDenominatorEligible);
  const by_layer = emptyByLayer();
  let confirmed = 0;
  for (const b of behaviors) {
    const layers = confirmingLayers.get(b.external_id);
    if (!layers) continue; // no hard edge -> not confirmed
    confirmed++;
    const primary = LAYER_PRECEDENCE.find((l) => layers.has(l)) ?? "unknown";
    by_layer[primary]++;
  }

  const total_behaviors = behaviors.length;
  return {
    total_behaviors,
    confirmed,
    confirmed_pct: total_behaviors > 0 ? round1((confirmed / total_behaviors) * 100) : 0,
    by_layer,
    unknown_count: by_layer.unknown,
    unknown_pct: confirmed > 0 ? round1((by_layer.unknown / confirmed) * 100) : 0
  };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

/**
 * The static-candidate metric AND the denominator composition as ONE atomic pair.
 *
 * It ALWAYS recomputes both from the graph's nodes/edges and never trusts the persisted
 * `analysis.confirmed_by_layer`/`denominator`: a persisted value can be stale (an old
 * graph, or one edited out of band) in ways a cheap consistency check can't catch (e.g.
 * the total agrees but `confirmed` was computed before a downgrade). Recomputing is O(n)
 * and diagnostics are not a hot path, so the trade buys a hard guarantee — every
 * static diagnostic reports the SAME numbers, consistent with the actual graph, with
 * `coverage.total_behaviors === denominator.total` by construction. The persisted
 * `analysis` fields remain in graph.json for the JSON contract; only rendering recomputes.
 */
export function resolveCoverage(
  graph: Pick<LocalGraph, "nodes" | "edges">
): { coverage: ConfirmedCoverageByLayer; denominator: DenominatorComposition } {
  return { coverage: confirmedCoverageByLayer(graph), denominator: denominatorComposition(graph) };
}
