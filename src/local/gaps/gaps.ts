import { GraphNode, LocalGraph } from "../graph/ontology.js";
import { behaviorNodes, priorityRank } from "../graph/factories.js";
import { structurallyUnconfirmable } from "../graph/confirmable.js";
import { GapItem, GapsResult } from "../types.js";

/**
 * Test-coverage gap analysis over behavior anchors.
 *
 * Surfaces behaviors that are missing concrete acceptance criteria and/or hard
 * test evidence, so the kit can recommend where to add or generate tests. This
 * is a *readiness* signal built from metadata only — no source code, prompts, or
 * heuristic internals leak into the returned structure.
 */

const DEFAULT_LIMIT = 10;

/** Hard test evidence: explicit TESTED_BY/COVERS edge. */
function hasHardTestEvidence(graph: LocalGraph, externalId: string): boolean {
  return graph.edges.some(
    (e) =>
      (e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS") &&
      (e.from_external_id === externalId || e.to_external_id === externalId)
  );
}

/** Weak test evidence: only candidate MAY_BE_TESTED_BY/MAY_COVER. */
function hasWeakTestEvidence(graph: LocalGraph, externalId: string): boolean {
  return graph.candidate_edges.some(
    (e) =>
      (e.relationship_type === "MAY_BE_TESTED_BY" || e.relationship_type === "MAY_COVER") &&
      (e.from_external_id === externalId || e.to_external_id === externalId)
  );
}

function testEvidenceFor(graph: LocalGraph, externalId: string): "none" | "weak" | "covered" {
  if (hasHardTestEvidence(graph, externalId)) return "covered";
  if (hasWeakTestEvidence(graph, externalId)) return "weak";
  return "none";
}

/** Acceptance criteria via explicit edge OR inline properties. */
function hasAcceptanceCriteria(graph: LocalGraph, node: GraphNode): boolean {
  const linked = graph.edges.some(
    (e) => e.relationship_type === "HAS_ACCEPTANCE_CRITERION" && e.from_external_id === node.external_id
  );
  if (linked) return true;
  const inline = node.properties.acceptance_criteria;
  return Array.isArray(inline) && inline.length > 0;
}

/** Weakest evidence first, so the most under-tested behaviors surface at the top. */
const EVIDENCE_RANK: Record<"none" | "weak" | "covered", number> = {
  none: 0,
  weak: 1,
  covered: 2
};

function reasonFor(testEvidence: "none" | "weak" | "covered", hasAc: boolean): string {
  const parts: string[] = [];
  if (testEvidence === "none") parts.push("No test evidence linked");
  else if (testEvidence === "weak") parts.push("Only weak (candidate) test evidence linked");
  if (!hasAc) parts.push("Missing acceptance criteria");
  return parts.length > 0 ? parts.join("; ") : "Behavior is fully covered";
}

function recommendedActionFor(testEvidence: "none" | "weak" | "covered", hasAc: boolean): string {
  const parts: string[] = [];
  if (testEvidence === "none") parts.push("Add or generate a test for this behavior");
  else if (testEvidence === "weak") parts.push("Confirm or strengthen the candidate test link into hard evidence");
  if (!hasAc) parts.push("Add acceptance criteria to make assertions concrete");
  return parts.length > 0 ? parts.join("; ") : "No action needed";
}

export function findGaps(graph: LocalGraph, opts?: { limit?: number; min_priority?: string }): GapsResult {
  const behaviors = behaviorNodes(graph);
  const totalBehaviors = behaviors.length;
  // Behaviors whose only tests are e2e/api are NOT structural gaps — a real test
  // likely exists, we just cannot confirm it by import resolution. Filter them
  // out of the gap list (stays 3-state) and report the count separately.
  const nsc = structurallyUnconfirmable(graph);

  const minRank = opts?.min_priority === undefined ? -1 : priorityRank(opts.min_priority);
  const limit = opts?.limit ?? DEFAULT_LIMIT;

  const gaps: GapItem[] = [];
  let notStructurallyConfirmable = 0;

  for (const node of behaviors) {
    const priorityValue = String(node.properties.priority ?? "unknown");
    if (priorityRank(priorityValue) < minRank) continue;

    if (nsc.has(node.external_id)) {
      notStructurallyConfirmable++;
      continue;
    }

    const testEvidence = testEvidenceFor(graph, node.external_id);
    const hasAc = hasAcceptanceCriteria(graph, node);

    const isGap = testEvidence !== "covered" || hasAc === false;
    if (!isGap) continue;

    gaps.push({
      external_id: node.external_id,
      title: node.title ?? node.external_id,
      kind: node.kind,
      priority: priorityValue,
      reason: reasonFor(testEvidence, hasAc),
      has_acceptance_criteria: hasAc,
      test_evidence: testEvidence,
      recommended_action: recommendedActionFor(testEvidence, hasAc)
    });
  }

  const sorted = [...gaps].sort((a, b) => {
    const evidenceDelta = EVIDENCE_RANK[a.test_evidence] - EVIDENCE_RANK[b.test_evidence];
    if (evidenceDelta !== 0) return evidenceDelta;
    return priorityRank(b.priority) - priorityRank(a.priority);
  });

  return {
    gaps: sorted.slice(0, limit),
    total_behaviors: totalBehaviors,
    ...(notStructurallyConfirmable > 0 ? { not_structurally_confirmable: notStructurallyConfirmable } : {}),
    ...(totalBehaviors === 0
      ? {
          guidance:
            "No behavior anchors found. Run analyze on a path that contains tests, or add requirements/templates (.csv/.md) via --paths."
        }
      : {})
  };
}
