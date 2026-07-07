import { CandidateEdge, LocalGraph } from "../graph/ontology.js";
import { findNode, generatedTestById } from "../graph/factories.js";
import { ExplainResult } from "../types.js";

/**
 * Explain *why* a generated test is grounded — the trust feature.
 *
 * Explainability boundary: this exposes evidence, provenance, and strength
 * only. It NEVER reveals prompt text, scoring weights, or internal heuristics.
 * Everything returned is traceable metadata already present in the graph.
 */

interface ParsedWeakLabel {
  relationship_type: string;
  from: string;
  to: string;
}

/**
 * Weak relationship labels are emitted by the generator in the form
 * `REL:from->to` (e.g. `MAY_BE_TESTED_BY:REQ-001->test:src/a.test.ts`).
 * The relationship prefix ends at the first `:`; the remainder is split on the
 * first `->`. Labels without a `->` separator (e.g. `inferred_anchor:REQ-001`)
 * are not parseable and yield null.
 */
function parseWeakLabel(label: string): ParsedWeakLabel | null {
  const colon = label.indexOf(":");
  if (colon <= 0) return null;
  const relationship_type = label.slice(0, colon);
  const rest = label.slice(colon + 1);
  const arrow = rest.indexOf("->");
  if (arrow < 0) return null;
  const from = rest.slice(0, arrow);
  const to = rest.slice(arrow + 2);
  if (from.length === 0 || to.length === 0) return null;
  return { relationship_type, from, to };
}

function matchCandidateEdge(graph: LocalGraph, parsed: ParsedWeakLabel): CandidateEdge | undefined {
  return graph.candidate_edges.find(
    (e) =>
      e.relationship_type === parsed.relationship_type &&
      e.from_external_id === parsed.from &&
      e.to_external_id === parsed.to
  );
}

export function explainTest(graph: LocalGraph, generated_test_id: string): ExplainResult {
  const test = generatedTestById(graph, generated_test_id);
  if (!test) {
    throw new Error(`Generated test ${generated_test_id} not found in the local graph.`);
  }

  const grounded_by = test.grounding.entity_ids.map((externalId) => {
    const node = findNode(graph, externalId);
    if (!node) {
      return {
        external_id: externalId,
        kind: "unknown",
        title: externalId,
        evidence_strength: "unknown"
      };
    }
    const entry: {
      external_id: string;
      kind: string;
      title: string;
      evidence_strength: string;
      source_ref?: string;
    } = {
      external_id: node.external_id,
      kind: node.kind,
      title: node.title ?? node.external_id,
      evidence_strength: node.evidence_strength
    };
    if (node.provenance?.source_ref) {
      entry.source_ref = node.provenance.source_ref;
    }
    return entry;
  });

  const weak_relationships = test.grounding.weak_relationships_used.map((label) => {
    // The generator emits `inferred_anchor:<id>` for the weak behavior anchor itself.
    if (label.startsWith("inferred_anchor:")) {
      const id = label.slice("inferred_anchor:".length);
      const node = findNode(graph, id);
      return {
        from: id,
        relation: "INFERRED_ANCHOR",
        to: "(this behavior)",
        reason: "Behavior anchor inferred from local test names — weak evidence.",
        confidence: node ? node.confidence : 0
      };
    }
    const parsed = parseWeakLabel(label);
    if (!parsed) {
      return { from: label, relation: "RELATES_TO", to: "(unresolved)", reason: label, confidence: 0 };
    }
    const edge = matchCandidateEdge(graph, parsed);
    return {
      from: parsed.from,
      relation: parsed.relationship_type,
      to: parsed.to,
      reason: edge ? edge.reason : label,
      confidence: edge ? edge.confidence : 0
    };
  });

  return {
    generated_test_id: test.id,
    title: test.title,
    behavior_tested: test.title,
    grounded_by,
    source_refs: test.grounding.source_refs,
    weak_evidence_used: test.weak_evidence_used,
    weak_relationships,
    stale: Boolean(test.stale)
  };
}
