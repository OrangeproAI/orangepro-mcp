import { stableId } from "../util/ids.js";
import { BOILERPLATE_REASON } from "../analyze/boilerplate.js";
import { GENERATED_CODE_REASON, NON_PRODUCT_REASON } from "../analyze/classify.js";
import {
  BEHAVIOR_KINDS,
  BehaviorSource,
  CandidateEdge,
  CandidateRelationshipType,
  DenominatorComposition,
  EvidenceStrength,
  GraphEdge,
  GraphNode,
  LocalGraph,
  NodeKind,
  Provenance,
  RelationshipType,
  ReviewStatus
} from "./ontology.js";

export interface NodeInput {
  kind: NodeKind;
  external_id: string;
  title?: string;
  properties?: Record<string, unknown>;
  evidence_strength: EvidenceStrength;
  review_status: ReviewStatus;
  confidence: number;
  provenance: Provenance;
  content_hash?: string;
  behavior_source?: BehaviorSource;
  denominator_eligible?: boolean;
  denominator_reason?: string;
}

/**
 * Kind-based denominator defaults for nodes whose producer did not set the
 * fields explicitly (hand-built graphs, fixtures). The four real producers
 * (analyzer UserFlow/CodeSymbol, csv, markdown) always set them explicitly —
 * these defaults encode the same Gate-3 policy: explicit requirements count,
 * test-inferred flows never do, and a bare CodeSymbol is NOT counted unless
 * the analyzer proves it eligible.
 */
function denominatorDefaults(kind: NodeKind): Pick<GraphNode, "behavior_source" | "denominator_eligible" | "denominator_reason"> {
  if (kind === "Requirement" || kind === "BusinessRule") {
    return {
      behavior_source: "requirement_template",
      denominator_eligible: true,
      denominator_reason: "Explicit requirement — always countable."
    };
  }
  if (kind === "UserFlow") {
    return {
      behavior_source: "test_inferred",
      denominator_eligible: false,
      denominator_reason: "Inferred from test names — a test cannot witness its own requirement."
    };
  }
  if (kind === "CodeSymbol") {
    return {
      behavior_source: "code_export",
      denominator_eligible: false,
      denominator_reason: "Code export not proven countable (analyzer decides eligibility)."
    };
  }
  return {};
}

export function makeNode(input: NodeInput): GraphNode {
  const defaults = denominatorDefaults(input.kind);
  return {
    id: stableId(input.kind, input.external_id),
    external_id: input.external_id,
    kind: input.kind,
    title: input.title,
    properties: input.properties ?? {},
    evidence_strength: input.evidence_strength,
    review_status: input.review_status,
    confidence: input.confidence,
    provenance: input.provenance,
    content_hash: input.content_hash,
    behavior_source: input.behavior_source ?? defaults.behavior_source,
    denominator_eligible: input.denominator_eligible ?? defaults.denominator_eligible,
    denominator_reason: input.denominator_reason ?? defaults.denominator_reason
  };
}

export interface TestCaseNodeInput {
  testRel: string;
  title: string;
  testLayer: string;
  layerConfidence: string;
  layerSignals: string[];
  testNames: string[];
  provenance: Provenance;
  contentHash?: string;
}

export function makeTestCaseNode(input: TestCaseNodeInput): GraphNode {
  return makeNode({
    kind: "TestCase",
    external_id: `test:${input.testRel}`,
    title: input.title,
    properties: {
      test_layer: input.testLayer,
      layer_confidence: input.layerConfidence,
      layer_signals: input.layerSignals,
      file: input.testRel,
      test_names: input.testNames
    },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: input.provenance,
    content_hash: input.contentHash
  });
}

export interface EdgeInput {
  from_external_id: string;
  to_external_id: string;
  relationship_type: RelationshipType;
  evidence_strength: Extract<EvidenceStrength, "hard" | "reviewed" | "framework-derived">;
  review_status: ReviewStatus;
  provenance: Provenance;
  confidence?: number;
  properties?: Record<string, unknown>;
  last_verified?: number;
}

export function makeEdge(input: EdgeInput): GraphEdge {
  return {
    id: stableId("edge", `${input.from_external_id}|${input.relationship_type}|${input.to_external_id}`),
    ...input
  };
}

export interface ProofEdgesInput {
  testRel: string;
  symId: string;
  provenance: Provenance;
  lastVerified: number;
  /**
   * Optional STRUCTURAL edge metadata (never proof) copied onto both proof edges, e.g.
   * the Java enclosing `@Test` method name auto-drive uses to derive `Class#method`.
   * Omitted ⇒ edges are byte-identical to the pre-J-INT-2 shape (Python/scoped callers).
   */
  properties?: Record<string, unknown>;
}

export function makeProofEdges(input: ProofEdgesInput): GraphEdge[] {
  const testExternalId = `test:${input.testRel}`;
  const props = input.properties ? { properties: input.properties } : {};
  return [
    makeEdge({
      from_external_id: input.symId,
      to_external_id: testExternalId,
      relationship_type: "TESTED_BY",
      evidence_strength: "hard",
      review_status: "auto_detected",
      provenance: input.provenance,
      last_verified: input.lastVerified,
      ...props
    }),
    makeEdge({
      from_external_id: testExternalId,
      to_external_id: input.symId,
      relationship_type: "COVERS",
      evidence_strength: "hard",
      review_status: "auto_detected",
      provenance: input.provenance,
      last_verified: input.lastVerified,
      ...props
    })
  ];
}

export interface CandidateEdgeInput {
  from_external_id: string;
  to_external_id: string;
  relationship_type: CandidateRelationshipType;
  evidence_strength: Extract<EvidenceStrength, "candidate" | "weak">;
  review_status?: ReviewStatus;
  reason: string;
  confidence: number;
  provenance?: Provenance;
}

export function makeCandidateEdge(input: CandidateEdgeInput): CandidateEdge {
  return {
    id: stableId("cand", `${input.from_external_id}|${input.relationship_type}|${input.to_external_id}`),
    ...input
  };
}

// ── Graph query helpers ──────────────────────────────────────────────

export function nodesByKind(graph: LocalGraph, kind: NodeKind): GraphNode[] {
  return graph.nodes.filter((n) => n.kind === kind);
}

export function findNode(graph: LocalGraph, externalId: string): GraphNode | undefined {
  return graph.nodes.find((n) => n.external_id === externalId);
}

export function behaviorNodes(graph: LocalGraph): GraphNode[] {
  return graph.nodes.filter((n) => BEHAVIOR_KINDS.has(n.kind));
}

/**
 * SOLE source of truth for what counts in the coverage denominator (Gate 3).
 * Nothing else may decide eligibility — not kind sets, not evidence strength.
 * Stale nodes never count: incremental update keeps deleted files' exports as
 * `stale: true` ghosts, and a deleted export is not witnessable by the repo.
 */
export function isDenominatorEligible(n: GraphNode): boolean {
  return n.denominator_eligible === true && n.stale !== true;
}

/** The behaviors the coverage denominator is computed over. */
export function denominatorBehaviors(graph: LocalGraph): GraphNode[] {
  return graph.nodes.filter(isDenominatorEligible);
}

/** Auditable composition of the denominator (shared by score + analyzer). */
export function denominatorComposition(graph: Pick<LocalGraph, "nodes">): DenominatorComposition {
  const comp: DenominatorComposition = {
    total: 0,
    code_export: 0,
    requirement_template: 0,
    markdown_requirement: 0,
    excluded_test_inferred: 0,
    excluded_boilerplate: 0,
    excluded_infra: 0,
    excluded_generated: 0,
    code_symbols_total: 0,
    unattributed: 0
  };
  for (const n of graph.nodes) {
    if (n.stale === true) continue; // deleted-file ghosts are not witnessable
    if (n.kind === "CodeSymbol") comp.code_symbols_total++; // true "found" total (eligible + every excluded class)
    if (isDenominatorEligible(n)) {
      comp.total++;
      if (n.behavior_source === "code_export") comp.code_export++;
      else if (n.behavior_source === "markdown_requirement") comp.markdown_requirement++;
      else if (n.behavior_source === "requirement_template") comp.requirement_template++;
      // An eligible node with a test_inferred/missing source is a producer-bug
      // combination — surface it, never launder it into a requirement count.
      else comp.unattributed++;
    } else if (n.behavior_source === "test_inferred") {
      comp.excluded_test_inferred++;
    } else if (n.denominator_reason === BOILERPLATE_REASON) {
      // Recomputed from nodes (not persisted analysis) so the report disclosure
      // can never disagree with the graph it is paired with.
      comp.excluded_boilerplate++;
    } else if (n.denominator_reason === NON_PRODUCT_REASON) {
      comp.excluded_infra++;
    } else if (n.denominator_reason === GENERATED_CODE_REASON) {
      comp.excluded_generated++;
    }
  }
  return comp;
}

/** Hard/reviewed edges where the given external id is the source. */
export function outgoingEdges(graph: LocalGraph, externalId: string): GraphEdge[] {
  return graph.edges.filter((e) => e.from_external_id === externalId);
}

/** Hard/reviewed edges where the given external id is the target. */
export function incomingEdges(graph: LocalGraph, externalId: string): GraphEdge[] {
  return graph.edges.filter((e) => e.to_external_id === externalId);
}

export function edgesOfType(graph: LocalGraph, externalId: string, type: RelationshipType): GraphEdge[] {
  return graph.edges.filter(
    (e) => e.relationship_type === type && (e.from_external_id === externalId || e.to_external_id === externalId)
  );
}

export function candidateEdgesFrom(graph: LocalGraph, externalId: string): CandidateEdge[] {
  return graph.candidate_edges.filter((e) => e.from_external_id === externalId);
}

export function generatedTestById(graph: LocalGraph, testId: string): import("./ontology.js").GeneratedTest | undefined {
  return graph.generated_tests.find((t) => t.id === testId || t.title === testId);
}

/** Priority ranking helper used by gaps + generation target selection. */
export function priorityRank(value: unknown): number {
  const p = String(value ?? "").toLowerCase();
  if (p.includes("crit") || p === "p0") return 4;
  if (p.includes("high") || p === "p1") return 3;
  if (p.includes("med") || p === "p2") return 2;
  if (p.includes("low") || p === "p3") return 1;
  return 0;
}
