#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import ts from "typescript";
import { opAnalyze, opCompare } from "../dist/local/operations.js";
import { loadGraph, workspacePaths } from "../dist/local/workspace.js";
import { looksJson, testsFileExt } from "../dist/local/generate/compareReport.js";
import { preloadTreeSitter } from "../dist/local/analyze/treeSitter/engine.js";
import { treeSitterLanguages } from "../dist/local/analyze/treeSitter/languages.js";

const DEFAULT_OUT_DIR = "artifacts/generated-test-validation";
const STATIC_CHECK_TIMEOUT_MS = 3000;

function usage() {
  return [
    "Usage: node scripts/validate-generated-tests.mjs --repo <path> [--repo <path> ...]",
    "",
    "Options:",
    "  --repo <path>       Local repository to analyze. Positional paths also work.",
    "  --provider <name>   Generation provider. Default: deterministic.",
    "  --model <name>      Model override for non-deterministic providers.",
    "  --limit <n>         Tests per arm. Default: 1.",
    "  --out <dir>         Output directory. Default: artifacts/generated-test-validation.",
    "  --include-markdown  Include markdown requirements during analyze.",
    "  --help              Show this help.",
    "",
    "The script writes validation.json and validation.md. It never writes generated",
    "tests into the target repositories."
  ].join("\n");
}

function parseArgs(argv) {
  const opts = {
    repos: [],
    provider: "deterministic",
    model: undefined,
    limit: 1,
    outDir: DEFAULT_OUT_DIR,
    includeMarkdown: false
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
    else if (a === "--out") opts.outDir = argv[++i];
    else if (a === "--include-markdown") opts.includeMarkdown = true;
    else if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
    else opts.repos.push(a);
  }
  opts.repos = opts.repos.map((r) => resolve(r));
  if (!opts.repos.length) throw new Error("At least one --repo path is required.");
  if (!Number.isFinite(opts.limit) || opts.limit < 1) throw new Error("--limit must be a positive integer.");
  return opts;
}

function commandOk(command, args) {
  try {
    execFileSync(command, args, { stdio: "ignore", timeout: STATIC_CHECK_TIMEOUT_MS });
    return true;
  } catch {
    return false;
  }
}

function commandAvailable(command) {
  return commandOk("sh", ["-c", `command -v ${command}`]);
}

const TOOLING = {
  python3: commandAvailable("python3"),
  gofmt: commandAvailable("gofmt")
};

function isSpecBody(body) {
  return looksJson(body) || (body || "").trimStart().startsWith("<");
}

function shortDiag(message) {
  return String(message || "")
    .replace(/\s+/g, " ")
    .slice(0, 240);
}

function writeTempFile(ext, body) {
  const dir = mkdtempSync(join(tmpdir(), "op-gen-validate-"));
  const cleanExt = ext.replace(/[^a-z0-9.]/gi, "") || "txt";
  const file = join(dir, `generated.${cleanExt}`);
  writeFileSync(file, body.endsWith("\n") ? body : `${body}\n`, "utf8");
  return { dir, file };
}

function validateTypeScriptLike(body, ext) {
  const diagnostics = ts.transpileModule(body, {
    fileName: ext.includes("tsx") ? "generated.tsx" : "generated.ts",
    reportDiagnostics: true,
    compilerOptions: {
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.ESNext,
      jsx: ts.JsxEmit.ReactJSX,
      esModuleInterop: true
    }
  }).diagnostics ?? [];
  return diagnostics
    .filter((d) => d.category === ts.DiagnosticCategory.Error)
    .map((d) => shortDiag(ts.flattenDiagnosticMessageText(d.messageText, " ")));
}

function validatePython(body) {
  if (!TOOLING.python3) return { warnings: ["python3 not found; skipped py_compile"], errors: [] };
  const { dir, file } = writeTempFile("py", body);
  try {
    execFileSync("python3", ["-m", "py_compile", file], { stdio: "pipe", timeout: STATIC_CHECK_TIMEOUT_MS });
    return { warnings: [], errors: [] };
  } catch (err) {
    const output = `${err?.stdout?.toString?.() ?? ""}${err?.stderr?.toString?.() ?? ""}`;
    return { warnings: [], errors: [shortDiag(output || err.message)] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function goImportSpecs(body) {
  const specs = [];
  const lines = body.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    const single = trimmed.match(/^import\s+(?:[A-Za-z_][A-Za-z0-9_]*\s+|\.\s+|_\s+)?"([^"]+)"/);
    if (single) {
      specs.push(single[1]);
      continue;
    }
    if (/^import\s*\($/.test(trimmed)) {
      for (i++; i < lines.length; i++) {
        const inBlock = lines[i].trim();
        if (inBlock === ")") break;
        const block = inBlock.match(/^(?:[A-Za-z_][A-Za-z0-9_]*\s+|\.\s+|_\s+)?"([^"]+)"/);
        if (block) specs.push(block[1]);
      }
    }
  }
  return specs;
}

function validateGo(body) {
  const errors = [];
  if (!/^\s*package\s+[A-Za-z_][A-Za-z0-9_]*\b/m.test(body)) errors.push("Go test is missing a package declaration.");
  if (!goImportSpecs(body).includes("testing")) errors.push('Go test is missing import "testing".');
  if (!/\bfunc\s+Test[A-Za-z0-9_]*\s*\(\s*t\s+\*testing\.T\s*\)/m.test(body)) {
    errors.push("Go test is missing a func Test...(t *testing.T) entrypoint.");
  }
  if (errors.length) return { warnings: [], errors };
  if (!TOOLING.gofmt) return { warnings: ["gofmt not found; ran structural Go check only"], errors: [] };
  const { dir, file } = writeTempFile("go", body);
  try {
    execFileSync("gofmt", [file], { stdio: "pipe", timeout: STATIC_CHECK_TIMEOUT_MS });
    return { warnings: [], errors: [] };
  } catch (err) {
    const output = `${err?.stdout?.toString?.() ?? ""}${err?.stderr?.toString?.() ?? ""}`;
    return { warnings: [], errors: [shortDiag(output || err.message)] };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

function hasBalancedBraces(body) {
  let depth = 0;
  let stringQuote = null;
  let lineComment = false;
  let blockComment = false;
  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    const next = body[i + 1];
    if (lineComment) {
      if (ch === "\n") lineComment = false;
      continue;
    }
    if (blockComment) {
      if (ch === "*" && next === "/") {
        blockComment = false;
        i++;
      }
      continue;
    }
    if (stringQuote) {
      if (ch === "\\") {
        i++;
        continue;
      }
      if (ch === stringQuote) stringQuote = null;
      continue;
    }
    if (ch === "/" && next === "/") {
      lineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      blockComment = true;
      i++;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      stringQuote = ch;
      continue;
    }
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth < 0) return false;
    }
  }
  return depth === 0 && !stringQuote && !blockComment;
}

function validateJava(body) {
  const errors = [];
  if (!/\bimport\s+org\.junit(?:\.jupiter\.api)?\.Test\s*;/.test(body)) errors.push("Java test is missing JUnit @Test import.");
  if (!/\bclass\s+[A-Za-z_][A-Za-z0-9_]*\s*\{/.test(body)) errors.push("Java test is missing a test class.");
  if (!/@Test\b/.test(body)) errors.push("Java test is missing an @Test method.");
  if (!/\bassert(?:True|False|Equals|NotNull|Null|Throws)\s*\(|\b(?:Assertions|Assert)\./.test(body)) {
    errors.push("Java test is missing a JUnit assertion.");
  }
  if (!hasBalancedBraces(body)) errors.push("Java test has unbalanced braces.");
  return { warnings: [], errors };
}

function staticFormatCheck(test) {
  const framework = (test.framework_hint || "").toLowerCase();
  const body = test.body || "";
  const ext = testsFileExt(test.framework_hint || "", [body]);
  if (isSpecBody(body)) return { errors: [], warnings: [] };
  if (framework.includes("pytest") || framework.includes("python")) return validatePython(body);
  if (framework.includes("go")) return validateGo(body);
  if (framework.includes("junit") || framework.includes("java")) return validateJava(body);
  if (
    framework.includes("vitest") ||
    framework.includes("jest") ||
    framework.includes("playwright") ||
    framework.includes("cypress") ||
    framework.includes("mocha") ||
    framework.includes("ava")
  ) {
    return { errors: validateTypeScriptLike(body, ext), warnings: [] };
  }
  return { errors: [], warnings: [`No static format checker for framework '${test.framework_hint || "unknown"}'`] };
}

function expectedPathRule(test) {
  const framework = (test.framework_hint || "").toLowerCase();
  const ext = testsFileExt(test.framework_hint || "", [test.body || ""]);
  if (framework.includes("go")) return { ok: (p) => /_test\.go$/.test(p), message: "Go run hint path must end in _test.go" };
  if (framework.includes("junit") || framework.includes("java")) return { ok: (p) => /\.java$/.test(p), message: "JUnit run hint path must end in .java" };
  if (framework.includes("pytest") || framework.includes("python")) return { ok: (p) => /\.py$/.test(p), message: "pytest run hint path must end in .py" };
  if (framework.includes("playwright")) return { ok: (p) => new RegExp(`\\.spec\\.ts${ext.endsWith("tsx") ? "x" : ""}$`).test(p), message: "Playwright run hint path must be .spec.ts/.spec.tsx" };
  if (framework.includes("cypress")) return { ok: (p) => new RegExp(`\\.cy\\.ts${ext.endsWith("tsx") ? "x" : ""}$`).test(p), message: "Cypress run hint path must be .cy.ts/.cy.tsx" };
  if (framework.includes("vitest") || framework.includes("jest")) return { ok: (p) => new RegExp(`\\.test\\.ts${ext.endsWith("tsx") ? "x" : ""}$`).test(p), message: "TS test run hint path must be .test.ts/.test.tsx" };
  if (framework.includes("ava")) return { ok: (p) => /\.test\.[cm]?[jt]sx?$/.test(p), message: "AVA run hint path must be .test.js/.test.ts" };
  return null;
}

function validateRunCommand(test, hint) {
  const framework = (test.framework_hint || "").toLowerCase();
  const command = hint?.run_command || "";
  if (framework.includes("go") && command !== "go test ./...") return "Go run command should be go test ./...";
  if ((framework.includes("junit") || framework.includes("java")) && !/^(?:\.\/mvnw|mvn)\s+test\s+-Dtest=|^(?:\.\/gradlew|gradle)\s+test\s+--tests\s+/.test(command)) {
    return "JUnit run command should use Maven/Gradle test with a test-class selector";
  }
  if ((framework.includes("pytest") || framework.includes("python")) && !command.startsWith("pytest ")) return "pytest run command should start with pytest";
  if (framework.includes("vitest") && !command.startsWith("npx vitest run ")) return "Vitest run command should start with npx vitest run";
  if (framework.includes("jest") && !command.startsWith("npx jest ")) return "Jest run command should start with npx jest";
  if (framework.includes("playwright") && !command.startsWith("npx playwright test ")) return "Playwright run command should start with npx playwright test";
  if (framework.includes("cypress") && !command.startsWith("npx cypress run --spec ")) return "Cypress run command should start with npx cypress run --spec";
  if (framework.includes("ava") && !command.startsWith("npx ava ")) return "AVA run command should start with npx ava";
  return null;
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
  if (fw.includes("vitest") || fw.includes("jest") || fw.includes("playwright") || fw.includes("cypress") || fw.includes("mocha") || fw.includes("ava")) {
    return language === "typescript" || language === "javascript";
  }
  return true;
}

export function validateGeneratedTest(test, hint, graph) {
  const errors = [];
  const warnings = [];
  const runnable = test.runnable !== false && !isSpecBody(test.body || "");
  const status = runnable ? "runnable" : "draft";
  const targetLanguage = targetLanguageForTest(graph, test);
  if (runnable && !hint) errors.push("Runnable test has no run hint.");
  if (!runnable && hint) errors.push("Draft/spec test has a run hint; this would imply it is runnable.");
  if (runnable && targetLanguage && !frameworkMatchesLanguage(test.framework_hint || "", targetLanguage)) {
    errors.push(`Framework/target mismatch: ${test.framework_hint || "unknown"} generated for ${targetLanguage} target.`);
  }
  if (hint) {
    const rule = expectedPathRule(test);
    if (rule && !rule.ok(hint.suggested_path || "")) errors.push(rule.message);
    const commandIssue = validateRunCommand(test, hint);
    if (commandIssue) errors.push(commandIssue);
  }
  if (runnable) {
    const checked = staticFormatCheck(test);
    errors.push(...checked.errors.map((e) => `Static format check failed: ${e}`));
    warnings.push(...checked.warnings);
  }
  return {
    id: test.id,
    title: test.title,
    framework: test.framework_hint,
    target_language: targetLanguage,
    status,
    runnable: test.runnable !== false,
    unresolved_reason: test.unresolved_reason || "",
    has_run_hint: Boolean(hint),
    suggested_path: hint?.suggested_path || "",
    run_command: hint?.run_command || "",
    body_lines: (test.body || "").split(/\r?\n/).length,
    errors,
    warnings
  };
}

function graphStats(workspaceRoot) {
  const graph = loadGraph(workspacePaths(workspaceRoot).graphPath);
  const byRel = {};
  const byCandidateRel = {};
  for (const edge of graph.relationships ?? []) byRel[edge.relationship_type] = (byRel[edge.relationship_type] ?? 0) + 1;
  for (const edge of graph.candidate_relationships ?? []) byCandidateRel[edge.relationship_type] = (byCandidateRel[edge.relationship_type] ?? 0) + 1;
  const eligible = (graph.nodes ?? []).filter((n) => n.kind === "CodeSymbol" && n.denominator_eligible === true && n.stale !== true);
  const files = (graph.nodes ?? []).filter((n) => n.kind === "File");
  return {
    files: files.length,
    nodes: graph.nodes?.length ?? 0,
    relationships: graph.relationships?.length ?? 0,
    candidate_relationships: graph.candidate_relationships?.length ?? 0,
    behavior_denominator: eligible.length,
    calls: byRel.CALLS ?? 0,
    may_calls: byCandidateRel.MAY_CALL ?? 0,
    hard_test_edges: (byRel.TESTED_BY ?? 0) + (byRel.COVERS ?? 0)
  };
}

function summarizeArm(arm, armName, graph) {
  const hintsById = new Map((arm.run_hints ?? []).map((h) => [h.generated_test_id, h]));
  const tests = (arm.generated_tests ?? []).map((t) => validateGeneratedTest(t, hintsById.get(t.id), graph));
  const errors = tests.flatMap((t) => t.errors.map((message) => ({ test_id: t.id, title: t.title, message })));
  const warnings = tests.flatMap((t) => t.warnings.map((message) => ({ test_id: t.id, title: t.title, message })));
  const frameworks = {};
  for (const t of tests) frameworks[t.framework || "unknown"] = (frameworks[t.framework || "unknown"] ?? 0) + 1;
  return {
    arm: armName,
    generated: tests.length,
    runnable: tests.filter((t) => t.status === "runnable").length,
    drafts: tests.filter((t) => t.status !== "runnable").length,
    run_hints: arm.run_hints?.length ?? 0,
    frameworks,
    warnings,
    errors,
    tests
  };
}

function averageScore(dimensions) {
  const values = Object.values(dimensions ?? {}).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (!values.length) return 0;
  return Math.round(values.reduce((a, b) => a + b, 0) / values.length);
}

function gitHead(root) {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
  } catch {
    return null;
  }
}

function gitDirty(root) {
  try {
    return execFileSync("git", ["status", "--short"], { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString().trim().length > 0;
  } catch {
    return null;
  }
}

async function validateRepo(repo, opts) {
  const workspace = mkdtempSync(join(tmpdir(), "op-gen-dataset-"));
  try {
    const analyze = opAnalyze(workspace, { source: repo, includeMarkdown: opts.includeMarkdown });
    const cmp = await opCompare(workspace, { provider: opts.provider, model: opts.model, limit: opts.limit });
    const graph = loadGraph(workspacePaths(workspace).graphPath);
    const grounded = summarizeArm(cmp.grounded, "grounded", graph);
    const baseline = summarizeArm(cmp.baseline, "baseline", graph);
    const baselineScore = averageScore(cmp.scores.baseline);
    const groundedScore = averageScore(cmp.scores.grounded);
    return {
      repo,
      repo_name: basename(repo),
      repo_commit: gitHead(repo),
      repo_dirty: gitDirty(repo),
      workspace_deleted: true,
      analyze,
      graph: graphStats(workspace),
      provider: cmp.model_provider,
      model: cmp.model_name,
      scoring_method: cmp.scoring_method,
      scores: cmp.scores,
      lift: {
        baseline_score: baselineScore,
        grounded_score: groundedScore,
        delta: groundedScore - baselineScore
      },
      matrix: cmp.matrix,
      warnings: cmp.warnings,
      arms: { grounded, baseline },
      errors: [...grounded.errors.map((e) => ({ arm: "grounded", ...e })), ...baseline.errors.map((e) => ({ arm: "baseline", ...e }))]
    };
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

function renderMarkdown(report) {
  const lines = [];
  lines.push("# Generated Test Validation Dataset");
  lines.push("");
  lines.push(`Generated: ${report.generated_at}`);
  lines.push(`OrangePro commit: ${report.orangepro_commit || "unknown"}${report.orangepro_dirty ? " (dirty working tree)" : ""}`);
  lines.push(`Provider: ${report.provider}${report.model ? ` / ${report.model}` : ""}`);
  lines.push(`Limit per arm: ${report.limit}`);
  lines.push("");
  lines.push("This dataset checks the generated test artifacts without writing them into target repos.");
  lines.push("Runnable tests must have a matching run hint and pass a cheap framework-specific syntax check.");
  lines.push("");
  lines.push("| Repo | Denominator | CALLS | MAY_CALL | Lift | Grounded tests | Grounded runnable | Grounded issues | Baseline tests | Baseline runnable | Baseline issues |");
  lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
  for (const r of report.repos) {
    const g = r.arms.grounded;
    const b = r.arms.baseline;
    lines.push(
      `| ${r.repo_name} | ${r.graph.behavior_denominator} | ${r.graph.calls} | ${r.graph.may_calls} | ${r.lift.delta >= 0 ? "+" : ""}${r.lift.delta} | ${g.generated} | ${g.runnable} | ${g.errors.length} | ${b.generated} | ${b.runnable} | ${b.errors.length} |`
    );
  }
  lines.push("");
  for (const r of report.repos) {
    lines.push(`## ${r.repo_name}`);
    lines.push("");
    lines.push(`Repo commit: ${r.repo_commit || "unknown"}${r.repo_dirty ? " (dirty)" : ""}`);
    lines.push(`Graph: ${r.graph.files} files, ${r.graph.behavior_denominator} counted behaviors, ${r.graph.calls} exact calls, ${r.graph.may_calls} likely calls.`);
    lines.push(`Lift: Local KG ${r.lift.grounded_score} vs baseline ${r.lift.baseline_score} (${r.lift.delta >= 0 ? "+" : ""}${r.lift.delta}).`);
    for (const armName of ["grounded", "baseline"]) {
      const arm = r.arms[armName];
      lines.push("");
      lines.push(`### ${armName === "grounded" ? "Local KG grounded" : "Prompt-only baseline"}`);
      lines.push("");
      lines.push(`Generated ${arm.generated}; runnable ${arm.runnable}; drafts ${arm.drafts}; run hints ${arm.run_hints}.`);
      lines.push(`Frameworks: ${Object.entries(arm.frameworks).map(([k, v]) => `${k}=${v}`).join(", ") || "none"}.`);
      for (const t of arm.tests.slice(0, 5)) {
        lines.push(`- ${t.title}: ${t.framework}, ${t.target_language || "unknown"} target, ${t.status}${t.suggested_path ? `, ${t.suggested_path}` : ""}`);
        if (t.unresolved_reason) lines.push(`  - Draft reason: ${t.unresolved_reason}`);
        for (const e of t.errors) lines.push(`  - ERROR: ${e}`);
        for (const w of t.warnings) lines.push(`  - Warning: ${w}`);
      }
      if (arm.tests.length > 5) lines.push(`- ${arm.tests.length - 5} more tests omitted from this summary; see validation.json.`);
    }
    if (r.errors.length) {
      lines.push("");
      lines.push("### Blocking issues");
      for (const e of r.errors) lines.push(`- ${e.arm} / ${e.title}: ${e.message}`);
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
    limit: opts.limit,
    include_markdown: opts.includeMarkdown,
    repos: []
  };
  for (const repo of opts.repos) {
    if (!existsSync(repo)) throw new Error(`Repo path does not exist: ${repo}`);
    console.error(`Validating generated tests for ${repo}`);
    report.repos.push(await validateRepo(repo, opts));
  }
  const outDir = resolve(opts.outDir);
  mkdirSync(outDir, { recursive: true });
  const jsonPath = join(outDir, "validation.json");
  const mdPath = join(outDir, "validation.md");
  writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  writeFileSync(mdPath, renderMarkdown(report), "utf8");
  const errors = report.repos.flatMap((r) => r.errors);
  console.log(`Wrote ${jsonPath}`);
  console.log(`Wrote ${mdPath}`);
  if (errors.length) {
    console.error(`Generated-test validation found ${errors.length} blocking issue(s).`);
    process.exitCode = 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err?.stack || err?.message || String(err));
    process.exitCode = 1;
  });
}
