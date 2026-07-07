import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { reportProgress } from "../util/progress.js";

export type CoverageArtifactFormat =
  | "go-coverprofile"
  | "lcov"
  | "cobertura"
  | "jacoco"
  | "coverage-py"
  | "simplecov"
  | "clover"
  | "unknown";

export interface CoverageArtifactInfo {
  path: string;
  language: "go" | "tsjs" | "python" | "java" | "csharp" | "ruby" | "php" | "unknown";
  format: CoverageArtifactFormat;
  ingestible: boolean;
  source: "existing" | "generated";
}

export interface CoverageCommandSuggestion {
  language: string;
  cwd: string;
  command: string;
  artifact_path?: string;
  reason: string;
}

export interface CoverageGenerationResult {
  language: string;
  module_dir: string;
  command: string;
  artifact_path?: string;
  ok: boolean;
  partial?: boolean;
  reason?: string;
}

export interface RuntimeCoveragePrepareResult {
  root: string;
  coverage_dir: string;
  artifacts: CoverageArtifactInfo[];
  generated: CoverageGenerationResult[];
  suggested_commands: CoverageCommandSuggestion[];
  warnings: string[];
}

export interface RuntimeCoveragePrepareOptions {
  generate?: boolean;
  timeoutMs?: number;
  /** Aggregate wall-clock budget across all coverage commands. Remaining modules are skipped once exceeded. */
  budgetMs?: number;
  runner?: CommandRunner;
}

export type CommandRunner = (cwd: string, command: string, args: string[], timeoutMs: number) => { status: number | null; stdout: string; stderr: string; error?: Error };

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_BUDGET_MS = 600_000;
const GENERATED_COVERAGE_DIR = ".orangepro/coverage";
const MAVEN_JACOCO_REPORT_GOAL = "org.jacoco:jacoco-maven-plugin:0.8.12:report";
const IGNORE_DIRS = new Set([".git", "node_modules", "vendor", "target", "dist", "build", ".orangepro", ".venv", "venv", ".tox", "__pycache__"]);

const KNOWN_ARTIFACTS: Array<Omit<CoverageArtifactInfo, "source">> = [
  { path: "coverage.out", language: "go", format: "go-coverprofile", ingestible: true },
  { path: "cover.out", language: "go", format: "go-coverprofile", ingestible: true },
  { path: "coverprofile.out", language: "go", format: "go-coverprofile", ingestible: true },
  { path: "go.coverprofile", language: "go", format: "go-coverprofile", ingestible: true },
  { path: "coverage/go.coverprofile", language: "go", format: "go-coverprofile", ingestible: true },
  { path: "coverage/coverage.out", language: "go", format: "go-coverprofile", ingestible: true },
  { path: "coverage/lcov.info", language: "tsjs", format: "lcov", ingestible: true },
  { path: "lcov.info", language: "tsjs", format: "lcov", ingestible: true },
  { path: "coverage/cobertura-coverage.xml", language: "tsjs", format: "cobertura", ingestible: false },
  { path: "coverage/coverage-final.json", language: "tsjs", format: "unknown", ingestible: false },
  { path: "coverage.xml", language: "python", format: "coverage-py", ingestible: true },
  { path: ".coverage", language: "python", format: "coverage-py", ingestible: false },
  { path: "target/site/jacoco/jacoco.xml", language: "java", format: "jacoco", ingestible: true },
  { path: "build/reports/jacoco/test/jacocoTestReport.xml", language: "java", format: "jacoco", ingestible: true },
  { path: "coverage.cobertura.xml", language: "csharp", format: "cobertura", ingestible: false },
  { path: "coverage/.resultset.json", language: "ruby", format: "simplecov", ingestible: false },
  { path: "clover.xml", language: "php", format: "clover", ingestible: false }
];

export function prepareRuntimeCoverage(root: string, opts: RuntimeCoveragePrepareOptions = {}): RuntimeCoveragePrepareResult {
  const absRoot = path.resolve(root);
  const timeoutMs = opts.timeoutMs ?? timeoutMsFromEnv() ?? DEFAULT_TIMEOUT_MS;
  const budgetMs = opts.budgetMs ?? budgetMsFromEnv() ?? DEFAULT_BUDGET_MS;
  const coverageDir = path.join(absRoot, GENERATED_COVERAGE_DIR);
  const warnings: string[] = [];
  const generated: CoverageGenerationResult[] = [];

  if (opts.generate) {
    const deadline = Date.now() + budgetMs;
    let budgetSkipped = false;
    // Returns true once the aggregate budget is spent; warns once and stops the remaining modules.
    const overBudget = (): boolean => {
      if (Date.now() < deadline) return false;
      if (!budgetSkipped) {
        budgetSkipped = true;
        warnings.push(
          `Coverage generation exceeded its ${Math.round(budgetMs / 1000)}s budget, so OrangePro skipped the remaining modules. Raise it with ORANGEPRO_COVERAGE_BUDGET_MS.`
        );
      }
      return true;
    };
    mkdirSync(coverageDir, { recursive: true });
    const goModules = findGoModules(absRoot);
    for (const mod of goModules) {
      if (overBudget()) break;
      const relModule = path.relative(absRoot, mod.dir).replace(/\\/g, "/");
      const label = slug(relModule || "root");
      const artifactRel = `${GENERATED_COVERAGE_DIR}/go-${label}.coverprofile`;
      const artifactAbs = path.join(absRoot, artifactRel);
      const args = ["test", "./...", `-coverprofile=${artifactAbs}`];
      reportProgress(`coverage: Go ${relModule || "."} — go ${args.map(shellToken).join(" ")}`);
      const res = (opts.runner ?? defaultRunner)(mod.dir, "go", args, timeoutMs);
      const artifactWritten = fileHasBytes(artifactAbs);
      const ok = res.status === 0 && artifactWritten;
      generated.push({
        language: "go",
        module_dir: relModule || ".",
        command: `go ${args.map(shellToken).join(" ")}`,
        ...(artifactWritten ? { artifact_path: artifactRel } : {}),
        ok,
        ...(!ok && artifactWritten ? { partial: true } : {}),
        ...(!ok ? { reason: summarizeFailure(res) } : {})
      });
      reportProgress(`${ok ? "coverage: ok" : "coverage: failed"} Go ${relModule || "."}`);
    }
    for (const task of findTsJsCoverageTasks(absRoot)) {
      if (overBudget()) break;
      reportProgress(`coverage: TS/JS ${task.relModule || "."} — ${renderCommand(task.command, task.args)}`);
      const res = (opts.runner ?? defaultRunner)(task.dir, task.command, task.args, timeoutMs);
      const artifactWritten = fileHasBytes(task.artifactAbs);
      const ok = res.status === 0 && artifactWritten;
      generated.push({
        language: "tsjs",
        module_dir: task.relModule || ".",
        command: renderCommand(task.command, task.args),
        ...(artifactWritten ? { artifact_path: task.artifactRel } : {}),
        ok,
        ...(!ok && artifactWritten ? { partial: true } : {}),
        ...(!ok ? { reason: summarizeFailure(res) } : {})
      });
      reportProgress(`${ok ? "coverage: ok" : "coverage: failed"} TS/JS ${task.relModule || "."}`);
    }
    for (const task of findPythonCoverageTasks(absRoot)) {
      if (overBudget()) break;
      reportProgress(`coverage: Python ${task.relModule || "."} — ${renderCommand(task.command, task.args)}`);
      const res = (opts.runner ?? defaultRunner)(task.dir, task.command, task.args, timeoutMs);
      const artifactWritten = fileHasBytes(task.artifactAbs);
      const ok = res.status === 0 && artifactWritten;
      generated.push({
        language: "python",
        module_dir: task.relModule || ".",
        command: renderCommand(task.command, task.args),
        ...(artifactWritten ? { artifact_path: task.artifactRel } : {}),
        ok,
        ...(!ok && artifactWritten ? { partial: true } : {}),
        ...(!ok ? { reason: summarizeFailure(res) } : {})
      });
      reportProgress(`${ok ? "coverage: ok" : "coverage: failed"} Python ${task.relModule || "."}`);
    }
    for (const task of findJavaCoverageTasks(absRoot)) {
      if (overBudget()) break;
      reportProgress(`coverage: Java ${task.relModule || "."} — ${renderCommand(task.command, task.args)}`);
      const res = (opts.runner ?? defaultRunner)(task.dir, task.command, task.args, timeoutMs);
      const artifactWritten = fileHasBytes(task.artifactAbs);
      const ok = res.status === 0 && artifactWritten;
      generated.push({
        language: "java",
        module_dir: task.relModule || ".",
        command: renderCommand(task.command, task.args),
        ...(artifactWritten ? { artifact_path: task.artifactRel } : {}),
        ok,
        ...(!ok && artifactWritten ? { partial: true } : {}),
        ...(!ok ? { reason: summarizeFailure(res) } : {})
      });
      reportProgress(`${ok ? "coverage: ok" : "coverage: failed"} Java ${task.relModule || "."}`);
    }
    if (generated.length === 0) warnings.push("No local coverage generators found, so OrangePro did not generate runtime coverage.");
  }

  const artifacts = detectCoverageArtifacts(absRoot);
  const suggested_commands = suggestCoverageCommands(absRoot);
  return {
    root: absRoot,
    coverage_dir: path.relative(absRoot, coverageDir).replace(/\\/g, "/") || GENERATED_COVERAGE_DIR,
    artifacts,
    generated,
    suggested_commands,
    warnings
  };
}

export function detectCoverageArtifacts(root: string): CoverageArtifactInfo[] {
  const absRoot = path.resolve(root);
  const out = new Map<string, CoverageArtifactInfo>();
  const add = (info: CoverageArtifactInfo): void => {
    const abs = path.join(absRoot, info.path);
    if (!existsSync(abs)) return;
    try {
      if (!statSync(abs).isFile()) return;
    } catch {
      return;
    }
    out.set(info.path, info);
  };
  for (const known of KNOWN_ARTIFACTS) add({ ...known, source: "existing" });
  for (const rel of findExistingGoCoverprofiles(absRoot)) add({ path: rel, language: "go", format: "go-coverprofile", ingestible: true, source: "existing" });
  for (const info of findExistingRuntimeCoverageReports(absRoot)) add({ ...info, source: "existing" });
  for (const info of generatedCoverageArtifacts(absRoot)) add({ ...info, source: "generated" });
  return [...out.values()].sort((a, b) => a.path.localeCompare(b.path));
}

export function suggestCoverageCommands(root: string): CoverageCommandSuggestion[] {
  const absRoot = path.resolve(root);
  const out: CoverageCommandSuggestion[] = [];
  for (const mod of findGoModules(absRoot)) {
    const relModule = path.relative(absRoot, mod.dir).replace(/\\/g, "/") || ".";
    const label = slug(relModule === "." ? "root" : relModule);
    const artifactPath = `${GENERATED_COVERAGE_DIR}/go-${label}.coverprofile`;
    const artifactFromModule = path.relative(mod.dir, path.join(absRoot, artifactPath)).replace(/\\/g, "/");
    out.push({
      language: "go",
      cwd: relModule,
      command: `go test ./... -coverprofile=${artifactFromModule}`,
      artifact_path: artifactPath,
      reason: "Go has built-in coverage; no external service or key is required."
    });
  }
  const tsTasks = findTsJsCoverageTasks(absRoot);
  if (tsTasks.length > 0) {
    for (const task of tsTasks) {
      out.push({
        language: "tsjs",
        cwd: task.relModule || ".",
        command: renderCommand(task.command, task.args),
        artifact_path: task.artifactRel,
        reason: "Repo package script already emits lcov; OrangePro ingests it locally when the artifact exists."
      });
    }
  } else if (existsSync(path.join(absRoot, "package.json"))) {
    out.push({
      language: "tsjs",
      cwd: ".",
      command: "npm test -- --coverage",
      artifact_path: "coverage/lcov.info",
      reason: "Use the repo's existing JS/TS runner to emit lcov; OrangePro ingests lcov locally when the artifact exists."
    });
  }
  for (const task of findPythonCoverageTasks(absRoot)) {
    const artifactFromModule = path.relative(task.dir, task.artifactAbs).replace(/\\/g, "/");
    out.push({
      language: "python",
      cwd: task.relModule || ".",
      command: `python3 -m pytest --cov=. --cov-report=xml:${artifactFromModule}`,
      artifact_path: task.artifactRel,
      reason: "coverage.py/pytest-cov can emit XML locally; no external service or key is required."
    });
  }
  for (const task of findJavaCoverageTasks(absRoot)) {
    out.push({
      language: "java",
      cwd: task.relModule || ".",
      command: renderCommand(task.command, task.args),
      artifact_path: task.artifactRel,
      reason:
        task.buildTool === "maven"
          ? "JaCoCo runs locally through Maven; no SonarQube key is required."
          : "JaCoCo runs locally through Gradle; no SonarQube key is required."
    });
  }
  return out;
}

function findGoModules(root: string): Array<{ dir: string }> {
  const out: Array<{ dir: string }> = [];
  const visit = (dir: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "go.mod")) out.push({ dir });
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) continue;
      visit(path.join(dir, entry.name));
    }
  };
  visit(root);
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

interface TsJsCoverageTask {
  dir: string;
  relModule: string;
  command: string;
  args: string[];
  artifactRel: string;
  artifactAbs: string;
}

interface PythonCoverageTask {
  dir: string;
  relModule: string;
  command: string;
  args: string[];
  artifactRel: string;
  artifactAbs: string;
}

interface JavaCoverageTask {
  dir: string;
  relModule: string;
  command: string;
  args: string[];
  artifactRel: string;
  artifactAbs: string;
  buildTool: "maven" | "gradle";
}

function findTsJsCoverageTasks(root: string): TsJsCoverageTask[] {
  const out: TsJsCoverageTask[] = [];
  for (const pkg of findPackageJsons(root)) {
    const task = coverageScriptForPackage(pkg.dir, pkg.json);
    if (!task) continue;
    const relModule = path.relative(root, pkg.dir).replace(/\\/g, "/");
    const artifactRel = path.join(relModule, "coverage", "lcov.info").replace(/\\/g, "/").replace(/^\/+/, "");
    out.push({
      dir: pkg.dir,
      relModule,
      command: task.command,
      args: task.args,
      artifactRel,
      artifactAbs: path.join(root, artifactRel)
    });
  }
  return out.sort((a, b) => a.relModule.localeCompare(b.relModule));
}

function findJavaCoverageTasks(root: string): JavaCoverageTask[] {
  return [...findMavenCoverageTasks(root), ...findGradleCoverageTasks(root)].sort((a, b) => a.relModule.localeCompare(b.relModule));
}

function findMavenCoverageTasks(root: string): JavaCoverageTask[] {
  const out: JavaCoverageTask[] = [];
  const visit = (dir: string, rel: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && e.name === "pom.xml")) {
      const relModule = rel.replace(/\\/g, "/");
      const artifactRel = path.join(relModule, "target", "site", "jacoco", "jacoco.xml").replace(/\\/g, "/").replace(/^\/+/, "");
      out.push({
        dir,
        relModule,
        command: existsSync(path.join(dir, "mvnw")) ? "./mvnw" : "mvn",
        args: ["test", MAVEN_JACOCO_REPORT_GOAL],
        artifactRel,
        artifactAbs: path.join(root, artifactRel),
        buildTool: "maven"
      });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      visit(path.join(dir, entry.name), childRel);
    }
  };
  visit(root, "");
  return out;
}

function findGradleCoverageTasks(root: string): JavaCoverageTask[] {
  const out: JavaCoverageTask[] = [];
  const visit = (dir: string, rel: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (entries.some((e) => e.isFile() && (e.name === "build.gradle" || e.name === "build.gradle.kts"))) {
      const relModule = rel.replace(/\\/g, "/");
      const artifactRel = path.join(relModule, "build", "reports", "jacoco", "test", "jacocoTestReport.xml")
        .replace(/\\/g, "/")
        .replace(/^\/+/, "");
      out.push({
        dir,
        relModule,
        command: existsSync(path.join(dir, "gradlew")) ? "./gradlew" : "gradle",
        args: ["test", "jacocoTestReport"],
        artifactRel,
        artifactAbs: path.join(root, artifactRel),
        buildTool: "gradle"
      });
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name)) continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      visit(path.join(dir, entry.name), childRel);
    }
  };
  visit(root, "");
  return out;
}

function findPythonCoverageTasks(root: string): PythonCoverageTask[] {
  const out: PythonCoverageTask[] = [];
  const hasMarker = (entries: import("node:fs").Dirent[]): boolean =>
    entries.some((e) => e.isFile() && (e.name === "pyproject.toml" || e.name === "pytest.ini" || e.name === "setup.cfg" || e.name === "tox.ini"));
  const add = (dir: string, rel: string): void => {
    const relModule = rel.replace(/\\/g, "/");
    const label = slug(relModule || "root");
    const artifactRel = `${GENERATED_COVERAGE_DIR}/python-${label}.coverage.xml`;
    const artifactAbs = path.join(root, artifactRel);
    out.push({
      dir,
      relModule,
      command: "python3",
      args: ["-m", "pytest", "--cov=.", `--cov-report=xml:${artifactAbs}`],
      artifactRel,
      artifactAbs
    });
  };
  const visit = (dir: string, rel: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (hasMarker(entries)) add(dir, rel);
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name) || entry.name === "coverage") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      visit(path.join(dir, entry.name), childRel);
    }
  };
  try {
    const rootEntries = readdirSync(root, { withFileTypes: true });
    if (hasMarker(rootEntries)) add(root, "");
    else visit(root, "");
  } catch {
    return [];
  }
  return out.sort((a, b) => a.relModule.localeCompare(b.relModule));
}

function findPackageJsons(root: string): Array<{ dir: string; json: Record<string, unknown> }> {
  const out: Array<{ dir: string; json: Record<string, unknown> }> = [];
  const visit = (dir: string, rel: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    if (rel && isIgnoredPackageDir(rel)) return;
    const pkg = entries.find((e) => e.isFile() && e.name === "package.json");
    if (pkg) {
      try {
        out.push({ dir, json: JSON.parse(readFileSync(path.join(dir, "package.json"), "utf8")) as Record<string, unknown> });
      } catch {
        /* ignore unreadable package.json */
      }
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || IGNORE_DIRS.has(entry.name) || entry.name === "coverage") continue;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isIgnoredPackageDir(childRel)) continue;
      visit(path.join(dir, entry.name), childRel);
    }
  };
  visit(root, "");
  return out;
}

function isIgnoredPackageDir(rel: string): boolean {
  return /(^|\/)(\.github|e2e-tests|node_modules|vendor|dist|build|target|\.orangepro)(\/|$)/.test(rel);
}

function coverageScriptForPackage(
  dir: string,
  pkg: Record<string, unknown>
): { command: string; args: string[] } | null {
  if (pkg.workspaces !== undefined) return null;
  const scripts = pkg.scripts && typeof pkg.scripts === "object" ? (pkg.scripts as Record<string, unknown>) : {};
  const candidates = Object.entries(scripts)
    .filter(([, value]) => typeof value === "string")
    .map(([name, value]) => ({ name, value: value as string, score: coverageScriptScore(name, value as string) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  const best = candidates[0];
  if (!best) return null;
  const manager = packageManagerFor(dir, pkg);
  if (manager === "yarn") return { command: "yarn", args: [best.name] };
  if (manager === "pnpm") return { command: "pnpm", args: ["run", best.name] };
  return { command: "npm", args: ["run", best.name] };
}

function coverageScriptScore(name: string, command: string): number {
  const text = `${name} ${command}`.toLowerCase();
  if (/\b(watch|e2e|cypress|playwright)\b/.test(text)) return 0;
  if (!/\bcoverage\b/.test(text) && !/--coverage\b/.test(text)) return 0;
  let score = 0;
  if (/\b--coverage\b/.test(text) || /\bcoverage\b/.test(name.toLowerCase())) score += 100;
  if (/^test[:-]?ci$/.test(name.toLowerCase())) score += 50;
  if (/^test/.test(name.toLowerCase())) score += 20;
  if (/\b(jest|vitest)\b/.test(command.toLowerCase())) score += 10;
  return score;
}

function packageManagerFor(dir: string, pkg: Record<string, unknown>): "npm" | "pnpm" | "yarn" {
  const declared = typeof pkg.packageManager === "string" ? pkg.packageManager.toLowerCase() : "";
  if (declared.startsWith("pnpm")) return "pnpm";
  if (declared.startsWith("yarn")) return "yarn";
  if (existsSync(path.join(dir, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(path.join(dir, "yarn.lock"))) return "yarn";
  return "npm";
}

function generatedCoverageArtifacts(root: string): Array<Omit<CoverageArtifactInfo, "source">> {
  const dir = path.join(root, GENERATED_COVERAGE_DIR);
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.isFile())
    .flatMap((e): Array<Omit<CoverageArtifactInfo, "source">> => {
      const rel = `${GENERATED_COVERAGE_DIR}/${e.name}`;
      if (/\.(coverprofile|out|cov)$/i.test(e.name)) {
        return [{ path: rel, language: "go" as const, format: "go-coverprofile" as const, ingestible: true }];
      }
      if (/\.coverage\.xml$/i.test(e.name)) {
        return [{ path: rel, language: "python" as const, format: "coverage-py" as const, ingestible: true }];
      }
      return [];
    });
}

function fileHasBytes(abs: string): boolean {
  try {
    return existsSync(abs) && statSync(abs).size > 0;
  } catch {
    return false;
  }
}

function findExistingGoCoverprofiles(root: string): string[] {
  const out: string[] = [];
  const visit = (dir: string, rel: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        visit(childAbs, childRel);
      } else if (entry.isFile() && isGoCoverprofileName(childRel)) {
        out.push(childRel);
      }
    }
  };
  visit(root, "");
  return out;
}

function findExistingRuntimeCoverageReports(root: string): Array<Omit<CoverageArtifactInfo, "source">> {
  const out = new Map<string, Omit<CoverageArtifactInfo, "source">>();
  const visit = (dir: string, rel: string): void => {
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      const childAbs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (IGNORE_DIRS.has(entry.name)) continue;
        visit(childAbs, childRel);
      } else if (entry.isFile()) {
        const lower = childRel.toLowerCase();
        if (lower.endsWith("/lcov.info") || lower === "lcov.info") {
          out.set(childRel, { path: childRel, language: "tsjs", format: "lcov", ingestible: true });
        } else if (lower.endsWith("/coverage.xml") || lower === "coverage.xml") {
          out.set(childRel, { path: childRel, language: "python", format: "coverage-py", ingestible: true });
        } else if (lower.endsWith("/jacoco.xml") || lower.endsWith("/jacocotestreport.xml")) {
          out.set(childRel, { path: childRel, language: "java", format: "jacoco", ingestible: true });
        }
      }
    }
  };
  visit(root, "");
  return [...out.values()];
}

function isGoCoverprofileName(rel: string): boolean {
  const base = path.posix.basename(rel);
  return /^(coverage|cover)(profile)?\.(out|cov)$/i.test(base) || /\.coverprofile$/i.test(base);
}

function defaultRunner(cwd: string, command: string, args: string[], timeoutMs: number): ReturnType<CommandRunner> {
  const res = spawnSync(command, args, { cwd, encoding: "utf8", timeout: timeoutMs, maxBuffer: 1_000_000 });
  return {
    status: res.status,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
    ...(res.error ? { error: res.error } : {})
  };
}

function summarizeFailure(res: ReturnType<CommandRunner>): string {
  if (res.error) return res.error.message;
  const text = `${res.stderr}\n${res.stdout}`.trim();
  return text ? text.slice(0, 500) : `command exited with status ${res.status ?? "unknown"}`;
}

function timeoutMsFromEnv(): number | undefined {
  const raw = process.env.ORANGEPRO_COVERAGE_TIMEOUT_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function budgetMsFromEnv(): number | undefined {
  const raw = process.env.ORANGEPRO_COVERAGE_BUDGET_MS;
  if (!raw) return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
}

function slug(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80) || "root";
}

function shellToken(s: string): string {
  return /^[A-Za-z0-9_./:=+-]+$/.test(s) ? s : JSON.stringify(s);
}

function renderCommand(command: string, args: string[]): string {
  return [command, ...args].map(shellToken).join(" ");
}
