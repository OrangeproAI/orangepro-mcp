import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  opAnalyze,
  opAiFlows,
  opAiLinks,
  opChanged,
  opCompare,
  opDoctor,
  opProofDoctor,
  opDynamicProof,
  opExplain,
  opExport,
  opGaps,
  opGenerate,
  opProveLoop,
  opRecordRun,
  opRtm,
  opScore,
  opStats,
  opStart,
  opStatus,
  opUpdate,
  resolveDiffTargets
} from "./operations.js";
import { runnableRunHintsFor, AGENT_RUN_WORKFLOW, GROUNDING_CONTRACT } from "./generate/runHints.js";
import { preloadTreeSitter } from "./analyze/treeSitter/engine.js";
import { treeSitterLanguages } from "./analyze/treeSitter/languages.js";
import { redactSecrets } from "./util/redact.js";

interface ToolTextResponse {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
  [key: string]: unknown;
}

function asText(payload: unknown): ToolTextResponse {
  return { content: [{ type: "text", text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2) }] };
}

function asError(error: unknown): ToolTextResponse {
  const message = redactSecrets(error instanceof Error ? error.message : String(error));
  return { content: [{ type: "text", text: `OrangePro local error: ${message}` }], isError: true };
}

const Workspace = {
  workspace: z.string().optional().describe("Local workspace root. Defaults to the current directory.")
};

const DEFAULT_MARKDOWN_RTM_LIMIT = 500;

/**
 * MCP server exposing OrangePro local graph/test tools. Agent-agnostic (Cursor,
 * Codex, Claude, Copilot, …). First slice exposes NO upload or repo-write tools.
 */
export function createLocalServer(): McpServer {
  const server = new McpServer({ name: "orangepro-local", version: "0.2.0" });
  const root = (ws?: string): string => ws || process.cwd();

  server.registerTool(
    "orangepro_start",
    {
      title: "Start OrangePro",
      description:
        "One-command local setup for a repo or PR: analyze sources, auto-apply weak AI candidate links and candidate flows when a real BYOK provider is configured, write behavior-coverage.html + rtm.md, summarize changed/gap targets, and return agent next actions. AI lanes stay separate and never affect Proven coverage.",
      inputSchema: {
        ...Workspace,
        source: z.string().optional().describe("Source path to analyze. Defaults to workspace."),
        base_ref: z.string().optional().describe("Optional PR/diff base ref. Default auto-detects main/master when possible."),
        include_markdown: z.boolean().optional().describe("Enrich requirements-like Markdown docs. Default true."),
        generate_coverage: z.boolean().optional().describe("Run safe local coverage generation before analyze where supported. Default false."),
        coverage_timeout_ms: z.number().int().min(1000).max(600000).optional().describe("Per-command coverage-generation timeout."),
        no_ai: z.boolean().optional().describe("Disable automatic AI weak-link and candidate-flow passes even if a provider key is configured."),
        no_ai_flows: z.boolean().optional().describe("Disable automatic AI candidate-flow discovery while keeping weak AI links enabled."),
        ai_all: z.boolean().optional().describe("Run AI weak-linking over all deterministic behavior nodes instead of gaps-only."),
        provider: z.enum(["openai", "ollama", "anthropic"]).optional().describe("BYOK provider override for the AI passes."),
        model: z.string().optional().describe("Model name override."),
        prompt_version: z.enum(["v2", "v5"]).optional().describe("Opt-in generation strategy for the auto-prove generation lane. Default v2/deterministic; v5 uses batched two-phase generation. The prove/mint gate is unchanged either way.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true }
    },
    async (input) => {
      try {
        await preloadTreeSitter(treeSitterLanguages());
        return asText(
          await opStart(root(input.workspace), {
            source: input.source,
            baseRef: input.base_ref,
            includeMarkdown: input.include_markdown,
            generateCoverage: input.generate_coverage,
            coverageTimeoutMs: input.coverage_timeout_ms,
            ai: !input.no_ai,
            aiAll: input.ai_all,
            aiFlows: !input.no_ai_flows,
            provider: input.provider,
            model: input.model,
            promptVersion: input.prompt_version
          })
        );
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_analyze_sources",
    {
      title: "Analyze local sources",
      description:
        "Build or refresh the local OrangePro evidence graph from a local checkout/path plus optional CSV/Markdown enrichers. Metadata-only by default — reads source in-process but never stores or uploads code. Optionally stages/applies AI candidate flows and refreshes the report when ai_flows=true.",
      inputSchema: {
        ...Workspace,
        paths: z.array(z.string()).optional().describe("Extra template/doc files (.csv/.md) to enrich the graph."),
        include_markdown: z.boolean().optional().describe("Enrich requirements-like Markdown docs. Default true."),
        ai_flows: z.boolean().optional().describe("Generate and apply AI-suggested candidate flows after analyze, then refresh the behavior report. Requires a BYOK provider; skips without failing analyze if none is configured."),
        provider: z.enum(["openai", "ollama", "anthropic"]).optional().describe("BYOK provider override for ai_flows."),
        model: z.string().optional().describe("Model name override for ai_flows."),
        mode: z.enum(["metadata_only"]).optional().describe("Persistence privacy mode. Only metadata_only is supported."),
        include_source_snippets: z.boolean().optional().describe("Deferred: source snippets are never persisted in the first slice.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async (input) => {
      try {
        const workspace = root(input.workspace);
        const analyze = opAnalyze(workspace, { paths: input.paths, includeMarkdown: input.include_markdown });
        if (!input.ai_flows) return asText(analyze);
        try {
          const generated = await opAiFlows(workspace, { provider: input.provider, model: input.model });
          const applied = await opAiFlows(workspace, { apply: true });
          return asText({ ...analyze, ai_flows: { status: "applied", generate: generated, apply: applied } });
        } catch (error) {
          const reason = error instanceof Error ? error.message : String(error);
          return asText({ ...analyze, ai_flows: { status: "skipped", reason }, warnings: [...analyze.warnings, `AI candidate flows skipped: ${reason}`] });
        }
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_graph_score",
    {
      title: "Graph readiness score",
      description:
        "Return the local graph readiness score (0-100), band, per-dimension breakdown, and plain-language missing evidence. Readiness signal, not a proof of test lift.",
      inputSchema: { ...Workspace },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    async (input) => {
      try {
        return asText(opScore(root(input.workspace)));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_status",
    {
      title: "Local workspace status",
      description:
        "Show local workspace state without generating anything: whether the graph is fresh/stale/missing, source mix, score, and privacy settings (always local, no upload).",
      inputSchema: { ...Workspace },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    async (input) => {
      try {
        return asText(opStatus(root(input.workspace)));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_doctor",
    {
      title: "Recommend next evidence",
      description:
        "Recommend the smallest next source that would most improve generated-test quality, with expected score impact. Teaches what data improves output.",
      inputSchema: {
        ...Workspace,
        goal: z.string().optional().describe("Optimization goal hint, e.g. 'better_tests'."),
        proof: z
          .boolean()
          .optional()
          .describe("Proof-focused mode: explain why top targets are not Dynamically Proven (deduped blockers + smallest next steps). Read-only; mints nothing.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    async (input) => {
      try {
        return asText(input.proof ? opProofDoctor(root(input.workspace)) : opDoctor(root(input.workspace)));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_find_test_gaps",
    {
      title: "Find test gaps",
      description:
        "List requirements/flows with weak or missing test evidence, plus top_risk_gaps for unproven code symbols ranked by the OrangePro Risk Score (Probability × Impact × DetectionDifficulty). Risk is prioritization only; it never changes coverage/proof status.",
      inputSchema: {
        ...Workspace,
        limit: z.number().int().min(1).max(100).optional().describe("Max gaps to return. Default 10."),
        min_priority: z.string().optional().describe("Minimum priority to include (low|medium|high|critical).")
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    async (input) => {
      try {
        return asText(opGaps(root(input.workspace), { limit: input.limit, min_priority: input.min_priority }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_record_run",
    {
      title: "Record gap-fill outcome",
      description:
        "Record an agent test-writing attempt as static diagnostics. When test_path is provided for TS/JS, OrangePro first tries scoped deterministic re-prove; otherwise it re-analyzes the repo. Static hard COVERS edges render as Associated signal; public Proven requires orangepro_prove.",
      inputSchema: {
        ...Workspace,
        target_symbol: z.string().optional().describe("Exact CodeSymbol external id, e.g. sym:svc/add.go#Add. Preferred."),
        target_id: z.string().optional().describe("Optional graph target id that must resolve to exactly one hard-linked CodeSymbol."),
        source: z.string().optional().describe("Source checkout to re-analyze. Defaults to workspace."),
        test_path: z.string().optional().describe("Workspace-relative test file the agent just wrote. Enables scoped deterministic re-prove for TS/JS."),
        agent_pass: z.boolean().optional().describe("Whether the agent-reported test command passed. Advisory only."),
        vacuous: z.boolean().optional().describe("Whether the agent judged the test vacuous/non-assertive. Advisory only."),
        evidence_ids: z.array(z.string()).optional().describe("Generated-test/evidence ids tied to this attempt. Metadata only."),
        provider: z.string().optional().describe("Model provider used by the agent/generator, if any."),
        model: z.string().optional().describe("Model name used by the agent/generator, if any."),
        prompt_version: z.string().optional().describe("Prompt or workflow version used, if any."),
        run_id: z.string().optional().describe("Optional caller-supplied run id. Defaults to a local monotonic id.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false }
    },
    async (input) => {
      try {
        await preloadTreeSitter(treeSitterLanguages());
        return asText(
          opRecordRun(root(input.workspace), {
            target_symbol: input.target_symbol,
            target_id: input.target_id,
            source: input.source,
            test_path: input.test_path,
            agent_pass: input.agent_pass,
            vacuous: input.vacuous,
            evidence_ids: input.evidence_ids,
            provider: input.provider,
            model: input.model,
            prompt_version: input.prompt_version,
            run_id: input.run_id
          })
        );
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_prove",
    {
      title: "Run dynamic targeted proof",
      description:
        "Run the dynamic targeted-proof oracle for a CodeSymbol and append a metadata-only ledger certificate. Public Proven closes only when baseline green plus a valid sentinel mutation of the credited symbol fails the same test at an assertion. Static record_run is diagnostics only.",
      inputSchema: {
        ...Workspace,
        target_symbol: z.string().optional().describe("Exact CodeSymbol external id, e.g. sym:src/service.ts#OrderService.createOrder. Preferred."),
        target_id: z.string().optional().describe("Optional graph target id that must resolve to exactly one hard-linked CodeSymbol."),
        source: z.string().optional().describe("Source checkout containing the test and target files. Defaults to workspace."),
        test_path: z.string().optional().describe("TS/JS: repo-relative test file to run (required for TS/JS targets)."),
        test_run: z.string().optional().describe("Go: fully-anchored test name for `go test -run`, e.g. '^TestCompute$' (required for Go targets). Java: 'TestClass#testMethod', e.g. 'CalculatorTest#addsTwoNumbers' (required for Java targets)."),
        replacement: z.string().optional().describe("TS/JS: inert sentinel body, e.g. 'return null;' or 'return {\"ok\":false};'. Must be JSON-only per the oracle (required for TS/JS targets). Go derives its own sentinel."),
        target_file: z.string().optional().describe("Optional consistency check. If provided, must match the file derived from target_symbol."),
        method: z.string().optional().describe("Optional consistency check. If provided, must match the member derived from target_symbol."),
        replacement_mode: z.enum(["return-json", "promise-json"]).optional().describe("Sentinel wrapping mode. Default return-json."),
        runner: z.enum(["auto", "vitest", "jest", "mocha", "pytest"]).optional().describe("Test runner override. Default auto."),
        timeout_ms: z.number().int().min(1000).max(600000).optional().describe("Per baseline/mutant test timeout."),
        link_node_modules: z.boolean().optional().describe("Trusted-repo speed mode: symlink node_modules into temp copies."),
        vitest_config: z.string().optional().describe("Repo-relative Vitest config path."),
        jest_config: z.string().optional().describe("Repo-relative Jest config path."),
        test_env: z.array(z.string()).optional().describe("Explicit non-secret KEY=value env entries for the test run."),
        run_id: z.string().optional().describe("Optional caller-supplied run id. Defaults to a local monotonic id.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (input) => {
      try {
        await preloadTreeSitter(treeSitterLanguages());
        return asText(
          opDynamicProof(root(input.workspace), {
            target_symbol: input.target_symbol,
            target_id: input.target_id,
            source: input.source,
            test_path: input.test_path,
            test_run: input.test_run,
            target_path: input.target_file,
            method: input.method,
            replacement: input.replacement,
            replacement_mode: input.replacement_mode,
            runner: input.runner,
            timeout_ms: input.timeout_ms,
            link_node_modules: input.link_node_modules,
            vitest_config: input.vitest_config,
            jest_config: input.jest_config,
            test_env: input.test_env,
            run_id: input.run_id
          })
        );
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_prove_loop",
    {
      title: "Setup, run dynamic proof, refresh report",
      description:
        "Product wrapper around orangepro_prove: run trusted-local setup_commands in the source checkout, then the UNCHANGED dynamic targeted-proof oracle, then refresh the behavior report. Setup is non-secret repo prep only (build/install/shim); a setup failure returns unrunnable, does not run the oracle, and leaves the ledger untouched (never Proven). Public Proven still closes only through the unchanged certificate.",
      inputSchema: {
        ...Workspace,
        target_symbol: z.string().optional().describe("Exact CodeSymbol external id, e.g. sym:src/service.ts#OrderService.createOrder. Preferred."),
        target_id: z.string().optional().describe("Optional graph target id that must resolve to exactly one hard-linked CodeSymbol."),
        source: z.string().optional().describe("Source checkout containing the test and target files. Setup runs here. Defaults to workspace."),
        test_path: z.string().optional().describe("TS/JS: repo-relative test file to run (required for TS/JS targets)."),
        test_run: z.string().optional().describe("Go: fully-anchored test name for `go test -run`, e.g. '^TestCompute$' (required for Go targets). Java: 'TestClass#testMethod', e.g. 'CalculatorTest#addsTwoNumbers' (required for Java targets)."),
        replacement: z.string().optional().describe("TS/JS: inert sentinel body, e.g. 'return null;' or 'return {\"ok\":false};'. Must be JSON-only per the oracle (required for TS/JS targets). Go derives its own sentinel."),
        target_file: z.string().optional().describe("Optional consistency check. If provided, must match the file derived from target_symbol."),
        method: z.string().optional().describe("Optional consistency check. If provided, must match the member derived from target_symbol."),
        replacement_mode: z.enum(["return-json", "promise-json"]).optional().describe("Sentinel wrapping mode. Default return-json."),
        runner: z.enum(["auto", "vitest", "jest", "mocha", "pytest"]).optional().describe("Test runner override. Default auto."),
        timeout_ms: z.number().int().min(1000).max(600000).optional().describe("Per baseline/mutant test timeout."),
        link_node_modules: z.boolean().optional().describe("Trusted-repo speed mode: symlink node_modules into temp copies."),
        vitest_config: z.string().optional().describe("Repo-relative Vitest config path."),
        jest_config: z.string().optional().describe("Repo-relative Jest config path."),
        test_env: z.array(z.string()).optional().describe("Explicit non-secret KEY=value env entries for the test run."),
        setup_commands: z
          .array(
            z.object({
              command: z.string().describe("Executable to run in the source checkout, e.g. 'npm'."),
              args: z.array(z.string()).optional().describe("Argument vector, e.g. ['ci'] or ['run','build']."),
              timeout_ms: z.number().int().min(1).optional().describe("Optional per-command timeout override.")
            })
          )
          .optional()
          .describe("Trusted-local repo prep run in the source checkout before the oracle. Non-secret only (build/install/shim). First non-zero exit returns unrunnable."),
        setup_timeout_ms: z.number().int().min(1).max(600000).optional().describe("Default per-setup-command timeout (ms). Default 30000."),
        run_id: z.string().optional().describe("Optional caller-supplied run id. Defaults to a local monotonic id.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true }
    },
    async (input) => {
      try {
        return asText(
          opProveLoop(root(input.workspace), {
            target_symbol: input.target_symbol,
            target_id: input.target_id,
            source: input.source,
            test_path: input.test_path,
            test_run: input.test_run,
            target_path: input.target_file,
            method: input.method,
            replacement: input.replacement,
            replacement_mode: input.replacement_mode,
            runner: input.runner,
            timeout_ms: input.timeout_ms,
            link_node_modules: input.link_node_modules,
            vitest_config: input.vitest_config,
            jest_config: input.jest_config,
            test_env: input.test_env,
            setup_commands: input.setup_commands,
            setup_timeout_ms: input.setup_timeout_ms,
            run_id: input.run_id
          })
        );
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_stats",
    {
      title: "Gap-fill ledger stats",
      description:
        "Summarize the local gap-fill ledger: attempted, dynamic-reproven, unproven, legacy static-associated, generated-but-unverifiable, and kept rate. Metadata-only.",
      inputSchema: { ...Workspace },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    async (input) => {
      try {
        return asText(opStats(root(input.workspace)));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_rtm",
    {
      title: "Deterministic traceability matrix",
      description:
        "Write and return a deterministic Requirements Traceability Matrix. Status comes only from the local graph and gap-fill ledger: Proven, Runtime-covered, Associated signal, No integration signal, Reproven, or Generated-unverifiable. No LLM calls.",
      inputSchema: {
        ...Workspace,
        format: z.enum(["md", "csv", "json"]).optional().describe("Output format. Default md."),
        output_path: z.string().optional().describe("Output path. Default .orangepro/rtm.<format>."),
        base_ref: z.string().optional().describe("Optional PR/diff scope. Restricts rows to behaviors touched vs this ref."),
        status: z.array(z.string()).optional().describe("Optional status filter, e.g. ['no-link','runtime','associated']."),
        limit: z.number().int().min(1).max(50000).optional().describe("Optional max rows to emit. Markdown defaults to 500 rows; JSON/CSV are uncapped unless set.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async (input) => {
      try {
        return asText(
          opRtm(root(input.workspace), {
            format: input.format,
            outputPath: input.output_path,
            baseRef: input.base_ref,
            statuses: input.status,
            limit: input.limit ?? ((input.format ?? "md") === "md" ? DEFAULT_MARKDOWN_RTM_LIMIT : undefined)
          })
        );
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_update_graph",
    {
      title: "Incrementally update graph",
      description:
        "Refresh the local graph from changed files. Incremental and non-destructive by default — preserves evidence and marks affected generated tests stale.",
      inputSchema: {
        ...Workspace,
        force_full_rebuild: z.boolean().optional().describe("Force a full rebuild instead of an incremental update.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async (input) => {
      try {
        return asText(opUpdate(root(input.workspace), { force_full_rebuild: input.force_full_rebuild }));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_changed_impact",
    {
      title: "Changed-file impact",
      description:
        "DIFF/PR TOOL — only for real code-review situations. Summarizes what changed vs a base git ref and which local graph behaviors/tests are affected (basic changed-file impact; no deep route/API shape analysis). Requires a git repo and a real diff: returns status 'no_diff' / 'no_code_changes' (diff was docs-only) / 'missing_base_ref' / 'not_a_git_repo' with guidance instead of fabricated impact when there is nothing to analyze. For baseline (no-PR) test opportunities use orangepro_find_test_gaps.",
      inputSchema: { ...Workspace, base_ref: z.string().optional().describe("Base git ref to diff against. Default 'main'.") },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    async (input) => {
      try {
        return asText(opChanged(root(input.workspace), input.base_ref));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_ai_links",
    {
      title: "Stage/apply AI candidate links",
      description:
        "Opt-in AI lane: propose weak MAY_RELATE_TO candidate links between existing deterministic behavior and CodeSymbol nodes. Generate writes .orangepro/ai/links.json only; apply=true explicitly merges survivors into candidate_edges. These links never affect proven coverage.",
      inputSchema: {
        ...Workspace,
        apply: z.boolean().optional().describe("Apply staged links into candidate_edges. Default false stages links only."),
        all: z.boolean().optional().describe("Link across all behavior nodes instead of the default gaps-only scope."),
        provider: z.enum(["openai", "ollama", "anthropic"]).optional().describe("BYOK provider override."),
        model: z.string().optional().describe("Model name override."),
        max_behaviors: z.number().int().positive().optional().describe("Maximum behavior targets to process in this AI linking run."),
        symbols_per_behavior: z.number().int().positive().optional().describe("Deterministic CodeSymbol shortlist size per behavior."),
        max_prompt_tokens: z.number().int().positive().optional().describe("Approximate per-batch prompt token ceiling.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async (input) => {
      try {
        return asText(
          await opAiLinks(root(input.workspace), {
            apply: input.apply,
            all: input.all,
            provider: input.provider,
            model: input.model,
            maxBehaviors: input.max_behaviors,
            symbolsPerBehavior: input.symbols_per_behavior,
            maxPromptTokens: input.max_prompt_tokens
          })
        );
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_ai_flows",
    {
      title: "Stage/apply AI candidate flows",
      description:
        "Opt-in AI lane: propose candidate behavior-flow chains over existing deterministic entry and CodeSymbol ids. Generate writes .orangepro/flows.json only; apply=true stores survivors under analysis.candidate_flows. Candidate flows are a verify-these worklist and never affect Proven, deterministic flow counts, tiers, or coverage.",
      inputSchema: {
        ...Workspace,
        apply: z.boolean().optional().describe("Apply staged flows into analysis.candidate_flows. Default false stages flows only."),
        provider: z.enum(["openai", "ollama", "anthropic"]).optional().describe("BYOK provider override."),
        model: z.string().optional().describe("Model name override.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async (input) => {
      try {
        return asText(
          await opAiFlows(root(input.workspace), {
            apply: input.apply,
            provider: input.provider,
            model: input.model
          })
        );
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_generate_tests",
    {
      title: "Generate grounded tests",
      description:
        "Generate a small capped set (1-5) of grounded tests from local evidence using your own model key (BYOK: OpenAI-compatible, Ollama, or Anthropic). Tests are diversified across lightweight LOCAL scenario buckets (happy_path, validation_error, edge_case, integration_flow, security_privacy, regression) chosen from the evidence — unjustified buckets are skipped, never padded. By default it focuses the top-gap behavior and returns up to `limit` bucket-diverse tests for it; pass multiple target_ids to split the budget across them. Each test reports its bucket plus VALIDATED grounding `evidence` (every cited entity resolved against the local graph with its kind, evidence strength, and source_ref) and discloses weak/candidate evidence; `evidence_summary` reports proof coverage and any broken citations, so the grounding is verifiable rather than asserted. If evidence is too thin, returns missing-evidence guidance instead of generic tests. Returns each test's code plus `run_hints` (a suggested file path + run command) and an `agent_workflow`: YOU (the agent) write each file and run it with your shell tools, then report pass/fail + stack traces — OrangePro never writes to or runs anything in the repo. Requires the repo's test framework/deps to already be installed.",
      inputSchema: {
        ...Workspace,
        target_ids: z.array(z.string()).optional().describe("Behavior/requirement external ids to target. Default: the top-gap behavior. Pass several to split the budget across them (each gets a test when the budget allows, in priority order)."),
        base_ref: z.string().optional().describe("PR-scoped generation: restrict to the behaviors the diff vs this ref touches (e.g. 'main') — for branch/PR review, target only the changed code. Requires a git repo + a real diff; returns structured guidance (status + guidance) instead of fabricating when there is none. Overrides target_ids."),
        framework: z.string().optional().describe("Framework hint, e.g. 'playwright', 'vitest', 'pytest'."),
        limit: z.number().int().min(1).max(5).optional().describe("Total tests to generate (1-5), spread across local scenario buckets. Default 3."),
        provider: z
          .enum(["openai", "ollama", "anthropic", "deterministic"])
          .optional()
          .describe("BYOK provider override (auto-detected from env if omitted). Use 'deterministic' for an offline stand-in; without any provider configured, generation returns setup guidance instead of degrading."),
        model: z.string().optional().describe("Model name override."),
        prompt_version: z
          .enum(["v2", "v5"])
          .optional()
          .describe("Prompt strategy. Defaults to v2; v5 is opt-in until corpus validation clears it as default."),
        write_files: z.boolean().optional().describe("Deferred/premium: repo file writing is disabled in the first slice; always treated as false."),
        compare: z
          .boolean()
          .optional()
          .describe("Run BOTH arms — prompt-only baseline vs Local KG, same model + system prompt — and return side-by-side scores (completeness, context awareness, accuracy, domain specificity) plus both test suites. Non-persisting testing view.")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: true }
    },
    async (input) => {
      try {
        // PR-scoped generation: --base/base_ref restricts targets to the diff.
        let target_ids = input.target_ids;
        if (input.base_ref) {
          const dt = resolveDiffTargets(root(input.workspace), input.base_ref);
          if (dt.status !== "ok") {
            return asText({ status: dt.status, base_ref: dt.base_ref, guidance: dt.guidance, generated_tests: [] });
          }
          if (!dt.target_ids.length) {
            return asText({ status: "no_behaviors", base_ref: dt.base_ref, guidance: dt.guidance, generated_tests: [] });
          }
          target_ids = dt.target_ids;
        }
        if (input.compare) {
          // Each arm already carries run_hints (runnable tests only); attach the
          // write -> run -> report workflow so the agent can run the Local KG arm.
          const cmp = await opCompare(root(input.workspace), {
            target_ids,
            framework: input.framework,
            limit: input.limit,
            provider: input.provider,
            model: input.model,
            prompt_version: input.prompt_version
          });
          return asText({ ...cmp, agent_workflow: AGENT_RUN_WORKFLOW });
        }
        const result = await opGenerate(root(input.workspace), {
          target_ids,
          framework: input.framework,
          limit: input.limit,
          provider: input.provider,
          model: input.model,
          prompt_version: input.prompt_version
        });
        const note = input.write_files
          ? { write_files_note: "Repo file writing is a deferred/premium capability; tests were generated in-memory only (write_files=false)." }
          : {};
        // The agent is the test runner: return each RUNNABLE test's suggested write
        // path + run command plus the write -> run -> report workflow. Non-runnable
        // grounded drafts (runnable === false) are excluded from run_hints so the
        // agent never runs a draft with a fabricated/missing import; they remain in
        // `generated_tests` with their `unresolved_reason`. OrangePro never writes
        // to or runs anything in the repo.
        return asText({
          ...result,
          agent_workflow: AGENT_RUN_WORKFLOW,
          grounding_contract: GROUNDING_CONTRACT,
            run_hints: runnableRunHintsFor(result.generated_tests, root(input.workspace)),
          ...note
        });
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_explain_test",
    {
      title: "Explain a generated test",
      description:
        "Explain why a generated test exists: which graph evidence anchors support it, source refs, and whether weak/candidate evidence was used. Exposes trust artifacts only, not internal generation logic.",
      inputSchema: {
        ...Workspace,
        generated_test_id: z.string().min(1).describe("The generated test id (or title) from orangepro_generate_tests.")
      },
      annotations: { readOnlyHint: true, destructiveHint: false }
    },
    async (input) => {
      try {
        return asText(opExplain(root(input.workspace), input.generated_test_id));
      } catch (error) {
        return asError(error);
      }
    }
  );

  server.registerTool(
    "orangepro_export_evidence_pack",
    {
      title: "Export evidence pack",
      description:
        "Export a portable evidence pack (JSON) plus a human-readable Markdown summary for review or later hosted promotion. Includes facts, provenance, generated outputs, and high-level score metadata — never prompts, weights, traces, or raw source. Validates against the local schema.",
      inputSchema: {
        ...Workspace,
        output_path: z.string().optional().describe("Output JSON path. Default 'orangepro-evidence-pack.json'."),
        include_generated_bodies: z
          .boolean()
          .optional()
          .describe(
            "Embed generated test bodies in the pack. Default false: bodies stay in the local workspace so the exported pack is metadata-only. Raw source snippets never cross the boundary regardless of this flag."
          ),
        graph_html: z.boolean().optional().describe("Also write a self-contained offline evidence-graph explorer (metadata only, no network).")
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true }
    },
    async (input) => {
      try {
        const result = opExport(root(input.workspace), input.output_path || "orangepro-evidence-pack.json", {
          include_generated_bodies: input.include_generated_bodies,
          graph_html: input.graph_html
        });
        return asText(result);
      } catch (error) {
        return asError(error);
      }
    }
  );

  return server;
}

export async function startLocalMcpServer(): Promise<void> {
  // Preload configured tree-sitter grammars once so the sync analyzer can extract
  // via AST when the analyze/generate tools run.
  await preloadTreeSitter(treeSitterLanguages());
  const server = createLocalServer();
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
