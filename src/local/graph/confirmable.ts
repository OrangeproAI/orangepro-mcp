// Structural-confirmability deferral (Phase 4.5 / Gate 7b).
//
// Some behaviors can never be proven by static TS import resolution + symbol
// evidence because their real coverage lives at a layer the resolver does not
// traverse (e2e / api). These are NOT gaps (a real test may exist) and NOT
// confirmed (we cannot prove it). Forcing them into either side breaks trust, so
// they get a third state: `not_structurally_confirmable` (nsc), excluded from the
// confirmed-% denominator and recorded with a `defer_reason`.
//
// v1 deferral signal: a behavior with NO hard TESTED_BY/COVERS edge whose linked
// candidate tests are ALL e2e- or api-layer (the AST classifier's authoritative
// layer). Precedence: a hard edge → confirmed BEFORE nsc is ever considered.
// (dynamic-import / DI-container / route-registration deferral is a documented
// follow-up; under-deferring keeps behaviors visible, the safe direction.)

import { LocalGraph } from "./ontology.js";

export type DeferReason = "layer_e2e" | "layer_api";

/**
 * Map of behavior external_id → defer reason for every behavior that is
 * not-structurally-confirmable. O(edges + nodes), computed once per consumer.
 */
export function structurallyUnconfirmable(graph: LocalGraph): Map<string, DeferReason> {
  // Behaviors touched by a hard coverage edge (either end) are confirmed — never nsc.
  const hard = new Set<string>();
  for (const e of graph.edges) {
    if (e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS") {
      hard.add(e.from_external_id);
      hard.add(e.to_external_id);
    }
  }

  // TestCase id → its authoritative layer (Phase 4.6).
  const layerOf = new Map<string, string>();
  for (const n of graph.nodes) {
    if (n.kind === "TestCase") {
      layerOf.set(n.external_id, typeof n.properties.test_layer === "string" ? (n.properties.test_layer as string) : "unknown");
    }
  }

  // behavior id → set of linked TestCase ids (via the weak candidate edges).
  const linkedTests = new Map<string, Set<string>>();
  const link = (behavior: string, test: string): void => {
    if (!layerOf.has(test)) return;
    let s = linkedTests.get(behavior);
    if (!s) {
      s = new Set();
      linkedTests.set(behavior, s);
    }
    s.add(test);
  };
  for (const e of graph.candidate_edges) {
    if (e.relationship_type !== "MAY_BE_TESTED_BY" && e.relationship_type !== "MAY_COVER") continue;
    // The TestCase is whichever end is a known TestCase; the other (NON-test) end
    // is the behavior. Mutually exclusive so an edge between two TestCases never
    // mis-attributes a TestCase as a behavior.
    const toIsTest = layerOf.has(e.to_external_id);
    const fromIsTest = layerOf.has(e.from_external_id);
    if (toIsTest && !fromIsTest) link(e.from_external_id, e.to_external_id);
    else if (fromIsTest && !toIsTest) link(e.to_external_id, e.from_external_id);
  }

  const out = new Map<string, DeferReason>();
  for (const [behavior, tests] of linkedTests) {
    if (hard.has(behavior)) continue; // confirmed precedence
    const layers = [...tests].map((t) => layerOf.get(t) ?? "unknown");
    if (layers.length === 0) continue;
    if (!layers.every((l) => l === "e2e" || l === "api")) continue;
    out.set(behavior, layers.includes("e2e") ? "layer_e2e" : "layer_api");
  }
  return out;
}
