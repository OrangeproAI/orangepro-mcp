import { describe, expect, it } from "vitest";
import { createOrangeProQaToolHandlers } from "../src/qaTools.js";

class ScriptFakeClient {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];

  async get(path: string): Promise<unknown> {
    this.calls.push({ method: "GET", path });
    if (path.endsWith("/status")) {
      return { status: "COMPLETED" };
    }
    if (path.endsWith("/scripts")) {
      return {
        scripts: [
          { filename: "checkout.spec.ts", content: "import { test } from '@playwright/test';\ntest('checkout', async () => {});", framework: "playwright" }
        ]
      };
    }
    throw new Error(`Unexpected GET ${path}`);
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method: "POST", path, body });
    if (path === "/script-generation/initialize") {
      return { jobId: "script-job-1", status: "INITIALIZED" };
    }
    if (path.includes("/submit")) {
      return { status: "ok" };
    }
    throw new Error(`Unexpected POST ${path}`);
  }
}

class FailingClient {
  async get(): Promise<unknown> { throw new Error("connection refused"); }
  async post(): Promise<unknown> { throw new Error("connection refused"); }
}

class FakeClient {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];

  async get(path: string): Promise<unknown> {
    this.calls.push({ method: "GET", path });
    if (path === "/analytics/coverage-heatmap") {
      return {
        coverage_score: 65,
        total_categories: 3,
        covered_categories: 1,
        zones: [
          { category: "Authentication", coverage_level: "green", test_count: 12 },
          { category: "Payments", coverage_level: "red", test_count: 0 },
          { category: "Checkout", coverage_level: "yellow", test_count: 3 }
        ],
        summary: { red: 1, yellow: 1, green: 1 }
      };
    }
    if (path === "/analytics/dashboard") {
      return {
        total_test_cases: 150,
        total_executions: 20,
        completed_jobs: 18,
        failed_jobs: 2,
        in_progress_jobs: 0,
        recent_executions: []
      };
    }
    if (path === "/analytics/coverage-trend?days=30") {
      return {
        days: 30,
        trend: [
          { date: "2026-03-01", test_cases: 60 },
          { date: "2026-04-01", test_cases: 65 }
        ]
      };
    }
    if (path === "/analytics/release-readiness") {
      return {
        recommendation: "review",
        confidence_score: 55.2,
        scope: "tenant",
        summary: { total_test_cases: 100, total_executions: 15, completed_jobs: 13, failed_jobs: 2, in_progress_jobs: 0 },
        coverage: { score: 65, total_categories: 10, covered: 6, partial: 2, uncovered: 2, red_zones: ["Payments"], trend_direction: "stable" },
        quality: { feedback_score: 0.8, thumbs_up: 40, thumbs_down: 10, no_feedback: 50, dedup_rate: 0.12, avg_test_cases_per_job: 6.7 },
        scripts: { total: 30, ready: 25, failed: 5, coverage_percent: 60, by_framework: { playwright: 20 } },
        risk_areas: [{ category: "Payments", test_count: 1, coverage_level: "red", reason: "Only 1 test" }],
        recent_failures: [{ job_id: "j1", job_name: "Sprint 5", status: "FAILED", test_cases_count: 8, created_at: "2026-04-01" }],
        recommended_actions: [{ action: "Generate tests for Payments", priority: "high" }]
      };
    }
    if (path.endsWith("/status")) {
      return { status: "COMPLETED" };
    }
    if (path.endsWith("/results?format=json")) {
      return {
        jobId: "job-123",
        status: "COMPLETED",
        data: {
          all_test_cases: [
            {
              title: "Login with valid credentials",
              category: "Authentication",
              steps: ["Enter email", "Enter password", "Click login"],
              expected_result: "User is logged in"
            }
          ],
          count: 1
        }
      };
    }
    throw new Error(`Unexpected GET ${path}`);
  }

  async post(path: string, body?: unknown): Promise<unknown> {
    this.calls.push({ method: "POST", path, body });
    if (path === "/bug-to-test/analyze") {
      return {
        analysis: {
          root_cause: "Missing null check in payment processor",
          affected_areas: ["payments", "checkout"],
          risk_level: "high"
        },
        session_id: "sess-mock-123",
        source_reference: null
      };
    }
    if (path === "/bug-to-test/generate") {
      return {
        job_id: "job-mock-456",
        test_cases: [
          {
            title: "Verify null payment handling",
            steps: ["Navigate to checkout", "Submit with empty payment"],
            expected_result: "Graceful error message shown",
            priority: "high"
          }
        ],
        scripts: []
      };
    }
    if (path === "/analytics/test-impact-radar") {
      return {
        overall_risk: 65,
        recommendation: "moderate_risk",
        risk_drivers: [{ driver: "category_spread", score: 20, detail: "2 areas" }],
        impacted_categories: ["Auth", "Payments"],
        similar_bugs: [{ bug_id: "b1", summary: "Login crash", affected_feature_area: "Auth", relevance_score: 0.72, is_regression: false, severity: "high" }],
        coverage_gaps: [{ category: "Auth", test_count: 1, gap_severity: "high" }],
        recommended_tests: [{ title: "Verify login", category: "Auth", source: "existing", job_id: "j1" }],
        recommended_generations: [{ category: "Auth", reason: "Only 1 test", suggested_count: 5 }],
        pr_context: { title: "Fix auth", categories_matched: 2, total_historical_bugs: 50 }
      };
    }
    if (path === "/test-generation/initialize") {
      return { job_id: "job-123", status: "INITIALIZED" };
    }
    if (path === "/test-generation/job-123/submit") {
      return {};
    }
    throw new Error(`Unexpected POST ${path}`);
  }
}

describe("legacy QA MCP handlers", () => {
  it("gets coverage gaps from analytics heatmap", async () => {
    const client = new FakeClient();
    const handlers = createOrangeProQaToolHandlers(client as never);

    const result = await handlers.getCoverageGaps({ area: "pay" });
    const payload = JSON.parse(result.content[0].text);

    expect(client.calls[0]).toEqual({ method: "GET", path: "/analytics/coverage-heatmap" });
    expect(payload.gaps_by_severity.red).toBe(1);
    expect(payload.zones).toHaveLength(1);
    expect(payload.summary).toContain("Critical gaps");
  });

  it("converts a bug into regression tests", async () => {
    const client = new FakeClient();
    const handlers = createOrangeProQaToolHandlers(client as never);

    const result = await handlers.convertBugToTests({ bug_description: "Payment fails", severity: "high" });
    const payload = JSON.parse(result.content[0].text);

    expect(client.calls[0]).toMatchObject({ method: "POST", path: "/bug-to-test/analyze" });
    expect(client.calls[1]).toMatchObject({ method: "POST", path: "/bug-to-test/generate" });
    expect(payload.total_tests).toBe(1);
    expect(payload.regression_tests[0].priority).toBe("high");
  });

  it("builds a regression pack through the bug-to-test pipeline", async () => {
    const client = new FakeClient();
    const handlers = createOrangeProQaToolHandlers(client as never);

    const result = await handlers.buildRegressionPack({ area: "checkout", context: "FX checkout changed" });
    const payload = JSON.parse(result.content[0].text);

    expect(payload.pack_name).toBe("Regression: checkout");
    expect(payload.total_tests).toBe(1);
    expect(String((client.calls[0].body as { content: string }).content)).toContain("FX checkout changed");
  });

  it("explains quality risk from dashboard, heatmap, and trend", async () => {
    const client = new FakeClient();
    const handlers = createOrangeProQaToolHandlers(client as never);

    const result = await handlers.explainQualityRisk({ question: "Can we ship?" });
    const payload = JSON.parse(result.content[0].text);

    expect(client.calls.map((call) => call.path)).toEqual([
      "/analytics/dashboard",
      "/analytics/coverage-heatmap",
      "/analytics/coverage-trend?days=30"
    ]);
    expect(payload.risk_areas).toHaveLength(2);
    expect(payload.summary).toContain("Can we ship?");
  });

  it("generates missing coverage through initialize submit poll results", async () => {
    const client = new FakeClient();
    const handlers = createOrangeProQaToolHandlers(client as never);

    const result = await handlers.generateMissingCoverage({ user_story: "As a user I can log in", app_domain: "E-Commerce" });
    const payload = JSON.parse(result.content[0].text);

    expect(client.calls.map((call) => call.path)).toEqual([
      "/test-generation/initialize",
      "/test-generation/job-123/submit",
      "/test-generation/job-123/status",
      "/test-generation/job-123/results?format=json"
    ]);
    expect(payload.status).toBe("COMPLETED");
    expect(payload.total_generated).toBe(1);
  });

  it("analyzes PR risk through test impact radar", async () => {
    const client = new FakeClient();
    const handlers = createOrangeProQaToolHandlers(client as never);

    const result = await handlers.analyzePrRisk({ pr_title: "Fix auth", pr_description: "desc", changed_files: ["src/auth.ts"] });
    const payload = JSON.parse(result.content[0].text);

    expect(client.calls[0]).toEqual({
      method: "POST",
      path: "/analytics/test-impact-radar",
      body: { pr_title: "Fix auth", pr_description: "desc", changed_files: ["src/auth.ts"] }
    });
    expect(payload.overall_risk).toBe(65);
    expect(payload.summary).toContain("MODERATE RISK");
  });

  it("analyzes release readiness", async () => {
    const client = new FakeClient();
    const handlers = createOrangeProQaToolHandlers(client as never);

    const result = await handlers.analyzeReleaseReadiness();
    const payload = JSON.parse(result.content[0].text);

    expect(client.calls[0]).toEqual({ method: "GET", path: "/analytics/release-readiness" });
    expect(payload.recommendation).toBe("review");
    expect(payload.summary).toContain("tenant-wide");
  });
});

describe("generate_test_scripts (TDD)", () => {
  it("generates test scripts through initialize submit poll scripts", async () => {
    const client = new ScriptFakeClient();
    const handlers = createOrangeProQaToolHandlers(client as never);

    const result = await handlers.generateTestScripts({
      source_job_id: "completed-tg-job-1",
      framework: "playwright"
    });
    const payload = JSON.parse(result.content[0].text);

    expect(client.calls.map((c) => c.method + " " + c.path.replace(/\/script-generation\/script-job-1/, "/script-generation/{id}"))).toEqual([
      "POST /script-generation/initialize",
      "POST /script-generation/{id}/submit",
      "GET /script-generation/{id}/status",
      "GET /script-generation/{id}/scripts"
    ]);
    expect(payload.status).toBe("COMPLETED");
    expect(payload.scripts).toHaveLength(1);
    expect(payload.scripts[0].filename).toBe("checkout.spec.ts");
    expect(payload.scripts[0].framework).toBe("playwright");
  });

  it("returns isError when script generation fails", async () => {
    const client = new FailingClient();
    const handlers = createOrangeProQaToolHandlers(client as never);

    const result = await handlers.generateTestScripts({
      source_job_id: "nonexistent-job"
    });

    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("connection refused");
  });
});
