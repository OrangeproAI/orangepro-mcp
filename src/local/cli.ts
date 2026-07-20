#!/usr/bin/env node
import { parseArgs, collectSetupCommands } from "./cliArgs.js";
import { TOOL_VERSION } from "./analyze/parseCache.js";
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
  opGaps,
  opGenerate,
  opGraphHtml,
  opBehaviorCoverageHtml,
  opCoverageReport,
  opInit,
  opProveLoop,
  opRuntimeCoverage,
  opScore,
  opRecordRun,
  opRtm,
  opStats,
  opStatus,
  opUpdate,
  opSetModelDefault,
  opStart,
  getModelDefault,
  resolveDiffTargets,
  resolvePrCheckout,
  writeCompareReport
} from "./operations.js";
import type { GenerateComparison } from "./operations.js";
import { dominantBlockReason } from "./viz/behaviorReportData.js";
import { coverageRevealLine } from "./viz/coverageReveal.js";
import { autoProve, isRoastSurvivor } from "./autoProve.js";
import type { AutoProveAttempt } from "./autoProve.js";
import { opRecipeDbSqljs } from "./recipe/dbSqljs.js";
import { runExportCli } from "./exportCli.js";
import { startLocalMcpServer } from "./mcp.js";
import { createInterface } from "node:readline/promises";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { selectProviderAndModel, Chooser, Asker, ProviderSelection } from "./interactive.js";
import { resolveProviderConfig } from "./localConfig.js";
import { runnableRunHintsFor, suggestedTestPath, suggestedRunCommand } from "./generate/runHints.js";
import { buildAgentWorkflowPack, normalizeAgentClient, renderAgentWorkflowPack } from "./agentWorkflow.js";
import { preloadTreeSitter } from "./analyze/treeSitter/engine.js";
import { treeSitterLanguages } from "./analyze/treeSitter/languages.js";
import { reportProgress, setProgressReporter } from "./util/progress.js";
import { WORKSPACE_DIR } from "./workspace.js";
import { summarizeCorpusScope, type CorpusScopeSummary } from "./corpusScope.js";
import {
  JobRecord,
  jobJsonPath,
  jobLogPath,
  listJobs,
  newJobId,
  readJobRecord,
  updateJobRecord,
  writeJobRecord
} from "./jobs/jobStore.js";
import { runGenerateJob } from "./jobs/runner.js";
import type { GenerateOptions } from "./types.js";

function out(line = ""): void {
  process.stdout.write(line + "\n");
}

function err(line: string): void {
  process.stderr.write(line + "\n");
}

function printScopePreflight(scope: CorpusScopeSummary): void {
  if (!scope.is_large) return;
  out("⚠ Large repository detected for OrangePro start.");
  out(
    `  ${scope.files.toLocaleString()} source/doc file(s)` +
      (scope.truncated ? " (scan truncated)" : "") +
      " — full deterministic analysis can still run, but AI/generation is clearer when scoped."
  );
  out("");
  out("Top-level breakdown:");
  for (const entry of scope.top_level.slice(0, 6)) {
    out(`  ${entry.files.toLocaleString().padStart(7)}  ${entry.path}  (${entry.note})`);
    if (entry.files >= scope.thresholds.large_scope_files && entry.children.length) {
      const children = entry.children
        .slice(0, 3)
        .map((child) => `${child.path} ${child.files.toLocaleString()}`)
        .join(", ");
      out(`           try deeper: ${children}`);
    }
  }
  out("");
  out("Suggested focused starts:");
  for (const entry of scope.suggested_scopes.slice(0, 4)) {
    out(`  - opro start ${entry.path} --generate-coverage`);
  }
  out("  - or run full local graph anyway: opro start . --generate-coverage --no-ai");
  out("");
}

function asBool(value: string | boolean | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (typeof value === "boolean") return value;
  return value !== "false" && value !== "0";
}

function asList(value: string | boolean | undefined): string[] | undefined {
  if (typeof value !== "string") return undefined;
  return value.split(",").map((s) => s.trim()).filter(Boolean);
}

function numericFlag(value: string | boolean | undefined): number | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

const HELP = `opro — OrangePro (local-first, BYOK, metadata-only artifacts)

Usage:
  opro                                       # one-command start: analyze, optional AI links + flows, report, RTM, agent handoff
  opro start [path] [--base <ref>] [--no-ai] [--no-ai-flows] [--generate-coverage] [--prompt-version v5] [--json]
  opro roast [path] [--limit 5] [--json]     # keyless: find passing tests whose targeted mutant still survives
  opro init
  opro setup                                 # interactive: choose a default model provider + model (saved locally)
  opro analyze [path] [--paths a.csv,b.md] [--include-markdown true|false] [--generate-coverage] [--coverage-timeout-ms 120000] [--ai-flows] [--no-coverage-html] [--json]
    # writes an offline behavior-coverage view to .orangepro/behavior-coverage.html by default; --ai-flows also stages/applies AI candidate flows when a BYOK key is configured
  opro status [--json]
  opro coverage [path] [--generate] [--timeout-ms 120000] [--json]
    # detects runtime coverage artifacts (Go coverprofile, lcov, coverage.py XML, JaCoCo XML);
    # --generate runs local free coverage tooling where safely supported (Go, JS/TS scripts, pytest-cov XML, JaCoCo)
  opro doctor [--proof] [--json]   # --proof: why top targets are not Dynamically Proven
  opro update [--force] [--json]
  opro changed --base <ref> [--json]
  opro score [--json]
  opro gaps [--limit 10] [--min-priority medium] [--json]
    # also returns top_risk_gaps: unproven code symbols ranked by OrangePro Risk Score (P × I × D)
  opro record --target-symbol sym:file#Symbol [--test path] [--agent-pass true|false] [--evidence-ids id1,id2] [--provider openai] [--model gpt-4.1] [--prompt-version v1] [--json]
    # record writes static reprove diagnostics only; public Proven requires \`opro prove\`
  opro prove --target-symbol sym:file#Symbol --test path --replacement 'return ...;' [--target-file path] [--method name] [--replacement-mode return-json|promise-json] [--runner auto|vitest|jest|mocha|pytest] [--link-node-modules] [--json]
    # runs the dynamic targeted-proof oracle and writes a metadata-only ledger certificate only when baseline-green → mutant assertion-fail closes
  opro prove-loop --target-symbol sym:file#Symbol --test path --replacement 'return ...;' [--setup 'npm run build'] [--setup 'npm ci'] [--setup-timeout-ms 120000] [--source path] [--runner auto|vitest|jest|mocha|pytest] [--link-node-modules] [--json]
    # trusted-local wrapper: runs each --setup command in the source checkout, then \`opro prove\` (unchanged oracle + cert), then refreshes the behavior report; setup failure returns unrunnable (never Proven)
  opro recipe db-sqljs --target-symbol sym:file#Class.method --entity file#Entity --out orangepro_generated/<name>.sqljs.spec.ts [--source path] [--seed-field name] [--json]
    # writes a REAL NestJS+TypeORM sqljs integration spec (in-memory) + setup profile; makes a DB-backed baseline runnable so \`opro prove-loop\` can close Proven. Never mocks the target.
  opro stats [--json]
  opro rtm [--format md|csv|json] [--base <ref>] [--out <path>] [--status proven,no-link] [--limit N] [--json]
    # Markdown is capped by default for large repos; use --format json/csv for full machine-readable RTM
  opro ai-links [--all] [--apply] [--provider openai|anthropic|ollama] [--model <name>] [--max-behaviors <n>] [--symbols-per-behavior <n>] [--max-prompt-tokens <n>] [--json]
    # opt-in AI lane: stage weak candidate behavior↔code links in .orangepro/ai/links.json; --apply merges them into candidate_edges only
  opro ai-flows [--apply] [--provider openai|anthropic|ollama] [--model <name>] [--json]
    # opt-in AI lane: stage candidate behavior flows (closed anchor set) in .orangepro/flows.json; --apply stores them under analysis.candidate_flows only — a verify-these worklist, never evidence
  opro generate [--target REQ-001] [--base <ref>] [--pr <n> [--yes]] [--changed] [--framework playwright] [--limit 3] [--prompt-version v2|v5] [--provider openai|anthropic|ollama|deterministic] [--model <name>] [--single [--raw]] [--background] [--json]
    # default: A/B both arms (prompt-only vs Local KG, same model) scored side by side + writes a fresh report; --single generates one arm only
    # --base <ref>: NON-MUTATING default for PR/branch review — generate only for the behaviors the diff vs <ref> touches (e.g. --base main); read-only \`git diff\`, no checkout
    # --pr <n>:     MUTATING escape hatch — checks out PR #n (switches your working tree) via the GitHub CLI \`gh\`, re-analyzes, targets its diff; needs confirmation (--yes/--force or a y/N prompt) and refuses on a dirty tree
    # --changed:    target the current branch's diff vs its base (main/master), code changes only (docs ignored)
    # --background: run the job detached (A/B, or agent-mode with --single → result file of run hints), return a job id immediately; poll with \`opro jobs <id>\`
  opro jobs [<job-id>] [--json]                # list background jobs, or show one (status + outputs + log tail)
  opro explain <generated_test_id> [--json]
  opro agent [--client generic|claude-code|cursor|codex|opencode|windsurf] [--json]
    # prints MCP config + copy-paste instructions for a coding agent to write/run grounded tests
  opro export [--out orangepro-evidence-pack.json] [--include-generated-bodies] [--graph-html] [--json]
  opro export --format graph-html [--out orangepro-graph.html]   # offline evidence-graph explorer only
  opro mcp

The command is also available as \`orangepro-local\`. If \`opro\` is not on your PATH,
run \`npm link\` once after \`npm run build\`, or invoke it directly with
\`node dist/local/cli.js <command>\`.

Default exports and graph HTML are metadata-only. Generated test bodies stay local
unless explicitly exported (--include-generated-bodies); source is read in-process
for generation but never stored or uploaded. Test generation uses your own model key
(BYOK). Use a strong current model for real evaluation; cheaper models are fine for
smoke tests but hallucinate more. With no key, generate returns setup guidance and no
tests — the offline deterministic stand-in is opt-in only (--provider deterministic or
ORANGEPRO_ALLOW_DETERMINISTIC=1).
`;

const DEFAULT_MARKDOWN_RTM_LIMIT = 500;

function printJson(value: unknown): void {
  out(JSON.stringify(value, null, 2));
}

function installCliProgress(label: string): () => void {
  let step = 0;
  let lastPct: number | null = null;
  setProgressReporter((message, progress) => {
    step++;
    if (progress && progress.total > 0) {
      lastPct = Math.max(0, Math.min(100, Math.round((progress.current / progress.total) * 100)));
    }
    const meter = lastPct === null ? "" : ` [${bar(lastPct / 100)}] ${lastPct}% (${100 - lastPct}% left)`;
    err(`[opro ${label} ${String(step).padStart(2, "0")}]${meter} ${message}`);
  });
  return () => setProgressReporter(null);
}

function bar(value: number): string {
  const filled = Math.round(value * 10);
  return "█".repeat(filled) + "░".repeat(10 - filled);
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const [rawCommand, ...rawRest] = argv;
  // --version/-v must never fall through to the default one-command start:
  // an unrecognized-flag path that silently runs a full analysis (and spends
  // BYOK tokens) is a trust bug, not a convenience.
  if (rawCommand === "--version" || rawCommand === "-v" || rawCommand === "version") {
    out(TOOL_VERSION);
    return 0;
  }
  const command = !rawCommand || rawCommand.startsWith("--") ? "start" : rawCommand;
  const rest = !rawCommand || rawCommand.startsWith("--") ? argv : rawRest;
  const { positionals, flags } = parseArgs(rest);
  const json = asBool(flags.json, false);
  const cwd = process.cwd();

  if (command === "help" || flags.help || flags.version) {
    if (flags.version) {
      out(TOOL_VERSION);
      return 0;
    }
    out(HELP);
    return 0;
  }

  // Preload configured tree-sitter grammars before analysis so the sync analyzer
  // can extract via AST. Idempotent; only the analysis commands pay for it.
  if (command === "start" || command === "roast" || command === "analyze" || command === "update" || command === "generate" || command === "record" || command === "prove" || command === "prove-loop") {
    await preloadTreeSitter(treeSitterLanguages());
  }

  switch (command) {
    case "start": {
      const source = positionals[0] || ".";
      if (!json) printScopePreflight(summarizeCorpusScope(resolve(source)));
      const clearProgress = !json ? installCliProgress("start") : () => undefined;
      let res;
      try {
        res = await opStart(cwd, {
          source,
          baseRef: typeof flags.base === "string" ? flags.base : undefined,
          includeMarkdown: asBool(flags["include-markdown"], true),
          generateCoverage: asBool(flags["generate-coverage"], false),
          coverageTimeoutMs: numericFlag(flags["coverage-timeout-ms"]),
          ai: !asBool(flags["no-ai"], false),
          aiAll: asBool(flags["ai-all"], false),
          aiFlows: !asBool(flags["no-ai-flows"], false),
          autoLimit: numericFlag(flags["auto-limit"]),
          noAuto: asBool(flags["no-auto"], false),
          promptVersion: flags["prompt-version"] === "v5" ? "v5" : undefined,
          provider: typeof flags.provider === "string" ? flags.provider : undefined,
          model: typeof flags.model === "string" ? flags.model : undefined
        });
      } finally {
        clearProgress();
      }
      if (json) printJson(res);
      else {
        out("OrangePro start complete.");
        out(`  graph:          ${res.analyze.graph_path}`);
        if (res.behavior_coverage_path) {
          out(`  behavior coverage: ${res.behavior_coverage_path}`);
          out(`    open with:    open ${res.behavior_coverage_path}`);
        }
        if (res.coverage_report_path) out(`  coverage report: ${res.coverage_report_path}`);
        out(`  RTM:            ${res.rtm.rtm_path}${res.rtm.rows.length < res.rtm.summary.total ? ` (capped ${res.rtm.rows.length}/${res.rtm.summary.total} rows)` : ""}`);
        out(`  Dynamically Proven:    ${res.rtm.summary.proven}/${res.rtm.summary.total} (static map covers all ${res.rtm.summary.total}; dynamic proof verifies the top ${res.auto_prove.attempted || "few"})`);
        if (res.rtm.summary.total > 0 && res.rtm.summary.proven === 0) {
          out("  Proof next:            no behavior is dynamically proven yet; run from a coding agent with a model key and follow the generated-test proof handoff.");
        }
        const ap = res.auto_prove;
        if (ap.status === "skipped-no-key") {
          out(`  Dynamic proof:         skipped — ${ap.reason ?? "no provider key"}`);
        } else if (ap.status === "disabled") {
          out("  Dynamic proof:         not attempted (--no-auto)");
        } else if (ap.ran) {
          out(`  Dynamic proof:         attempted top ${ap.attempted} target(s), ${ap.proven} dynamically proven`);
          if (ap.proven === 0) {
            const dom = dominantBlockReason(ap.needs_setup);
            if (dom) out(`    blocked because:     ${dom.label} (${dom.count}/${dom.total}); Statically Linked signals still shown`);
          }
          for (const file of ap.generated_files) out(`    wrote:               ${file}`);
          for (const attempt of ap.needs_setup) out(`    needs setup:         ${attempt.target_symbol} — ${attempt.reason ?? "baseline/setup did not run"}`);
          for (const skip of ap.skipped) out(`    skipped:             ${skip.target_symbol ?? skip.title} — ${skip.reason}`);
        }
        out(`  Runtime-covered:       ${res.rtm.summary.runtime_covered}`);
        // G6: same-denominator coverage-vs-proof reveal — renders only when runtime
        // coverage was ingested; percentages share summary.total (never mixed scopes).
        const reveal = coverageRevealLine(res.rtm.summary);
        if (reveal) out(`  ${reveal}`);
        out(`  Statically Linked:     ${res.rtm.summary.associated} (static test link, not dynamic proof)`);
        out(`  No integration signal: ${res.rtm.summary.no_link}`);
        out(`  AI-linked:      ${res.ai_linked.behaviors} behavior(s), ${res.ai_linked.symbols} symbol(s), ${res.ai_linked.links} weak link(s) — not coverage`);
        if (res.ai_links.status === "applied") {
          const generated = res.ai_links.generate?.mode === "generate" ? res.ai_links.generate : undefined;
          const applied = res.ai_links.apply?.mode === "apply" ? res.ai_links.apply : undefined;
          out(`  AI grounding:   applied ${applied?.applied_links ?? 0} weak link(s)${generated?.cache_hit ? " (cache hit)" : ""}`);
        } else {
          out(`  AI grounding:   ${res.ai_links.status}${res.ai_links.reason ? ` — ${res.ai_links.reason}` : ""}`);
        }
        if (res.ai_flows.status === "applied") {
          const generated = res.ai_flows.generate?.mode === "generate" ? res.ai_flows.generate : undefined;
          const applied = res.ai_flows.apply?.mode === "apply" ? res.ai_flows.apply : undefined;
          out(`  AI flows:       applied ${applied?.applied_flows ?? 0} candidate flow(s)${generated?.cache_hit ? " (cache hit)" : ""} — not evidence`);
        } else {
          out(`  AI flows:       ${res.ai_flows.status}${res.ai_flows.reason ? ` — ${res.ai_flows.reason}` : ""}`);
        }
        if (res.changed.status === "ok") {
          out(`  PR scope:       ${res.changed.changed_files.length} changed file(s) vs ${res.changed.base_ref}`);
          out(`  affected:       ${res.changed.affected_behaviors.length} behavior(s), ${res.changed.affected_tests.length} test(s)`);
        } else {
          out(`  PR scope:       ${res.changed.status} vs ${res.changed.base_ref}`);
        }
        out("");
        out("Next actions for your coding agent:");
        for (const action of res.next_actions) out(`  - ${action}`);
        out("");
        out("Install/use MCP in an agent:");
        out("  - opro agent --client codex");
        out("  - opro agent --client claude-code");
        out("  - opro agent --client cursor");
        out("  - opro agent --client opencode");
        // opStart aggregates warnings from ai-flows generate AND apply — the same
        // message (e.g. the prompt entry cap) can legitimately arrive twice.
        // Dedupe at print time; JSON output keeps the raw array.
        for (const w of [...new Set(res.warnings)]) out(`  warning: ${w}`);
      }
      return 0;
    }

    case "roast": {
      const source = positionals[0] || ".";
      const limit = numericFlag(flags.limit) ?? numericFlag(flags["auto-limit"]) ?? 5;
      const clearProgress = !json ? installCliProgress("roast") : () => undefined;
      let res;
      try {
        opAnalyze(cwd, { source });
        res = await autoProve(
          cwd,
          { autoLimit: limit, existingOnly: true },
          { clock: () => new Date().toISOString(), env: process.env, proveLoop: opProveLoop }
        );
      } finally {
        clearProgress();
      }
      const survived = res.attempts.filter(isRoastSurvivor);
      const payload = {
        status: "roast",
        source,
        attempted: res.attempted,
        dynamically_proven: res.proven,
        survived_mutants: survived.length,
        needs_setup: res.needs_setup,
        survivors: survived.map((a) => ({
          target_symbol: a.target_symbol,
          test_path: a.test_path,
          mutant_status: a.mutant_status,
          reason: a.reason
        }))
      };
      if (json) {
        printJson(payload);
      } else {
        out("OrangePro roast complete.");
        out(`  attempted:            ${payload.attempted}`);
        out(`  Newly proven this run: ${payload.dynamically_proven}`);
        out(`  Survived mutants:     ${payload.survived_mutants}`);
        if (survived.length > 0) {
          out("");
          out(`${survived.length} passing test(s) still passed when OrangePro replaced the target with a sentinel mutant:`);
          for (const attempt of survived.slice(0, limit)) {
            out(`  - ${attempt.test_path} survived mutant on ${attempt.target_symbol}`);
            if (attempt.reason) out(`    reason: ${attempt.reason}`);
          }
          out("");
          out("Equivalent mutants can also survive, so treat this as a proof-strengthening queue, not automatic blame.");
          out("Survived mutants are not Dynamically Proven. They are targets for stronger assertions.");
        } else if (res.proven > 0) {
          out("  verdict:              no survived targeted mutants found in this pass.");
        } else if (res.needs_setup.length > 0) {
          const dom = dominantBlockReason(res.needs_setup);
          out(`  verdict:              proof could not run for ${res.needs_setup.length} target(s)${dom ? `; dominant blocker: ${dom.label}` : ""}.`);
        } else {
          out("  verdict:              no survived targeted mutants found in this pass.");
        }
      }
      return 0;
    }

    case "init": {
      const res = opInit(cwd);
      if (json) printJson(res);
      else {
        out("Initialized OrangePro local workspace.");
        out(`  graph:  ${res.graph_path}`);
        out(`  config: ${res.config_path}`);
        out("Next: opro analyze .");
      }
      return 0;
    }

    case "setup": {
      if (json) {
        err("`opro setup` is interactive and cannot be combined with --json. Pass --provider/--model to `generate` instead.");
        return 2;
      }
      if (!process.stdin.isTTY) {
        err("`opro setup` is interactive — run it in a terminal, or pass --provider/--model to `opro generate`.");
        return 2;
      }
      const sel = await pickProviderInteractively();
      if (!sel) {
        out("Setup cancelled — no changes made.");
        return 0;
      }
      if (sel.provider === "deterministic" || !sel.model) {
        out("Deterministic is the offline stand-in — nothing to save.");
        out("Use it per run: opro generate --provider deterministic");
        return 0;
      }
      opSetModelDefault(cwd, { provider: sel.provider, model: sel.model });
      out(`Saved default: ${sel.provider} / ${sel.model}  →  .orangepro/config.json`);
      out("API keys still come from your environment (never saved). Override any run with --provider/--model.");
      out("Next: opro analyze . && opro generate");
      return 0;
    }

    case "analyze": {
      const path = positionals[0] || ".";
      const clearProgress = !json ? installCliProgress("analyze") : () => undefined;
      try {
        const res = opAnalyze(cwd, {
          source: path,
          paths: asList(flags.paths),
          includeMarkdown: asBool(flags["include-markdown"], true),
          generateCoverage: asBool(flags["generate-coverage"], false),
          coverageTimeoutMs: numericFlag(flags["coverage-timeout-ms"])
        });
        let aiFlows:
          | { status: "applied"; generate: Awaited<ReturnType<typeof opAiFlows>>; apply: Awaited<ReturnType<typeof opAiFlows>> }
          | { status: "skipped"; reason: string }
          | undefined;
        const aiFlowWarnings: string[] = [];
        if (asBool(flags["ai-flows"], false)) {
          try {
            reportProgress("analyze: generating AI candidate flows");
            const generated = await opAiFlows(cwd, {
              provider: typeof flags.provider === "string" ? flags.provider : undefined,
              model: typeof flags.model === "string" ? flags.model : undefined
            });
            reportProgress("analyze: applying AI candidate flows");
            const applied = await opAiFlows(cwd, { apply: true });
            aiFlows = { status: "applied", generate: generated, apply: applied };
            aiFlowWarnings.push(...generated.warnings, ...applied.warnings);
          } catch (e) {
            const reason = e instanceof Error ? e.message : String(e);
            aiFlows = { status: "skipped", reason };
            aiFlowWarnings.push(`AI candidate flows skipped: ${reason}`);
          }
        }
        const htmlWarnings: string[] = [];
        // The offline behavior-coverage view is the single HTML written by analyze
        // (opt out with --no-coverage-html). A render failure must NEVER fail analyze.
        let coverageHtml: string | undefined;
        if (!asBool(flags["no-coverage-html"], false)) {
          try {
            reportProgress("analyze: writing behavior coverage HTML");
            coverageHtml = opBehaviorCoverageHtml(cwd, `${WORKSPACE_DIR}/behavior-coverage.html`).behavior_coverage_path;
          } catch (e) {
            htmlWarnings.push(`behavior coverage view not written: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        // COVERAGE_REPORT.md (3-file contract) — written by default; a render
        // failure must NEVER fail analyze (the graph is already saved).
        let coverageReport: string | undefined;
        try {
          reportProgress("analyze: writing coverage report");
          coverageReport = opCoverageReport(cwd, `${WORKSPACE_DIR}/COVERAGE_REPORT.md`).coverage_report_path;
        } catch (e) {
          htmlWarnings.push(`coverage report not written: ${e instanceof Error ? e.message : String(e)}`);
        }
        if (json) printJson({ ...res, warnings: [...res.warnings, ...aiFlowWarnings], ...(aiFlows ? { ai_flows: aiFlows } : {}), behavior_coverage_path: coverageHtml, coverage_report_path: coverageReport });
        else {
          out(`Analyzed ${path}`);
          out(`  sources:                 ${res.sources_count}`);
          out(`  entities:                ${res.entities_count}`);
          out(`  relationships:           ${res.relationships_count}`);
          out(`  candidate relationships: ${res.candidate_relationships_count}`);
          out(`  AI-linked:               ${res.ai_linked.behaviors} behavior(s), ${res.ai_linked.symbols} symbol(s), ${res.ai_linked.links} weak link(s) — not coverage`);
          if (aiFlows?.status === "applied") {
            const generated = aiFlows.generate.mode === "generate" ? aiFlows.generate : undefined;
            const applied = aiFlows.apply.mode === "apply" ? aiFlows.apply : undefined;
            out(`  AI flows:                ${applied?.applied_flows ?? 0} candidate flow(s)${generated?.cache_hit ? " (cache hit)" : ""} — not evidence`);
          } else if (aiFlows) {
            out(`  AI flows:                ${aiFlows.status}${aiFlows.reason ? ` — ${aiFlows.reason}` : ""}`);
          }
          out(`  behavior anchors:        ${res.behavior_anchors_count}`);
          out(`  files scanned:           ${res.analysis.files_scanned ?? "?"}`);
          if (res.analysis.runtime_coverage) {
            const rc = res.analysis.runtime_coverage;
            out(`  runtime covered:         ${rc.covered_symbols}/${rc.total_eligible_symbols} (${rc.covered_pct}%)`);
            out(`  runtime artifacts:       ${rc.artifacts.map((a) => a.path).join(", ") || "none"}`);
          } else if (asBool(flags["generate-coverage"], false)) {
            out("  runtime covered:         not available (coverage generation did not produce an ingestible report)");
          }
          out(`  graph:                   ${res.graph_path}`);
          if (coverageHtml) {
            out(`  behavior coverage:       ${coverageHtml}`);
            out(`    open with: open ${coverageHtml}`);
          }
          if (coverageReport) out(`  coverage report:         ${coverageReport}`);
          for (const w of [...new Set([...res.warnings, ...aiFlowWarnings, ...htmlWarnings])]) out(`  warning: ${w}`);
          const sugg = res.analysis.exclude_suggestions ?? [];
          if (sugg.length) {
            out("");
            out("Speed up / de-noise — directories with no code/test/config/doc evidence (add to .orangeproignore):");
            for (const s of sugg.slice(0, 8)) out(`  ${s.path}/   (${s.files} files)`);
          }
          if (res.behavior_anchors_count === 0) {
            // Catch the dead-end here, not three commands later at `generate`.
            out("");
            out("⚠ Not test-ready: 0 behavior anchors found — gaps/generate have nothing to target yet.");
            printNoAnchorsHelp();
            out("(score, doctor, and export still work on the current graph.)");
          } else {
            out("Next: opro score | doctor | gaps | generate");
          }
        }
        return 0;
      } finally {
        clearProgress();
      }
    }

    case "coverage": {
      const path = positionals[0] || ".";
      const clearProgress = !json ? installCliProgress("coverage") : () => undefined;
      let res;
      try {
        res = opRuntimeCoverage(cwd, {
          source: path,
          generate: asBool(flags.generate, false),
          timeoutMs: numericFlag(flags["timeout-ms"])
        });
      } finally {
        clearProgress();
      }
      if (json) printJson(res);
      else {
        out(`Coverage artifacts for ${path}`);
        if (res.artifacts.length) {
          out("  found:");
          for (const a of res.artifacts) {
            out(`    ${a.path} (${a.language}, ${a.format}${a.ingestible ? ", ingestible now" : ", detected only"})`);
          }
        } else {
          out("  found: none");
        }
        if (res.generated.length) {
          out("  generated:");
          for (const g of res.generated) {
            out(`    ${g.ok ? "ok" : "failed"} ${g.module_dir}: ${g.command}`);
            if (g.artifact_path) out(`      artifact: ${g.artifact_path}`);
            if (g.reason) out(`      reason: ${g.reason}`);
          }
        }
        if (res.suggested_commands.length) {
          out("  suggested local coverage commands:");
          for (const s of res.suggested_commands.slice(0, 8)) {
            out(`    (${s.language}) cd ${s.cwd} && ${s.command}`);
            out(`      ${s.reason}`);
          }
        }
        for (const w of res.warnings) out(`  warning: ${w}`);
        out("");
        out("Next: run `opro analyze .` to ingest detected artifacts, or `opro analyze . --generate-coverage` to generate and ingest in one step.");
      }
      return 0;
    }

    case "status": {
      const res = opStatus(cwd);
      if (json) printJson(res);
      else {
        out(`Workspace:   ${res.workspace_initialized ? "initialized" : "not initialized"}`);
        out(`Freshness:   ${res.freshness}${res.changed_files ? ` (${res.changed_files} changed files)` : ""}`);
        out(`Score:       ${res.quality_score ?? "n/a"}`);
        out(`Can generate: ${res.can_generate_tests}`);
        out(`Sources:     ${Object.entries(res.sources).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}`);
        out(`Privacy:     local-only, upload=${res.privacy.upload_enabled}, snippets_in_pack=${res.privacy.source_snippets_in_pack}`);
        if (res.analysis) {
          const a = res.analysis;
          out(
            `Coverage:    ${a.inferred_flows} behavior anchors / ${a.test_files} test files` +
              (a.flows_truncated ? `  ⚠ ${a.flows_truncated} truncated (raise ORANGEPRO_MAX_FLOWS)` : "")
          );
        }
        if (res.freshness === "stale") out("Run: opro update");
      }
      return 0;
    }

    case "doctor": {
      if (asBool(flags.proof, false)) {
        const res = opProofDoctor(cwd);
        if (json) printJson(res);
        else {
          out(res.headline);
          for (const b of res.blockers) {
            out(`  ${b.count} target${b.count === 1 ? "" : "s"} blocked by ${b.label}${b.source === "preflight" ? " (preflight — no test was run)" : ""}`);
            out(`     e.g. ${b.representative.target_symbol}${b.representative.reason ? ` — ${b.representative.reason}` : ""}`);
            out(`     next: ${b.next_step}`);
          }
          for (const nk of res.non_killing) {
            const nkLabel = nk.mutant_status === "associated_non_assertion_failure" ? "mutant failed (non-assertion)" : "mutant survived";
            out(`  ${nkLabel}: ${nk.target_symbol}${nk.test_path ? ` (test: ${nk.test_path})` : ""}`);
            out(`     ${nk.note}`);
          }
        }
        return 0;
      }
      const res = opDoctor(cwd);
      if (json) printJson(res);
      else {
        out(`Status: ${res.status}`);
        out("Recommendations (smallest next steps to improve generated tests):");
        for (const r of res.recommendations) out(`  ${r.priority}. ${r.action}  [${r.expected_score_impact}]\n     why: ${r.why}`);
        out(`Can continue without these: ${res.can_continue_without_recommendations}`);
      }
      return 0;
    }

    case "update": {
      const clearProgress = !json ? installCliProgress("update") : () => undefined;
      let res;
      try {
        res = opUpdate(cwd, { force_full_rebuild: asBool(flags.force, false) });
      } finally {
        clearProgress();
      }
      if (json) printJson(res);
      else {
        out(`Update: ${res.status}`);
        out(`  changed files:        ${res.changed_files}`);
        out(`  updated entities:     ${res.updated_entities}`);
        out(`  stale generated tests: ${res.stale_generated_tests}`);
        for (const w of res.warnings) out(`  warning: ${w}`);
      }
      return 0;
    }

    case "changed": {
      const res = opChanged(cwd, typeof flags.base === "string" ? flags.base : undefined);
      if (json) printJson(res);
      else if (res.status !== "ok") {
        out(`No diff analysis (${res.status}) vs ${res.base_ref}.`);
        if (res.guidance) out(res.guidance);
      } else {
        out(`Changed vs ${res.base_ref}: ${res.changed_files.length} files`);
        for (const f of res.changed_files.slice(0, 20)) out(`  - ${f}`);
        const ab = res.affected_behaviors;
        out(`Affected behaviors: ${ab.length}${ab.length ? ` — ${ab.slice(0, 10).join(", ")}${ab.length > 10 ? ` … (+${ab.length - 10} more; use --json)` : ""}` : ""}`);
        out(`Affected tests:     ${res.affected_tests.join(", ") || "none"}`);
        out("Recommended actions:");
        for (const a of res.recommended_actions) out(`  - ${a}`);
      }
      return 0;
    }

    case "score": {
      const res = opScore(cwd);
      if (json) printJson(res);
      else {
        out(`Test-readiness score: ${res.overall}/100  (${res.band})`);
        const d = res.denominator;
        out(
          `Coverage measured over ${d.total} behavior(s) — ${d.code_export} functions/classes in your code, ` +
            `${d.requirement_template} from requirements, ${d.markdown_requirement} from docs` +
            (d.excluded_test_inferred > 0 ? `; ${d.excluded_test_inferred} guessed from test names (not counted)` : "") +
            (d.unattributed > 0 ? `; ${d.unattributed} unclassified (see graph.json)` : "")
        );
        out("Breakdown:");
        for (const [k, v] of Object.entries(res.breakdown)) out(`  ${bar(v as number)}  ${(v as number).toFixed(2)}  ${k}`);
        out("What would raise it:");
        for (const m of res.missing_evidence) out(`  - ${m}`);
      }
      return 0;
    }

    case "gaps": {
      const res = opGaps(cwd, {
        limit: typeof flags.limit === "string" ? Number.parseInt(flags.limit, 10) : undefined,
        min_priority: typeof flags["min-priority"] === "string" ? flags["min-priority"] : undefined
      });
      if (json) printJson(res);
      else {
        out(`Test gaps (${res.gaps.length} of ${res.total_behaviors} behaviors):`);
        if (res.guidance) out(`  ${res.guidance}`);
        for (const g of res.gaps) {
          out(`  [${g.priority}] ${g.title}  (${g.external_id})`);
          out(`      evidence: ${g.test_evidence}, acceptance criteria: ${g.has_acceptance_criteria}`);
          out(`      ${g.reason} -> ${g.recommended_action}`);
        }
        if (res.top_risk_gaps?.length) {
          out("");
          out("Top risk-ranked code gaps (prioritization only; does not change coverage):");
          for (const g of res.top_risk_gaps) {
            out(`  [risk ${g.risk_score.toFixed(1)}] ${g.title}  (${g.external_id})`);
            out(`      ${g.file}`);
            out(`      refs: ${g.incoming_refs}, churn: ${g.git_churn}, entry point: ${g.entry_point ? "yes" : "no"}`);
            out(`      ${g.reasons.join("; ")}`);
          }
        }
      }
      return 0;
    }

    case "record": {
      const res = opRecordRun(cwd, {
        target_symbol: typeof flags["target-symbol"] === "string" ? flags["target-symbol"] : undefined,
        target_id: typeof flags.target === "string" ? flags.target : undefined,
        source: typeof flags.source === "string" ? flags.source : undefined,
        test_path: typeof flags.test === "string" ? flags.test : undefined,
        agent_pass: flags["agent-pass"] === undefined ? undefined : asBool(flags["agent-pass"], false),
        vacuous: asBool(flags.vacuous, false),
        evidence_ids: asList(flags["evidence-ids"]),
        provider: typeof flags.provider === "string" ? flags.provider : undefined,
        model: typeof flags.model === "string" ? flags.model : undefined,
        prompt_version: typeof flags["prompt-version"] === "string" ? flags["prompt-version"] : undefined,
        run_id: typeof flags["run-id"] === "string" ? flags["run-id"] : undefined
      });
      if (json) printJson(res);
      else {
        out(`Recorded run: ${res.record.run_id}`);
        out(`  target:      ${res.record.target_symbol}`);
        out(`  status:      ${res.record.status}`);
        out(`  closed:      ${res.record.closed}`);
        if (res.record.reprove_mode) out(`  reprove:     ${res.record.reprove_mode}`);
        out(`  agent_pass:  ${res.record.agent_pass ?? "unknown"} (advisory)`);
        out(`  new edges:   ${res.record.new_edges.length}`);
        for (const e of res.record.new_edges.slice(0, 5)) out(`    ${e}`);
        out(`  ledger:      ${res.ledger_path}`);
      }
      return 0;
    }

    case "prove": {
      const replacementMode =
        flags["replacement-mode"] === undefined
          ? undefined
          : flags["replacement-mode"] === "return-json" || flags["replacement-mode"] === "promise-json"
            ? flags["replacement-mode"]
            : undefined;
      if (flags["replacement-mode"] !== undefined && !replacementMode) {
        throw new Error("--replacement-mode must be one of: return-json, promise-json");
      }
      const proofRunner =
      flags.runner === undefined ? undefined : flags.runner === "auto" || flags.runner === "vitest" || flags.runner === "jest" || flags.runner === "mocha" || flags.runner === "pytest" ? flags.runner : undefined;
    if (flags.runner !== undefined && !proofRunner) {
      throw new Error("--runner must be one of: auto, vitest, jest, mocha, pytest");
      }
      const res = opDynamicProof(cwd, {
        target_symbol: typeof flags["target-symbol"] === "string" ? flags["target-symbol"] : undefined,
        target_id: typeof flags.target === "string" ? flags.target : undefined,
        source: typeof flags.source === "string" ? flags.source : undefined,
        test_path: typeof flags.test === "string" ? flags.test : "",
        test_run: typeof flags["test-run"] === "string" ? flags["test-run"] : undefined,
        target_path: typeof flags["target-file"] === "string" ? flags["target-file"] : undefined,
        method: typeof flags.method === "string" ? flags.method : undefined,
        replacement: typeof flags.replacement === "string" ? flags.replacement : "",
        replacement_mode: replacementMode,
        runner: proofRunner,
        timeout_ms: numericFlag(flags["timeout-ms"]),
        link_node_modules: asBool(flags["link-node-modules"], false),
        vitest_config: typeof flags["vitest-config"] === "string" ? flags["vitest-config"] : undefined,
        jest_config: typeof flags["jest-config"] === "string" ? flags["jest-config"] : undefined,
        test_env: asList(flags["test-env"]),
        run_id: typeof flags["run-id"] === "string" ? flags["run-id"] : undefined
      });
      if (json) printJson(res);
      else {
        out(`Dynamic proof: ${res.record.run_id}`);
        out(`  target:      ${res.record.target_symbol}`);
        out(`  status:      ${res.record.status}`);
        out(`  closed:      ${res.record.closed}`);
        out(`  oracle:      ${res.oracle.status}${res.oracle.reason ? ` (${res.oracle.reason})` : ""}`);
        out(`  test:        ${res.record.dynamic_proof?.test_path ?? "unknown"}`);
        out(`  runner:      ${res.record.dynamic_proof?.runner ?? "unknown"}`);
        out(`  ledger:      ${res.ledger_path}`);
      }
      return 0;
    }

    case "prove-loop": {
      const replacementMode =
        flags["replacement-mode"] === undefined
          ? undefined
          : flags["replacement-mode"] === "return-json" || flags["replacement-mode"] === "promise-json"
            ? flags["replacement-mode"]
            : undefined;
      if (flags["replacement-mode"] !== undefined && !replacementMode) {
        throw new Error("--replacement-mode must be one of: return-json, promise-json");
      }
      const proofRunner =
      flags.runner === undefined ? undefined : flags.runner === "auto" || flags.runner === "vitest" || flags.runner === "jest" || flags.runner === "mocha" || flags.runner === "pytest" ? flags.runner : undefined;
    if (flags.runner !== undefined && !proofRunner) {
      throw new Error("--runner must be one of: auto, vitest, jest, mocha, pytest");
      }
      const res = opProveLoop(cwd, {
        target_symbol: typeof flags["target-symbol"] === "string" ? flags["target-symbol"] : undefined,
        target_id: typeof flags.target === "string" ? flags.target : undefined,
        source: typeof flags.source === "string" ? flags.source : undefined,
        test_path: typeof flags.test === "string" ? flags.test : "",
        test_run: typeof flags["test-run"] === "string" ? flags["test-run"] : undefined,
        target_path: typeof flags["target-file"] === "string" ? flags["target-file"] : undefined,
        method: typeof flags.method === "string" ? flags.method : undefined,
        replacement: typeof flags.replacement === "string" ? flags.replacement : "",
        replacement_mode: replacementMode,
        runner: proofRunner,
        timeout_ms: numericFlag(flags["timeout-ms"]),
        link_node_modules: asBool(flags["link-node-modules"], false),
        vitest_config: typeof flags["vitest-config"] === "string" ? flags["vitest-config"] : undefined,
        jest_config: typeof flags["jest-config"] === "string" ? flags["jest-config"] : undefined,
        test_env: asList(flags["test-env"]),
        run_id: typeof flags["run-id"] === "string" ? flags["run-id"] : undefined,
        setup_commands: collectSetupCommands(rest),
        setup_timeout_ms: numericFlag(flags["setup-timeout-ms"])
      });
      if (json) printJson(res);
      else if ("status" in res) {
        out("Prove-loop: unrunnable (oracle not run; ledger untouched)");
        out(`  reason:      ${res.reason}`);
      } else {
        out(`Dynamic proof: ${res.record.run_id}`);
        out(`  target:      ${res.record.target_symbol}`);
        out(`  status:      ${res.record.status}`);
        out(`  closed:      ${res.record.closed}`);
        out(`  oracle:      ${res.oracle.status}${res.oracle.reason ? ` (${res.oracle.reason})` : ""}`);
        out(`  test:        ${res.record.dynamic_proof?.test_path ?? "unknown"}`);
        out(`  runner:      ${res.record.dynamic_proof?.runner ?? "unknown"}`);
        out(`  ledger:      ${res.ledger_path}`);
        if (res.behavior_coverage_path) out(`  behavior report: ${res.behavior_coverage_path}`);
      }
      return 0;
    }

    case "recipe": {
      const recipe = positionals[0];
      if (recipe !== "db-sqljs") {
        throw new Error("recipe supports: db-sqljs. Usage: opro recipe db-sqljs --target-symbol sym:<file>#<Class>.<method> --entity <file>#<Entity> --out orangepro_generated/<name>.sqljs.spec.ts");
      }
      const res = opRecipeDbSqljs(cwd, {
        target_symbol: typeof flags["target-symbol"] === "string" ? flags["target-symbol"] : "",
        entity: typeof flags.entity === "string" ? flags.entity : "",
        out: typeof flags.out === "string" ? flags.out : "",
        source: typeof flags.source === "string" ? flags.source : undefined,
        seed_field: typeof flags["seed-field"] === "string" ? flags["seed-field"] : undefined
      });
      if (json) printJson(res);
      else {
        out(`Recipe db-sqljs: wrote ${res.spec_rel}`);
        out(`  target:        ${res.target_symbol}`);
        out(`  entity:        ${res.entity_id}`);
        out(`  runner:        ${res.runner} (config ${res.vitest_config})`);
        out(`  setup profile: ${res.profile.id} (${res.profile.confidence})`);
        out(`  next (prove):  opro prove-loop --target-symbol ${res.target_symbol} --source <src> --test ${res.spec_rel} --replacement "${res.genuine_mutation.replacement}" --runner vitest --link-node-modules`);
        out(`  DB-3 guard:    equivalent mutation \`${res.equivalent_mutation.replacement}\` must SURVIVE (non-Proven).`);
      }
      return 0;
    }

    case "stats": {
      const res = opStats(cwd);
      if (json) printJson(res);
      else {
        out(`Gap-fill kept rate: ${res.quality_adjusted_kept_rate}% (${res.reproven}/${res.attempted})`);
        out(`  unproven:                ${res.unproven}`);
      out(`  legacy statically-linked: ${res.already_proven}`);
        out(`  generated unverifiable:  ${res.generated_unverifiable}`);
        out(`  ledger:                  ${res.ledger_path}`);
      }
      return 0;
    }

    case "rtm": {
      const rawFormat = typeof flags.format === "string" ? flags.format : "md";
      const format = rawFormat === "csv" || rawFormat === "json" ? rawFormat : "md";
      const explicitLimit = numericFlag(flags.limit);
      const res = opRtm(cwd, {
        format,
        outputPath: typeof flags.out === "string" ? flags.out : undefined,
        baseRef: typeof flags.base === "string" ? flags.base : undefined,
        statuses: asList(flags.status),
        limit: explicitLimit ?? (format === "md" ? DEFAULT_MARKDOWN_RTM_LIMIT : undefined)
      });
      if (json) printJson(res);
      else {
        out(`Wrote RTM: ${res.rtm_path}`);
        if (res.rows.length < res.summary.total) {
          out(`  rows:        ${res.rows.length}/${res.summary.total} shown (Markdown capped; use --format json or --format csv for full machine-readable RTM)`);
        }
        out(`  total:                 ${res.summary.total}`);
        out(`  dynamically proven:    ${res.summary.proven}`);
        out(`  runtime-covered:       ${res.summary.runtime_covered}`);
        out(`  statically linked:     ${res.summary.associated}`);
        out(`  no integration signal: ${res.summary.no_link}`);
        out(`  reproven:    ${res.summary.reproven_this_run}`);
        out(`  kept-rate:   ${res.summary.kept_rate}% (${res.summary.reproven_this_run}/${res.summary.attempted})`);
        if (res.scope?.guidance) out(`  scope:       ${res.scope.guidance}`);
      }
      return 0;
    }

    case "ai-links": {
      const clearProgress = !json ? installCliProgress("ai-links") : () => undefined;
      let res;
      try {
        res = await opAiLinks(cwd, {
          apply: asBool(flags.apply, false),
          all: asBool(flags.all, false),
          provider: typeof flags.provider === "string" ? flags.provider : undefined,
          model: typeof flags.model === "string" ? flags.model : undefined,
          maxBehaviors: numericFlag(flags["max-behaviors"]),
          symbolsPerBehavior: numericFlag(flags["symbols-per-behavior"]),
          maxPromptTokens: numericFlag(flags["max-prompt-tokens"])
        });
      } finally {
        clearProgress();
      }
      if (json) printJson(res);
      else if (res.mode === "apply") {
        out(`Applied AI candidate links: ${res.applied_links}`);
        out(`  staged file: ${res.ai_links_path}`);
        out(`  candidate edges: ${res.candidate_edges_before} -> ${res.candidate_edges_after}`);
        out(`  AI-linked:       ${res.ai_linked.behaviors} behavior(s), ${res.ai_linked.symbols} symbol(s), ${res.ai_linked.links} weak link(s) — not coverage`);
        if (res.skipped_links) out(`  skipped: ${res.skipped_links}`);
        for (const w of res.warnings) out(`  warning: ${w}`);
      } else {
        out(`Staged AI candidate links: ${res.links}`);
        out(`  staged file: ${res.ai_links_path}`);
        out(`  scope: ${asBool(flags.all, false) ? "all" : "gaps"}`);
        out(`  selected behaviors: ${res.selected_behaviors}`);
        out(`  candidate symbols:  ${res.candidate_symbols}${res.total_symbols ? ` of ${res.total_symbols}` : ""}`);
        out("  sent to AI:       behavior + CodeSymbol metadata shortlists (ids/titles/signatures only; no source bodies)");
        if (res.batch_count !== undefined) out(`  batches: ${res.completed_batches ?? 0}/${res.batch_count}`);
        if (res.skipped_behaviors) out(`  skipped behaviors: ${res.skipped_behaviors}`);
        out(`  cache hit: ${res.cache_hit}`);
        if (res.dropped_links) out(`  dropped: ${res.dropped_links}`);
        for (const w of res.warnings) out(`  warning: ${w}`);
        out("Next: run `opro ai-links --apply` to merge weak candidate links into the local graph.");
      }
      return 0;
    }

    case "ai-flows": {
      const clearProgress = !json ? installCliProgress("ai-flows") : () => undefined;
      let res;
      try {
        res = await opAiFlows(cwd, {
          apply: asBool(flags.apply, false),
          provider: typeof flags.provider === "string" ? flags.provider : undefined,
          model: typeof flags.model === "string" ? flags.model : undefined
        });
      } finally {
        clearProgress();
      }
      if (json) printJson(res);
      else if (res.mode === "apply") {
        out(`Applied AI candidate flows: ${res.applied_flows} — a verify-these worklist, never evidence`);
        out(`  staged file: ${res.ai_flows_path}`);
        out(`  proposed ${res.rejections.proposed} -> accepted ${res.rejections.accepted} (missing anchor ${res.rejections.rejected_missing_anchor}, unresolved hop ${res.rejections.rejected_unresolved_hop}, cycle ${res.rejections.rejected_cycle}, over cap ${res.rejections.rejected_over_cap}, duplicate ${res.rejections.rejected_duplicate}, malformed ${res.rejections.rejected_malformed})`);
        out("  stored under analysis.candidate_flows only; deterministic flows, tiers, and Proven are untouched");
        if (res.behavior_coverage_path) out(`  behavior report: ${res.behavior_coverage_path}`);
        for (const w of res.warnings) out(`  warning: ${w}`);
      } else {
        out(`Staged AI candidate flows: ${res.flows}`);
        out(`  staged file: ${res.ai_flows_path}`);
        out(`  closed anchor set: ${res.entry_points} entry point(s), ${res.anchor_symbols} symbol(s)`);
        out("  sent to AI: entry-point + CodeSymbol metadata (ids/titles/files only; no source bodies)");
        out(`  proposed ${res.rejections.proposed} -> accepted ${res.rejections.accepted}`);
        out(`  cache hit: ${res.cache_hit}`);
        for (const w of res.warnings) out(`  warning: ${w}`);
        out("Next: run `opro ai-flows --apply` to store candidate flows under analysis.candidate_flows (ai_suggested, never counted as flows/evidence).");
      }
      return 0;
    }

    case "generate": {
      // Detached child of a `--background` launch: run the resolved job and exit.
      // (Targets/provider are already resolved by the parent and passed as flags.)
      if (flags["__run-detached"] && typeof flags["job-id"] === "string") {
        const detSingle = asBool(flags.single, false);
        await runGenerateJob(
          cwd,
          flags["job-id"],
          {
            target_ids: asList(flags.target),
            framework: typeof flags.framework === "string" ? flags.framework : undefined,
            limit: typeof flags.limit === "string" ? Number.parseInt(flags.limit, 10) : undefined,
            provider: typeof flags.provider === "string" ? flags.provider : undefined,
            model: typeof flags.model === "string" ? flags.model : undefined,
            input_mode: detSingle && asBool(flags.raw, false) ? "raw_prompt" : "graph_grounded",
            prompt_version: (flags["prompt-version"] === "v5" ? "v5" : "v2") as GenerateOptions["prompt_version"]
          },
          undefined,
          detSingle ? "single" : "compare"
        );
        return 0;
      }
      let provider = typeof flags.provider === "string" ? flags.provider : undefined;
      let model = typeof flags.model === "string" ? flags.model : undefined;
      // No explicit flags? Fall back to the saved `opro setup` default, then to
      // an interactive picker (TTY only, nothing else configured).
      if (!provider && !model) {
        const saved = getModelDefault(cwd);
        if (saved) {
          provider = saved.provider;
          model = saved.model;
        }
      }
      const envConfigured =
        resolveProviderConfig(process.env) !== null ||
        /^(1|true|yes)$/i.test(String(process.env.ORANGEPRO_ALLOW_DETERMINISTIC ?? ""));
      if (!provider && !model && !envConfigured && !json && Boolean(process.stdin.isTTY)) {
        const sel = await pickProviderInteractively();
        if (sel) {
          provider = sel.provider;
          model = sel.model;
        }
      }
      const PROVIDERS = ["openai", "anthropic", "ollama", "deterministic"];
      if (provider && !PROVIDERS.includes(provider)) {
        err(`Unknown provider '${provider}'. Use one of: ${PROVIDERS.join(", ")}.`);
        return 2;
      }
      // PR / branch / base scoped generation: restrict targets to the behaviors a
      // diff touches (never fabricates impact when there is no usable diff).
      let diffTargets: string[] | undefined;
      let base = typeof flags.base === "string" ? flags.base : undefined;
      const wantChanged = asBool(flags.changed, false);
      const prRaw = flags.pr;

      // --pr <n>: one command — check out the PR via gh, re-analyze it, target its diff.
      if (prRaw !== undefined) {
        const prNum = typeof prRaw === "string" ? Number.parseInt(prRaw, 10) : NaN;
        if (!Number.isInteger(prNum) || prNum <= 0) {
          const m = "`--pr` needs a PR number, e.g. `opro generate --pr 123`.";
          if (json) printJson({ error: m });
          else err(m);
          return 2;
        }
        // `--pr` mutates the working tree (gh pr checkout + git fetch). It is the
        // opt-in escape hatch; the non-mutating default is `--base <ref>`. Require
        // explicit confirmation: --yes/--force, or an interactive y/N prompt.
        // Non-TTY / --json / MCP without a flag never auto-confirm.
        const confirmedByFlag = asBool(flags.yes, false) || asBool(flags.force, false);
        let confirmed = confirmedByFlag;
        if (!confirmed && !json && Boolean(process.stdin.isTTY)) {
          out(`⚠ --pr ${prNum} runs \`gh pr checkout ${prNum}\` and \`git fetch\` — this switches your working tree to the PR branch.`);
          confirmed = await confirmTTY(`Check out PR #${prNum} now? [y/N] `);
          if (!confirmed) {
            out("Cancelled — no checkout. Tip: use `--base <ref>` to diff the PR without checking it out.");
            return 0;
          }
        }
        const pr = resolvePrCheckout(cwd, prNum, { confirmed });
        if (pr.status !== "ok") {
          if (json) printJson({ status: pr.status, base_ref: pr.base_ref, guidance: pr.guidance, generated_tests: [] });
          else {
            out(
              pr.status === "needs_confirmation"
                ? `Confirmation required for --pr ${prNum} (no changes made).`
                : `Cannot check out PR #${prNum} (${pr.status}).`
            );
            if (pr.guidance) out(pr.guidance);
          }
          return 0;
        }
        if (!json) {
          out(`Checked out PR #${pr.pr}${pr.base_ref ? ` (base ${pr.base_ref})` : ""}.`);
          err("Re-analyzing the checked-out PR so the graph matches it…");
        }
        opAnalyze(cwd, { source: "." });
        base = base ?? pr.base_ref;
      }

      // Resolve diff targets when scoping by --base / --pr / --changed (current branch).
      if (base !== undefined || wantChanged || prRaw !== undefined) {
        const dt = resolveDiffTargets(cwd, base);
        if (dt.status !== "ok") {
          if (json) printJson({ status: dt.status, base_ref: dt.base_ref, guidance: dt.guidance, generated_tests: [] });
          else {
            out(`No diff generation (${dt.status}) vs ${dt.base_ref}.`);
            if (dt.guidance) out(dt.guidance);
          }
          return 0;
        }
        if (!dt.target_ids.length) {
          if (json) printJson({ status: "no_behaviors", base_ref: dt.base_ref, guidance: dt.guidance, generated_tests: [] });
          else out(dt.guidance ?? `The diff vs ${dt.base_ref} touched no tracked behaviors.`);
          return 0;
        }
        diffTargets = dt.target_ids;
        base = dt.base_ref;
        if (!json) {
          // Count + a short preview, not the full id dump (a big PR can match many).
          const preview = dt.target_ids.slice(0, 5).join(", ");
          const more = dt.target_ids.length > 5 ? ` … (+${dt.target_ids.length - 5} more; use --json for the full list)` : "";
          out(`Diff vs ${dt.base_ref}: targeting ${dt.target_ids.length} affected behavior(s): ${preview}${more}`);
        }
      }
      // Full target list is surfaced under --json (the human path prints a preview).
      const diffMeta = diffTargets ? { base_ref: base, target_ids: diffTargets } : {};
      const promptVersion = flags["prompt-version"] === "v5" ? "v5" : "v2";
      const genOpts: GenerateOptions & { provider?: string; model?: string } = {
        target_ids: diffTargets ?? (asList(flags.target) || (typeof flags.target === "string" ? [flags.target] : undefined)),
        framework: typeof flags.framework === "string" ? flags.framework : undefined,
        limit: typeof flags.limit === "string" ? Number.parseInt(flags.limit, 10) : undefined,
        provider,
        model,
        prompt_version: promptVersion
      };
      // Background mode: detach the long run and return immediately so an agentic
      // tool isn't blocked. Works for the A/B path AND --single (agent mode). The
      // job writes results + status to .orangepro/jobs/ and notifies on completion.
      if (asBool(flags.background, false)) {
        const entry = process.argv[1] ?? "";
        if (!entry.endsWith(".js")) {
          // Dev runtime (tsx running a .ts entry): a detached `node <entry.ts>` can't
          // resolve the .js import specifiers and would die as a stuck 'queued' ghost.
          // Run in the foreground instead of lying about a launch.
          err("--background needs the built CLI (run `npm run build`, or use the installed `opro`); running in the foreground.");
        } else {
          const bgSingle = asBool(flags.single, false);
          const launched = launchBackgroundGenerate(cwd, genOpts, { single: bgSingle, raw: asBool(flags.raw, false) });
          if (json) printJson({ status: "started", mode: bgSingle ? "single" : "compare", ...launched });
          else {
            out(`Started background ${bgSingle ? "single (agent-mode)" : "A/B"} generation — job ${launched.job_id}.`);
            out(`  log:    ${launched.log_path}`);
            out(`  status: opro jobs ${launched.job_id}`);
            out(`  list:   opro jobs`);
          }
          return 0;
        }
      }
      // Live progress to stderr for interactive runs — generation makes several
      // sequential model calls and otherwise looks hung (esp. reasoning models).
      const clearProgress = !json ? installCliProgress("generate") : () => undefined;
      if (!json) {
        err("Generating… model calls run one after another; this can take a bit with reasoning models (gpt-5/o-series).");
      }
      if (!asBool(flags.single, false)) {
        // Default: A/B both arms (prompt-only vs Local KG) + a fresh report each run.
        let cmp: GenerateComparison;
        try {
          cmp = await opCompare(cwd, genOpts);
        } finally {
          clearProgress();
        }
        const noTests =
          cmp.baseline.generated_tests.length === 0 && cmp.grounded.generated_tests.length === 0;
        // Skip the report when there is nothing to compare — an all-zero report reads
        // as "broken" rather than "no testable behaviors yet".
        const report = cmp.model_provider !== "none" && !noTests ? writeCompareReport(cwd, cmp) : undefined;
        if (json) printJson({ ...cmp, ...(report ?? {}), ...diffMeta });
        else {
          printComparison(cmp);
          if (report) {
            out(`\nLocal KG tests:  ${report.local_kg_tests_path}   ← runnable, KEEP these`);
            out(`Local KG (JSON): ${report.local_kg_json_path}   ← structured cases`);
            out(`Baseline tests:  ${report.baseline_tests_path}   ← runnable, comparison-only`);
            out(`Baseline (JSON): ${report.baseline_json_path}   ← structured cases`);
            out(`Report:          ${report.report_path}`);
            out(`Report (JSON):   ${report.report_json_path}`);
          }
        }
        return 0;
      }
      // --single: generate just one arm (and persist the tests to the local graph).
      let res;
      try {
        res = await opGenerate(cwd, {
          ...genOpts,
          input_mode: asBool(flags.raw, false) ? "raw_prompt" : "graph_grounded"
        });
      } finally {
        clearProgress();
      }
      if (json) printJson({ ...res, run_hints: runnableRunHintsFor(res.generated_tests, cwd), ...diffMeta });
      else {
        if (res.model_provider === "none") out("No tests generated: no model provider configured (see guidance below).");
        else out(`Generated ${res.generated_tests.length} test(s) via ${res.model_provider}/${res.model_name} (repo files written: ${res.wrote_repo_files})`);
        if (res.model_provider !== "none" && res.generated_tests.length === 0) printNoAnchorsHelp();
        const evById = new Map(res.evidence.map((e) => [e.generated_test_id, e]));
        res.generated_tests.forEach((t, i) => {
          const path = suggestedTestPath(t, i);
          const ev = evById.get(t.id);
          out(`\n● ${t.title}  [${t.test_type} / ${t.framework_hint}]${t.bucket ? `  {${t.bucket}}` : ""}  id=${t.id}`);
          out(`  grounded by: ${t.grounding.entity_ids.join(", ") || "—"}`);
          out(`  source refs: ${t.grounding.source_refs.join(", ") || "—"}`);
          if (ev) {
            out(
              `  validated:   ${ev.validated_count}/${ev.evidence.length} citation(s) resolve to the graph; ${ev.proof_count} hard/reviewed citation${ev.has_proof ? "" : "  ⚠ no hard citation — verify before trusting"}`
            );
          }
          out(`  weak/candidate evidence used: ${t.weak_evidence_used ? "yes" : "no"}`);
          if (t.grounding.import_provenance) out(`  import:      ${t.grounding.import_provenance}`);
          out(`  write to:    ${path}`);
          if (t.runnable === false) {
            // Degrade honestly: a non-runnable draft gets NO run command and a
            // visible diagnostic instead of pretending it is ready to run.
            out(`  ⚠ DRAFT (not runnable): ${t.unresolved_reason ?? "fix the subject import before running."}`);
          } else {
            out(`  run:         ${suggestedRunCommand(t.framework_hint, path, cwd)}`);
          }
          out(indent(t.body));
        });
        if (res.generated_tests.length) {
          const s = res.evidence_summary;
          out(
            `\nProvenance: ${s.tests_with_proof}/${s.tests} test(s) cite hard/reviewed evidence for grounding` +
              (s.invalid_citations > 0 ? `; ${s.invalid_citations} broken citation(s)` : "") +
              (s.tests_without_validated_evidence > 0 ? `; ${s.tests_without_validated_evidence} with no resolvable evidence` : "") +
              "."
          );
          out("\nWrite each test to its path and run it (your repo's test command, or the suggestion above).");
          out("In Cursor/Claude Code/Codex the agent does this for you — OrangePro only generates the code.");
        }
        if (res.missing_evidence.length) {
          out("\nMissing evidence (too thin to generate a specific test):");
          for (const m of res.missing_evidence) out(`  - ${m.title}: needs ${m.needed.join("; ")}`);
        }
        for (const w of res.warnings) out(`  warning: ${w}`);
      }
      return 0;
    }

    case "explain": {
      const id = positionals[0];
      if (!id) {
        err("explain requires a generated_test_id");
        return 2;
      }
      const res = opExplain(cwd, id);
      if (json) printJson(res);
      else {
        out(`Test: ${res.title}  (${res.generated_test_id})`);
        out(`Behavior tested: ${res.behavior_tested}`);
        out("Grounded by:");
        for (const g of res.grounded_by) out(`  - [${g.evidence_strength}] ${g.kind} ${g.title}${g.source_ref ? `  (${g.source_ref})` : ""}`);
        out(`Source refs: ${res.source_refs.join(", ") || "—"}`);
        out(`Weak/candidate evidence used: ${res.weak_evidence_used ? "yes" : "no"}`);
        if (res.weak_relationships.length) {
          out("Weak relationships:");
          for (const w of res.weak_relationships) out(`  - ${w.from} -[${w.relation}]-> ${w.to}  (${w.reason}, conf ${w.confidence})`);
        }
        out(`Stale: ${res.stale}`);
      }
      return 0;
    }

    case "export": {
      // Only `--format graph-html` is explorer-only; boolean `--graph-html`
      // falls through to a full pack export (+ Markdown + explorer).
      const r = runExportCli(cwd, {
        format: typeof flags.format === "string" ? flags.format : undefined,
        out: typeof flags.out === "string" ? flags.out : undefined,
        include_generated_bodies: asBool(flags["include-generated-bodies"], false),
        graph_html: asBool(flags["graph-html"], false)
      });
      if (r.mode === "graph_html") {
        if (json) printJson({ graph_html_path: r.graph_html_path });
        else {
          out(`Evidence graph explorer: ${r.graph_html_path}`);
          out(`Open with: open ${r.graph_html_path}`);
        }
        return 0;
      }
      if (json) printJson(r);
      else {
        out(`Evidence pack:    ${r.pack_path}`);
        out(`Markdown summary: ${r.summary_path}`);
        out(`Schema valid:     ${r.valid}`);
        if (r.graph_html_path) out(`Graph explorer:   ${r.graph_html_path}`);
        for (const e of r.errors ?? []) out(`  schema error: ${e}`);
      }
      return 0;
    }

    case "jobs": {
      const id = positionals[0];
      if (id) {
        const rec = readJobRecord(cwd, id);
        if (!rec) {
          const m = `No background job '${id}' found under .orangepro/jobs.`;
          if (json) printJson({ error: m });
          else err(m);
          return 2;
        }
        const shown = jobDisplayStatus(rec);
        if (json) printJson({ ...rec, stale: shown === "stale" });
        else {
          out(`Job ${rec.id}: ${shown}${shown === "stale" ? " (process gone — never finished)" : ""}`);
          out(`  command: ${rec.command}`);
          out(`  created: ${rec.created_at}${rec.finished_at ? `   finished: ${rec.finished_at}` : ""}`);
          if (rec.outputs?.tests_path) out(`  tests:   ${rec.outputs.tests_path}`);
          if (rec.outputs?.report_path) out(`  report:  ${rec.outputs.report_path}`);
          if (rec.outputs?.result_path) out(`  result:  ${rec.outputs.result_path}   ← generated tests + run hints`);
          if (rec.error) out(`  error:   ${rec.error}`);
          if (existsSync(rec.log_path)) {
            const tail = readFileSync(rec.log_path, "utf8").trimEnd().split("\n").filter(Boolean).slice(-10);
            if (tail.length) {
              out("  log (tail):");
              for (const l of tail) out(`    ${l}`);
            }
          }
        }
        return 0;
      }
      const jobs = listJobs(cwd);
      if (json) printJson({ jobs: jobs.map((j) => ({ ...j, stale: jobDisplayStatus(j) === "stale" })) });
      else if (!jobs.length) out("No background jobs yet. Start one with: opro generate --background");
      else for (const j of jobs) { const o = j.outputs?.tests_path || j.outputs?.result_path; out(`  ${jobDisplayStatus(j).padEnd(8)} ${j.id}  ${j.created_at}${o ? `  → ${o}` : ""}`); }
      return 0;
    }

    case "agent": {
      const cliPath = resolve(process.argv[1] ?? "dist/local/cli.js");
      const pack = buildAgentWorkflowPack(cliPath, normalizeAgentClient(flags.client));
      if (json) printJson(pack);
      else out(renderAgentWorkflowPack(pack));
      return 0;
    }

    case "mcp": {
      await startLocalMcpServer();
      return 0;
    }

    default:
      err(`Unknown command: ${command}\n`);
      out(HELP);
      return 2;
  }
}

function indent(text: string): string {
  return text
    .split("\n")
    .map((l) => `    ${l}`)
    .join("\n");
}

/** Interactive y/N confirmation for a mutating action (TTY only; caller gates on isTTY). */
async function confirmTTY(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const ans = (await rl.question(question)).trim().toLowerCase();
    return ans === "y" || ans === "yes";
  } finally {
    rl.close();
  }
}

/** readline-backed interactive provider/model picker (shared by `setup` and `generate`). */
async function pickProviderInteractively(): Promise<ProviderSelection | null> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const choose: Chooser = async (title, options) => {
    out(title);
    options.forEach((o, i) => out(`  ${i + 1}) ${o}`));
    const ans = (await rl.question("Choice (number, or blank to cancel): ")).trim();
    const n = Number.parseInt(ans, 10);
    return Number.isInteger(n) && n >= 1 && n <= options.length ? n - 1 : -1;
  };
  const ask: Asker = (q) => rl.question(q);
  try {
    return await selectProviderAndModel(process.env, choose, ask);
  } finally {
    rl.close();
  }
}

/**
 * Spawn a detached child that runs the (long) A/B generation, returning a job
 * handle immediately. The child re-execs this CLI with `--__run-detached` and the
 * already-resolved generation flags. Only safe, non-secret params are recorded;
 * model keys come from the inherited env, never persisted.
 */
function launchBackgroundGenerate(
  cwd: string,
  genOpts: { target_ids?: string[]; framework?: string; limit?: number; provider?: string; model?: string; prompt_version?: "v2" | "v5" },
  opts: { single?: boolean; raw?: boolean } = {}
): { job_id: string; log_path: string; status_path: string } {
  const id = newJobId();
  const childArgs: string[] = ["generate", "--__run-detached", "--job-id", id];
  const args: Record<string, string | number | boolean> = {};
  if (genOpts.provider) { childArgs.push("--provider", genOpts.provider); args.provider = genOpts.provider; }
  if (genOpts.model) { childArgs.push("--model", genOpts.model); args.model = genOpts.model; }
  if (genOpts.framework) { childArgs.push("--framework", genOpts.framework); args.framework = genOpts.framework; }
  if (genOpts.limit) { childArgs.push("--limit", String(genOpts.limit)); args.limit = genOpts.limit; }
  if (genOpts.prompt_version && genOpts.prompt_version !== "v2") { childArgs.push("--prompt-version", genOpts.prompt_version); args.prompt_version = genOpts.prompt_version; }
  if (genOpts.target_ids?.length) { childArgs.push("--target", genOpts.target_ids.join(",")); args.targets = genOpts.target_ids.length; }
  if (opts.single) { childArgs.push("--single"); args.single = true; if (opts.raw) { childArgs.push("--raw"); args.raw = true; } }
  const rec: JobRecord = {
    id,
    status: "queued",
    command: "generate",
    created_at: new Date().toISOString(),
    cwd,
    args,
    log_path: jobLogPath(cwd, id)
  };
  writeJobRecord(cwd, rec);
  const child = spawn(process.execPath, [process.argv[1], ...childArgs], { cwd, detached: true, stdio: "ignore", env: process.env });
  // A spawn-level failure must not crash the launcher (it has already returned a
  // job handle) — surface it on the record instead of an uncaught error event.
  child.on("error", (e) => {
    updateJobRecord(cwd, id, { status: "failed", error: e instanceof Error ? e.message : String(e) });
  });
  child.unref();
  return { job_id: id, log_path: jobLogPath(cwd, id), status_path: jobJsonPath(cwd, id) };
}

/** Whether a recorded pid is still alive (best-effort; unknown pid => assume alive). */
function pidAlive(pid?: number): boolean {
  if (!pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "EPERM"; // exists but not signalable by us
  }
}

/** Display status, reconciling a 'running' record whose process is gone to 'stale'. */
function jobDisplayStatus(rec: JobRecord): string {
  return rec.status === "running" && rec.pid && !pidAlive(rec.pid) ? "stale" : rec.status;
}

function printNoAnchorsHelp(): void {
  out("The local graph has no testable behaviors yet. Add one of:");
  out("  - a requirements template:  opro analyze <repo> --paths requirements-template.csv");
  out("  - or analyze a repo that has tests (behaviors are inferred from test names).");
  out("Then re-run: opro generate");
}

function printComparison(cmp: GenerateComparison): void {
  if (cmp.model_provider === "none") {
    out("No comparison: no model provider configured (see guidance below).");
    for (const w of cmp.warnings) out(`  warning: ${w}`);
    return;
  }
  // Nothing to compare: a real model was configured but the graph had no behavior
  // anchors to target, so both arms are empty. Show actionable guidance instead of
  // an all-zero table that reads as a failure.
  if (cmp.baseline.generated_tests.length === 0 && cmp.grounded.generated_tests.length === 0) {
    out(`No comparison: ${cmp.model_provider}/${cmp.model_name} had no behavior anchors to target.`);
    printNoAnchorsHelp();
    for (const w of cmp.warnings) out(`  warning: ${w}`);
    return;
  }
  const s = cmp.scores;
  const mx = cmp.matrix;
  out(`Comparison via ${cmp.model_provider}/${cmp.model_name} — prompt-only baseline vs Local KG`);
  out(`shared system prompt: ${cmp.system_prompt_source} · scored by: ${cmp.scoring_method}`);
  if (cmp.rationale) out(`judge: ${cmp.rationale}`);
  out("");
  const row = (label: string, a: number, b: number): void =>
    out(`  | ${label.padEnd(20)} | ${String(a).padStart(11)} | ${String(b).padStart(8)} |`);
  out(`  | ${"score (0-100)".padEnd(20)} | prompt-only | Local KG |`);
  out(`  | ${"-".repeat(20)} | ----------: | -------: |`);
  row("Completeness", s.baseline.completeness, s.grounded.completeness);
  row("Context awareness", s.baseline.context_awareness, s.grounded.context_awareness);
  row("Accuracy", s.baseline.accuracy, s.grounded.accuracy);
  row("Domain specificity", s.baseline.domain_specificity, s.grounded.domain_specificity);
  out("");
  const mrow = (label: string, a: number | string, b: number | string): void =>
    out(`  | ${label.padEnd(26)} | ${String(a).padStart(11)} | ${String(b).padStart(8)} |`);
  out(`  | ${"comparison matrix".padEnd(26)} | prompt-only | Local KG |`);
  out(`  | ${"-".repeat(26)} | ----------: | -------: |`);
  mrow("Tests", mx.baseline.tests, mx.grounded.tests);
  mrow("Concrete assertions (avg)", mx.baseline.concrete_assertions_avg, mx.grounded.concrete_assertions_avg);
  mrow("Traceability (source refs)", mx.baseline.traceability_refs, mx.grounded.traceability_refs);
  mrow("Weak evidence disclosed", mx.baseline.weak_evidence_disclosed, mx.grounded.weak_evidence_disclosed);
  mrow("Smoke-only", mx.baseline.smoke_only, mx.grounded.smoke_only);
  out("");
  out("── prompt-only (baseline) ──");
  for (const t of cmp.baseline.generated_tests) {
    out(`\n● ${t.title}  [${t.test_type}/${t.framework_hint}]`);
    out(indent(t.body));
  }
  out("\n── Local KG (graph-grounded) ──");
  for (const t of cmp.grounded.generated_tests) {
    out(`\n● ${t.title}  [${t.test_type}/${t.framework_hint}]${t.bucket ? `  {${t.bucket}}` : ""}`);
    out(`  grounded by: ${t.grounding.entity_ids.join(", ") || "—"}`);
    out(`  source refs: ${t.grounding.source_refs.join(", ") || "—"}`);
    out(indent(t.body));
  }
  // Agent run hints for the Local KG (keep-these) arm. Empty for spec-mode (the
  // real-provider JSON/XML eval artifact), so this only shows for runnable code.
  if (cmp.grounded.run_hints.length) {
    out("\nWrite & run the Local KG tests (the agent does this for you):");
    for (const h of cmp.grounded.run_hints) {
      out(`  write to: ${h.suggested_path}`);
      out(`  run:      ${h.run_command}`);
    }
    out("In Cursor/Claude Code/Codex the agent writes each file, runs it, and reports pass/fail — OrangePro only generates the code.");
  } else if (cmp.grounded.generated_tests.length) {
    out("\nThese Local KG test cases are specs (an eval artifact), not runnable code.");
    out("Convert them, or run `opro generate --single` for runnable framework code with per-test write/run hints.");
  }
  for (const w of cmp.warnings) out(`  warning: ${w}`);
}

main()
  .then((code) => {
    if (code !== 0) process.exitCode = code;
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    // JSON consumers get a structured error envelope on stdout; humans get stderr.
    if (process.argv.includes("--json")) out(JSON.stringify({ error: message }, null, 2));
    else err(`opro: ${message}`);
    process.exitCode = 1;
  });
