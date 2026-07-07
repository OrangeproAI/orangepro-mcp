import { EvidenceStrength, GeneratedTest, GraphNode, LocalGraph, TestGrounding } from "./ontology.js";
import { redactSecrets } from "../util/redact.js";

/**
 * Citation validation — the trust primitive for the keyless grounding contract.
 *
 * A generated test's `grounding.entity_ids` are CLAIMS ("this test is anchored to
 * these graph entities"). This module turns those claims into VALIDATED citations:
 * each id is resolved against the loaded graph, tagged with the resolved node's
 * kind / evidence strength / provenance source_ref, and counted as proof only when
 * it resolves to a hard or reviewed node. Unresolved ids are surfaced (never
 * silently dropped) so a consumer can tell real provenance from generic output.
 *
 * Scope (step 1): this validates that grounding ANCHORS resolve to real, addressable
 * graph entities — i.e. provenance is real, not merely asserted. It does NOT yet
 * detect a model that IGNORED the grounding; that needs the agent-reported
 * `evidence_used` round-trip, which lands with the ledger (`prove_run`/`record_run`, step 3) and
 * will reuse `buildCitationIndex`/`validateEvidence` below — hence they are exported.
 *
 * Pure + deterministic — no I/O, no model calls. The resolution mirrors the graph's
 * own `findNode` first-match semantics, and the resolve-or-unknown shaping is the
 * sibling of explain.ts's `grounded_by` mapping — keep the two in lockstep.
 */

/** A single cited piece of evidence, validated against the graph. */
export interface CitedEvidence {
  /** The external_id the test cited. */
  evidence_id: string;
  /** True when evidence_id resolves to a real graph node. */
  validated: boolean;
  /** Resolved node kind, or "unknown" when unresolved. */
  kind: string;
  /** Resolved node title (falls back to the id). */
  title: string;
  /** Resolved node evidence strength, or "unknown" when unresolved. */
  evidence_strength: EvidenceStrength | "unknown";
  /** Provenance source_ref of the resolved node, when present. */
  source_ref?: string;
}

/** Validation of one generated test's grounding citations. */
export interface EvidenceValidation {
  evidence: CitedEvidence[];
  /** How many cited ids resolve to real graph nodes. */
  validated_count: number;
  /** How many cited ids do NOT resolve (broken citations). */
  invalid_count: number;
  /** Validated citations whose node strength is hard|reviewed (real proof). */
  proof_count: number;
  /** True when at least one citation is validated proof (hard/reviewed). */
  has_proof: boolean;
}

/** Per-test validated evidence, keyed back to the generated test. */
export interface GeneratedTestEvidence extends EvidenceValidation {
  generated_test_id: string;
  title: string;
}

/** Roll-up of validated evidence across a generation run. */
export interface EvidenceSummary {
  tests: number;
  /** Tests citing at least one hard/reviewed validated entity. */
  tests_with_proof: number;
  /** Tests whose citations resolve to nothing in the graph (unverifiable). */
  tests_without_validated_evidence: number;
  /** Total cited ids across all tests that do not resolve. */
  invalid_citations: number;
}

/** O(1) lookup index over a loaded graph for citation validation. */
export interface CitationIndex {
  nodeById: ReadonlyMap<string, GraphNode>;
}

const PROOF_STRENGTHS: ReadonlySet<EvidenceStrength> = new Set<EvidenceStrength>(["hard", "reviewed"]);

function isProof(strength: EvidenceStrength | "unknown"): boolean {
  return strength !== "unknown" && PROOF_STRENGTHS.has(strength);
}

/**
 * Build an O(1) external_id -> node index for the loaded graph. First-write wins,
 * mirroring `findNode`'s first-match semantics, so a duplicate external_id
 * resolves to the same node the rest of the kit would pick.
 */
export function buildCitationIndex(graph: LocalGraph): CitationIndex {
  const nodeById = new Map<string, GraphNode>();
  for (const node of graph.nodes) {
    if (!nodeById.has(node.external_id)) nodeById.set(node.external_id, node);
  }
  return { nodeById };
}

/**
 * Validate a generated test's grounding citations against the graph index:
 * resolve each cited entity_id, attach kind/strength/source_ref, and count how
 * many are genuine proof (hard/reviewed).
 */
export function validateEvidence(index: CitationIndex, grounding: TestGrounding): EvidenceValidation {
  const evidence: CitedEvidence[] = grounding.entity_ids.map((id) => {
    const node = index.nodeById.get(id);
    if (!node) {
      return { evidence_id: id, validated: false, kind: "unknown", title: id, evidence_strength: "unknown" };
    }
    const cited: CitedEvidence = {
      evidence_id: node.external_id,
      validated: true,
      kind: node.kind,
      // Defense-in-depth: titles/source_refs are metadata, but re-scrub at this exit
      // boundary so the "no secrets" guarantee holds regardless of how the node was
      // populated (mirrors the evidence-pack exporter's redactDeep). external_id is
      // structural (path / req id) and stays verbatim so the agent can reconcile it.
      title: redactSecrets(node.title ?? node.external_id),
      evidence_strength: node.evidence_strength
    };
    if (node.provenance?.source_ref) cited.source_ref = redactSecrets(node.provenance.source_ref);
    return cited;
  });

  const validated_count = evidence.reduce((n, e) => (e.validated ? n + 1 : n), 0);
  const proof_count = evidence.reduce((n, e) => (e.validated && isProof(e.evidence_strength) ? n + 1 : n), 0);
  return {
    evidence,
    validated_count,
    invalid_count: evidence.length - validated_count,
    proof_count,
    has_proof: proof_count > 0
  };
}

/**
 * Validate every generated test's citations against the graph and roll the
 * results into a per-test list plus a run-level summary. Builds the index once.
 */
export function summarizeTestEvidence(
  graph: LocalGraph,
  tests: GeneratedTest[]
): { per_test: GeneratedTestEvidence[]; summary: EvidenceSummary } {
  const index = buildCitationIndex(graph);
  const per_test: GeneratedTestEvidence[] = tests.map((t) => ({
    generated_test_id: t.id,
    title: t.title,
    ...validateEvidence(index, t.grounding)
  }));

  const summary: EvidenceSummary = {
    tests: per_test.length,
    tests_with_proof: per_test.reduce((n, p) => (p.has_proof ? n + 1 : n), 0),
    tests_without_validated_evidence: per_test.reduce((n, p) => (p.validated_count === 0 ? n + 1 : n), 0),
    invalid_citations: per_test.reduce((n, p) => n + p.invalid_count, 0)
  };
  return { per_test, summary };
}
