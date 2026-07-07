import {
  CandidateEdge,
  GeneratedTest,
  GenerationRun,
  GraphEdge,
  GraphNode,
  LocalGraph,
  NodeKind,
  Provenance,
  ReviewStatus,
  SourceScope
} from "../graph/ontology.js";
import { ScoreResult } from "../types.js";
import { Clock, systemClock } from "../util/time.js";
import { EVIDENCE_PACK_SCHEMA_VERSION, EvidencePack } from "./schema.js";
import { redactSecrets } from "../util/redact.js";

/**
 * A generated test's `body` is model output that can paraphrase the fed test
 * source. The exported pack is the metadata-only IP boundary, so by default the
 * body is NOT embedded — it stays in the local workspace graph. It is included
 * only when `include_generated_bodies` is explicitly set. (This is distinct from
 * the deferred raw-source-snippets policy, which never crosses the boundary.)
 */
const BODY_OMITTED =
  "[omitted: metadata-only export — generated test body kept local; set include_generated_bodies to embed]";

/**
 * Build a strict, promotion-ready evidence pack from a local graph + score.
 *
 * The pack is the IP boundary: only metadata, provenance, and grounding cross
 * it. Prompt text, scoring weights, traversal traces, and raw source NEVER do.
 * The strict `evidencePackSchema` enforces this — extra keys would be rejected —
 * so this builder deliberately constructs minimal, shape-exact objects.
 *
 * Everything is built immutably: input graph/nodes/edges are never mutated.
 */
export function buildPack(
  graph: LocalGraph,
  score: ScoreResult,
  opts?: { include_generated_bodies?: boolean },
  clock?: Clock
): EvidencePack {
  const now = (clock ?? systemClock)();

  const pack: EvidencePack = {
    schema_version: EVIDENCE_PACK_SCHEMA_VERSION,
    created_at: now,
    workspace: {
      name: graph.workspace.name,
      root_hash: graph.workspace.root_hash,
      source_upload_policy: graph.workspace.source_upload_policy
    },
    sources: graph.sources.map(toSource),
    entities: graph.nodes.map(toEntity),
    // IMPORTS edges are local resolver substrate (they feed coverage metrics and
    // the structural confirmer), not promotion evidence: at monorepo scale they
    // would dominate the pack for zero consumer value, so they stay local-only.
    relationships: graph.edges.filter(isPackRelationshipEdge).map(toRelationship),
    candidate_relationships: graph.candidate_edges.map(toCandidateRelationship),
    quality_score: {
      overall: score.overall,
      band: score.band,
      breakdown: {
        behavior_anchors: score.breakdown.behavior_anchors,
        acceptance_criteria: score.breakdown.acceptance_criteria,
        provenance: score.breakdown.provenance,
        interface_mapping: score.breakdown.interface_mapping,
        validation_evidence: score.breakdown.validation_evidence,
        known_regressions: score.breakdown.known_regressions
      },
      missing_evidence: [...score.missing_evidence]
    },
    generation_runs: graph.generation_runs.map((run) =>
      toGenerationRun(run, graph.generated_tests, opts?.include_generated_bodies ?? false)
    )
  };

  return pack;
}

function toSource(source: SourceScope): EvidencePack["sources"][number] {
  return {
    source_scope_id: source.source_scope_id,
    source_system: source.source_system,
    source_type: source.source_type,
    display_name: source.display_name,
    content_hash: source.content_hash,
    metadata: { ...source.metadata }
  };
}

/** Map a node kind to the pack's snake_case entity_type. */
function entityTypeOf(kind: NodeKind): string {
  switch (kind) {
    case "AcceptanceCriterion":
      return "acceptance_criterion";
    case "CodeSymbol":
      return "code_symbol";
    case "ConfigFile":
      return "config_file";
    case "TestCase":
      return "test_case";
    case "UserFlow":
      return "user_flow";
    case "TenantStub":
      return "tenant_stub";
    case "BusinessRule":
      return "business_rule";
    case "SourceScope":
      return "source_scope";
    case "EvidenceItem":
      return "evidence_item";
    default:
      return kind.toLowerCase();
  }
}

/**
 * Defense-in-depth secret scrub for any string crossing the pack boundary. Node
 * properties are reviewed metadata (secret-redacted at ingest); re-redacting here
 * makes the boundary's "no secrets" guarantee hold regardless of how a property
 * was populated. Structure and non-secret text (e.g. acceptance criteria) are
 * preserved — only secret patterns are replaced.
 */
function redactDeep(value: unknown): unknown {
  if (typeof value === "string") return redactSecrets(value);
  if (Array.isArray(value)) return value.map(redactDeep);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redactDeep(v)])
    );
  }
  return value;
}

function toEntity(node: GraphNode): EvidencePack["entities"][number] {
  const properties: Record<string, unknown> = redactDeep({ ...node.properties }) as Record<string, unknown>;
  if (node.content_hash !== undefined) {
    properties.content_hash = node.content_hash;
  }
  return {
    external_id: node.external_id,
    entity_type: entityTypeOf(node.kind),
    review_status: node.review_status,
    confidence: node.confidence,
    properties,
    provenance: toProvenance(node.provenance)
  };
}

/** Rebuild provenance into the strict shape, dropping any extra keys. */
function toProvenance(provenance: Provenance): EvidencePack["entities"][number]["provenance"] {
  const out: EvidencePack["entities"][number]["provenance"] = {
    source_scope_id: provenance.source_scope_id
  };
  if (provenance.source_ref !== undefined) out.source_ref = provenance.source_ref;
  if (provenance.quote_hash !== undefined) out.quote_hash = provenance.quote_hash;
  if (provenance.detector !== undefined) out.detector = provenance.detector;
  return out;
}

type ProofReviewStatus = Exclude<ReviewStatus, "ai_suggested">;
type PackGraphEdge = GraphEdge & { evidence_strength: "hard" | "reviewed" };

function isPackRelationshipEdge(edge: GraphEdge): edge is PackGraphEdge {
  return edge.relationship_type !== "IMPORTS" && edge.evidence_strength !== "framework-derived";
}

function proofReviewStatus(status: ReviewStatus): ProofReviewStatus {
  if (status === "ai_suggested") {
    throw new Error("AI-suggested review status is not valid on hard/reviewed evidence-pack relationships.");
  }
  return status;
}

function toRelationship(edge: PackGraphEdge): EvidencePack["relationships"][number] {
  const rel: EvidencePack["relationships"][number] = {
    from_external_id: edge.from_external_id,
    to_external_id: edge.to_external_id,
    relationship_type: edge.relationship_type,
    evidence_strength: edge.evidence_strength,
    review_status: proofReviewStatus(edge.review_status),
    provenance: toProvenance(edge.provenance)
  };
  if (edge.confidence !== undefined) rel.confidence = edge.confidence;
  return rel;
}

function toCandidateRelationship(edge: CandidateEdge): EvidencePack["candidate_relationships"][number] {
  return {
    from_external_id: edge.from_external_id,
    to_external_id: edge.to_external_id,
    relationship_type: edge.relationship_type,
    evidence_strength: edge.evidence_strength,
    // Reasons can carry repo-derived text (e.g. a resolved import specifier):
    // redact for defense-in-depth parity with toEntity's redactDeep.
    reason: redactSecrets(edge.reason),
    confidence: edge.confidence
  };
}

function toGenerationRun(
  run: GenerationRun,
  allTests: GeneratedTest[],
  includeBody: boolean
): EvidencePack["generation_runs"][number] {
  const tests = allTests.filter((t) => t.run_id === run.run_id).map((t) => toGeneratedTest(t, includeBody));
  return {
    run_id: run.run_id,
    model_provider: run.model_provider,
    model_name: run.model_name,
    input_mode: run.input_mode,
    prompt_version: run.prompt_version,
    generated_tests: tests
  };
}

function toGeneratedTest(
  test: GeneratedTest,
  includeBody: boolean
): EvidencePack["generation_runs"][number]["generated_tests"][number] {
  return {
    title: test.title,
    test_type: test.test_type,
    framework_hint: test.framework_hint,
    body: includeBody ? test.body : BODY_OMITTED,
    bucket: test.bucket,
    prompt_version: test.prompt_version,
    grounding: {
      entity_ids: [...test.grounding.entity_ids],
      source_refs: [...test.grounding.source_refs],
      weak_relationships_used: [...test.grounding.weak_relationships_used]
    },
    weak_evidence_used: test.weak_evidence_used
  };
}
