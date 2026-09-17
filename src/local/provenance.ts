import type { AnalysisMeta, ArtifactIdentity, LocalGraph } from "./graph/ontology.js";
import { LOCAL_GRAPH_SCHEMA_VERSION } from "./graph/ontology.js";
import { ORS_VERSION } from "./score/risk.js";
import { ORANGEPRO_VERSION } from "./version.js";
import { hashString } from "./util/hash.js";

export const ARTIFACT_IDENTITY_VERSION = "orangepro.artifact_identity.v1" as const;
export const ANALYZER_VERSION = "orangepro.analyzer.v2" as const;
export const PROOF_ORACLE_VERSION = "orangepro.targeted_mutation_oracle.v1" as const;

export type ComparisonCompatibilityState =
  | "first_run"
  | "comparable"
  | "repository_changed"
  | "analysis_changed"
  | "ranking_changed"
  | "experiment_changed"
  | "provenance_incomplete";

export interface ArtifactIdentityInputs {
  configHash: string;
  history: {
    state: "full" | "shallow" | "partial" | "unavailable";
    churnWindow: string;
    churnAvailable: boolean;
    commitDate: string | null;
    /** Exact hash of the churn and first-commit inputs consumed by ORS. */
    inputFingerprint?: string;
  };
  analyzerVersion?: string;
  orsVersion?: string;
  oracleVersion?: string;
}

function stable(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => `${JSON.stringify(key)}:${stable(record[key])}`).join(",")}}`;
}

function digest(value: unknown): string {
  return hashString(stable(value));
}

/** Included paths + bytes after OrangePro ignore/cap rules. Git metadata is deliberately excluded. */
export function repositorySnapshot(graph: Pick<LocalGraph, "manifest">): string {
  return digest(Object.entries(graph.manifest.files)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, file]) => ({ path, hash: file.hash })));
}

function analysisScope(analysis?: AnalysisMeta): Record<string, unknown> {
  return {
    max_files: analysis?.max_files ?? null,
    max_symbols: analysis?.max_symbols ?? null,
    max_inferred_flows: analysis?.max_inferred_flows ?? null,
    files_cap_hit: analysis?.files_cap_hit ?? false,
    symbol_cap_hit: analysis?.symbol_cap_hit ?? false,
    budget_ms: analysis?.not_analyzed_due_to_budget?.budget_ms ?? null,
    flow_options: analysis?.flows?.options ?? null,
    tree_sitter_loaded: [...(analysis?.tree_sitter?.loaded ?? [])].sort(),
    tree_sitter_downgraded: [...(analysis?.tree_sitter?.downgraded ?? [])].sort()
  };
}

export function buildArtifactIdentity(graph: LocalGraph, inputs: ArtifactIdentityInputs): ArtifactIdentity {
  const repository_snapshot = repositorySnapshot(graph);
  const analyzer_version = inputs.analyzerVersion ?? ANALYZER_VERSION;
  const ors_version = inputs.orsVersion ?? ORS_VERSION;
  const oracle_version = inputs.oracleVersion ?? PROOF_ORACLE_VERSION;
  const analysis_fingerprint = digest({
    repository_snapshot,
    analyzer_version,
    graph_schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    source_upload_policy: graph.workspace.source_upload_policy,
    scope: analysisScope(graph.analysis),
    history: inputs.history
  });
  const ranking_fingerprint = digest({ analysis_fingerprint, risk_config_hash: inputs.configHash, ors_version });
  const run_fingerprint = digest({ ranking_fingerprint, oracle_version });
  return {
    schema_version: ARTIFACT_IDENTITY_VERSION,
    repository_snapshot,
    analysis_fingerprint,
    ranking_fingerprint,
    run_fingerprint,
    analyzer_version,
    graph_schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    ors_version,
    oracle_version,
    risk_config_hash: inputs.configHash,
    tool_version: ORANGEPRO_VERSION,
    git_commit: graph.manifest.git?.commit ?? null,
    git_dirty: graph.manifest.git?.dirty ?? null
  };
}

export function comparisonCompatibility(
  previous?: ArtifactIdentity | null,
  current?: ArtifactIdentity | null
): ComparisonCompatibilityState {
  if (!previous || !current) return "provenance_incomplete";
  if (previous.schema_version !== ARTIFACT_IDENTITY_VERSION || current.schema_version !== ARTIFACT_IDENTITY_VERSION) {
    return "provenance_incomplete";
  }
  if (previous.repository_snapshot !== current.repository_snapshot) return "repository_changed";
  if (previous.analysis_fingerprint !== current.analysis_fingerprint) return "analysis_changed";
  if (previous.ranking_fingerprint !== current.ranking_fingerprint) return "ranking_changed";
  if (previous.run_fingerprint !== current.run_fingerprint) return "experiment_changed";
  return "comparable";
}
