import {
  AnalysisMeta,
  CandidateEdge,
  DenominatorComposition,
  GeneratedTest,
  GenerationRun,
  GraphEdge,
  GraphNode,
  ManifestFileEntry,
  SourceScope
} from "./graph/ontology.js";

// ── Analyzer / enricher outputs ──────────────────────────────────────
// Both produce graph fragments that the builder merges into a LocalGraph.

export interface GraphFragment {
  nodes: GraphNode[];
  edges: GraphEdge[];
  candidate_edges: CandidateEdge[];
  sources: SourceScope[];
  warnings: string[];
}

export interface AnalyzeFragment extends GraphFragment {
  /** Per-file manifest entries keyed by relPath, for the freshness manifest. */
  file_entries: Record<string, ManifestFileEntry>;
  analysis: AnalysisMeta;
}

// ── Score / doctor ───────────────────────────────────────────────────

export type ScoreBand = "thin" | "usable" | "good" | "strong";

export interface ScoreBreakdown {
  behavior_anchors: number;
  acceptance_criteria: number;
  provenance: number;
  interface_mapping: number;
  validation_evidence: number;
  known_regressions: number;
}

export interface ScoreResult {
  overall: number;
  band: ScoreBand;
  breakdown: ScoreBreakdown;
  /** Plain-language list of what would raise the score (the trust feature). */
  missing_evidence: string[];
  /** What the coverage denominator is made of (test-inferred flows count 0). */
  denominator: DenominatorComposition;
}

export interface DoctorRecommendation {
  priority: number;
  action: string;
  why: string;
  expected_score_impact: string;
}

export interface DoctorResult {
  status: ScoreBand;
  recommendations: DoctorRecommendation[];
  can_continue_without_recommendations: boolean;
}

// ── Gaps ─────────────────────────────────────────────────────────────

export interface GapItem {
  external_id: string;
  title: string;
  kind: string;
  priority: string;
  reason: string;
  has_acceptance_criteria: boolean;
  test_evidence: "none" | "weak" | "covered";
  recommended_action: string;
}

export interface RiskGapItem {
  external_id: string;
  title: string;
  file: string;
  risk_score: number;
  incoming_refs: number;
  git_churn: number;
  entry_point: boolean;
  reasons: string[];
  /** ORS decomposition (optional for backward compatibility). */
  probability?: number;
  impact?: number;
  detection_difficulty?: number;
  fan_out?: number;
  route_weight?: number;
  data_sensitivity?: number;
  flow_position?: number;
  complexity_proxy?: number;
  is_new_code?: boolean;
  integration_signal?: "associated" | "candidate" | "none";
}

export interface GapsResult {
  gaps: GapItem[];
  total_behaviors: number;
  /** Unproven code symbols ranked for prioritization only; does not affect coverage/proof status. */
  top_risk_gaps?: RiskGapItem[];
  risk_model?: {
    formula: string;
    note: string;
  };
  /** Behaviors excluded from the gap list because their only tests are e2e/api (not_structurally_confirmable). */
  not_structurally_confirmable?: number;
  /** Set when there are no behavior anchors to analyze: the next step to take. */
  guidance?: string;
}

// ── Generation ───────────────────────────────────────────────────────

export interface ModelCompletionRequest {
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
}

/** Provider adapter contract. Implemented for OpenAI-compatible, Ollama, Anthropic. */
export interface ModelProvider {
  readonly providerName: string;
  readonly modelName: string;
  complete(req: ModelCompletionRequest): Promise<string>;
}

/** Reads a workspace-relative source file in-process. Returns null if unavailable. */
export type FileReader = (relPath: string) => string | null;

export interface MissingEvidenceItem {
  external_id: string;
  title: string;
  reason: string;
  needed: string[];
}

export interface GenerateResult {
  run: GenerationRun | null;
  generated_tests: GeneratedTest[];
  /** Populated instead of generic tests when evidence is too thin. */
  missing_evidence: MissingEvidenceItem[];
  warnings: string[];
}

export interface GenerateOptions {
  target_ids?: string[];
  framework?: string;
  limit?: number;
  /** Internal comparison only: bypass grounding to produce a raw-prompt baseline. */
  input_mode?: "graph_grounded" | "raw_prompt";
  /** Prompt strategy. v5 is opt-in until corpus validation clears it as default. */
  prompt_version?: "v2" | "v5";
  /** Override the shared system prompt (used by the A/B compare view). */
  systemPrompt?: string;
}

// ── Explain ──────────────────────────────────────────────────────────

export interface ExplainResult {
  generated_test_id: string;
  title: string;
  behavior_tested: string;
  grounded_by: Array<{
    external_id: string;
    kind: string;
    title: string;
    evidence_strength: string;
    source_ref?: string;
  }>;
  source_refs: string[];
  weak_evidence_used: boolean;
  weak_relationships: Array<{ from: string; relation: string; to: string; reason: string; confidence: number }>;
  stale: boolean;
}

// ── Freshness ────────────────────────────────────────────────────────

export type FreshnessState = "fresh" | "stale" | "missing";

export interface StatusResult {
  workspace_initialized: boolean;
  graph_path: string;
  last_analyzed_at: string | null;
  local_only: boolean;
  sources: Record<string, number>;
  quality_score: number | null;
  can_generate_tests: boolean;
  freshness: FreshnessState;
  changed_files: number;
  analysis: AnalysisMeta | null;
  privacy: {
    graph_storage: "local";
    upload_enabled: boolean;
    source_snippets_in_pack: boolean;
  };
}

export interface UpdateResult {
  status: "updated" | "fresh" | "rebuilt" | "missing";
  changed_files: number;
  updated_entities: number;
  stale_generated_tests: number;
  warnings: string[];
}

/**
 * Diff/PR tool-mode status. `ok` means a real diff was analyzed; the others are
 * structured guidance states so a diff/PR tool never fabricates impact when there
 * is nothing to analyze.
 */
export type ChangedStatus = "ok" | "no_diff" | "no_code_changes" | "missing_base_ref" | "not_a_git_repo";

/**
 * How the diff reached an affected behavior, strongest path first:
 * - "direct": the behavior's own test file is itself in the diff.
 * - "import": a changed file the test RESOLVED-IMPORTS (import-graph evidence).
 * - "stem": basename-stem name heuristic (weak; only where the resolver couldn't link).
 * - "area": coarse directory-area fallback — last resort, capped; not file-precise.
 */
export type DiffLinkKind = "direct" | "import" | "stem" | "area";

export interface ChangedResult {
  status: ChangedStatus;
  base_ref: string;
  changed_files: string[];
  affected_behaviors: string[];
  /**
   * Provenance per affected behavior id: import-graph evidence ("direct"/"import")
   * vs heuristic ("stem"/"area"). One entry for every id in affected_behaviors, so
   * a consumer can trust import-precise targets and treat area matches as coarse.
   */
  link_kinds: Record<string, DiffLinkKind>;
  affected_tests: string[];
  recommended_actions: string[];
  /** Set when status !== "ok": the human-readable next step (no impact is fabricated). */
  guidance?: string;
}

/** Injectable git accessor so changed/manifest logic is testable without a repo. */
export type GitRunner = (args: string[]) => string | null;
