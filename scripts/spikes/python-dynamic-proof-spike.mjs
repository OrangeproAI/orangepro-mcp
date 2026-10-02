#!/usr/bin/env node
// Python dynamic-proof mechanism. It proves only a targeted sentinel mutation killed
// by the exact pytest assertion, and otherwise fails closed with redacted diagnostics.

import { cpSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const PROJECT_MARKERS = ["pyproject.toml", "setup.cfg", "setup.py", "pytest.ini", ".pytest.ini", "tox.ini"];

function usage() {
  return [
    "Usage: node scripts/spikes/python-dynamic-proof-spike.mjs --root <repo> --test <nodeid> --target <rel.py> --func <name> [--mode sentinel|equivalent] [--python-runner auto|<command>] [--skip-preflight] [--preflight] [--json]",
    "",
    "Only an exact pytest function selector and an annotation-aware, type-compatible sentinel may mint proof."
  ].join("\n");
}

function parseArgs(argv) {
  const out = { mode: "sentinel", json: false, preflight: false, skipPreflight: false, pythonRunner: "auto", timeoutMs: 30000, explicitTimeout: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") { out.json = true; continue; }
    if (arg === "--preflight") { out.preflight = true; continue; }
    if (arg === "--skip-preflight") { out.skipPreflight = true; continue; }
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional arg: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${arg}`);
    out[key] = value;
    if (key === "timeoutMs") out.explicitTimeout = true;
  }
  for (const required of out.preflight ? ["root", "test"] : ["root", "test", "target", "func"]) {
    if (!out[required]) throw new Error(`Missing required --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  const timeoutMs = Number(out.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  out.timeoutMs = timeoutMs;
  if (!['sentinel', 'equivalent'].includes(out.mode)) throw new Error("--mode must be sentinel or equivalent");
  if (typeof out.pythonRunner !== "string" || out.pythonRunner.trim() === "") throw new Error("--python-runner must be auto or a non-empty command");
  if (out.preflight && out.skipPreflight) throw new Error("--preflight and --skip-preflight cannot be combined");
  return out;
}

function inside(root, candidate) {
  const rel = path.relative(root, candidate);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function contained(root, rel) {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, rel);
  const relative = path.relative(absRoot, abs);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes root: ${rel}`);
  return { absRoot, abs, rel: relative.split(path.sep).join("/") };
}

function copyRoot(root, dest) {
  cpSync(root, dest, {
    recursive: true,
    dereference: false,
    filter(src) {
      const base = path.basename(src);
      // Cargo build output is not source and may be written concurrently by a
      // native extension build. Keep Cargo manifests and the source itself.
      if (base === "target" && existsSync(path.join(path.dirname(src), "Cargo.toml"))) return false;
      return ![".git", ".orangepro", ".pytest_cache", "__pycache__", ".venv", "venv", "node_modules"].includes(base);
    }
  });
}

function cleanEnv(repoRoot) {
  const keep = {};
  for (const key of ["PATH", "HOME", "SystemRoot", "WINDIR"]) if (process.env[key]) keep[key] = process.env[key];
  keep.PYTHONDONTWRITEBYTECODE = "1";
  if (repoRoot) keep.PYTHONPATH = [repoRoot, ...(existsSync(path.join(repoRoot, "src")) ? [path.join(repoRoot, "src")] : [])].join(path.delimiter);
  return keep;
}

/** The nearest bounded project that owns the selected test file. */
function pythonProjectRoot(repoRoot, testRel) {
  const root = path.resolve(repoRoot);
  const testAbs = path.resolve(root, testRel.split("::", 1)[0]);
  if (!inside(root, testAbs)) throw new Error(`Path escapes root: ${testRel}`);
  let dir = path.dirname(testAbs);
  for (;;) {
    if (PROJECT_MARKERS.some((marker) => existsSync(path.join(dir, marker)))) return dir;
    if (dir === root) return root;
    const parent = path.dirname(dir);
    if (parent === dir || !inside(root, parent)) return root;
    dir = parent;
  }
}

function pyprojectUsesUv(file) {
  try { return /^\s*\[tool\.uv\]/m.test(readFileSync(file, "utf8")); } catch { return false; }
}

function commandAvailable(command, env) {
  const result = spawnSync(command, ["--version"], { env, encoding: "utf8", stdio: ["ignore", "ignore", "ignore"], timeout: 5000 });
  return !result.error && typeof result.status === "number";
}

/** Parse a configured command into argv without invoking a shell. */
function commandArgv(command) {
  const argv = [];
  let token = "";
  let quote = null;
  let escaped = false;
  let started = false;
  for (const ch of command.trim()) {
    if (ch === "\0") throw new Error("python runner command contains NUL");
    if (escaped) {
      token += ch;
      escaped = false;
      started = true;
      continue;
    }
    if (quote === "'") {
      if (ch === "'") quote = null;
      else token += ch;
      started = true;
      continue;
    }
    if (quote === '"') {
      if (ch === '"') quote = null;
      else if (ch === "\\") escaped = true;
      else token += ch;
      started = true;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      started = true;
    } else if (ch === "\\") {
      escaped = true;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) {
        argv.push(token);
        token = "";
        started = false;
      }
    } else {
      token += ch;
      started = true;
    }
  }
  if (escaped || quote) throw new Error("python runner command has an unterminated quote or escape");
  if (started) argv.push(token);
  if (!argv[0]) throw new Error("python runner command is empty");
  return argv;
}

function ancestorDirs(projectRoot, repoRoot) {
  const dirs = [];
  let dir = projectRoot;
  for (;;) {
    dirs.push(dir);
    if (dir === repoRoot) break;
    const parent = path.dirname(dir);
    if (parent === dir || !inside(repoRoot, parent)) break;
    dir = parent;
  }
  return dirs;
}

/**
 * Select one manager from the test project upward (bounded by the copied repo). The
 * returned object is immutable by convention and reused verbatim for baseline/mutant.
 */
function pythonRunnerPlan(repoRoot, projectRoot, sourceRepoRoot, sourceProjectRoot, configuredRunner) {
  const root = path.resolve(repoRoot);
  const env = cleanEnv(projectRoot);
  // A copied workspace must import the copied source, not the user's installed
  // project. Keep the bounded project first and include its containing repo.
  env.PYTHONPATH = [...new Set([projectRoot, root, ...(existsSync(path.join(projectRoot, "src")) ? [path.join(projectRoot, "src")] : []), ...(existsSync(path.join(root, "src")) ? [path.join(root, "src")] : [])])].join(path.delimiter);
  const fallback = [];
  const base = { cwd: projectRoot, displayCwd: sourceProjectRoot, env, fallback };
  if (configuredRunner !== "auto") {
    const argv = commandArgv(configuredRunner);
    let command = argv[0];
    if ((command.includes("/") || command.includes(path.sep)) && !path.isAbsolute(command)) {
      const sourceCommand = path.resolve(sourceProjectRoot, command);
      if (existsSync(sourceCommand)) command = sourceCommand;
    }
    return { ...base, command, args: argv.slice(1), manager: "custom" };
  }
  // Reuse an original prepared interpreter before even considering uv. A locked
  // uv invocation can still build the copied workspace, invalidating the budget.
  for (const dir of [...new Set([sourceProjectRoot, sourceRepoRoot])]) {
    const python = path.join(dir, ".venv", "bin", "python");
    if (existsSync(python)) return { ...base, command: python, args: ["-m", "pytest"], manager: "venv", environment: "existing" };
  }
  const dirs = ancestorDirs(projectRoot, root);
  const sourceDirs = ancestorDirs(sourceProjectRoot, path.resolve(sourceRepoRoot));
  const firstWith = (marker) => dirs.find((dir) => existsSync(path.join(dir, marker)));
  const firstUvConfig = dirs.find((dir) => pyprojectUsesUv(path.join(dir, "pyproject.toml")));
  const external = [
    { found: firstWith("uv.lock"), command: "uv", args: ["run", "--frozen", "python", "-m", "pytest"], manager: "uv" },
    { found: firstUvConfig, command: "uv", args: ["run", "python", "-m", "pytest"], manager: "uv" },
    { found: firstWith("poetry.lock"), command: "poetry", args: ["run", "python", "-m", "pytest"], manager: "poetry" },
    { found: firstWith("pdm.lock"), command: "pdm", args: ["run", "python", "-m", "pytest"], manager: "pdm" }
  ];
  for (const candidate of external) {
    if (!candidate.found) continue;
    if (commandAvailable(candidate.command, env)) {
      if (candidate.manager !== "uv") return { ...base, command: candidate.command, args: candidate.args, manager: candidate.manager };
      const sourceDir = sourceDirs[dirs.indexOf(candidate.found)];
      const sourceVenv = [sourceProjectRoot, sourceDir].filter(Boolean).flatMap((dir) => [".venv", "venv"].map((name) => path.join(dir, name))).find((dir) => existsSync(path.join(dir, "bin", "python")));
      if (sourceVenv) {
        // uv run --frozen still syncs and rebuilds the local project. --no-sync
        // against an existing matching environment leaves the user environment
        // untouched; PYTHONPATH points at the isolated source copy above.
        env.UV_PROJECT_ENVIRONMENT = sourceVenv;
        return { ...base, command: "uv", args: ["run", "--no-sync", ...(candidate.args.includes("--frozen") ? ["--frozen"] : []), "python", "-m", "pytest"], manager: "uv", environment: "existing" };
      }
      // Install locked dependencies into the disposable copy without compiling
      // the root project or any workspace member. A missing import fails closed.
      return { ...base, command: "uv", args: ["run", "--no-sync", ...(candidate.args.includes("--frozen") ? ["--frozen"] : []), "python", "-m", "pytest"], manager: "uv", environment: "scratch", setupArgs: ["sync", ...(candidate.args.includes("--frozen") ? ["--frozen"] : []), "--no-install-workspace"] };
    }
    fallback.push(`${candidate.manager} marker found but ${candidate.command} is unavailable; falling back`);
  }
  for (const venv of [".venv", "venv"]) {
    const sourceDir = sourceDirs.find((dir) => existsSync(path.join(dir, venv, "bin", "python")));
    if (sourceDir) return { ...base, command: path.join(sourceDir, venv, "bin", "python"), args: ["-m", "pytest"], manager: venv };
  }
  const fallbackPython = commandAvailable("python", env)
    ? "python"
    : commandAvailable("python3", env)
      ? "python3"
      : "python";
  if (fallbackPython === "python3") fallback.push("python is unavailable; using python3");
  return { ...base, command: fallbackPython, args: ["-m", "pytest"], manager: "fallback" };
}

/** Derive only unambiguous regular Python modules; namespace packages fail closed. */
function targetModule(repoRoot, projectRoot, targetAbs) {
  const roots = [...new Set([projectRoot, repoRoot, path.join(projectRoot, "src"), path.join(repoRoot, "src")])];
  const matches = [];
  for (const root of roots) {
    if (!inside(root, targetAbs)) continue;
    const parts = path.relative(root, targetAbs).split(path.sep);
    if (!parts.every((part) => /^[A-Za-z_]\w*(?:\.py)?$/.test(part)) || !parts.at(-1)?.endsWith(".py")) continue;
    const file = parts.pop();
    if (parts.some((_, i) => !existsSync(path.join(root, ...parts.slice(0, i + 1), "__init__.py")))) continue;
    const name = file === "__init__.py" ? parts.join(".") : [...parts, file.slice(0, -3)].join(".");
    if (name) matches.push(name);
  }
  return new Set(matches).size === 1 ? matches[0] : null;
}

function checkTargetImport(plan, moduleName, copiedTarget, timeoutMs) {
  const pytestIndex = plan.args.findIndex((arg, i) => arg === "-m" && plan.args[i + 1] === "pytest");
  const prefix = pytestIndex >= 0 ? plan.args.slice(0, pytestIndex) : plan.args;
  const probe = runCommand(plan, [...prefix, "-c", "import importlib,sys; m=importlib.import_module(sys.argv[1]); print(getattr(m, '__file__', '') or '')", moduleName], timeoutMs);
  let matches = false;
  try {
    const imported = probe.stdout.trim().split(/\r?\n/).at(-1);
    matches = probe.exitCode === 0 && !!imported && realpathSync(imported) === realpathSync(copiedTarget);
  } catch { /* Missing file and namespace imports cannot prove a copied target. */ }
  return { probe, matches };
}

function redactedTail(text) {
  return text.split(/\r?\n/).slice(-40).map((line) =>
    line
      .replace(/-----BEGIN [A-Z ]*PRIVATE KEY-----.*$/gi, "<redacted:private-key>")
      .replace(/\bsk-ant-[A-Za-z0-9_-]{16,}\b/g, "<redacted:anthropic-key>")
      .replace(/\bsk-[A-Za-z0-9]{20,}\b/g, "<redacted:openai-key>")
      .replace(/\bgh[po]_[A-Za-z0-9]{20,}\b/g, "<redacted:github-token>")
      .replace(/\bAKIA[0-9A-Z]{16}\b/g, "<redacted:aws-access-key>")
      .replace(/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "<redacted:slack-token>")
      .replace(/\b(?:password|passwd|secret|api[_-]?key|access[_-]?token|client[_-]?secret)\b\s*[:=]\s*["']?[^\s"']{8,}/gi, "<redacted:credential>")
      .replace(/\bBearer\s+\S+/gi, "Bearer <redacted:credential>")
  );
}

function diagnostic(run, failureClass) {
  return {
    command: [run.command, ...run.args].join(" "),
    cwd: run.displayCwd,
    exit_code: run.exitCode,
    duration_ms: run.durationMs,
    ...(failureClass ? { failure_class: failureClass } : {}),
    stdout_tail: redactedTail(run.stdout),
    stderr_tail: redactedTail(run.stderr),
    ...(run.fallback.length ? { runner_fallback: run.fallback } : {})
  };
}

function diagnosticFailureClass(run, classified, phase) {
  if (run.timedOut) return "timeout";
  if (classified.kind === "collectionError") return "collection_error";
  if (phase === "preflight" && (run.spawnError || classified.kind !== "passed")) return "env_unavailable";
  if (classified.kind !== "passed") return "test_failed";
  return undefined;
}

function runCommand(plan, args, timeoutMs) {
  const started = Date.now();
  const result = spawnSync(plan.command, args, {
    cwd: plan.cwd,
    env: plan.env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    // A timed-out environment manager may leave compiler children writing to
    // the scratch copy. Isolate its process group so they can be stopped too.
    detached: process.platform !== "win32",
    timeout: timeoutMs
  });
  if (result.error?.code === "ETIMEDOUT" && result.pid && process.platform !== "win32") {
    try { process.kill(-result.pid, "SIGKILL"); } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    command: plan.command,
    args,
    cwd: plan.cwd,
    displayCwd: plan.displayCwd,
    fallback: plan.fallback,
    manager: plan.manager,
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    spawnError: result.error?.code ?? null,
    durationMs: Date.now() - started,
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`
  };
}

function runPytest(plan, nodeid, timeoutMs, collectOnly = false) {
  return runCommand(plan, [...plan.args, "-q", ...(collectOnly ? ["--collect-only"] : []), nodeid, "--tb=short"], timeoutMs);
}

function exactNodeIdPattern(nodeid) {
  const escaped = nodeid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\//g, "[/\\\\]");
  const selectedParamSet = /\[[^\]]+\]$/.test(nodeid);
  return new RegExp(`FAILED\\s+${escaped}${selectedParamSet ? "" : "(?:\\[[^\\]\\n]+\\])?"}(?:\\s|$)`);
}

function isExactPytestNodeId(nodeid) {
  const parts = nodeid.split("::");
  return parts.length >= 2 && /^test[A-Za-z0-9_]*(?:\[.+\])?$/.test(parts[parts.length - 1]);
}

function classifyPytest(run, nodeid) {
  if (run.timedOut) return { kind: "otherError", reason: "pytest timed out" };
  if (run.exitCode === 0) return { kind: "passed" };
  const normalized = run.output.replace(/\r/g, "");
  const hasErrorSummary = /(^|\n)ERROR(?:S)?(?:\s|$)/.test(normalized) || /(^|\n)ERROR\s+collecting\s+/i.test(normalized) || /(^|\n)ImportError\b|(^|\n)ModuleNotFoundError\b|(^|\n)SyntaxError\b/i.test(normalized);
  if (hasErrorSummary) return { kind: "collectionError", reason: "pytest reported collection/import/setup error" };
  const failedTarget = exactNodeIdPattern(nodeid).test(normalized);
  const exceptionLine = normalized.match(/(?:^|\n)E\s+([A-Za-z_][A-Za-z0-9_.]*):/);
  if (exceptionLine && exceptionLine[1] !== "AssertionError" && !exceptionLine[1].endsWith(".AssertionError")) return { kind: "otherError", reason: "pytest failure raised before a trusted assertion mismatch" };
  const assertionLike = /\bAssertionError\b|(^|\n)E\s+assert\s/m.test(normalized);
  if (run.exitCode === 1 && failedTarget && assertionLike) return { kind: "assertionFailure" };
  return { kind: "otherError", reason: "pytest failure was not a trusted assertion failure" };
}

/** Only direct literal equality to the named call can constrain an unannotated type. */
function observedOracleType(repoRoot, nodeid, func) {
  const testPath = path.resolve(repoRoot, nodeid.split("::", 1)[0]);
  let source;
  try { source = readFileSync(testPath, "utf8"); } catch { return null; }
  const escaped = func.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const classify = (literal) => {
    const value = literal.trim();
    if (/^(True|False)$/.test(value)) return "bool";
    if (/^(['\"]).*\1$/.test(value)) return "str";
    if (/^(\[\]|\{\}|\(\)|set\(\))$/.test(value)) return "collection";
    if (value === "None") return "optional";
    if (/^-?\d+(?:\.\d+)?$/.test(value)) return "scalar";
    return null;
  };
  const direct = new RegExp(`\\bassert\\s+(?:${escaped}\\s*\\([^\\n]*\\)\\s*==\\s*([^#\\n]+)|([^#\\n]+)\\s*==\\s*${escaped}\\s*\\([^\\n]*\\))`, "g");
  const types = [];
  for (const match of source.matchAll(direct)) {
    const type = classify(match[1] ?? match[2] ?? "");
    if (type) types.push(type);
  }
  return types.length > 0 && types.every((type) => type === types[0]) ? types[0] : null;
}

function mutate(repoRoot, targetRel, func, mode, timeoutMs, oracleType) {
  const helper = path.join(here, "python-mutate.py");
  const args = [helper, "--file", path.join(repoRoot, targetRel), "--func", func, "--mode", mode];
  if (oracleType) args.push("--oracle-type", oracleType);
  const result = spawnSync("python3", args, {
    cwd: repoRoot,
    env: cleanEnv(repoRoot),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs
  });
  if (result.status !== 0 || result.error) return { ok: false, reason: result.error?.message || result.stderr || "mutator failed" };
  try { return JSON.parse(result.stdout || "{}"); } catch { return { ok: false, reason: "mutator produced invalid json" }; }
}

function summarize(run) {
  const line = run.output.split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  return line ? line.slice(0, 240) : "";
}

function emit(verdict, pretty) { process.stdout.write(JSON.stringify(verdict, null, pretty ? 2 : 0)); }

function main() {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (error) { console.error(error.message); console.error(usage()); process.exit(2); }

  const root = path.resolve(args.root);
  const testPath = args.test.split("::", 1)[0];
  const test = contained(root, testPath);
  const projectRoot = pythonProjectRoot(root, args.test);
  const projectRootRel = path.relative(root, projectRoot).split(path.sep).join("/") || ".";
  const relativeTest = path.relative(projectRoot, test.abs).split(path.sep).join("/") + args.test.slice(testPath.length);
  const target = args.preflight ? null : contained(root, args.target);
  if (!args.preflight && !isExactPytestNodeId(args.test)) {
    emit({ status: "unrunnable", proven: false, category: "mutation_unsupported", reason: "pytest selector must identify exactly one test function", runner: "pytest", project_root: projectRootRel, test: args.test, target: target.rel, func: args.func, mutant: { assertionFailure: false } }, args.json);
    return;
  }

  const tmp = mkdtempSync(path.join(tmpdir(), "opro-python-proof-"));
  const repoRoot = path.join(tmp, "repo");
  try {
    copyRoot(root, repoRoot);
    const copiedProjectRoot = path.resolve(repoRoot, projectRootRel);
    let plan = pythonRunnerPlan(repoRoot, copiedProjectRoot, root, projectRoot, args.pythonRunner.trim());
    // An isolated copy needs to create its own environment before the first test.
    // Cold dependency installation is not the test's 30-second execution limit.
    // An explicit --timeout-ms still caps every phase as the caller requested.
    const preflightTimeoutMs = args.explicitTimeout ? args.timeoutMs : 300000;
    if (plan.setupArgs) {
      const setup = runCommand(plan, plan.setupArgs, preflightTimeoutMs);
      if (setup.exitCode !== 0 || setup.spawnError) {
        const failureClass = setup.timedOut ? "timeout" : "env_unavailable";
        emit({ status: args.preflight ? "environment_unavailable" : "unrunnable", proven: false, category: "environment_unavailable", reason: `environment_unavailable: Python project dependencies could not be prepared (${failureClass})`, runner: "pytest", project_root: projectRootRel, diagnostics: diagnostic(setup, failureClass), mutant: { assertionFailure: false } }, args.json);
        return;
      }
    }
    let preflight = args.skipPreflight ? null : runPytest(plan, relativeTest, preflightTimeoutMs, true);
    // A nested project may have a runtime-only venv, while pytest lives in the
    // workspace dev environment. Retry collection with the root interpreter.
    if (preflight && projectRoot !== root && args.pythonRunner === "auto" && /No module named pytest/.test(preflight.output)) {
      const rootPython = path.join(root, ".venv", "bin", "python");
      if (existsSync(rootPython) && rootPython !== plan.command) {
        plan = { ...plan, command: rootPython, args: ["-m", "pytest"], fallback: [...plan.fallback, "subproject pytest unavailable; using workspace interpreter"] };
        preflight = runPytest(plan, relativeTest, preflightTimeoutMs, true);
      }
    }
    const preflightClass = preflight ? classifyPytest(preflight, relativeTest) : { kind: "passed" };
    if (args.preflight) {
      const available = preflightClass.kind === "passed";
      const preflightFailure = diagnosticFailureClass(preflight, preflightClass, "preflight");
      emit({
        status: available ? "preflight_ok" : "environment_unavailable",
        proven: false,
        ...(available ? {} : { category: preflightFailure === "collection_error" ? "collection_error" : "environment_unavailable" }),
        reason: available ? "Python pytest collection succeeded." : `environment_unavailable: pytest collection failed (${preflightClass.reason ?? "unknown"})`,
        runner: "pytest",
        project_root: projectRootRel,
        diagnostics: diagnostic(preflight, preflightFailure),
        mutant: { assertionFailure: false }
      }, args.json);
      return;
    }
    if (preflightClass.kind !== "passed") {
      const preflightFailure = diagnosticFailureClass(preflight, preflightClass, "preflight");
      const category = preflightFailure === "collection_error" ? "collection_error" : "environment_unavailable";
      emit({ status: "unrunnable", proven: false, category, reason: `${category}: pytest collection failed before proof could run`, runner: "pytest", project_root: projectRootRel, baseline: { exitCode: preflight.exitCode, timedOut: preflight.timedOut, failureSummary: summarize(preflight) }, diagnostics: diagnostic(preflight, preflightFailure), mutant: { assertionFailure: false } }, args.json);
      return;
    }

    const copiedTarget = path.join(repoRoot, target.rel);
    const moduleName = targetModule(repoRoot, copiedProjectRoot, copiedTarget);
    if (!moduleName) {
      emit({ status: "unrunnable", proven: false, category: "environment_unavailable", reason: "target_not_loaded_from_sandbox: ambiguous or unsupported Python module path", runner: "pytest", project_root: projectRootRel, diagnostics: { command: "module resolution", cwd: projectRoot, exit_code: null, duration_ms: 0, failure_class: "target_not_loaded_from_sandbox", stdout_tail: [], stderr_tail: [] }, mutant: { assertionFailure: false } }, args.json);
      return;
    }
    const imported = checkTargetImport(plan, moduleName, copiedTarget, args.timeoutMs);
    if (!imported.matches) {
      emit({ status: "unrunnable", proven: false, category: "environment_unavailable", reason: "target_not_loaded_from_sandbox: target import did not resolve to the copied source", runner: "pytest", project_root: projectRootRel, diagnostics: diagnostic(imported.probe, "target_not_loaded_from_sandbox"), mutant: { assertionFailure: false } }, args.json);
      return;
    }
    const targetImport = { verified: true, module: moduleName };

    // Baseline and mutant use the exact same command/cwd/env plan after collection.
    const baseline = runPytest(plan, relativeTest, args.timeoutMs);
    const baselineClass = classifyPytest(baseline, relativeTest);
    if (baselineClass.kind !== "passed") {
      emit({ status: "unrunnable", proven: false, reason: "baseline test did not pass", runner: "pytest", project_root: projectRootRel, baseline: { exitCode: baseline.exitCode, timedOut: baseline.timedOut, failureSummary: summarize(baseline) }, diagnostics: diagnostic(baseline, diagnosticFailureClass(baseline, baselineClass, "baseline")), mutant: { assertionFailure: false } }, args.json);
      return;
    }

    const mutation = mutate(repoRoot, target.rel, args.func, args.mode, args.timeoutMs, observedOracleType(copiedProjectRoot, relativeTest, args.func));
    if (!mutation.ok) {
      emit({ status: "unrunnable", proven: false, category: "mutation_unsupported", reason: `mutation_unsupported: ${mutation.reason}`, runner: "pytest", project_root: projectRootRel, baseline: { exitCode: baseline.exitCode, timedOut: baseline.timedOut }, diagnostics: diagnostic(baseline), mutant: { assertionFailure: false } }, args.json);
      return;
    }

    const mutant = runPytest(plan, relativeTest, args.timeoutMs);
    const mutantClass = classifyPytest(mutant, relativeTest);
    const proven = mutantClass.kind === "assertionFailure";
    const survived = mutantClass.kind === "passed";
    emit({
      status: proven ? "proven" : survived ? "associated_survived" : "unrunnable",
      proven,
      reason: proven ? "mutant failed at a trusted pytest assertion" : survived ? "mutant survived" : mutantClass.reason,
      runner: "pytest",
      replacementMode: args.mode,
      project_root: projectRootRel,
      test: args.test,
      target: target.rel,
      func: args.func,
      target_import: targetImport,
      baseline: { exitCode: baseline.exitCode, timedOut: baseline.timedOut },
      mutant: { exitCode: mutant.exitCode, timedOut: mutant.timedOut, assertionFailure: proven, failureSummary: proven ? "" : summarize(mutant) },
      mutation: { sentinel: mutation.sentinel, source: mutation.sentinel_source },
      diagnostics: diagnostic(mutant, diagnosticFailureClass(mutant, mutantClass, "mutant"))
    }, args.json);
  } finally {
    try {
      rmSync(tmp, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // Keep the JSON verdict available, but ensure the caller cannot promote
      // proof if the private scratch copy was not safely removed.
      console.error("Python proof scratch cleanup failed; proof is not valid.");
      process.exitCode = 1;
    }
  }
}

main();
