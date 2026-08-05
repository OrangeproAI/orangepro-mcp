/**
 * OrangePro Remote MCP Server — Cloudflare Worker
 *
 * Exposes the OrangePro platform API tools over HTTP using the
 * MCP Streamable HTTP transport. No filesystem, no tree-sitter, no
 * local analysis — only the tools that call api.orangepro.ai.
 *
 * Required env vars (set in Cloudflare dashboard or wrangler.toml secrets):
 *   ORANGEPRO_API_BASE_URL  — defaults to https://api.orangepro.ai/api/v1
 *   ORANGEPRO_API_KEY       — per-request override via X-OrangePro-Api-Key header
 *   ORANGEPRO_TENANT_ID     — per-request override via X-OrangePro-Tenant-Id header
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// ── Types ────────────────────────────────────────────────────────────────────

interface Env {
  ORANGEPRO_API_BASE_URL?: string;
  ORANGEPRO_API_KEY?: string;
  ORANGEPRO_TENANT_ID?: string;
}

interface OrangeProConfig {
  apiBaseUrl: string;
  apiKey?: string;
  tenantId?: string;
  timeoutMs: number;
}

// ── API Client ───────────────────────────────────────────────────────────────

class OrangeProApiError extends Error {
  constructor(
    message: string,
    public readonly status: number,
    public readonly body: string
  ) {
    super(message);
    this.name = "OrangeProApiError";
  }
}

class OrangeProClient {
  constructor(private readonly config: OrangeProConfig) {}

  async get<T>(path: string): Promise<T> {
    return this.request<T>("GET", path);
  }

  async post<T>(path: string, body?: unknown): Promise<T> {
    return this.request<T>("POST", path, body);
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs);
    const url = `${this.config.apiBaseUrl}${path}`;
    try {
      const headers: Record<string, string> = { Accept: "application/json" };
      if (body !== undefined) headers["Content-Type"] = "application/json";
      if (this.config.apiKey) {
        headers["Authorization"] = `Bearer ${this.config.apiKey}`;
        headers["X-API-Key"] = this.config.apiKey;
      }
      const response = await fetch(url, {
        method,
        signal: controller.signal,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
      const text = await response.text();
      if (!response.ok) {
        throw new OrangeProApiError(
          `OrangePro API ${method} ${path} failed with HTTP ${response.status}`,
          response.status,
          text
        );
      }
      return text ? (JSON.parse(text) as T) : ({} as T);
    } finally {
      clearTimeout(timeout);
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function asText(payload: unknown) {
  return {
    content: [
      {
        type: "text" as const,
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2),
      },
    ],
  };
}

function asError(error: unknown) {
  const message =
    error instanceof OrangeProApiError
      ? `OrangePro API error (HTTP ${error.status}): ${error.message}`
      : error instanceof Error
        ? error.message
        : String(error);
  return { content: [{ type: "text" as const, text: message }], isError: true };
}

function agentPlatformPath(tenantId: string, suffix: string): string {
  return `/admin/tenants/${encodeURIComponent(tenantId)}/agent-platform${suffix}`;
}

function resolveTenant(inputTenantId: string | undefined, config: OrangeProConfig): string {
  const tenantId = inputTenantId || config.tenantId;
  if (!tenantId) {
    throw new Error("tenant_id is required. Pass tenant_id or set ORANGEPRO_TENANT_ID.");
  }
  return tenantId;
}

function isCoverageLevel(level: string, accepted: string[]): boolean {
  return accepted.includes(level.toLowerCase());
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const GENERATION_DEADLINE_MS = 25_000; // Stay under Cloudflare's 30s CPU limit
const GENERATION_POLL_INTERVAL_MS = 3_000;

// ── MCP Server Factory ───────────────────────────────────────────────────────

function createMcpServer(env: Env, requestHeaders: Headers): McpServer {
  // Allow per-request API key override via headers
  const apiKey =
    requestHeaders.get("x-orangepro-api-key") ||
    requestHeaders.get("authorization")?.replace(/^Bearer\s+/i, "") ||
    env.ORANGEPRO_API_KEY;

  const tenantId =
    requestHeaders.get("x-orangepro-tenant-id") || env.ORANGEPRO_TENANT_ID;

  const apiBaseUrl = (env.ORANGEPRO_API_BASE_URL || "https://api.orangepro.ai/api/v1").replace(/\/+$/, "");

  const config: OrangeProConfig = {
    apiBaseUrl,
    apiKey,
    tenantId,
    timeoutMs: 25_000,
  };

  const client = new OrangeProClient(config);

  const server = new McpServer({
    name: "orangepro-remote",
    version: "0.1.0",
  });

  const TenantInput = {
    tenant_id: z
      .string()
      .min(1)
      .optional()
      .describe("OrangePro tenant id. Defaults to ORANGEPRO_TENANT_ID env var."),
  };

  // ── Agent Platform Tools ────────────────────────────────────────────────────

  server.registerTool(
    "orangepro_list_agents",
    {
      title: "List OrangePro agents",
      description:
        "List all OrangePro agents configured for a tenant. Returns agent_id, name, status, source config, and last run time. Use this first to discover available agents before running or inspecting them.",
      inputSchema: { ...TenantInput },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        const tid = resolveTenant(input.tenant_id, config);
        const agents = await client.get<unknown[]>(agentPlatformPath(tid, "/agents"));
        return asText({ tenant_id: tid, agents });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_get_agent",
    {
      title: "Get OrangePro agent detail",
      description:
        "Get full configuration and status for a specific OrangePro agent. Returns source config, schedule, last run summary, and agent metadata.",
      inputSchema: {
        ...TenantInput,
        agent_id: z.string().min(1).describe("The agent_id to retrieve. Get this from orangepro_list_agents."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        const tid = resolveTenant(input.tenant_id, config);
        const agent = await client.get<unknown>(
          agentPlatformPath(tid, `/agents/${encodeURIComponent(input.agent_id)}`)
        );
        return asText(agent);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_run_agent",
    {
      title: "Run OrangePro agent",
      description:
        "Trigger an immediate run for an OrangePro agent. Returns run_id and initial status. Use orangepro_list_agent_runs to check completion.",
      inputSchema: {
        ...TenantInput,
        agent_id: z.string().min(1).describe("The agent_id to run. Get this from orangepro_list_agents."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const tid = resolveTenant(input.tenant_id, config);
        const run = await client.post<unknown>(
          agentPlatformPath(tid, `/agents/${encodeURIComponent(input.agent_id)}/run`)
        );
        return asText({ tenant_id: tid, agent_id: input.agent_id, run });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_list_agent_runs",
    {
      title: "List OrangePro agent runs",
      description:
        "List recent runs for a specific OrangePro agent. Returns run_id, status, start time, duration, and records processed.",
      inputSchema: {
        ...TenantInput,
        agent_id: z.string().min(1).describe("The agent_id to list runs for."),
        limit: z.number().int().min(1).max(200).optional().describe("Max number of runs to return. Default 20."),
        offset: z.number().int().min(0).optional().describe("Number of runs to skip for pagination."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        const tid = resolveTenant(input.tenant_id, config);
        const params = new URLSearchParams();
        if (input.limit !== undefined) params.set("limit", String(input.limit));
        if (input.offset !== undefined) params.set("offset", String(input.offset));
        const suffix = params.size ? `?${params.toString()}` : "";
        const runs = await client.get<unknown[]>(
          agentPlatformPath(tid, `/agents/${encodeURIComponent(input.agent_id)}/runs${suffix}`)
        );
        return asText({ tenant_id: tid, agent_id: input.agent_id, runs });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_get_agent_logs",
    {
      title: "Get OrangePro agent logs",
      description:
        "Read recent log lines for an OrangePro agent. Use to debug failures or verify what an agent did during a run.",
      inputSchema: {
        ...TenantInput,
        agent_id: z.string().min(1).describe("The agent_id to get logs for."),
        limit: z.number().int().min(1).max(500).optional().describe("Max number of log lines to return. Default 100."),
        offset: z.number().int().min(0).optional().describe("Number of log lines to skip for pagination."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        const tid = resolveTenant(input.tenant_id, config);
        const params = new URLSearchParams();
        if (input.limit !== undefined) params.set("limit", String(input.limit));
        if (input.offset !== undefined) params.set("offset", String(input.offset));
        const suffix = params.size ? `?${params.toString()}` : "";
        const logs = await client.get<unknown>(
          agentPlatformPath(tid, `/agents/${encodeURIComponent(input.agent_id)}/logs${suffix}`)
        );
        return asText(logs);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_get_agent_health",
    {
      title: "Get OrangePro agent health",
      description:
        "Read health and connectivity status for an OrangePro agent. Use to diagnose why an agent is failing.",
      inputSchema: {
        ...TenantInput,
        agent_id: z.string().min(1).describe("The agent_id to check health for."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        const tid = resolveTenant(input.tenant_id, config);
        const health = await client.get<unknown>(
          agentPlatformPath(tid, `/agents/${encodeURIComponent(input.agent_id)}/health`)
        );
        return asText(health);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_resolve_story",
    {
      title: "Resolve story in OrangePro KG",
      description:
        "Resolve a user story, requirement, or feature description against the OrangePro Knowledge Graph. Returns grounded entities, matched concepts, and confidence scores.",
      inputSchema: {
        ...TenantInput,
        story_text: z.string().min(1).max(20000).describe("The user story, requirement, or feature text to resolve against the KG."),
        input_kind: z.string().optional().describe("Input type: 'story', 'requirement', or 'feature'. Defaults to 'story'."),
        source_type: z.string().optional().describe("Source type: 'manual', 'jira', or 'github'. Defaults to 'manual'."),
        top_k: z.number().int().min(1).max(20).optional().describe("Number of top matches to return. Defaults to 5."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const tid = resolveTenant(input.tenant_id, config);
        const result = await client.post<unknown>("/kg/grounding/resolve", {
          story_text: input.story_text,
          input_kind: input.input_kind || "story",
          source_type: input.source_type || "manual",
          top_k: input.top_k || 5,
        });
        return asText({ tenant_id: tid, result });
      } catch (error) {
        return asError(error);
      }
    }
  );

  // ── QA Intelligence Tools ───────────────────────────────────────────────────

  server.registerTool(
    "get_coverage_gaps",
    {
      title: "Get OrangePro coverage gaps",
      description:
        "Find application areas lacking test coverage. Returns a heatmap of critical (red), partial (yellow), and healthy (green) coverage zones with test counts.",
      inputSchema: {
        area: z.string().optional().describe("Filter results to categories matching this string (case-insensitive)."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        const heatmap = await client.get<{
          coverage_score: number;
          total_categories: number;
          covered_categories: number;
          zones?: Array<{ category: string; coverage_level: string; test_count: number; last_run?: string }>;
        }>("/analytics/coverage-heatmap");
        const zones = input.area
          ? (heatmap.zones ?? []).filter((z) => z.category.toLowerCase().includes(input.area!.toLowerCase()))
          : (heatmap.zones ?? []);
        const gaps = zones.filter((z) => isCoverageLevel(z.coverage_level, ["red", "critical", "yellow", "partial"]));
        return asText({
          coverage_score: heatmap.coverage_score,
          total_categories: heatmap.total_categories,
          covered_categories: heatmap.covered_categories,
          gaps: gaps.map((z) => ({
            category: z.category,
            coverage_level: z.coverage_level,
            test_count: z.test_count,
            last_run: z.last_run,
          })),
          total_gaps: gaps.length,
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "convert_bug_to_tests",
    {
      title: "Convert bug to regression tests",
      description:
        "Generate regression tests from a bug report or incident description. Returns test cases with steps, expected results, and priority. Use to prevent the same bug from shipping again.",
      inputSchema: {
        bug_description: z.string().min(1).describe("Bug report, incident description, or defect summary."),
        severity: z.enum(["critical", "high", "medium", "low"]).optional().describe("Bug severity. Affects test priority weighting."),
        affected_area: z.string().optional().describe("Application area affected (e.g., 'checkout', 'auth', 'payments')."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      try {
        const content = [
          input.affected_area ? `Affected area: ${input.affected_area}.` : "",
          input.severity ? `Severity: ${input.severity}.` : "",
          input.bug_description,
        ].filter(Boolean).join(" ");
        const analyzeRes = await client.post<{ session_id: string }>("/bug-to-test/analyze", {
          input_type: "plain_text",
          content,
        });
        const generateRes = await client.post<{
          test_cases?: Array<{ title: string; steps: string[]; expected_result: string; priority?: string }>;
        }>("/bug-to-test/generate", {
          session_id: analyzeRes.session_id,
          generate_script: false,
        });
        const tests = generateRes.test_cases ?? [];
        return asText({
          bug_summary: input.bug_description.slice(0, 200),
          test_cases: tests.map((t) => ({
            title: t.title,
            steps: t.steps,
            expected_result: t.expected_result,
            priority: t.priority ?? "medium",
          })),
          total_tests: tests.length,
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "build_regression_pack",
    {
      title: "Build regression test pack",
      description:
        "Build a regression test pack for a specific application area. Returns a set of tests designed to catch regressions in that area.",
      inputSchema: {
        area: z.string().min(1).describe("Application area to build regression tests for (e.g., 'checkout', 'authentication', 'payments')."),
        context: z.string().optional().describe("Additional context about the area or recent changes."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      try {
        const bugDescription = input.context
          ? `Regression risk area: ${input.area}. Context: ${input.context}`
          : `Regression risk area: ${input.area}. Build comprehensive regression tests to ensure this area remains stable.`;
        const analyzeRes = await client.post<{ session_id: string }>("/bug-to-test/analyze", {
          input_type: "plain_text",
          content: bugDescription,
        });
        const generateRes = await client.post<{
          test_cases?: Array<{ title: string; steps: string[]; expected_result: string; priority?: string }>;
        }>("/bug-to-test/generate", {
          session_id: analyzeRes.session_id,
          generate_script: false,
        });
        const tests = generateRes.test_cases ?? [];
        return asText({
          pack_name: `Regression: ${input.area}`,
          area: input.area,
          tests: tests.map((t) => ({
            title: t.title,
            steps: t.steps,
            expected_result: t.expected_result,
            priority: t.priority ?? "medium",
          })),
          total_tests: tests.length,
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "explain_quality_risk",
    {
      title: "Explain quality risk",
      description:
        "Get a quality risk assessment using coverage heatmap, execution history, and 30-day trend data. Use to answer 'are we safe to ship?' or 'what areas need more tests?'",
      inputSchema: {
        area: z.string().optional().describe("Focus the risk assessment on categories matching this string."),
        question: z.string().optional().describe("Specific quality question to answer (e.g., 'Is the checkout flow well-tested?')."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async (input) => {
      try {
        const [dashboard, heatmap, trend] = await Promise.all([
          client.get<{ total_test_cases: number; total_executions: number; completed_jobs: number; failed_jobs: number }>("/analytics/dashboard").catch(() => null),
          client.get<{ coverage_score: number; total_categories: number; covered_categories: number; zones?: Array<{ category: string; coverage_level: string; test_count: number }> }>("/analytics/coverage-heatmap").catch(() => null),
          client.get<{ trend?: Array<{ test_cases: number }> }>("/analytics/coverage-trend?days=30").catch(() => null),
        ]);
        const riskAreas: Array<{ area: string; risk_level: string; reason: string }> = [];
        if (heatmap?.zones) {
          const zones = input.area
            ? heatmap.zones.filter((z) => z.category.toLowerCase().includes(input.area!.toLowerCase()))
            : heatmap.zones;
          for (const zone of zones) {
            if (isCoverageLevel(zone.coverage_level, ["red", "critical"])) {
              riskAreas.push({ area: zone.category, risk_level: "high", reason: `Critical coverage gap — only ${zone.test_count} test(s)` });
            } else if (isCoverageLevel(zone.coverage_level, ["yellow", "partial"])) {
              riskAreas.push({ area: zone.category, risk_level: "medium", reason: `Partial coverage — ${zone.test_count} test(s), more needed` });
            }
          }
        }
        let trendDirection = "stable";
        if (trend?.trend && trend.trend.length >= 2) {
          const recent = trend.trend[trend.trend.length - 1]?.test_cases ?? 0;
          const earlier = trend.trend[0]?.test_cases ?? 0;
          if (recent > earlier + 5) trendDirection = "improving";
          else if (recent < earlier - 5) trendDirection = "declining";
        }
        const parts: string[] = [];
        if (input.question) parts.push(`Regarding "${input.question}":\n`);
        if (heatmap) parts.push(`Overall coverage score: ${heatmap.coverage_score}% (${heatmap.covered_categories}/${heatmap.total_categories} categories).`);
        if (dashboard) parts.push(`Project has ${dashboard.total_test_cases} test cases across ${dashboard.total_executions} executions. ${dashboard.completed_jobs} jobs completed, ${dashboard.failed_jobs} failed.`);
        parts.push(`Coverage trend (30 days): ${trendDirection}.`);
        const highRisk = riskAreas.filter((a) => a.risk_level === "high");
        const medRisk = riskAreas.filter((a) => a.risk_level === "medium");
        if (highRisk.length > 0) parts.push(`\nHigh-risk areas (${highRisk.length}):\n${highRisk.map((a) => `  - ${a.area}: ${a.reason}`).join("\n")}`);
        if (medRisk.length > 0) parts.push(`\nMedium-risk areas (${medRisk.length}):\n${medRisk.map((a) => `  - ${a.area}: ${a.reason}`).join("\n")}`);
        if (riskAreas.length === 0) parts.push("\nNo critical risk areas detected. Coverage looks healthy.");
        return asText({ risk_areas: riskAreas, trend_direction: trendDirection, summary: parts.join("\n") });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "generate_missing_coverage",
    {
      title: "Generate missing coverage",
      description:
        "Generate test cases for a user story or feature that needs better coverage. Returns categorized test cases with steps and expected results.",
      inputSchema: {
        user_story: z.string().min(1).describe("User story, feature description, or coverage gap to generate tests for."),
        app_context: z.string().optional().describe("Application overview or technical context to improve test relevance."),
        app_domain: z.string().optional().describe("Application domain (e.g., 'E-Commerce', 'Banking', 'Healthcare')."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      try {
        const jobId = crypto.randomUUID();
        const metadata = { context: { email: "mcp-user@orangepro.ai", orgName: "orangepro", jobId }, app_domain: input.app_domain ?? "" };
        const init = await client.post<{ jobId?: string; job_id?: string }>("/test-generation/initialize", { metadata });
        const resolvedJobId = init.jobId ?? init.job_id ?? jobId;
        await client.post<unknown>(`/test-generation/${encodeURIComponent(resolvedJobId)}/submit`, {
          userStories: { source: { type: "MANUAL", content: input.user_story } },
          applicationOverview: { source: { type: "MANUAL", content: input.app_context ?? "" } },
          metadata,
          app_domain: input.app_domain ?? "",
        });
        const deadline = Date.now() + GENERATION_DEADLINE_MS;
        let lastStatus = "IN_PROGRESS";
        while (Date.now() < deadline) {
          const status = await client.get<{ status: string }>(`/test-generation/${encodeURIComponent(resolvedJobId)}/status`);
          lastStatus = status.status.toUpperCase();
          if (lastStatus === "COMPLETED") {
            const raw = await client.get<{ data?: { all_test_cases?: unknown[]; count?: number }; test_cases?: unknown[]; total?: number }>(`/test-generation/${encodeURIComponent(resolvedJobId)}/results?format=json`);
            const testCases = raw.data?.all_test_cases ?? raw.test_cases ?? [];
            return asText({ job_id: resolvedJobId, status: "COMPLETED", test_cases: testCases, total: raw.data?.count ?? raw.total ?? testCases.length });
          }
          if (lastStatus === "FAILED") {
            return asText({ job_id: resolvedJobId, status: "FAILED", test_cases: [], total: 0 });
          }
          await sleep(GENERATION_POLL_INTERVAL_MS);
        }
        return asText({ job_id: resolvedJobId, status: lastStatus, test_cases: [], total: 0, note: "Generation is still in progress. Use the job_id to check status later." });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "analyze_pr_risk",
    {
      title: "Analyze PR risk",
      description:
        "Analyze a pull request for quality risk. Returns overall risk score (0-100), risk drivers, impacted categories, coverage gaps, and recommended tests to run. Use before merging to catch regressions.",
      inputSchema: {
        pr_title: z.string().min(1).describe("Pull request title."),
        pr_description: z.string().optional().describe("Pull request body or description of changes."),
        changed_files: z.array(z.string()).optional().describe("List of changed file paths (e.g., ['src/checkout.ts', 'src/payment.ts'])."),
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true },
    },
    async (input) => {
      try {
        const data = await client.post<unknown>("/analytics/pr-risk", {
          pr_title: input.pr_title,
          pr_description: input.pr_description ?? "",
          changed_files: input.changed_files ?? [],
        });
        return asText(data);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "analyze_release_readiness",
    {
      title: "Analyze release readiness",
      description:
        "Get a tenant-wide release readiness assessment. Returns a ship/review/block recommendation with confidence score, coverage analysis, risk areas, and recommended actions.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false },
    },
    async () => {
      try {
        const data = await client.get<unknown>("/analytics/release-readiness");
        return asText(data);
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "generate_test_scripts",
    {
      title: "Generate executable test scripts",
      description:
        "Convert test cases from a completed test generation job into executable scripts for Playwright, Cypress, Selenium, or Puppeteer.",
      inputSchema: {
        source_job_id: z.string().min(1).describe("Job ID from a completed test generation run (from generate_missing_coverage output)."),
        framework: z.enum(["playwright", "cypress", "selenium", "puppeteer", "all"]).optional().describe("Target test framework. Defaults to playwright."),
        test_case_ids: z.array(z.string()).optional().describe("Specific test case IDs to convert. If omitted, converts all."),
        app_domain: z.string().optional().describe("Application domain for context (e.g., 'E-Commerce')."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false },
    },
    async (input) => {
      try {
        const jobId = crypto.randomUUID();
        const metadata = { context: { email: "mcp-user@orangepro.ai", orgName: "orangepro", jobId }, app_domain: input.app_domain ?? "" };
        const init = await client.post<{ jobId?: string; job_id?: string }>("/script-generation/initialize", { metadata });
        const resolvedJobId = init.jobId ?? init.job_id ?? jobId;
        await client.post<unknown>(`/script-generation/${encodeURIComponent(resolvedJobId)}/submit`, {
          source_job_id: input.source_job_id,
          framework: input.framework ?? "playwright",
          ...(input.test_case_ids ? { test_case_ids: input.test_case_ids } : {}),
          metadata,
          app_domain: input.app_domain ?? "",
        });
        const deadline = Date.now() + GENERATION_DEADLINE_MS;
        let lastStatus = "IN_PROGRESS";
        while (Date.now() < deadline) {
          const status = await client.get<{ status: string }>(`/script-generation/${encodeURIComponent(resolvedJobId)}/status`);
          lastStatus = status.status.toUpperCase();
          if (lastStatus === "COMPLETED") {
            const results = await client.get<{ scripts?: Array<{ filename: string; framework: string }> }>(`/script-generation/${encodeURIComponent(resolvedJobId)}/scripts`);
            return asText({ job_id: resolvedJobId, status: "COMPLETED", scripts: results.scripts ?? [], total_scripts: results.scripts?.length ?? 0 });
          }
          if (lastStatus === "FAILED") {
            return asText({ job_id: resolvedJobId, status: "FAILED", scripts: [] });
          }
          await sleep(GENERATION_POLL_INTERVAL_MS);
        }
        return asText({ job_id: resolvedJobId, status: lastStatus, scripts: [], note: "Script generation still in progress. Check back with the job_id." });
      } catch (error) {
        return asError(error);
      }
    }
  );

  return server;
}

// ── Cloudflare Worker Entry Point ─────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);

    // Health check
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", server: "orangepro-remote-mcp", version: "0.1.0" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }

    // MCP endpoint — stateless Streamable HTTP (Web Standards transport)
    if (url.pathname === "/mcp") {
      const server = createMcpServer(env, request.headers);
      const transport = new WebStandardStreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless mode
      });
      await server.connect(transport);
      return transport.handleRequest(request);
    }

    return new Response("Not found", { status: 404 });
  },
};
