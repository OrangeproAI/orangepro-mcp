#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { opAnalyze, opCompare } from "../dist/local/operations.js";
import { loadGraph, workspacePaths } from "../dist/local/workspace.js";
import { preloadTreeSitter } from "../dist/local/analyze/treeSitter/engine.js";
import { treeSitterLanguages } from "../dist/local/analyze/treeSitter/languages.js";

const DEFAULT_OUT_DIR = "artifacts/generated-test-execution-smoke";
const DEFAULT_TIMEOUT_MS = 300000;

function usage() {
  return [
    "Usage: node scripts/run-generated-test-smoke.mjs --repo <path> [--repo <path> ...]",
    "",
    "Options:",
    "  --repo <path>       Local repository to analyze and smoke in a temp copy.",
    "  --provider <name>   Generation provider. Default: deterministic.",
    "  --model <name>      Model override for non-deterministic providers.",
    "  --limit <n>         Tests per arm. Default: 1.",
    "  --arm <name>        grounded|baseline|both. Default: grounded.",
    "  --out <dir>         Output directory. Default: artifacts/generated-test-execution-smoke.",
    "  --timeout-ms <n>    Per setup/run command timeout. Default: 300000.",
    "  --keep-workspaces   Keep temp repo copies for debugging.",
    "",
    "The script writes execution.json and execution.md. It never writes generated",
    "tests into the original target repositories."
  ].join("\n");
}

function parseArgs(argv) {
  const opts = {
    repos: [],
    provider: "deterministic",
    model: undefined,
    limit: 1,
    arm: "grounded",
    outDir: DEFAULT_OUT_DIR,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    keepWorkspaces: false
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--help" || a === "-h") {
      console.log(usage());
      process.exit(0);
    }
    if (a === "--repo") opts.repos.push(argv[++i]);
    else if (a === "--provider") opts.provider = argv[++i];
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "--limit") opts.limit = Number.parseInt(argv[++i], 10);
    else if (a === "--arm") opts.arm = argv[++i];
    else if (a === "--out") opts.outDir = argv[++i];
    else if (a === "--timeout-ms") opts.timeoutMs = Number.parseInt(argv[++i], 10);
    else if (a === "--keep-workspaces") opts.keepWorkspaces = true;
    else if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
    else opts.repos.push(a);
  }
  opts.repos = opts.repos.map((r) => resolve(r));
  if (!opts.repos.length) throw new Error("At least one --repo path is required.");
  if (!["grounded", "baseline", "both"].includes(opts.arm)) throw new Error("--arm must be grounded, baseline, or both.");
  if (!Number.isFinite(opts.limit) || opts.limit < 1) throw new Error("--limit must be a positive integer.");
  if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs < 1000) throw new Error("--timeout-ms must be >= 1000.");
  return opts;
}

function gitHead(root) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, stdio: [ "ignore", "pipe", "ignore" ] }).toString().trim();
  } catch {
    return null;
  }
}

function gitDirty(root) {
  try {
    return execFileSync("git", ["status", "--short"], { cwd: root, stdio: [ "ignore", "pipe", "ignore" ] }).toString().trim().length > 0;
  } catch {
    return null;
  }
}

function graphStatsFromGraph(graph) {
  const byRel = {};
  const byCandidateRel = {};
  for (const edge of graph.relationships ?? []) byRel[edge.relationship_type] = (byRel[edge.relationship_type] ?? 0) + 1;
  for (const edge of graph.candidate_relationships ?? []) byCandidateRel[edge.relationship_type] = (byCandidateRel[edge.relationship_type] ?? 0) + 1;
  const eligible = (graph.nodes ?? []).filter((n) => n.kind === "CodeSymbol" && n.denominator_eligible === true && n.stale !== true);
  const files = (graph.nodes ?? []).filter((n) => n.kind === "File");
  return {
    files: files.length,
    behavior_denominator: eligible.length,
    calls: byRel.CALLS ?? 0,
    may_calls: byCandidateRel.MAY_CALL ?? 0,
    hard_test_edges: (byRel.TESTED_BY ?? 0) + (byRel.COVERS ?? 0)
  };
}

function languageFromPath(rel) {
  const ext = String(rel || "").split(".").pop()?.toLowerCase() || "";
  if (["ts", "tsx", "mts", "cts"].includes(ext)) return "typescript";
  if (["js", "jsx", "mjs", "cjs"].includes(ext)) return "javascript";
  if (ext === "py") return "python";
  if (ext === "go") return "go";
  if (ext === "java") return "java";
  return "";
}

function graphNode(graph, externalId) {
  return (graph.nodes ?? []).find((n) => n.external_id === externalId) || null;
}

function languageForFile(graph, rel) {
  const fileNode = (graph.nodes ?? []).find((n) => n.kind === "File" && (n.external_id === rel || n.properties?.file === rel));
  return typeof fileNode?.properties?.language === "string" ? fileNode.properties.language : languageFromPath(rel);
}

function languageForNode(graph, node) {
  if (!node) return "";
  if (node.kind === "CodeSymbol" && typeof node.properties?.file === "string") return languageForFile(graph, node.properties.file);
  if (node.kind === "File") return languageForFile(graph, node.external_id);
  return "";
}

function targetLanguageForTest(graph, test) {
  for (const id of test.grounding?.entity_ids ?? []) {
    const node = graphNode(graph, id);
    const language = languageForNode(graph, node) || (id.includes("/") ? languageForFile(graph, id) : "");
    if (language) return language;
  }
  return "";
}

function frameworkMatchesLanguage(framework, language) {
  const fw = (framework || "").toLowerCase();
  if (!language) return true;
  if (fw.includes("go")) return language === "go";
  if (fw.includes("pytest") || fw.includes("python")) return language === "python";
  if (fw.includes("junit") || fw.includes("java")) return language === "java";
  if (fw.includes("vitest") || fw.includes("jest") || fw.includes("playwright") || fw.includes("cypress") || fw.includes("mocha")) {
    return language === "typescript" || language === "javascript";
  }
  return true;
}

function averageScore(dimensions) {
  const values = Object.values(dimensions ?? {}).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!values.length) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function runShell(command, cwd, timeoutMs) {
  const started = Date.now();
  const res = spawnSync("sh", ["-lc", command], {
    cwd,
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024
  });
  const output = `${res.stdout || ""}${res.stderr || ""}`;
  return {
    command,
    exit_code: typeof res.status === "number" ? res.status : null,
    signal: res.signal || null,
    timed_out: Boolean(res.error && res.error.code === "ETIMEDOUT"),
    duration_ms: Date.now() - started,
    ok: res.status === 0,
    output_tail: output.split(/\r?\n/).slice(-80).join("\n")
  };
}

function copyRepoToTemp(repo) {
  const parent = mkdtempSync(join(tmpdir(), "op-generated-run-"));
  const dst = join(parent, basename(repo));
  execFileSync(
    "rsync",
    [
      "-a",
      "--delete",
      "--exclude=.git",
      "--exclude=.orangepro",
      "--exclude=node_modules",
      "--exclude=.venv",
      "--exclude=target",
      "--exclude=.gradle",
      "--exclude=build",
      `${repo.replace(/\/$/, "")}/`,
      `${dst}/`
    ],
    { stdio: "pipe" }
  );
  return { parent, dst };
}

function packageManager(root) {
  const pkg = join(root, "package.json");
  if (!existsSync(pkg)) return null;
  try {
    const data = JSON.parse(readFileSync(pkg, "utf8")).packageManager || "";
    if (typeof data === "string" && data.startsWith("pnpm@")) return "pnpm";
    if (typeof data === "string" && data.startsWith("yarn@")) return "yarn";
    if (typeof data === "string" && data.startsWith("npm@")) return "npm";
  } catch {
    /* fall through to lockfiles */
  }
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  if (existsSync(join(root, "package-lock.json"))) return "npm";
  return "npm";
}

function setupCommand(framework, root) {
  const fw = (framework || "").toLowerCase();
  if (fw.includes("pytest") || fw.includes("python")) {
    return "uv venv .venv && uv pip install -e . pytest";
  }
  if (fw.includes("vitest") || fw.includes("jest") || fw.includes("playwright") || fw.includes("cypress") || fw.includes("mocha")) {
    const pm = packageManager(root);
    if (pm === "pnpm") return "pnpm install --frozen-lockfile=false";
    if (pm === "yarn") return "yarn install --ignore-scripts";
    if (pm === "npm") return existsSync(join(root, "package-lock.json")) ? "npm ci" : "npm install";
  }
  return "";
}

function runnableCommand(framework, runCommand, root) {
  const fw = (framework || "").toLowerCase();
  if (fw.includes("pytest") || fw.includes("python")) return `. .venv/bin/activate && ${runCommand}`;
  if ((fw.includes("junit") || fw.includes("java")) && runCommand.startsWith("./mvnw ") && !existsSync(join(root, "mvnw"))) {
    return `mvn ${runCommand.slice("./mvnw ".length)}`;
  }
  return runCommand;
}

function safeWriteGenerated(root, relPath, body) {
  const abs = resolve(root, relPath);
  const rootWithSep = resolve(root) + sep;
  if (!abs.startsWith(rootWithSep)) throw new Error(`Refusing to write generated test outside temp repo: ${relPath}`);
  mkdirSync(dirname(abs), { recursive: true });
  writeFileSync(abs, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return abs;
}

function testRows(arm, armName) {
  const hintsById = new Map((arm.run_hints ?? []).map((h) => [h.generated_test_id, h]));
  return (arm.generated_tests ?? []).map((test) => ({ arm: armName, test, hint: hintsById.get(test.id) || null }));
}

async function smokeRepo(repo, opts) {
  const workspace = mkdtempSync(join(tmpdir(), "op-generated-smoke-"));
  try {
    const analyze = opAnalyze(workspace, { source: repo, includeMarkdown: false });
    const cmp = await opCompare(workspace, { provider: opts.provider, model: opts.model, limit: opts.limit });
    const graph = loadGraph(workspacePaths(workspace).graphPath);
    const arms = opts.arm === "both" ? ["grounded", "baseline"] : [opts.arm];
    const rows = arms.flatMap((arm) => testRows(cmp[arm], arm));
    const baselineScore = averageScore(cmp.scores.baseline);
    const groundedScore = averageScore(cmp.scores.grounded);
    const executions = [];
    for (const row of rows) {
      const framework = row.test.framework_hint || "";
      const targetLanguage = targetLanguageForTest(graph, row.test);
      const { parent, dst } = copyRepoToTemp(repo);
      const execution = {
        arm: row.arm,
        test_id: row.test.id,
        title: row.test.title,
        framework,
        target_language: targetLanguage,
        runnable: row.test.runnable !== false,
        suggested_path: row.hint?.suggested_path || "",
        run_command: row.hint?.run_command || "",
        unresolved_reason: row.test.unresolved_reason || "",
        temp_repo: opts.keepWorkspaces ? dst : "",
        setup: null,
        run: null,
        result: "skipped"
      };
      try {
        if (row.test.runnable === false || !row.hint) {
          execution.result = "not_runnable";
          executions.push(execution);
          continue;
        }
        if (targetLanguage && !frameworkMatchesLanguage(framework, targetLanguage)) {
          execution.result = "framework_mismatch";
          execution.error = `Framework/target mismatch: ${framework || "unknown"} generated for ${targetLanguage} target.`;
          executions.push(execution);
          continue;
        }
        safeWriteGenerated(dst, row.hint.suggested_path, row.test.body || "");
        const setup = setupCommand(framework, dst);
        if (setup) {
          execution.setup = runShell(setup, dst, opts.timeoutMs);
          if (!execution.setup.ok) {
            execution.result = "setup_failed";
            executions.push(execution);
            continue;
          }
        }
        const command = runnableCommand(framework, row.hint.run_command, dst);
        execution.run = runShell(command, dst, opts.timeoutMs);
        execution.result = execution.run.ok ? "passed" : "failed";
        executions.push(execution);
      } finally {
        if (!opts.keepWorkspaces) rmSync(parent, { recursive: true, force: true });
      }
    }
    return {
      repo,
      repo_name: basename(repo),
      repo_commit: gitHead(repo),
      repo_dirty: gitDirty(repo),
      workspace_deleted: true,
      analyze,
      graph: graphStatsFromGraph(graph),
      provider: cmp.model_provider,
      model: cmp.model_name,
      scoring_method: cmp.scoring_method,
      warnings: cmp.warnings ?? [],
      lift: {
        baseline_score: baselineScore,
        grounded_score: groundedScore,
        delta: groundedScore - baselineScore
      },
      generated: {
        baseline: cmp.baseline.generated_tests.length,
        grounded: cmp.grounded.generated_tests.length
      },
      executions
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Generated Test Execution Smoke");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`OrangePro commit: ${report.orangepro_commit || "unknown"}${report.orangepro_dirty ? " (dirty working tree)" : ""}`);
  lines.push(`Provider: ${report.provider}${report.model ? ` / ${report.model}` : ""}`);
  lines.push(`Arm(s): ${report.arm}; limit per arm: ${report.limit}`);
  lines.push("");
  lines.push("This smoke writes generated tests into disposable repo copies, runs the repo test command, and deletes the copies unless --keep-workspaces is set.");
  lines.push("The original public repos are never modified.");
  if (report.provider === "deterministic") {
    lines.push("");
    lines.push("Note: deterministic output proves the file format and run pipeline. Promotion lift should be regenerated with a real BYOK model and stamped with provider/model.");
  }
  lines.push("");
  lines.push("| Repo | Lift | Generated | Executed | Passed | Failed | Setup failed | Framework mismatch | Not runnable |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of report.repos) {
    const executed = r.executions.filter((e) => e.result === "passed" || e.result === "failed").length;
    const passed = r.executions.filter((e) => e.result === "passed").length;
    const failed = r.executions.filter((e) => e.result === "failed").length;
    const setupFailed = r.executions.filter((e) => e.result === "setup_failed").length;
    const frameworkMismatch = r.executions.filter((e) => e.result === "framework_mismatch").length;
    const notRunnable = r.executions.filter((e) => e.result === "not_runnable").length;
    lines.push(
      `| ${r.repo_name} | ${r.lift.delta >= 0 ? "+" : ""}${r.lift.delta} | ${r.generated.grounded}/${r.generated.baseline} | ${executed} | ${passed} | ${failed} | ${setupFailed} | ${frameworkMismatch} | ${notRunnable} |`
    );
  }
  lines.push("");
  for (const r of report.repos) {
    lines.push(`## ${r.repo_name}`);
    lines.push("");
    lines.push(`Repo commit: ${r.repo_commit || "unknown"}${r.repo_dirty ? " (dirty)" : ""}`);
    lines.push(`Graph: ${r.graph.files} files, ${r.graph.behavior_denominator} counted behaviors, ${r.graph.calls} exact calls, ${r.graph.may_calls} likely calls.`);
    lines.push(`Lift: Local KG ${r.lift.grounded_score} vs baseline ${r.lift.baseline_score} (${r.lift.delta >= 0 ? "+" : ""}${r.lift.delta}).`);
    for (const warning of r.warnings ?? []) lines.push(`Warning: ${warning}`);
    lines.push("");
    for (const e of r.executions) {
      lines.push(`- ${e.arm} / ${e.title}: ${e.result}, ${e.framework}, ${e.target_language || "unknown"} target, ${e.suggested_path}`);
      if (e.error) lines.push(`  - error: ${e.error}`);
      if (e.unresolved_reason) lines.push(`  - draft reason: ${e.unresolved_reason}`);
      if (e.setup) lines.push(`  - setup: ${e.setup.ok ? "pass" : "fail"} (${e.setup.duration_ms}ms) ${e.setup.command}`);
      if (e.run) lines.push(`  - run: ${e.run.ok ? "pass" : "fail"} (${e.run.duration_ms}ms) ${e.run.command}`);
      if (e.result !== "passed") {
        const tail = e.run?.output_tail || e.setup?.output_tail || "";
        if (tail) lines.push(`  - tail: ${tail.split(/\r?\n/).slice(-8).join(" ").slice(0, 500)}`);
      }
    }
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

async function main() {
  if (!existsSync("dist/local/operations.js")) {
    throw new Error("dist/local/operations.js not found. Run npm run build before this script.");
  }
  const opts = parseArgs(process.argv.slice(2));
  await preloadTreeSitter(treeSitterLanguages());
  const report = {
    generated_at: new Date().toISOString(),
    orangepro_commit: gitHead(process.cwd()),
    orangepro_dirty: gitDirty(process.cwd()),
    provider: opts.provider,
    model: opts.model || "",
    arm: opts.arm,
    limit: opts.limit,
    timeout_ms: opts.timeoutMs,
    repos: []
  };
  for (const repo of opts.repos) {
    if (!existsSync(repo)) throw new Error(`Repo path does not exist: ${repo}`);
    console.error(`Running generated-test smoke for ${repo}`);
    report.repos.push(await smokeRepo(repo, opts));
  }
  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "execution.json");
  const mdPath = join(outDir, "execution.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  const failures = report.repos.flatMap((r) => r.executions.filter((e) => e.result !== "passed"));
  if (failures.length) {
    console.error(`Generated-test execution smoke found ${failures.length} non-passing result(s).`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error(err?.stack || err?.message || String(err));
  process.exitCode = 1;
});
