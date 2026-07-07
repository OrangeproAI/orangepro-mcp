#!/usr/bin/env node
// python-dynamic-proof-spike.mjs — Python dynamic-proof mechanism (P-1).
// Runs one pytest node in an isolated copy, applies a minimal AST sentinel
// mutation, and proves only when the mutant fails with a real assertion failure.

import { cpSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function usage() {
  return [
    "Usage: node scripts/spikes/python-dynamic-proof-spike.mjs --root <repo> --test <nodeid> --target <rel.py> --func <name> [--mode sentinel|equivalent] [--json]",
    "",
    "P-1 supports a single safe shape: one Python def/async def with a block suite. Ambiguous or unsupported shapes fail closed."
  ].join("\n");
}

function parseArgs(argv) {
  const out = { mode: "sentinel", json: false, timeoutMs: 30000 };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--json") {
      out.json = true;
      continue;
    }
    if (!arg.startsWith("--")) throw new Error(`Unexpected positional arg: ${arg}`);
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[++i];
    if (!value) throw new Error(`Missing value for ${arg}`);
    out[key] = value;
  }
  for (const required of ["root", "test", "target", "func"]) {
    if (!out[required]) throw new Error(`Missing required --${required.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`);
  }
  const timeoutMs = Number(out.timeoutMs);
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("--timeout-ms must be positive");
  out.timeoutMs = timeoutMs;
  if (!["sentinel", "equivalent"].includes(out.mode)) throw new Error("--mode must be sentinel or equivalent");
  return out;
}

function contained(root, rel) {
  const absRoot = path.resolve(root);
  const abs = path.resolve(absRoot, rel);
  const relative = path.relative(absRoot, abs);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) throw new Error(`Path escapes root: ${rel}`);
  return { absRoot, abs, rel: relative };
}

function copyRoot(root, dest) {
  cpSync(root, dest, {
    recursive: true,
    dereference: false,
    filter(src) {
      const base = path.basename(src);
      return ![".git", ".orangepro", ".pytest_cache", "__pycache__", ".venv", "venv", "node_modules"].includes(base);
    }
  });
}

function cleanEnv(repoRoot) {
  const keep = {};
  for (const key of ["PATH", "HOME", "SystemRoot", "WINDIR"]) {
    if (process.env[key]) keep[key] = process.env[key];
  }
  keep.PYTHONDONTWRITEBYTECODE = "1";
  keep.PYTEST_DISABLE_PLUGIN_AUTOLOAD = "1";
  delete keep.PYTHONPATH;
  if (repoRoot) {
    const srcRoot = path.join(repoRoot, "src");
    if (existsSync(srcRoot)) keep.PYTHONPATH = srcRoot;
  }
  return keep;
}

function runPytest(repoRoot, nodeid, timeoutMs) {
  const result = spawnSync("python3", ["-m", "pytest", "-q", nodeid, "--tb=short"], {
    cwd: repoRoot,
    env: cleanEnv(repoRoot),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs
  });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  return {
    exitCode: result.status ?? null,
    signal: result.signal ?? null,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    stdout,
    stderr,
    output: `${stdout}\n${stderr}`
  };
}

function exactNodeIdPattern(nodeid) {
  const escaped = nodeid.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\\\//g, "[/\\\\]");
  return new RegExp(`FAILED\\s+${escaped}(?:\\s|$)`);
}

function isExactPytestNodeId(nodeid) {
  const parts = nodeid.split("::");
  if (parts.length < 2) return false;
  const last = parts[parts.length - 1];
  return /^test[A-Za-z0-9_]*(?:\[.+\])?$/.test(last);
}

function classifyPytest(run, nodeid) {
  if (run.timedOut) return { kind: "otherError", reason: "pytest timed out" };
  if (run.exitCode === 0) return { kind: "passed" };
  const output = run.output;
  const normalized = output.replace(/\r/g, "");
  const hasErrorSummary =
    /(^|\n)ERROR(?:S)?(?:\s|$)/.test(normalized) ||
    /(^|\n)ERROR\s+collecting\s+/i.test(normalized) ||
    /(^|\n)ImportError\b|(^|\n)ModuleNotFoundError\b|(^|\n)SyntaxError\b/i.test(normalized);
  if (hasErrorSummary) return { kind: "otherError", reason: "pytest reported collection/import/setup error" };
  const failedTarget = exactNodeIdPattern(nodeid).test(normalized);
  const exceptionLine = normalized.match(/(?:^|\n)E\s+([A-Za-z_][A-Za-z0-9_.]*):/);
  if (exceptionLine && exceptionLine[1] !== "AssertionError" && !exceptionLine[1].endsWith(".AssertionError")) {
    return { kind: "otherError", reason: "pytest failure raised before a trusted assertion mismatch" };
  }
  const assertionLike = /\bAssertionError\b|(^|\n)E\s+assert\s/m.test(normalized);
  if (run.exitCode === 1 && failedTarget && assertionLike) return { kind: "assertionFailure" };
  return { kind: "otherError", reason: "pytest failure was not a trusted assertion failure" };
}

function mutate(repoRoot, targetRel, func, mode, timeoutMs) {
  const helper = path.join(here, "python-mutate.py");
  const targetAbs = path.join(repoRoot, targetRel);
  const result = spawnSync("python3", [helper, "--file", targetAbs, "--func", func, "--mode", mode], {
    cwd: repoRoot,
    env: cleanEnv(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs
  });
  if (result.status !== 0 || result.error) {
    return { ok: false, reason: result.error?.message || result.stderr || "mutator failed" };
  }
  try {
    return JSON.parse(result.stdout || "{}");
  } catch {
    return { ok: false, reason: "mutator produced invalid json" };
  }
}

function summarize(run) {
  const line = run.output
    .split(/\r?\n/)
    .map((s) => s.trim())
    .find(Boolean);
  return line ? line.slice(0, 240) : "";
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    console.error(usage());
    process.exit(2);
  }

  const root = path.resolve(args.root);
  const target = contained(root, args.target);
  const testPath = args.test.split("::", 1)[0];
  const test = contained(root, testPath);
  if (!isExactPytestNodeId(args.test)) {
    const verdict = {
      status: "unrunnable",
      proven: false,
      reason: "pytest selector must identify exactly one test function",
      runner: "pytest",
      test: args.test,
      target: target.rel,
      func: args.func,
      mutant: { assertionFailure: false }
    };
    process.stdout.write(JSON.stringify(verdict, null, args.json ? 2 : 0));
    return;
  }
  const tmp = mkdtempSync(path.join(tmpdir(), "opro-python-proof-"));
  const repoRoot = path.join(tmp, "repo");

  try {
    copyRoot(root, repoRoot);
    const baseline = runPytest(repoRoot, args.test, args.timeoutMs);
    const baselineClass = classifyPytest(baseline, args.test);
    if (baselineClass.kind !== "passed") {
      const verdict = {
        status: "unrunnable",
        proven: false,
        reason: "baseline test did not pass",
        runner: "pytest",
        baseline: { exitCode: baseline.exitCode, timedOut: baseline.timedOut, failureSummary: summarize(baseline) },
        mutant: { assertionFailure: false }
      };
      process.stdout.write(JSON.stringify(verdict, null, args.json ? 2 : 0));
      return;
    }

    const mutation = mutate(repoRoot, target.rel, args.func, args.mode, args.timeoutMs);
    if (!mutation.ok) {
      const verdict = {
        status: "unrunnable",
        proven: false,
        reason: `mutation refused: ${mutation.reason}`,
        runner: "pytest",
        baseline: { exitCode: baseline.exitCode, timedOut: baseline.timedOut },
        mutant: { assertionFailure: false }
      };
      process.stdout.write(JSON.stringify(verdict, null, args.json ? 2 : 0));
      return;
    }

    const mutant = runPytest(repoRoot, args.test, args.timeoutMs);
    const mutantClass = classifyPytest(mutant, args.test);
    const proven = mutantClass.kind === "assertionFailure";
    const survived = mutantClass.kind === "passed";
    const verdict = {
      status: proven ? "proven" : survived ? "associated_survived" : "unrunnable",
      proven,
      reason: proven ? "mutant failed at a trusted pytest assertion" : survived ? "mutant survived" : mutantClass.reason,
      runner: "pytest",
      replacementMode: args.mode,
      test: args.test,
      target: target.rel,
      func: args.func,
      baseline: { exitCode: baseline.exitCode, timedOut: baseline.timedOut },
      mutant: { exitCode: mutant.exitCode, timedOut: mutant.timedOut, assertionFailure: proven, failureSummary: proven ? "" : summarize(mutant) }
    };
    process.stdout.write(JSON.stringify(verdict, null, args.json ? 2 : 0));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

main();
