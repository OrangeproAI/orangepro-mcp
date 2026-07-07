/**
 * OrangePro local evidence-graph ontology.
 *
 * This is an OrangePro-shaped, test-generation-oriented graph — NOT a generic
 * code graph. Every node and edge carries evidence strength and provenance so
 * the kit can prove *why* a generated test is grounded, and so a pack can later
 * be promoted into a hosted tenant graph without changing the conceptual model.
 *
 * The graph is built directly by OrangePro; it does not depend on any
 * third-party graph product or format.
 */

export const LOCAL_GRAPH_SCHEMA_VERSION = "orangepro.local_graph.v1" as const;

/**
 * Where a behavior node came from — drives denominator eligibility (Gate 3).
 * Coverage % is only defensible over a denominator the repo can witness:
 * test-inferred flows are NEVER eligible (a test cannot witness its own
 * requirement), code exports are eligible per the callable rule, and explicit
 * requirements (template rows / markdown headings) are always eligible.
 */
export type BehaviorSource =
  | "test_inferred"
  | "code_export"
  | "contract_entrypoint"
  | "requirement_template"
  | "markdown_requirement";

/** Core local node kinds (mirrors the hosted ontology's promotable concepts). */
export type NodeKind =
  | "TenantStub"
  | "SourceScope"
  | "Requirement"
  | "AcceptanceCriterion"
  | "BusinessRule"
  | "UserFlow"
  | "Service"
  | "Endpoint"
  | "File"
  | "CodeSymbol"
  | "Framework"
  | "Package"
  | "ConfigFile"
  | "TestCase"
  | "Incident"
  | "EvidenceItem";

/**
 * Evidence strength on every relationship and node.
 * - `hard`: explicit source refs, exact ids/urls/paths, reviewed template rows.
 * - `reviewed`: locally confirmed by the user.
 * - `framework-derived`: deterministic framework contract output, never authored/proof evidence.
 * - `candidate`: inferred but plausible; may guide generation, never counts as proof.
 * - `weak`: low-confidence inference (LLM/similarity); must be disclosed if used.
 */
export type EvidenceStrength = "hard" | "reviewed" | "framework-derived" | "candidate" | "weak";

/** Trust label aligned with the evidence-pack contract. */
export type ReviewStatus = "local_reviewed" | "auto_detected" | "inferred" | "ai_suggested";

/** What test layer / how a behavior is validated. */
export type TestLayer = "unit" | "integration" | "e2e" | "api" | "component" | "manual" | "unknown";

/** Provenance is exportable (it is a trust artifact), but never carries source code. */
export interface Provenance {
  source_scope_id: string;
  /** e.g. "payments-template.csv#row=2" or "src/payments/card.ts". */
  source_ref?: string;
  /** sha256 of the exact supporting text — proves a quote without storing it. */
  quote_hash?: string;
  /** Which deterministic detector produced this (provenance, not algorithm internals). */
  detector?: string;
  /** AI-lane metadata for weak candidate suggestions; never used as proof. */
  model_provider?: string;
  model_name?: string;
  prompt_version?: string;
  cache_key?: string;
}

export interface GraphNode {
  /** Internal stable id (kind:hash). Not promoted as the external id. */
  id: string;
  /** External id used in the evidence pack (REQ-001, a file path, etc.). */
  external_id: string;
  kind: NodeKind;
  title?: string;
  /** Open, kind-specific metadata. Must never contain raw source code. */
  properties: Record<string, unknown>;
  evidence_strength: EvidenceStrength;
  review_status: ReviewStatus;
  confidence: number;
  provenance: Provenance;
  /** Content hash of the underlying source (for freshness), when applicable. */
  content_hash?: string;
  /** Marked true when a partial update invalidated this node's evidence. */
  stale?: boolean;
  /** Where this behavior came from (set on behavior/denominator-relevant nodes). */
  behavior_source?: BehaviorSource;
  /**
   * Counts in the coverage denominator. Set by producers at creation; consumed
   * ONLY through isDenominatorEligible()/denominatorBehaviors() (factories).
   */
  denominator_eligible?: boolean;
  /**
   * Plain-language why it is / is not denominator-eligible. Kept local in v1 —
   * the evidence-pack schema is unchanged and the exporter does not carry it.
   */
  denominator_reason?: string;
}

/** Hard/reviewed relationship — counts as proof. */
export type RelationshipType =
  | "HAS_ACCEPTANCE_CRITERION"
  | "HAS_BUSINESS_RULE"
  | "HAS_FLOW"
  | "TESTED_BY"
  | "COVERS"
  | "IMPLEMENTED_IN"
  | "DEFINED_IN"
  | "IMPORTS"
  // Symbol→symbol call edge. STRUCTURAL CONTEXT ONLY (like IMPORTS) — a proven,
  // exactly-resolved call from one CodeSymbol to another. NEVER coverage evidence:
  // not read by the confirmer, denominator, or test linkage. A later proof layer
  // may promote it, but on its own it implies nothing about whether code is tested.
  | "CALLS"
  | "USES_FRAMEWORK"
  | "DEPENDS_ON"
  | "CONFIGURED_BY"
  | "PART_OF"
  | "REGRESSION_OF"
  | "DESCRIBED_BY";

export interface GraphEdge {
  id: string;
  from_external_id: string;
  to_external_id: string;
  relationship_type: RelationshipType;
  evidence_strength: Extract<EvidenceStrength, "hard" | "reviewed" | "framework-derived">;
  review_status: ReviewStatus;
  provenance: Provenance;
  confidence?: number;
  /** Optional metadata for structural/audit consumers. Must never be used as proof. */
  properties?: Record<string, unknown>;
  /** Epoch milliseconds when this hard/reviewed edge was last verified. Optional for old graphs/back-compat. */
  last_verified?: number;
}

/** Candidate/weak relationship type — guides generation but is never proof. */
export type CandidateRelationshipType =
  | "MAY_REQUIRE_INTERFACE"
  | "MAY_BE_TESTED_BY"
  | "MAY_RELATE_TO"
  | "MAY_COVER"
  | "MAY_IMPLEMENT"
  // Heuristic symbol→symbol call hint (the candidate counterpart to hard CALLS).
  // STRUCTURAL CONTEXT ONLY — a "useful hint", never proof: never read by the
  // confirmer, denominator, or coverage. Carries confidence + a reason naming the
  // resolution kind so clustering/viz can weight it.
  | "MAY_CALL";

export interface CandidateEdge {
  id: string;
  from_external_id: string;
  to_external_id: string;
  relationship_type: CandidateRelationshipType;
  evidence_strength: Extract<EvidenceStrength, "candidate" | "weak">;
  review_status?: ReviewStatus;
  /** Human-readable basis (e.g. "LLM inferred from description"). */
  reason: string;
  confidence: number;
  provenance?: Provenance;
}

export interface SourceScope {
  source_scope_id: string;
  /** e.g. "repo", "manual_template", "markdown_docs". */
  source_system: string;
  /** e.g. "local_checkout", "customer_supplied". */
  source_type: string;
  display_name: string;
  content_hash: string;
  metadata: Record<string, unknown>;
}

/**
 * How the SUBJECT import in a generated test was obtained — disclosed so a
 * consumer never mistakes a guess for evidence:
 * - "test_metadata": reused verbatim from a linked existing test's parse metadata
 *   (the repo already proves the specifier resolves).
 * - "resolver_relative": derived by the kit and VALIDATED via the resolver
 *   (the specifier round-trips to a real source file with a real exported symbol).
 * - "model_provided": the generating model wrote its own imports (not kit-synthesized).
 * - "none": the kit could derive no import and did NOT fabricate one.
 */
export type ImportProvenance = "test_metadata" | "resolver_relative" | "model_provided" | "none";

/** Grounding links a generated test back to graph evidence. */
export interface TestGrounding {
  /** External ids of the entities that anchored the test. */
  entity_ids: string[];
  /** Source refs (provenance) backing the test. */
  source_refs: string[];
  /** Candidate/weak relationships used, disclosed for trust. */
  weak_relationships_used: string[];
  /** How the subject import was obtained (optional; absent on legacy records). */
  import_provenance?: ImportProvenance;
}

/**
 * Lightweight LOCAL scenario buckets used to diversify generated tests. These are
 * the public/local kit's own categories — NOT the hosted platform's bucket
 * orchestration, caps, or names.
 */
export type LocalBucket =
  | "happy_path"
  | "validation_error"
  | "edge_case"
  | "integration_flow"
  | "security_privacy"
  | "regression";

export interface GeneratedTest {
  id: string;
  run_id: string;
  title: string;
  test_type: TestLayer;
  framework_hint: string;
  /** Generated test body (Markdown/code). Stored in the workspace, not the repo. */
  body: string;
  grounding: TestGrounding;
  /** True when any weak/candidate evidence contributed. */
  weak_evidence_used: boolean;
  /** Local scenario bucket this test targets (optional; backward-compatible). */
  bucket?: LocalBucket;
  /** Prompt strategy that produced this artifact. Optional on legacy generated tests. */
  prompt_version?: string;
  /** Exact CodeSymbol target this draft is intended to close, when generation targeted a CodeSymbol. */
  target_symbol_external_id?: string;
  /**
   * Mechanically checked (static, in-process): the test has a real subject import
   * (not a fabricated guess), parses, and contains a real assertion. When false,
   * the test is a grounded DRAFT — see `unresolved_reason` — and ships with no run
   * command. Optional/absent on legacy records (treated as runnable).
   */
  runnable?: boolean;
  /** Why a test is not runnable (set only when runnable === false). */
  unresolved_reason?: string;
  /** Invalidated when underlying evidence changed. */
  stale?: boolean;
}

export interface GenerationRun {
  run_id: string;
  model_provider: string;
  model_name: string;
  /** "graph_grounded" vs "raw_prompt" (internal comparison only). */
  input_mode: "graph_grounded" | "raw_prompt";
  /** Records the prompt strategy version WITHOUT exposing the prompt text. */
  prompt_version: string;
  created_at: string;
  generated_test_ids: string[];
}

/** Per-file freshness manifest entry — metadata only. */
export interface ManifestFileEntry {
  hash: string;
  size: number;
  /** Coarse file role (code, test, config, doc, other). */
  kind: string;
}

export interface GitInfo {
  commit?: string;
  branch?: string;
  dirty?: boolean;
}

export interface Manifest {
  generated_at: string;
  git: GitInfo | null;
  files: Record<string, ManifestFileEntry>;
}

/**
 * `metadata_only`: no source CODE is persisted/exported (paths, names, hashes,
 * frameworks, provenance only). Customer-supplied template/doc text is reviewed
 * evidence and IS included. `include_sources` is deferred + opt-in only.
 */
/** One resolver gate axis: resolved out of eligible, raw counts (pct null when n=0). */
export interface ResolverAxisMeta {
  n: number;
  resolved: number;
  pct: number | null;
}

/**
 * Per-axis import-resolution gate metrics persisted by analyze — raw counts so
 * the number is auditable, never just asserted. Mirrors the resolve layer's
 * GateMetrics shape (kept structural here to avoid an ontology->resolve cycle).
 */
export interface ResolverMetricsMeta {
  all_internal: ResolverAxisMeta;
  test_file: ResolverAxisMeta;
  test_internal: ResolverAxisMeta;
  test_to_test: ResolverAxisMeta;
  test_to_source: ResolverAxisMeta;
  test_unresolved_internal: ResolverAxisMeta;
  source_to_source: ResolverAxisMeta;
  barrel_terminal: ResolverAxisMeta;
  workspace_package: ResolverAxisMeta;
}

/**
 * Gate 1 defensibility verdict: confirmed-coverage claims are gated on
 * test_to_source (full-repo scope), threshold 80%. Informational until the
 * Phase-4 confirmer emits hard edges, but persisted from day one.
 */
export interface ResolverGateMeta {
  axis: "test_to_source";
  threshold_pct: number;
  pct: number | null;
  /**
   * True iff the axis has data, the raw-count ratio meets the threshold (the
   * display pct rounds), AND the scan was complete (a files-cap-truncated run
   * measured an unknown fraction of the repo and is never defensible).
   */
  defensible: boolean;
}

/** Persisted analysis coverage signal so truncation is never silent. */
export interface AnalysisMeta {
  test_files: number;
  inferred_flows: number;
  /** Test files that exceeded the inferred-flow cap (not turned into anchors). */
  flows_truncated: number;
  max_inferred_flows: number;
  symbol_cap_hit: boolean;
  /** Files whose exports exceeded the per-file symbol cap (their tail exports are NOT in the denominator). */
  symbol_files_truncated?: number;
  /** Trivial accessors (Java getX/setX, toString/equals/hashCode, Python __repr__/__str__) kept as nodes but excluded from the behavior denominator. */
  excluded_boilerplate?: number;
  /** Source files scanned (after ignore rules). Optional for back-compat with older graphs. */
  files_scanned?: number;
  /** True when the file-count cap was hit — some files were not scanned at all. */
  files_cap_hit?: boolean;
  /** The file-count cap that applied to the scan. */
  max_files?: number;
  /**
   * Set when a wall-clock budget (ORANGEPRO_MAX_ANALYZE_MS) stopped the per-file scan
   * before all files were processed. Its presence means the analysis is PARTIAL — the
   * denominator understates the repo and confirmed-coverage is a floor, never a complete
   * headline (resolver_gate.defensible is forced false). Never a silent partial.
   */
  not_analyzed_due_to_budget?: { files_not_analyzed: number; elapsed_ms: number; budget_ms: number };
  /** Persistent parse-cache reuse for this run (Phase 5.4.2): pure parse outputs reused by content hash. */
  parse_cache?: { hits: number; misses: number; hit_rate: number };
  /** Persistent resolver-cache reuse for this run (Phase 5.4.3). */
  resolver_cache?: { hits: number; misses: number; hit_rate: number };
  /** Directories full of non-evidence files — candidates for .orangeproignore (speed/de-noise). */
  exclude_suggestions?: ExcludeSuggestion[];
  /**
   * tree-sitter extraction status (Java/Python/Go). `loaded` grammars extracted via
   * AST; `failed` grammars (load attempted + errored) fell back to the shallow regex
   * path; `downgraded` is the subset of `failed` actually present in the repo — its
   * coverage denominator is undercounted (not a silent degrade).
   */
  tree_sitter?: { loaded: string[]; failed: string[]; downgraded: string[] };
  /** Import-resolution gate metrics (TS/JS files; absent when none were scanned). */
  resolver_metrics?: ResolverMetricsMeta;
  /** Static-confirmation defensibility verdict derived from resolver_metrics. */
  resolver_gate?: ResolverGateMeta;
  /** What the coverage denominator is made of (Gate 3 transparency). */
  denominator?: DenominatorComposition;
  /** Backend behavior contracts discovered from framework entrypoints. Metadata only in v1; not yet the coverage denominator. */
  behavior_contracts?: BehaviorContractsMeta;
  /** Static confirmation outcome (Phase 4): hard TESTED_BY/COVERS edges found by the TypeChecker confirmer. */
  confirmed_coverage?: ConfirmedCoverageMeta;
  /** Static assertion candidates over the denominator behaviors, split by linked test layer (Phase 5.1). */
  confirmed_by_layer?: ConfirmedCoverageByLayer;
  /** Coverage-tool report ingestion: runtime-covered symbols, separate from exact test proof. */
  runtime_coverage?: RuntimeCoverageMeta;
  /** Deterministic Layer-1 code communities derived from structural calls/imports. Navigation only — never coverage evidence. */
  structural_clusters?: StructuralClustersMeta;
  /** Static behavior composition paths. Reachability only — never execution/proof/coverage evidence. */
  flows?: FlowAnalysisMeta;
  /**
   * AI-suggested candidate flows (a "verify these" worklist). NEVER evidence:
   * stored parallel to `flows`, never counted in flow totals/tiers, and never
   * used by RTM/risk/score. The behavior report reads it for its clearly-labeled
   * AI-suggested section only. Note: buildVizPayload copies graph.analysis
   * VERBATIM into payload.meta.analysis (an unrendered metadata block), so this
   * meta rides along there as labeled candidate metadata.
   */
  candidate_flows?: CandidateFlowMeta;
}

export interface BehaviorContractsMeta {
  total: number;
  by_framework: Record<string, number>;
  by_kind: Record<string, number>;
  handler_edges?: number;
}

export type FlowTier = "hard: reachable" | "framework-derived: reachable";

export interface BehaviorFlow {
  id: string;
  entry_point: { external_id: string; kind: "Endpoint" | "Behavior"; title?: string };
  hops: Array<{
    from: string;
    to: string;
    evidence_strength: Extract<EvidenceStrength, "hard" | "framework-derived">;
    resolution?: string;
  }>;
  terminal: string;
  depth: number;
  flow_tier: FlowTier;
  truncated?: boolean;
}

export interface FlowAnalysisMeta {
  method: "static_calls_weakest_link";
  total_flows: number;
  by_tier: Record<FlowTier, number>;
  truncated_flows: number;
  dropped: {
    max_depth: number;
    max_flows_per_entry: number;
    global_cap: number;
  };
  options: {
    max_depth: number;
    max_flows_per_entry: number;
    global_cap: number;
  };
  flows: BehaviorFlow[];
}

/**
 * First-class rejection accounting for AI-proposed candidate flows. Every flow
 * the model returned lands in exactly one bucket, so under-confirmation is
 * visible, never silent. Invariant (tested): proposed === accepted + Σ rejected_*.
 */
export interface CandidateFlowRejections {
  /** Everything the model returned. */
  proposed: number;
  /** Stored after all validation. */
  accepted: number;
  /** Start node is not a real entry point. */
  rejected_missing_anchor: number;
  /** Any hop id not in the closed anchor set / current graph. */
  rejected_unresolved_hop: number;
  /** Hop chain revisits a node. */
  rejected_cycle: number;
  /** Beyond the flow-count or hop-count caps. */
  rejected_over_cap: number;
  /** Duplicate of an already-accepted flow. */
  rejected_duplicate: number;
  /** Unparseable / schema-invalid entries. */
  rejected_malformed: number;
}

/**
 * An AI-PROPOSED behavior flow: a candidate-tier "verify this" worklist item,
 * NEVER evidence. Lives only in `analysis.candidate_flows` — parallel to, never
 * inside, `analysis.flows`. By construction no field of type FlowTier exists
 * here, hops are pinned to "candidate", and review_status is always
 * "ai_suggested".
 */
export interface CandidateFlow {
  id: string;
  entry_point: { external_id: string; kind: "Endpoint" | "Behavior"; title?: string };
  hops: Array<{
    from: string;
    to: string;
    evidence_strength: Extract<EvidenceStrength, "candidate">;
    /**
     * Informational only: whether the proposed hop matches an existing
     * hard/framework CALLS edge. NEVER changes evidence_strength — promotion
     * is the deterministic verifyFlows job (Slice 5/6), not this field.
     */
    hop_status: "matches_known_edge" | "unverified";
  }>;
  terminal: string;
  depth: number;
  /** Non-optional by design: every candidate flow is AI-suggested. */
  review_status: Extract<ReviewStatus, "ai_suggested">;
  confidence: number;
  /** Model-proposed short name (metadata only, never source code). */
  title?: string;
  /** Short metadata-only reason from the model. */
  rationale?: string;
  provenance: Provenance;
}

/** AI-suggested candidate flows: report-only worklist, never flow counts/tiers/coverage. */
export interface CandidateFlowMeta {
  method: "llm_closed_anchor_proposal";
  rejections: CandidateFlowRejections;
  options: { max_flows: number; max_hops: number };
  provenance: { model_provider: string; model_name: string; prompt_version: string; cache_key: string };
  flows: CandidateFlow[];
}

export interface StructuralCluster {
  id: string;
  title: string;
  size: number;
  files: number;
  languages: Record<string, number>;
  top_files: string[];
  top_symbols: string[];
  hard_calls: number;
  likely_calls: number;
  import_links: number;
}

export interface StructuralClustersMeta {
  method: "deterministic_components_with_path_splits";
  total_clusters: number;
  emitted_clusters: number;
  clustered_symbols: number;
  clustered_files: number;
  hard_call_edges: number;
  likely_call_edges: number;
  import_edges_considered: number;
  import_edges_used: number;
  import_hub_threshold: number;
  clusters: StructuralCluster[];
}

/**
 * Structural confirmation outcome (Phase 4 / Gate 2). Confirmed pairs emit hard
 * TESTED_BY/COVERS edges; everything else stays a candidate. Surfaced so the
 * headline is auditable and under-confirmation is never silent.
 */
export interface ConfirmedCoverageMeta {
  /** Distinct (test, behavior) pairs the confirmer proved → hard edges. */
  confirmed_pairs: number;
  /** (test, behavior) pairs evaluated by the confirmer. */
  attempted: number;
  /** Confirmed-by-rule but the impl symbol was capped out of the graph → downgraded to INFERRED (never COVERS-to-file). */
  capped_downgrades: number;
  /** When > 0, confirmation was skipped because this many files exceeded the confirmer budget (use --base / raise the cap). */
  skipped_files_budget: number;
  /** When present, the full confirmer exceeded budget but a risk-ranked subset still ran. */
  scoped_by_risk?: {
    candidate_pairs: number;
    involved_files: number;
    risk_symbols: number;
    risk_symbol_limit: number;
    file_budget: number;
  };
}

/**
 * Static assertion candidates as a fraction of the DENOMINATOR behaviors (CodeSymbols +
 * Requirements — Phase 3), split by the test LAYER that links each one (Phase
 * 5.1, carry-over #3). The headline UserFlow ring counted only test-inferred
 * flows and read ~0% on real repos even when many symbols had static candidates; this
 * diagnostic is computed over what actually counts. `by_layer` PARTITIONS `confirmed`
 * by each behavior's primary confirming layer (sums to `confirmed`), so e2e/api
 * are reported separately and never blended into the structural unit-level %.
 */
export interface ConfirmedCoverageByLayer {
  /** Denominator behaviors (denominatorBehaviors): the % is over this, not UserFlows. */
  total_behaviors: number;
  /** Denominator behaviors with a hard TESTED_BY/COVERS edge. */
  confirmed: number;
  /** confirmed / total_behaviors * 100 (0 when total is 0). */
  confirmed_pct: number;
  /** Partition of `confirmed` by primary confirming layer (sums to `confirmed`). */
  by_layer: Record<TestLayer, number>;
  /** Confirmed behaviors whose confirming test layer could not be determined. */
  unknown_count: number;
  /** unknown_count / confirmed * 100 (0 when confirmed is 0). */
  unknown_pct: number;
}

export interface RuntimeCoverageArtifactMeta {
  path: string;
  format: "go-coverprofile" | "lcov" | "coverage-py" | "jacoco";
  files: number;
  covered_ranges: number;
}

export interface RuntimeCoverageSkippedArtifactMeta {
  path: string;
  format: "go-coverprofile" | "lcov" | "coverage-py" | "jacoco" | "unknown";
  reason: string;
}

export interface RuntimeCoverageLanguageMeta {
  eligible: number;
  symbols_with_spans: number;
  covered: number;
  covered_pct: number;
}

/**
 * Runtime coverage imported from existing coverage-tool reports. This is NOT
 * exact test-to-symbol proof: it means the suite executed lines inside a symbol.
 * It stays separate from hard TESTED_BY/COVERS so coverage-report evidence never
 * blurs with assertion-level proof.
 */
export interface RuntimeCoverageMeta {
  artifacts: RuntimeCoverageArtifactMeta[];
  skipped_artifacts?: RuntimeCoverageSkippedArtifactMeta[];
  total_eligible_symbols: number;
  symbols_with_spans: number;
  covered_symbols: number;
  covered_pct: number;
  by_language: Record<string, RuntimeCoverageLanguageMeta>;
}

/**
 * What the coverage denominator is made of. `total` counts ONLY eligible
 * behaviors; test-inferred flows are inventoried in `excluded_test_inferred`
 * and contribute 0 — the composition makes that exclusion auditable.
 */
export interface DenominatorComposition {
  total: number;
  code_export: number;
  requirement_template: number;
  markdown_requirement: number;
  excluded_test_inferred: number;
  /** Trivial accessors kept as nodes but excluded from the denominator — recomputed from nodes (never read from persisted analysis), so the disclosure can never disagree with the graph. */
  excluded_boilerplate: number;
  /** CI/test-infra symbols (.github, e2e/playwright/cypress, fixtures/mocks) kept as nodes but excluded from the denominator. Node-derived. */
  excluded_infra: number;
  /** Generated-code symbols kept as nodes but excluded from the denominator. Node-derived. */
  excluded_generated: number;
  /** ALL non-stale CodeSymbol nodes (the true "code symbols found" total). code_export + excluded_boilerplate + other-excluded (non-callable consts, .d.ts) = this. */
  code_symbols_total: number;
  /**
   * Eligible nodes whose behavior_source is NOT an eligible source (e.g. an
   * eligible test_inferred node — a producer-bug combination). Counted in
   * their own bucket so the audit artifact SURFACES the contradiction instead
   * of laundering it into requirement_template.
   */
  unattributed: number;
}

/** A directory worth excluding from analysis: many files, none carrying graph evidence. */
export interface ExcludeSuggestion {
  /** Workspace-relative directory path. */
  path: string;
  /** How many scanned files it contributed. */
  files: number;
  /** Why it is suggested (human-readable). */
  reason: string;
}

export type SourceUploadPolicy = "metadata_only" | "include_sources";

export interface WorkspaceMeta {
  name: string;
  root: string;
  root_hash: string;
  source_upload_policy: SourceUploadPolicy;
}

/** The full local graph persisted to `.orangepro/graph.json`. */
export interface LocalGraph {
  schema_version: typeof LOCAL_GRAPH_SCHEMA_VERSION;
  workspace: WorkspaceMeta;
  created_at: string;
  updated_at: string;
  sources: SourceScope[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  candidate_edges: CandidateEdge[];
  generation_runs: GenerationRun[];
  generated_tests: GeneratedTest[];
  manifest: Manifest;
  /** Optional for backward compatibility with graphs written before analysis meta. */
  analysis?: AnalysisMeta;
}

/** Node kinds that map to behaviors/requirements for scoring + gaps + generation. */
export const BEHAVIOR_KINDS: ReadonlySet<NodeKind> = new Set<NodeKind>([
  "Requirement",
  "UserFlow",
  "BusinessRule"
]);
