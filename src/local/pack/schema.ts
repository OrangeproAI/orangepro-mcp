import { z } from "zod";

/**
 * Evidence pack schema (`orangepro.local_evidence_pack.v0`).
 *
 * Objects are `.strict()` on purpose: unknown keys FAIL validation. This is the
 * IP boundary in code form — prompt text, prompt templates, scoring weights,
 * ranking traces, traversal traces, or raw source would all be rejected, so the
 * pack stays "promotion-ready but not reverse-engineering-ready".
 */
export const EVIDENCE_PACK_SCHEMA_VERSION = "orangepro.local_evidence_pack.v0" as const;

const provenanceSchema = z
  .object({
    source_scope_id: z.string().min(1),
    source_ref: z.string().optional(),
    quote_hash: z.string().optional(),
    detector: z.string().optional()
  })
  .strict();

const sourceSchema = z
  .object({
    source_scope_id: z.string().min(1),
    source_system: z.string().min(1),
    source_type: z.string().min(1),
    display_name: z.string(),
    content_hash: z.string(),
    metadata: z.record(z.unknown())
  })
  .strict();

const entitySchema = z
  .object({
    external_id: z.string().min(1),
    entity_type: z.string().min(1),
    review_status: z.enum(["local_reviewed", "auto_detected", "inferred", "ai_suggested"]),
    confidence: z.number().min(0).max(1),
    properties: z.record(z.unknown()),
    provenance: provenanceSchema
  })
  .strict();

const relationshipSchema = z
  .object({
    from_external_id: z.string().min(1),
    to_external_id: z.string().min(1),
    relationship_type: z.string().min(1),
    evidence_strength: z.enum(["hard", "reviewed"]),
    review_status: z.enum(["local_reviewed", "auto_detected", "inferred"]),
    provenance: provenanceSchema,
    confidence: z.number().min(0).max(1).optional()
  })
  .strict();

const candidateRelationshipSchema = z
  .object({
    from_external_id: z.string().min(1),
    to_external_id: z.string().min(1),
    relationship_type: z.string().min(1),
    evidence_strength: z.enum(["candidate", "weak"]),
    reason: z.string(),
    confidence: z.number().min(0).max(1)
  })
  .strict();

const qualityScoreSchema = z
  .object({
    overall: z.number().min(0).max(100),
    band: z.enum(["thin", "usable", "good", "strong"]),
    breakdown: z
      .object({
        behavior_anchors: z.number().min(0).max(1),
        acceptance_criteria: z.number().min(0).max(1),
        provenance: z.number().min(0).max(1),
        interface_mapping: z.number().min(0).max(1),
        validation_evidence: z.number().min(0).max(1),
        known_regressions: z.number().min(0).max(1)
      })
      .strict(),
    missing_evidence: z.array(z.string())
  })
  .strict();

const groundingSchema = z
  .object({
    entity_ids: z.array(z.string()),
    source_refs: z.array(z.string()),
    weak_relationships_used: z.array(z.string())
  })
  .strict();

const generatedTestSchema = z
  .object({
    title: z.string().min(1),
    test_type: z.string().min(1),
    framework_hint: z.string(),
    body: z.string(),
    grounding: groundingSchema,
    weak_evidence_used: z.boolean(),
    // Optional per-artifact prompt lineage; old packs only carry this on the run.
    prompt_version: z.string().optional(),
    // Optional local scenario bucket (backward-compatible: old packs omit it).
    bucket: z
      .enum(["happy_path", "validation_error", "edge_case", "integration_flow", "security_privacy", "regression"])
      .optional()
  })
  .strict();

const generationRunSchema = z
  .object({
    run_id: z.string().min(1),
    model_provider: z.string(),
    model_name: z.string(),
    input_mode: z.enum(["graph_grounded", "raw_prompt"]),
    prompt_version: z.string(),
    generated_tests: z.array(generatedTestSchema)
  })
  .strict();

export const evidencePackSchema = z
  .object({
    schema_version: z.literal(EVIDENCE_PACK_SCHEMA_VERSION),
    created_at: z.string(),
    workspace: z
      .object({
        name: z.string(),
        root_hash: z.string(),
        source_upload_policy: z.enum(["metadata_only", "include_sources"])
      })
      .strict(),
    sources: z.array(sourceSchema),
    entities: z.array(entitySchema),
    relationships: z.array(relationshipSchema),
    candidate_relationships: z.array(candidateRelationshipSchema),
    quality_score: qualityScoreSchema,
    generation_runs: z.array(generationRunSchema)
  })
  .strict();

export type EvidencePack = z.infer<typeof evidencePackSchema>;
