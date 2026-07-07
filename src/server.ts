import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { OrangeProClient } from "./apiClient.js";
import { OrangeProConfig } from "./config.js";
import { createOrangeProToolHandlers, TenantInput } from "./orangeproTools.js";
import { createOrangeProQaToolHandlers } from "./qaTools.js";

export function createServer(config: OrangeProConfig, client = new OrangeProClient(config)): McpServer {
  const server = new McpServer({
    name: "orangepro",
    version: "0.2.0"
  });
  const handlers = createOrangeProToolHandlers(client, config);
  const qaHandlers = createOrangeProQaToolHandlers(client, config);

  // ── Agent Platform Tools ──────────────────────────────────────────

  server.registerTool(
    "orangepro_list_agents",
    {
      title: "List OrangePro agents",
      description:
        "List all configured OrangePro agents for a tenant. Use this first to discover available agents before getting details or triggering runs. Returns agent_id, name, type, status, and last run timestamp for each agent.",
      inputSchema: TenantInput,
      annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: true }
    },
    handlers.listAgents
  );

  server.registerTool(
    "orangepro_get_agent",
    {
      title: "Get OrangePro agent",
      description:
        "Get full detail, configuration, timeline, and recent runs for a specific OrangePro agent. Use after orangepro_list_agents to inspect a particular agent. Returns agent config, run history, and current status.",
      inputSchema: {
        ...TenantInput,
        agent_id: z.string().min(1).describe("The agent_id from orangepro_list_agents.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    handlers.getAgent
  );

  server.registerTool(
    "orangepro_run_agent",
    {
      title: "Run OrangePro agent",
      description:
        "Start an OrangePro agent run. Safe to retry — the API returns the active run if one is already in progress. Use this to trigger data ingestion, KG sync, or test generation agents.",
      inputSchema: {
        ...TenantInput,
        agent_id: z.string().min(1).describe("The agent_id to run. Get this from orangepro_list_agents.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    handlers.runAgent
  );

  server.registerTool(
    "orangepro_list_agent_runs",
    {
      title: "List OrangePro agent runs",
      description:
        "List recent runs for a specific OrangePro agent. Use to check run history, find failed runs, or verify a recent run completed. Returns run_id, status, start time, duration, and records processed.",
      inputSchema: {
        ...TenantInput,
        agent_id: z.string().min(1).describe("The agent_id to list runs for."),
        limit: z.number().int().min(1).max(200).optional().describe("Max number of runs to return. Default 20."),
        offset: z.number().int().min(0).optional().describe("Number of runs to skip for pagination.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    handlers.listRuns
  );

  server.registerTool(
    "orangepro_get_agent_logs",
    {
      title: "Get OrangePro agent logs",
      description:
        "Read recent log lines for an OrangePro agent. Use to debug failures, check processing details, or verify what an agent did during a run. Returns timestamped log lines.",
      inputSchema: {
        ...TenantInput,
        agent_id: z.string().min(1).describe("The agent_id to get logs for."),
        limit: z.number().int().min(1).max(500).optional().describe("Max number of log lines to return. Default 100."),
        offset: z.number().int().min(0).optional().describe("Number of log lines to skip for pagination.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    handlers.getLogs
  );

  server.registerTool(
    "orangepro_get_agent_health",
    {
      title: "Get OrangePro agent health",
      description:
        "Read health and connectivity status for an OrangePro agent. Use to diagnose why an agent is failing — checks source config, auth, and runtime status.",
      inputSchema: {
        ...TenantInput,
        agent_id: z.string().min(1).describe("The agent_id to check health for.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    handlers.getHealth
  );

  server.registerTool(
    "orangepro_resolve_story",
    {
      title: "Resolve story in OrangePro KG",
      description:
        "Resolve a user story, requirement, or feature description against the OrangePro Knowledge Graph. Returns grounded entities, matched concepts, and confidence scores. Use to verify story coverage or find KG gaps.",
      inputSchema: {
        ...TenantInput,
        story_text: z.string().min(1).max(20000).describe("The user story, requirement, or feature text to resolve against the KG."),
        input_kind: z.string().optional().describe("Input type: 'story', 'requirement', or 'feature'. Defaults to 'story'."),
        source_type: z.string().optional().describe("Source type: 'manual', 'jira', or 'github'. Defaults to 'manual'."),
        top_k: z.number().int().min(1).max(20).optional().describe("Number of top matches to return. Defaults to 5.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    handlers.resolveStory
  );

  // ── QA Intelligence Tools ─────────────────────────────────────────

  server.registerTool(
    "get_coverage_gaps",
    {
      title: "Get OrangePro coverage gaps",
      description:
        "Find application areas lacking test coverage. Returns a heatmap of critical (red), partial (yellow), and healthy (green) coverage zones with test counts. Use to identify where to generate additional tests.",
      inputSchema: {
        area: z.string().optional().describe("Filter results to categories matching this string (case-insensitive).")
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    qaHandlers.getCoverageGaps
  );

  server.registerTool(
    "convert_bug_to_tests",
    {
      title: "Convert bug to regression tests",
      description:
        "Analyze a bug report and generate durable regression tests to prevent recurrence. Provide a detailed bug description for best results. Returns root cause analysis, affected areas, and generated test cases with steps.",
      inputSchema: {
        bug_description: z.string().min(1).describe("Detailed bug report: what happened, expected behavior, actual behavior, and reproduction steps."),
        severity: z.enum(["critical", "high", "medium", "low"]).optional().describe("Bug severity hint — affects test priority ranking.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    qaHandlers.convertBugToTests
  );

  server.registerTool(
    "build_regression_pack",
    {
      title: "Build regression pack",
      description:
        "Generate a focused regression test pack for a feature area or recent change. Use after a refactor, migration, or risky change to ensure the area stays stable. Returns a set of test cases targeting the specified area.",
      inputSchema: {
        area: z.string().min(1).describe("Feature area, system, or flow to protect (e.g., 'checkout', 'user authentication', 'payment processing')."),
        context: z.string().optional().describe("Recent change description or additional risk context (e.g., 'migrated payment provider from Stripe to Adyen').")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    qaHandlers.buildRegressionPack
  );

  server.registerTool(
    "explain_quality_risk",
    {
      title: "Explain quality risk",
      description:
        "Get a quality risk assessment using coverage heatmap, execution history, and 30-day trend data. Identifies high-risk and medium-risk areas. Use to answer questions like 'are we safe to ship?' or 'what areas need more tests?'",
      inputSchema: {
        area: z.string().optional().describe("Focus the risk assessment on categories matching this string."),
        question: z.string().optional().describe("Specific quality question to answer (e.g., 'Is the checkout flow well-tested?').")
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    qaHandlers.explainQualityRisk
  );

  server.registerTool(
    "generate_missing_coverage",
    {
      title: "Generate missing coverage",
      description:
        "Generate test cases for a user story or feature that needs better coverage. Submits a test generation job and polls for results (up to 2 minutes). Returns categorized test cases with steps and expected results.",
      inputSchema: {
        user_story: z.string().min(1).describe("User story, feature description, or coverage gap to generate tests for."),
        app_context: z.string().optional().describe("Application overview or technical context to improve test relevance."),
        app_domain: z.string().optional().describe("Application domain (e.g., 'E-Commerce', 'Banking', 'Healthcare') to tailor test patterns.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    qaHandlers.generateMissingCoverage
  );

  server.registerTool(
    "analyze_pr_risk",
    {
      title: "Analyze PR risk",
      description:
        "Analyze a pull request for quality risk. Returns overall risk score (0-100), risk drivers, impacted categories, similar historical bugs, coverage gaps, and recommended tests to run. Use before merging to catch regressions.",
      inputSchema: {
        pr_title: z.string().min(1).describe("Pull request title."),
        pr_description: z.string().optional().describe("Pull request body, summary, or description of changes."),
        changed_files: z.array(z.string()).optional().describe("List of changed file paths (e.g., ['src/checkout.ts', 'src/payment.ts']).")
      },
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true }
    },
    qaHandlers.analyzePrRisk
  );

  server.registerTool(
    "analyze_release_readiness",
    {
      title: "Analyze release readiness",
      description:
        "Get a tenant-wide release readiness assessment. Returns a ship/review/block recommendation with confidence score, coverage analysis, execution summary, script readiness, risk areas, recent failures, and recommended actions. Use before deciding whether to release.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    qaHandlers.analyzeReleaseReadiness
  );

  server.registerTool(
    "generate_test_scripts",
    {
      title: "Generate executable test scripts",
      description:
        "Convert test cases from a completed test generation job into executable test scripts. Requires a source_job_id from a prior generate_missing_coverage or convert_bug_to_tests call. Generates scripts for Playwright, Cypress, Selenium, or Puppeteer. Use this as the second step after generating test cases to get runnable automation code.",
      inputSchema: {
        source_job_id: z.string().min(1).describe("Job ID from a completed test generation run (from generate_missing_coverage output)."),
        framework: z.enum(["playwright", "cypress", "selenium", "puppeteer", "all"]).optional().describe("Target test framework. 'all' generates for all frameworks. Defaults to playwright."),
        test_case_ids: z.array(z.string()).optional().describe("Specific test case IDs to convert. If omitted, converts all test cases from the source job."),
        app_domain: z.string().optional().describe("Application domain for context (e.g., 'E-Commerce').")
      },
      annotations: { readOnlyHint: false, destructiveHint: false }
    },
    qaHandlers.generateTestScripts
  );

  // ── Prompts ───────────────────────────────────────────────────────

  server.registerPrompt(
    "review_agent_run",
    {
      title: "Review OrangePro agent run",
      description: "Analyze an OrangePro agent run for outcome, failures, and next actions.",
      argsSchema: {
        agent_id: z.string().min(1).describe("The agent_id to review."),
        run_id: z.string().optional().describe("Specific run_id to review. If omitted, reviews the most recent run.")
      }
    },
    ({ agent_id, run_id }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Review OrangePro agent ${agent_id}${run_id ? ` run ${run_id}` : ""}.`,
              "Use the MCP tools to inspect agent detail, runs, logs, and health.",
              "Return: outcome, failures, tenant/KG impact, and the next concrete action."
            ].join("\n")
          }
        }
      ]
    })
  );

  server.registerPrompt(
    "debug_failed_agent",
    {
      title: "Debug failed OrangePro agent",
      description: "Investigate why an OrangePro agent failed or produced no useful graph writes.",
      argsSchema: {
        agent_id: z.string().min(1).describe("The agent_id to debug.")
      }
    },
    ({ agent_id }) => ({
      messages: [
        {
          role: "user",
          content: {
            type: "text",
            text: [
              `Debug OrangePro agent ${agent_id}.`,
              "Check health first, then logs, then recent runs.",
              "Classify the failure as source config, auth, LLM, KG write, runtime, or no-op data."
            ].join("\n")
          }
        }
      ]
    })
  );

  return server;
}
