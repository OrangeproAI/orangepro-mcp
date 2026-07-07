import { OrangeProClient } from "./apiClient.js";
import { asText, asError } from "./orangeproTools.js";
import {
  BugAnalyzeResponse,
  BugGenerateResponse,
  CoverageHeatmapResponse,
  CoverageTrendResponse,
  DashboardResponse,
  GeneratedScript,
  JobInitResponse,
  JobResultsResponse,
  JobStatusResponse,
  ReleaseReadinessResponse,
  ScriptJobResultsResponse,
  TestCase,
  TestImpactRadarResponse
} from "./types.js";

const GENERATION_DEADLINE_MS = 120_000;
const GENERATION_POLL_INTERVAL_MS = 5_000;

type BugSeverity = "critical" | "high" | "medium" | "low";

type ProgressReporter = (progress: number, total: number) => void;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ToolExtra = { sendNotification?: (n: any) => Promise<void>; _meta?: { progressToken?: string | number } };

export function createOrangeProQaToolHandlers(client: OrangeProClient, config?: { userEmail?: string; organizationName?: string }) {
  return {
    async getCoverageGaps(input: { area?: string }) {
      try {
        const heatmap = await client.get<CoverageHeatmapResponse>("/analytics/coverage-heatmap");
        const zones = heatmap.zones ?? [];
        const filtered = input.area
          ? zones.filter((zone) => zone.category.toLowerCase().includes(input.area!.toLowerCase()))
          : zones;

        const redZones = filtered.filter((zone) => isCoverageLevel(zone.coverage_level, ["red", "critical"]));
        const yellowZones = filtered.filter((zone) => isCoverageLevel(zone.coverage_level, ["yellow", "partial"]));
        const greenZones = filtered.filter((zone) => isCoverageLevel(zone.coverage_level, ["green", "good"]));

        const summary = [
          `Coverage Score: ${heatmap.coverage_score}%`,
          `${heatmap.covered_categories} of ${heatmap.total_categories} categories covered.`,
          redZones.length > 0
            ? `Critical gaps (${redZones.length}): ${redZones.map((zone) => zone.category).join(", ")}`
            : "No critical gaps found.",
          yellowZones.length > 0
            ? `Partial coverage (${yellowZones.length}): ${yellowZones.map((zone) => zone.category).join(", ")}`
            : "",
          greenZones.length > 0
            ? `Well-covered (${greenZones.length}): ${greenZones.map((zone) => zone.category).join(", ")}`
            : ""
        ].filter(Boolean).join("\n");

        return asText({
          coverage_score: heatmap.coverage_score,
          total_categories: heatmap.total_categories,
          covered_categories: heatmap.covered_categories,
          gaps_by_severity: {
            red: redZones.length,
            yellow: yellowZones.length,
            green: greenZones.length
          },
          zones: filtered.map((zone) => ({
            category: zone.category,
            level: zone.coverage_level,
            test_count: zone.test_count
          })),
          summary
        });
      } catch (error) {
        return asError(error);
      }
    },

    async convertBugToTests(input: { bug_description: string; severity?: BugSeverity }) {
      try {
        const { analysis, tests } = await analyzeBugAndGenerateTests(client, input.bug_description);
        const summary = [
          `Analyzed bug and generated ${tests.length} regression test(s).`,
          analysis.root_cause ? `Root cause: ${analysis.root_cause}` : "",
          analysis.risk_level ? `Risk level: ${analysis.risk_level}` : "",
          analysis.affected_areas?.length ? `Affected areas: ${analysis.affected_areas.join(", ")}` : "",
          tests.length > 0
            ? `\nGenerated tests:\n${tests.map((test, index) => `  ${index + 1}. ${test.title}`).join("\n")}`
            : "No tests generated."
        ].filter(Boolean).join("\n");

        return asText({
          analysis: {
            root_cause: analysis.root_cause ?? "See analysis details",
            affected_areas: analysis.affected_areas ?? [],
            risk_level: analysis.risk_level ?? input.severity ?? "medium"
          },
          regression_tests: tests.map((test) => ({
            title: test.title,
            steps: test.steps,
            expected_result: test.expected_result,
            priority: test.priority ?? input.severity ?? "medium"
          })),
          total_tests: tests.length,
          summary
        });
      } catch (error) {
        return asError(error);
      }
    },

    async buildRegressionPack(input: { area: string; context?: string }) {
      try {
        const bugDescription = input.context
          ? `Regression risk area: ${input.area}. Context: ${input.context}`
          : `Regression risk area: ${input.area}. Build comprehensive regression tests to ensure this area remains stable.`;
        const { tests } = await analyzeBugAndGenerateTests(client, bugDescription);

        const summary = [
          `Regression pack for "${input.area}": ${tests.length} test(s) generated.`,
          input.context ? `Context: ${input.context}` : "",
          tests.length > 0
            ? `\nTests:\n${tests.map((test, index) => `  ${index + 1}. ${test.title}`).join("\n")}`
            : "No regression tests generated. The area may already have sufficient coverage."
        ].filter(Boolean).join("\n");

        return asText({
          pack_name: `Regression: ${input.area}`,
          area: input.area,
          tests: tests.map((test) => ({
            title: test.title,
            steps: test.steps,
            expected_result: test.expected_result,
            priority: test.priority ?? "medium"
          })),
          total_tests: tests.length,
          summary
        });
      } catch (error) {
        return asError(error);
      }
    },

    async explainQualityRisk(input: { area?: string; question?: string }) {
      try {
        const [dashboard, heatmap, trend] = await Promise.all([
          client.get<DashboardResponse>("/analytics/dashboard").catch(() => null),
          client.get<CoverageHeatmapResponse>("/analytics/coverage-heatmap").catch(() => null),
          client.get<CoverageTrendResponse>("/analytics/coverage-trend?days=30").catch(() => null)
        ]);

        const riskAreas: Array<{ area: string; risk_level: string; reason: string }> = [];
        if (heatmap?.zones) {
          const zones = input.area
            ? heatmap.zones.filter((zone) => zone.category.toLowerCase().includes(input.area!.toLowerCase()))
            : heatmap.zones;

          for (const zone of zones) {
            if (isCoverageLevel(zone.coverage_level, ["red", "critical"])) {
              riskAreas.push({
                area: zone.category,
                risk_level: "high",
                reason: `Critical coverage gap — only ${zone.test_count} test(s)`
              });
            } else if (isCoverageLevel(zone.coverage_level, ["yellow", "partial"])) {
              riskAreas.push({
                area: zone.category,
                risk_level: "medium",
                reason: `Partial coverage — ${zone.test_count} test(s), more needed`
              });
            }
          }
        }

        const trendDirection = deriveTrendDirection(trend);
        const parts: string[] = [];
        if (input.question) {
          parts.push(`Regarding "${input.question}":\n`);
        }
        if (heatmap) {
          parts.push(`Overall coverage score: ${heatmap.coverage_score}% (${heatmap.covered_categories}/${heatmap.total_categories} categories).`);
        }
        if (dashboard) {
          parts.push(
            `Project has ${dashboard.total_test_cases} test cases across ${dashboard.total_executions} executions. ` +
            `${dashboard.completed_jobs} jobs completed, ${dashboard.failed_jobs} failed.`
          );
        }
        parts.push(`Coverage trend (30 days): ${trendDirection}.`);

        const highRisk = riskAreas.filter((area) => area.risk_level === "high");
        const medRisk = riskAreas.filter((area) => area.risk_level === "medium");
        if (highRisk.length > 0) {
          parts.push(`\nHigh-risk areas (${highRisk.length}):\n${highRisk.map((area) => `  - ${area.area}: ${area.reason}`).join("\n")}`);
        }
        if (medRisk.length > 0) {
          parts.push(`\nMedium-risk areas (${medRisk.length}):\n${medRisk.map((area) => `  - ${area.area}: ${area.reason}`).join("\n")}`);
        }
        if (riskAreas.length === 0) {
          parts.push("\nNo critical risk areas detected. Coverage looks healthy.");
        }
        if (trendDirection === "declining") {
          parts.push("\nWarning: Coverage has been declining over the past 30 days. Consider generating additional tests for gap areas.");
        }

        return asText({
          risk_areas: riskAreas,
          coverage_health: {
            score: heatmap?.coverage_score ?? null,
            trend_direction: trendDirection
          },
          stats: {
            total_tests: dashboard?.total_test_cases ?? 0,
            completed_jobs: dashboard?.completed_jobs ?? 0,
            failed_jobs: dashboard?.failed_jobs ?? 0
          },
          summary: parts.join("\n")
        });
      } catch (error) {
        return asError(error);
      }
    },

    async generateMissingCoverage(input: { user_story: string; app_context?: string; app_domain?: string }, extra?: ToolExtra) {
      try {
        const reportProgress = buildProgressReporter(extra);
        const result = await generateTests(client, input.user_story, input.app_context, input.app_domain, reportProgress, config?.userEmail, config?.organizationName);
        let summary: string;

        if (result.status === "COMPLETED") {
          const categories = new Set(result.test_cases.map((test) => test.category ?? "General"));
          summary = [
            `Generated ${result.total} test case(s) across ${categories.size} category(ies).`,
            `Categories: ${[...categories].join(", ")}`,
            "",
            "Test cases:",
            ...result.test_cases.map((test, index) =>
              `  ${index + 1}. [${test.category ?? "General"}] ${test.title}` +
              (test.steps.length > 0 ? ` (${test.steps.length} steps)` : "")
            )
          ].join("\n");
        } else if (result.status === "FAILED") {
          summary = `Test generation failed for job ${result.job_id}. Try providing more detail about the feature and expected behavior.`;
        } else {
          summary = `Test generation is still running (job: ${result.job_id}). Ask again later to check results.`;
        }

        return asText({
          job_id: result.job_id,
          status: result.status,
          test_cases: result.test_cases.map((test) => ({
            title: test.title,
            category: test.category ?? "General",
            steps: test.steps,
            expected_result: test.expected_result
          })),
          total_generated: result.total,
          summary
        });
      } catch (error) {
        return asError(error);
      }
    },

    async analyzePrRisk(input: { pr_title: string; pr_description?: string; changed_files?: string[] }) {
      try {
        const data = await client.post<TestImpactRadarResponse>("/analytics/test-impact-radar", {
          pr_title: input.pr_title,
          pr_description: input.pr_description ?? "",
          changed_files: input.changed_files ?? []
        });
        const riskLabel = data.recommendation === "high_risk"
          ? "HIGH RISK"
          : data.recommendation === "moderate_risk"
            ? "MODERATE RISK"
            : "LOW RISK";
        const parts: string[] = [
          `PR: ${data.pr_context.title}`,
          `Risk: ${riskLabel} (score: ${data.overall_risk}/100)`
        ];

        if (data.risk_drivers.length > 0) {
          parts.push("", "Risk drivers:", ...data.risk_drivers.map((driver) => `  - ${driver.driver}: +${driver.score} — ${driver.detail}`));
        }
        if (data.impacted_categories.length > 0) {
          parts.push("", `Impacted categories: ${data.impacted_categories.join(", ")}`);
        }
        if (data.similar_bugs.length > 0) {
          parts.push("", `Similar historical bugs (${data.similar_bugs.length}):`, ...data.similar_bugs.map((bug) =>
            `  - ${bug.summary} (${(bug.relevance_score * 100).toFixed(0)}% match, area: ${bug.affected_feature_area})`
          ));
        }
        if (data.coverage_gaps.length > 0) {
          parts.push("", `Coverage gaps (${data.coverage_gaps.length}):`, ...data.coverage_gaps.map((gap) =>
            `  - ${gap.category}: ${gap.test_count} tests (severity: ${gap.gap_severity})`
          ));
        }
        if (data.recommended_tests.length > 0) {
          parts.push("", `Recommended tests to re-run (${data.recommended_tests.length}):`, ...data.recommended_tests.slice(0, 5).map((test) =>
            `  - ${test.title} [${test.category}]`
          ));
        }
        if (data.recommended_generations.length > 0) {
          parts.push("", "Recommended test generation:", ...data.recommended_generations.map((generation) =>
            `  - Generate ${generation.suggested_count} tests for ${generation.category}: ${generation.reason}`
          ));
        }

        return asText({ ...data, summary: parts.join("\n") });
      } catch (error) {
        return asError(error);
      }
    },

    async analyzeReleaseReadiness() {
      try {
        const data = await client.get<ReleaseReadinessResponse>("/analytics/release-readiness");
        const parts: string[] = [
          "Scope: tenant-wide (not release-specific)",
          `Recommendation: ${data.recommendation.toUpperCase()} (confidence: ${data.confidence_score}%)`,
          "",
          `Coverage: ${data.coverage.score}% (${data.coverage.covered}/${data.coverage.total_categories} categories green, trend: ${data.coverage.trend_direction})`,
          `Executions: ${data.summary.total_executions} total, ${data.summary.completed_jobs} completed, ${data.summary.failed_jobs} failed`,
          `Test cases: ${data.summary.total_test_cases}`,
          `Scripts: ${data.scripts.ready}/${data.scripts.total} ready (${data.scripts.coverage_percent}% coverage)`
        ];

        if (data.risk_areas.length > 0) {
          parts.push("", `Risk areas (${data.risk_areas.length}):`, ...data.risk_areas.map((risk) => `  - ${risk.category}: ${risk.reason} (${risk.coverage_level})`));
        }
        if (data.recent_failures.length > 0) {
          parts.push("", `Recent failures (${data.recent_failures.length}):`, ...data.recent_failures.map((failure) =>
            `  - ${failure.job_name ?? failure.job_id}: ${failure.test_cases_count} test cases (${failure.created_at})`
          ));
        }
        if (data.recommended_actions.length > 0) {
          parts.push("", "Recommended actions:", ...data.recommended_actions.map((action) => `  - [${action.priority}] ${action.action}`));
        }

        return asText({ ...data, summary: parts.join("\n") });
      } catch (error) {
        return asError(error);
      }
    },

    async generateTestScripts(input: { source_job_id: string; framework?: string; test_case_ids?: string[]; app_domain?: string }, extra?: ToolExtra) {
      try {
        const reportProgress = buildProgressReporter(extra);
        const result = await generateScripts(client, input.source_job_id, input.framework, input.test_case_ids, input.app_domain, reportProgress, config?.userEmail, config?.organizationName);

        const summary = result.status === "COMPLETED"
          ? `Generated ${result.scripts.length} script(s):\n${result.scripts.map((s, i) => `  ${i + 1}. ${s.filename} (${s.framework})`).join("\n")}`
          : result.status === "FAILED"
            ? `Script generation failed for job ${result.job_id}. Try providing more structured test cases.`
            : `Script generation still running (job: ${result.job_id}). Ask again later.`;

        return asText({
          job_id: result.job_id,
          status: result.status,
          scripts: result.scripts,
          total_scripts: result.scripts.length,
          summary
        });
      } catch (error) {
        return asError(error);
      }
    }
  };
}

function buildProgressReporter(extra?: ToolExtra): ProgressReporter {
  const token = extra?._meta?.progressToken;
  if (!token || !extra?.sendNotification) {
    return () => {};
  }
  const send = extra.sendNotification;
  return (progress: number, total: number) => {
    send({ method: "notifications/progress", params: { progressToken: token, progress, total } }).catch(() => {});
  };
}

async function analyzeBugAndGenerateTests(client: OrangeProClient, bugDescription: string) {
  const analyzeRes = await client.post<BugAnalyzeResponse>("/bug-to-test/analyze", {
    input_type: "plain_text",
    content: bugDescription
  });
  const generateRes = await client.post<BugGenerateResponse>("/bug-to-test/generate", {
    session_id: analyzeRes.session_id,
    generate_script: false
  });

  return {
    analysis: analyzeRes.analysis ?? {},
    tests: generateRes.test_cases ?? []
  };
}

async function generateTests(client: OrangeProClient, userStory: string, appContext?: string, appDomain?: string, reportProgress?: ProgressReporter, email?: string, orgName?: string) {
  const jobId = crypto.randomUUID();
  const metadata = {
    context: {
      email: email ?? "mcp-user@orangepro.ai",
      orgName: orgName ?? "orangepro",
      jobId
    },
    app_domain: appDomain ?? ""
  };
  const init = await client.post<JobInitResponse>("/test-generation/initialize", { metadata });
  const resolvedJobId = init.jobId ?? init.job_id ?? jobId;
  const submitBody = {
    userStories: {
      source: { type: "MANUAL", content: userStory }
    },
    applicationOverview: {
      source: { type: "MANUAL", content: appContext ?? "" }
    },
    metadata,
    app_domain: appDomain ?? ""
  };
  await client.post<unknown>(`/test-generation/${encodeURIComponent(resolvedJobId)}/submit`, submitBody);

  const startTime = Date.now();
  const deadline = startTime + GENERATION_DEADLINE_MS;
  let lastStatus = "IN_PROGRESS";

  while (Date.now() < deadline) {
    const elapsed = Date.now() - startTime;
    reportProgress?.(elapsed, GENERATION_DEADLINE_MS);

    const status = await client.get<JobStatusResponse>(`/test-generation/${encodeURIComponent(resolvedJobId)}/status`);
    lastStatus = normalizeJobStatus(status.status);

    if (lastStatus === "COMPLETED") {
      reportProgress?.(GENERATION_DEADLINE_MS, GENERATION_DEADLINE_MS);
      const results = await getJobResults(client, resolvedJobId);
      return {
        job_id: resolvedJobId,
        status: "COMPLETED",
        test_cases: results.test_cases,
        total: results.total
      };
    }

    if (lastStatus === "FAILED") {
      return {
        job_id: resolvedJobId,
        status: "FAILED",
        test_cases: [] as TestCase[],
        total: 0
      };
    }

    await sleep(GENERATION_POLL_INTERVAL_MS);
  }

  return {
    job_id: resolvedJobId,
    status: lastStatus,
    test_cases: [] as TestCase[],
    total: 0
  };
}

async function generateScripts(client: OrangeProClient, sourceJobId: string, framework?: string, testCaseIds?: string[], appDomain?: string, reportProgress?: ProgressReporter, email?: string, orgName?: string) {
  const jobId = crypto.randomUUID();
  const metadata = {
    context: {
      email: email ?? "mcp-user@orangepro.ai",
      orgName: orgName ?? "orangepro",
      jobId
    },
    app_domain: appDomain ?? ""
  };
  const init = await client.post<JobInitResponse>("/script-generation/initialize", { metadata });
  const resolvedJobId = init.jobId ?? init.job_id ?? jobId;

  await client.post<unknown>(`/script-generation/${encodeURIComponent(resolvedJobId)}/submit`, {
    source_job_id: sourceJobId,
    framework: framework ?? "playwright",
    ...(testCaseIds ? { test_case_ids: testCaseIds } : {}),
    metadata,
    app_domain: appDomain ?? ""
  });

  const startTime = Date.now();
  const deadline = startTime + GENERATION_DEADLINE_MS;
  let lastStatus = "IN_PROGRESS";

  while (Date.now() < deadline) {
    const elapsed = Date.now() - startTime;
    reportProgress?.(elapsed, GENERATION_DEADLINE_MS);

    const status = await client.get<JobStatusResponse>(`/script-generation/${encodeURIComponent(resolvedJobId)}/status`);
    lastStatus = normalizeJobStatus(status.status);

    if (lastStatus === "COMPLETED") {
      reportProgress?.(GENERATION_DEADLINE_MS, GENERATION_DEADLINE_MS);
      const results = await client.get<ScriptJobResultsResponse>(`/script-generation/${encodeURIComponent(resolvedJobId)}/scripts`);
      return {
        job_id: resolvedJobId,
        status: "COMPLETED",
        scripts: results.scripts ?? []
      };
    }

    if (lastStatus === "FAILED") {
      return { job_id: resolvedJobId, status: "FAILED", scripts: [] as GeneratedScript[] };
    }

    await sleep(GENERATION_POLL_INTERVAL_MS);
  }

  return { job_id: resolvedJobId, status: lastStatus, scripts: [] as GeneratedScript[] };
}

async function getJobResults(client: OrangeProClient, jobId: string): Promise<JobResultsResponse> {
  const raw = await client.get<{
    jobId?: string;
    status?: string;
    data?: { all_test_cases?: TestCase[]; count?: number };
    test_cases?: TestCase[];
    total?: number;
  }>(`/test-generation/${encodeURIComponent(jobId)}/results?format=json`);

  const testCases = raw.data?.all_test_cases ?? raw.test_cases ?? [];
  return {
    test_cases: testCases,
    total: raw.data?.count ?? raw.total ?? testCases.length
  };
}

function normalizeJobStatus(status: string): string {
  return status.toUpperCase();
}

function isCoverageLevel(level: string, accepted: string[]): boolean {
  return accepted.includes(level.toLowerCase());
}

function deriveTrendDirection(trend: CoverageTrendResponse | null): "stable" | "improving" | "declining" {
  if (!trend?.trend || trend.trend.length < 2) {
    return "stable";
  }
  const recent = trend.trend[trend.trend.length - 1]?.test_cases ?? 0;
  const earlier = trend.trend[0]?.test_cases ?? 0;
  if (recent > earlier + 5) return "improving";
  if (recent < earlier - 5) return "declining";
  return "stable";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
