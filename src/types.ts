export type AgentSummary = {
  agent_id: string;
  name: string;
  agent_type: string;
  status: string;
  last_run_at?: string | null;
  records_processed?: number;
  tests_generated?: number;
};

export type AgentRunSummary = {
  run_id: string;
  status: string;
  started_at?: string;
  duration_ms?: number;
  records_processed?: number;
  tests_generated?: number;
};

export type AgentLogs = {
  agent_id: string;
  run_id?: string | null;
  lines: string[];
};

export type ToolTextResponse = {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
};

export type CoverageZone = {
  category: string;
  coverage_level: string;
  test_count: number;
  score?: number;
};

export type CoverageHeatmapResponse = {
  coverage_score: number;
  total_categories: number;
  covered_categories: number;
  zones: CoverageZone[];
  summary?: { red: number; yellow: number; green: number };
};

export type CoverageTrendResponse = {
  days: number;
  trend: Array<{ date: string; test_cases: number }>;
};

export type DashboardResponse = {
  total_test_cases: number;
  total_executions: number;
  completed_jobs: number;
  failed_jobs: number;
  in_progress_jobs: number;
  recent_executions: Array<Record<string, unknown>>;
};

export type BugAnalysis = {
  bug_id?: string;
  root_cause?: string;
  affected_areas?: string[];
  risk_level?: string;
  summary?: string;
  [key: string]: unknown;
};

export type BugAnalyzeResponse = {
  analysis: BugAnalysis;
  session_id: string;
  source_reference?: Record<string, unknown> | null;
};

export type RegressionTest = {
  title: string;
  steps: string[];
  expected_result: string;
  priority?: string;
  category?: string;
};

export type BugGenerateResponse = {
  job_id: string;
  test_cases: RegressionTest[];
  scripts: Array<Record<string, unknown>>;
};

export type ReleaseReadinessResponse = {
  recommendation: "ship" | "review" | "block";
  confidence_score: number;
  scope: string;
  summary: {
    total_test_cases: number;
    total_executions: number;
    completed_jobs: number;
    failed_jobs: number;
    in_progress_jobs: number;
  };
  coverage: {
    score: number;
    total_categories: number;
    covered: number;
    partial: number;
    uncovered: number;
    red_zones: string[];
    trend_direction: string;
  };
  quality: {
    feedback_score: number | null;
    thumbs_up: number;
    thumbs_down: number;
    no_feedback: number;
    dedup_rate: number;
    avg_test_cases_per_job: number;
  };
  scripts: {
    total: number;
    ready: number;
    failed: number;
    coverage_percent: number;
    by_framework: Record<string, number>;
  };
  risk_areas: Array<{ category: string; test_count: number; coverage_level: string; reason: string }>;
  recent_failures: Array<{ job_id: string; job_name: string | null; status: string; test_cases_count: number; created_at: string }>;
  recommended_actions: Array<{ action: string; priority: string; target?: string }>;
};

export type TestImpactRadarResponse = {
  overall_risk: number;
  recommendation: "low_risk" | "moderate_risk" | "high_risk";
  risk_drivers: Array<{ driver: string; score: number; detail: string }>;
  impacted_categories: string[];
  similar_bugs: Array<{
    bug_id: string;
    summary: string;
    affected_feature_area: string;
    relevance_score: number;
    is_regression: boolean;
    severity: string;
  }>;
  coverage_gaps: Array<{ category: string; test_count: number; gap_severity: string }>;
  recommended_tests: Array<{ title: string; category: string; source: string; job_id?: string }>;
  recommended_generations: Array<{ category: string; reason: string; suggested_count: number }>;
  pr_context: { title: string; categories_matched: number; total_historical_bugs: number };
};

export type JobInitResponse = {
  jobId: string;
  job_id?: string;
  status: string;
  uploadUrl?: string;
  message?: string;
};

export type JobStatusResponse = {
  status: string;
  progress?: number;
  current_step?: string;
};

export type TestCase = {
  id?: string;
  title: string;
  category?: string;
  steps: string[];
  expected_result: string;
  preconditions?: string[];
  qefix_label?: string;
};

export type JobResultsResponse = {
  test_cases: TestCase[];
  total: number;
};

export type GeneratedScript = {
  filename: string;
  content: string;
  framework: string;
  language?: string;
};

export type ScriptJobResultsResponse = {
  scripts: GeneratedScript[];
};
