/**
 * OrangePro Remote MCP Server — Cloudflare Worker
 *
 * Exposes OrangePro platform API tools over HTTP using the
 * MCP Streamable HTTP transport. No filesystem, no tree-sitter, no
 * local analysis — only the tools that call the OrangePro platform API.
 *
 * Auth: pass ORANGEPRO_API_KEY as X-Api-Key header or Authorization: Bearer <key>
 * The API key encodes tenant identity — no separate tenant_id needed for most routes.
 *
 * Required env vars:
 *   ORANGEPRO_API_BASE_URL  — defaults to https://opro-api-prod-candidate.onrender.com
 *   ORANGEPRO_API_KEY       — per-request override via X-OrangePro-Api-Key header
 *   ORANGEPRO_TENANT_ID     — required for agent platform routes (admin/tenants/{id}/...)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { z } from "zod";

// ── Types ─────────────────────────────────────────────────────────────────────

interface Env {
  ORANGEPRO_API_BASE_URL?: string;
  ORANGEPRO_API_KEY?: string;
  ORANGEPRO_TENANT_ID?: string;
}

// ── API Client ────────────────────────────────────────────────────────────────

function makeApiClient(env: Env, requestHeaders: Headers) {
  const baseUrl = (
    requestHeaders.get("x-orangepro-api-base-url") ||
    env.ORANGEPRO_API_BASE_URL ||
    "https://opro-api-prod-candidate.onrender.com"
  ).replace(/\/$/, "");

  const apiKey =
    requestHeaders.get("x-orangepro-api-key") ||
    env.ORANGEPRO_API_KEY ||
    "";

  const tenantId =
    requestHeaders.get("x-orangepro-tenant-id") ||
    env.ORANGEPRO_TENANT_ID ||
    "";

  async function call(
    method: "GET" | "POST" | "PATCH",
    path: string,
    body?: unknown
  ): Promise<unknown> {
    if (!apiKey) {
      throw new Error(
        "No API key provided. Set ORANGEPRO_API_KEY in the worker environment or pass X-OrangePro-Api-Key header."
      );
    }

    const url = `${baseUrl}${path}`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Api-Key": apiKey,
    };

    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });

    const text = await res.text();
    if (!res.ok) {
      throw new Error(
        `OrangePro API error (HTTP ${res.status}): ${method} ${path} → ${text.slice(0, 300)}`
      );
    }

    try {
      return JSON.parse(text);
    } catch {
      return { raw: text };
    }
  }

  function agentPath(suffix: string): string {
    if (!tenantId) {
      throw new Error(
        "ORANGEPRO_TENANT_ID is required for agent platform tools. Set it in the worker environment or pass X-OrangePro-Tenant-Id header."
      );
    }
    return `/api/v1/admin/tenants/${tenantId}/agent-platform${suffix}`;
  }

  return { call, agentPath, tenantId };
}

// ── MCP Server Factory ────────────────────────────────────────────────────────

function createMcpServer(env: Env, requestHeaders: Headers): McpServer {
  const server = new McpServer({
    name: "orangepro-remote",
    version: "0.1.0",
  });

  const api = makeApiClient(env, requestHeaders);

  // ── Coverage & Analytics ──────────────────────────────────────────────────

  server.tool(
    "get_coverage_gaps",
    "Find application areas lacking test coverage. Returns a heatmap of critical (red), partial (yellow), and healthy (green) coverage zones with test counts.",
    {
      area: z
        .string()
        .optional()
        .describe("Filter results to categories matching this string (case-insensitive)."),
    },
    async ({ area }) => {
      const params = area ? `?area=${encodeURIComponent(area)}` : "";
      const data = await api.call("GET", `/api/v1/analytics/coverage-heatmap${params}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "analyze_release_readiness",
    "Get a tenant-wide release readiness assessment. Returns a ship/review/block recommendation with confidence score, coverage analysis, risk areas, and recommended actions.",
    {},
    async () => {
      const data = await api.call("GET", "/api/v1/analytics/release-readiness");
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "explain_quality_risk",
    "Get a quality risk assessment using coverage heatmap, execution history, and 30-day trend data. Use to answer 'are we safe to ship?' or 'what areas need more tests?'",
    {
      area: z
        .string()
        .optional()
        .describe("Focus the risk assessment on categories matching this string."),
      question: z
        .string()
        .optional()
        .describe("Specific quality question to answer (e.g., 'Is the checkout flow well-tested?')."),
    },
    async ({ area, question }) => {
      const body: Record<string, string> = {};
      if (area) body.area = area;
      if (question) body.question = question;
      const data = await api.call("POST", "/api/v1/analytics/ship-confidence", body);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "analyze_pr_risk",
    "Analyze a pull request for quality risk. Returns overall risk score (0-100), risk drivers, impacted categories, coverage gaps, and recommended tests to run. Use before merging to catch regressions.",
    {
      pr_title: z.string().min(1).describe("Pull request title."),
      pr_description: z.string().optional().describe("Pull request body or description of changes."),
      changed_files: z
        .array(z.string())
        .optional()
        .describe("List of changed file paths (e.g., ['src/checkout.ts', 'src/payment.ts'])."),
    },
    async ({ pr_title, pr_description, changed_files }) => {
      const data = await api.call("POST", "/api/v1/analytics/coverage-gaps/suggestions", {
        pr_title,
        pr_description,
        changed_files,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Bug to Tests ──────────────────────────────────────────────────────────

  server.tool(
    "convert_bug_to_tests",
    "Generate regression tests from a bug report or incident description. Returns test cases with steps, expected results, and priority. Use to prevent the same bug from shipping again.",
    {
      bug_description: z.string().min(1).describe("Bug report, incident description, or defect summary."),
      severity: z
        .enum(["critical", "high", "medium", "low"])
        .optional()
        .describe("Bug severity. Affects test priority weighting."),
      affected_area: z
        .string()
        .optional()
        .describe("Application area affected (e.g., 'checkout', 'auth', 'payments')."),
    },
    async ({ bug_description, severity, affected_area }) => {
      // Step 1: analyze the bug
      const analysis = await api.call("POST", "/api/v1/analyze", {
        bug_description,
        severity,
        affected_area,
      });
      // Step 2: generate tests from analysis
      const data = await api.call("POST", "/api/v1/generate", {
        analysis,
        bug_description,
        severity,
        affected_area,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Test Generation ───────────────────────────────────────────────────────

  server.tool(
    "generate_missing_coverage",
    "Generate test cases for a user story or feature that needs better coverage. Returns categorized test cases with steps and expected results.",
    {
      user_story: z
        .string()
        .min(1)
        .describe("User story, feature description, or coverage gap to generate tests for."),
      app_context: z
        .string()
        .optional()
        .describe("Application overview or technical context to improve test relevance."),
      app_domain: z
        .string()
        .optional()
        .describe("Application domain (e.g., 'E-Commerce', 'Banking', 'Healthcare')."),
    },
    async ({ user_story, app_context, app_domain }) => {
      const data = await api.call("POST", "/api/v1/test-generation/initialize", {
        user_story,
        app_context,
        app_domain,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "build_regression_pack",
    "Build a regression test pack for a specific application area. Returns a set of tests designed to catch regressions in that area.",
    {
      area: z
        .string()
        .min(1)
        .describe("Application area to build regression tests for (e.g., 'checkout', 'authentication', 'payments')."),
      context: z
        .string()
        .optional()
        .describe("Additional context about the area or recent changes."),
    },
    async ({ area, context }) => {
      const data = await api.call("POST", "/api/v1/test-generation/initialize", {
        user_story: `Regression test pack for: ${area}`,
        app_context: context,
        app_domain: area,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "generate_test_scripts",
    "Convert test cases from a completed test generation job into executable scripts for Playwright, Cypress, Selenium, or Puppeteer.",
    {
      source_job_id: z
        .string()
        .min(1)
        .describe("Job ID from a completed test generation run (from generate_missing_coverage output)."),
      framework: z
        .enum(["playwright", "cypress", "selenium", "puppeteer", "all"])
        .optional()
        .describe("Target test framework. Defaults to playwright."),
      test_case_ids: z
        .array(z.string())
        .optional()
        .describe("Specific test case IDs to convert. If omitted, converts all."),
      app_domain: z.string().optional().describe("Application domain for context (e.g., 'E-Commerce')."),
    },
    async ({ source_job_id, framework, test_case_ids, app_domain }) => {
      // Initialize script generation job
      const init = await api.call("POST", "/api/v1/script-generation/initialize", {
        source_job_id,
        framework: framework || "playwright",
        test_case_ids,
        app_domain,
      }) as { job_id?: string };

      if (!init || !init.job_id) {
        return { content: [{ type: "text", text: JSON.stringify(init, null, 2) }] };
      }

      // Submit the job
      const data = await api.call("POST", `/api/v1/script-generation/${init.job_id}/submit`, {});
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Agent Platform ────────────────────────────────────────────────────────

  server.tool(
    "orangepro_list_agents",
    "List all OrangePro agents configured for a tenant. Returns agent_id, name, status, source config, and last run time. Use this first to discover available agents before running or inspecting them.",
    {
      tenant_id: z
        .string()
        .optional()
        .describe("OrangePro tenant id. Defaults to ORANGEPRO_TENANT_ID env var."),
    },
    async ({ tenant_id }) => {
      const tid = tenant_id || api.tenantId;
      if (!tid) throw new Error("tenant_id is required");
      const data = await api.call("GET", `/api/v1/admin/tenants/${tid}/agent-platform/agents`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "orangepro_get_agent",
    "Get full configuration and status for a specific OrangePro agent. Returns source config, schedule, last run summary, and agent metadata.",
    {
      agent_id: z.string().min(1).describe("The agent_id to retrieve. Get this from orangepro_list_agents."),
      tenant_id: z
        .string()
        .optional()
        .describe("OrangePro tenant id. Defaults to ORANGEPRO_TENANT_ID env var."),
    },
    async ({ agent_id, tenant_id }) => {
      const tid = tenant_id || api.tenantId;
      if (!tid) throw new Error("tenant_id is required");
      const data = await api.call("GET", `/api/v1/admin/tenants/${tid}/agent-platform/agents/${agent_id}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "orangepro_run_agent",
    "Trigger an immediate run for an OrangePro agent. Returns run_id and initial status. Use orangepro_list_agent_runs to check completion.",
    {
      agent_id: z.string().min(1).describe("The agent_id to run. Get this from orangepro_list_agents."),
      tenant_id: z
        .string()
        .optional()
        .describe("OrangePro tenant id. Defaults to ORANGEPRO_TENANT_ID env var."),
    },
    async ({ agent_id, tenant_id }) => {
      const tid = tenant_id || api.tenantId;
      if (!tid) throw new Error("tenant_id is required");
      const data = await api.call("POST", `/api/v1/admin/tenants/${tid}/agent-platform/agents/${agent_id}/run`, {});
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "orangepro_list_agent_runs",
    "List recent runs for a specific OrangePro agent. Returns run_id, status, start time, duration, and records processed.",
    {
      agent_id: z.string().min(1).describe("The agent_id to list runs for."),
      tenant_id: z
        .string()
        .optional()
        .describe("OrangePro tenant id. Defaults to ORANGEPRO_TENANT_ID env var."),
      limit: z.number().int().min(1).max(200).optional().describe("Max number of runs to return. Default 20."),
      offset: z.number().int().min(0).optional().describe("Number of runs to skip for pagination."),
    },
    async ({ agent_id, tenant_id, limit, offset }) => {
      const tid = tenant_id || api.tenantId;
      if (!tid) throw new Error("tenant_id is required");
      const params = new URLSearchParams();
      if (limit) params.set("limit", String(limit));
      if (offset) params.set("offset", String(offset));
      const qs = params.toString() ? `?${params}` : "";
      const data = await api.call("GET", `/api/v1/admin/tenants/${tid}/agent-platform/agents/${agent_id}/runs${qs}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "orangepro_get_agent_logs",
    "Read recent log lines for an OrangePro agent. Use to debug failures or verify what an agent did during a run.",
    {
      agent_id: z.string().min(1).describe("The agent_id to get logs for."),
      tenant_id: z
        .string()
        .optional()
        .describe("OrangePro tenant id. Defaults to ORANGEPRO_TENANT_ID env var."),
      limit: z.number().int().min(1).max(500).optional().describe("Max number of log lines to return. Default 100."),
      offset: z.number().int().min(0).optional().describe("Number of log lines to skip for pagination."),
    },
    async ({ agent_id, tenant_id, limit, offset }) => {
      const tid = tenant_id || api.tenantId;
      if (!tid) throw new Error("tenant_id is required");
      const params = new URLSearchParams();
      if (limit) params.set("limit", String(limit));
      if (offset) params.set("offset", String(offset));
      const qs = params.toString() ? `?${params}` : "";
      const data = await api.call("GET", `/api/v1/admin/tenants/${tid}/agent-platform/agents/${agent_id}/logs${qs}`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "orangepro_get_agent_health",
    "Read health and connectivity status for an OrangePro agent. Use to diagnose why an agent is failing.",
    {
      agent_id: z.string().min(1).describe("The agent_id to check health for."),
      tenant_id: z
        .string()
        .optional()
        .describe("OrangePro tenant id. Defaults to ORANGEPRO_TENANT_ID env var."),
    },
    async ({ agent_id, tenant_id }) => {
      const tid = tenant_id || api.tenantId;
      if (!tid) throw new Error("tenant_id is required");
      const data = await api.call("GET", `/api/v1/admin/tenants/${tid}/agent-platform/agents/${agent_id}/health`);
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── KG Explorer ───────────────────────────────────────────────────────────

  server.tool(
    "orangepro_resolve_story",
    "Resolve a user story, requirement, or feature description against the OrangePro Knowledge Graph. Returns grounded entities, matched concepts, and confidence scores.",
    {
      story_text: z
        .string()
        .min(1)
        .max(20000)
        .describe("The user story, requirement, or feature text to resolve against the KG."),
      input_kind: z
        .string()
        .optional()
        .describe("Input type: 'story', 'requirement', or 'feature'. Defaults to 'story'."),
      source_type: z
        .string()
        .optional()
        .describe("Source type: 'manual', 'jira', or 'github'. Defaults to 'manual'."),
      top_k: z
        .number()
        .int()
        .min(1)
        .max(20)
        .optional()
        .describe("Number of top matches to return. Defaults to 5."),
      tenant_id: z
        .string()
        .optional()
        .describe("OrangePro tenant id. Defaults to ORANGEPRO_TENANT_ID env var."),
    },
    async ({ story_text, input_kind, source_type, top_k, tenant_id }) => {
      const tid = tenant_id || api.tenantId;
      if (!tid) throw new Error("tenant_id is required");
      const data = await api.call("POST", `/api/v1/kg/tenants/${tid}/resolve-story`, {
        story_text,
        input_kind: input_kind || "story",
        source_type: source_type || "manual",
        top_k: top_k || 5,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// ── Cloudflare Worker Entry Point ─────────────────────────────────────────────

export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
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
