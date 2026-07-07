#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const EXPECTED_STATUSES = new Set(["proven", "associated_survived", "associated_non_assertion_failure", "unrunnable"]);
const RUNNERS = new Set(["auto", "vitest", "jest"]);
const REPLACEMENT_MODES = new Set(["return-json", "promise-json"]);

function usage() {
  return [
    "Usage: node scripts/spikes/dynamic-proof-real-repo-cost.mjs --config <cases.json> [--json] [--runner auto|vitest|jest] [--replacement-mode return-json|promise-json] [--test-env KEY=value] [--vitest-bin <path>] [--vitest-config <rel>] [--jest-bin <path>] [--jest-config <rel>] [--timeout-ms <n>] [--link-node-modules]",
    "",
    "Config shape:",
    "{",
    "  \"cases\": [",
    "    { \"repo\": \"vendure\", \"root\": \"/path/to/repo\", \"test\": \"rel.test.ts\", \"target\": \"rel.ts\", \"method\": \"name\", \"replacement\": \"return {\\\"ok\\\":false};\", \"replacementMode\": \"return-json\", \"testEnv\": { \"DATABASE_URL\": \"postgres://localhost/test\" }, \"expected\": \"proven\", \"runner\": \"auto\", \"vitestConfig\": \"vitest.config.mts\", \"jestConfig\": \"jest.config.js\", \"setupCommands\": [{ \"command\": \"npm\", \"args\": [\"ci\"] }] }",
    "  ]",
    "}",
    "",
    "This is a PR 0b measurement runner. It does not write graph edges or product artifacts.",
    "setupCommands are trusted local repo preparation steps run in the source checkout before isolated proof copies are made.",
    "Exit code: 0 means the measurement runner completed and emitted a scoreboard, even if cases are unrunnable; parse runnablePct/falseProofCount for gates."
  ].join("\n");
}

function parseArgs(argv) {
  const args = { json: false, linkNodeModules: false, runner: "auto", replacementMode: "return-json", testEnv: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--link-node-modules") {
      args.linkNodeModules = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (key === "testEnv") {
      args.testEnv.push(value);
      i += 1;
      continue;
    }
    args[key] = value;
    i += 1;
  }
  if (!args.config) {
    throw new Error("Missing required --config");
  }
  if (!["auto", "vitest", "jest"].includes(args.runner)) {
    throw new Error("--runner must be one of: auto, vitest, jest");
  }
  if (!REPLACEMENT_MODES.has(args.replacementMode)) {
    throw new Error("--replacement-mode must be one of: return-json, promise-json");
  }
  return args;
}

function scriptPath(name) {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(scriptDir, name);
}

function readConfig(configPath) {
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  if (!Array.isArray(parsed.cases)) {
    throw new Error("Config must contain a cases array");
  }
  return parsed.cases.map((entry, index) => {
    for (const key of ["repo", "root", "test", "target", "method", "replacement"]) {
      if (!Object.prototype.hasOwnProperty.call(entry, key) || typeof entry[key] !== "string") {
        throw new Error(`Case ${index} missing required ${key}`);
      }
    }
    if (entry.expected !== undefined && !EXPECTED_STATUSES.has(entry.expected)) {
      throw new Error(`Case ${index} has invalid expected status: ${entry.expected}`);
    }
    if (entry.runner !== undefined && !RUNNERS.has(entry.runner)) {
      throw new Error(`Case ${index} has invalid runner: ${entry.runner}`);
    }
    if (entry.replacementMode !== undefined && !REPLACEMENT_MODES.has(entry.replacementMode)) {
      throw new Error(`Case ${index} has invalid replacementMode: ${entry.replacementMode}`);
    }
    if (entry.jestConfig !== undefined && typeof entry.jestConfig !== "string") {
      throw new Error(`Case ${index} has invalid jestConfig`);
    }
    if (entry.vitestConfig !== undefined && typeof entry.vitestConfig !== "string") {
      throw new Error(`Case ${index} has invalid vitestConfig`);
    }
    if (entry.testEnv !== undefined && (!entry.testEnv || typeof entry.testEnv !== "object" || Array.isArray(entry.testEnv))) {
      throw new Error(`Case ${index} has invalid testEnv`);
    }
    if (entry.setupCommands !== undefined && !Array.isArray(entry.setupCommands)) {
      throw new Error(`Case ${index} has invalid setupCommands`);
    }
    const setupCommands = (entry.setupCommands ?? []).map((command, commandIndex) => validateSetupCommand(command, index, commandIndex));
    return {
      name: entry.name ?? `${entry.repo}:${entry.test}:${entry.method}`,
      repo: entry.repo,
      root: entry.root,
      test: entry.test,
      target: entry.target,
      method: entry.method,
      replacement: entry.replacement,
      replacementMode: entry.replacementMode ?? null,
      testEnv: validateTestEnvObject(entry.testEnv ?? {}, `Case ${index} testEnv`),
      expected: entry.expected ?? null,
      runner: entry.runner ?? null,
      vitestConfig: entry.vitestConfig ?? null,
      jestConfig: entry.jestConfig ?? null,
      setupCommands
    };
  });
}

function isSecretEnvKey(key) {
  return /TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET[_-]?KEY|PASSPHRASE|CREDENTIAL|PIN|AUTH|COOKIE|SESSION/i.test(key);
}

function validateTestEnvKey(key, label) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
    throw new Error(`${label} has invalid key: ${key}`);
  }
  if (isSecretEnvKey(key)) {
    throw new Error(`${label} secret-looking key is not allowed: ${key}`);
  }
}

function validateTestEnvObject(env, label) {
  const output = {};
  for (const [key, value] of Object.entries(env)) {
    validateTestEnvKey(key, label);
    if (typeof value !== "string") {
      throw new Error(`${label}.${key} must be a string`);
    }
    output[key] = value;
  }
  return output;
}

function parseTestEnv(entries, label = "--test-env") {
  const env = {};
  for (const entry of entries ?? []) {
    const index = entry.indexOf("=");
    if (index <= 0) {
      throw new Error(`${label} must be formatted as KEY=value`);
    }
    const key = entry.slice(0, index);
    validateTestEnvKey(key, label);
    env[key] = entry.slice(index + 1);
  }
  return env;
}

function validateSetupCommand(command, caseIndex, commandIndex) {
  if (!command || typeof command !== "object") {
    throw new Error(`Case ${caseIndex} setup command ${commandIndex} must be an object`);
  }
  if (typeof command.command !== "string" || command.command.trim() === "") {
    throw new Error(`Case ${caseIndex} setup command ${commandIndex} missing command`);
  }
  if (command.args !== undefined && (!Array.isArray(command.args) || command.args.some(arg => typeof arg !== "string"))) {
    throw new Error(`Case ${caseIndex} setup command ${commandIndex} has invalid args`);
  }
  if (command.cwd !== undefined && typeof command.cwd !== "string") {
    throw new Error(`Case ${caseIndex} setup command ${commandIndex} has invalid cwd`);
  }
  if (command.timeoutMs !== undefined) {
    parseTimeoutMs(command.timeoutMs, `Case ${caseIndex} setup command ${commandIndex} timeoutMs`);
  }
  return {
    command: command.command,
    args: command.args ?? [],
    cwd: command.cwd ?? ".",
    timeoutMs: command.timeoutMs ?? null
  };
}

function parseTimeoutMs(value, label = "--timeout-ms") {
  if (value === undefined) {
    return 30_000;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return parsed;
}

function resolveInside(root, relOrAbs) {
  const resolved = path.resolve(root, relOrAbs);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes root: ${relOrAbs}`);
  }
  return resolved;
}

function commandSummary(command) {
  return `${path.basename(command.command)} (${command.args.length} args)`;
}

function runSetupCommands(root, commands, defaultTimeoutMs) {
  if (commands.length === 0) {
    return { status: "skipped", commands: [] };
  }
  const results = [];
  for (const command of commands) {
    const started = performance.now();
    const timeoutMs = parseTimeoutMs(command.timeoutMs ?? defaultTimeoutMs, "setup timeoutMs");
    const result = spawnSync(command.command, command.args, {
      cwd: resolveInside(root, command.cwd),
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs
    });
    const item = {
      command: commandSummary(command),
      cwd: command.cwd,
      exitCode: result.status ?? 1,
      signal: result.signal ?? null,
      timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
      elapsedMs: Math.round(performance.now() - started),
      failureSummary: setupFailureSummary(result)
    };
    results.push(item);
    if (item.exitCode !== 0 || item.timedOut) {
      return { status: "failed", commands: results };
    }
  }
  return { status: "passed", commands: results };
}

function setupFailureSummary(result) {
  const stderr = redactSecrets(result.stderr ?? "").trim();
  if (stderr) {
    return stderr.split("\n", 1)[0];
  }
  const stdout = redactSecrets(result.stdout ?? "").trim();
  if (stdout) {
    return stdout.split("\n", 1)[0];
  }
  if (result.error?.code === "ETIMEDOUT") {
    return "setup command timed out";
  }
  return null;
}

function setupCacheKey(caseDef) {
  return JSON.stringify({
    root: path.resolve(caseDef.root),
    setupCommands: caseDef.setupCommands
  });
}

function setupFailureResult(caseDef, setup, runner, replacementMode) {
  const failed = setup.commands.find(command => command.exitCode !== 0 || command.timedOut);
  const failureSummary = failed
    ? `setup failed: ${failed.failureSummary ?? failed.command}`
    : "setup failed";
  return {
    name: caseDef.name,
    repo: caseDef.repo,
    test: caseDef.test,
    target: caseDef.target,
    method: caseDef.method,
    expected: caseDef.expected,
    vitestConfig: caseDef.vitestConfig,
    jestConfig: caseDef.jestConfig,
    replacementMode: caseDef.replacementMode ?? replacementMode,
    testEnv: Object.keys(caseDef.testEnv).sort(),
    runner,
    setup,
    processExitCode: 1,
    processSignal: null,
    processTimedOut: failed?.timedOut ?? false,
    elapsedMs: 0,
    stderr: "",
    result: {
      status: "unrunnable",
      proven: false,
      reason: "setup command did not pass",
      baseline: {
        exitCode: 1,
        timedOut: failed?.timedOut ?? false,
        elapsedMs: failed?.elapsedMs ?? 0,
        failureSummary
      },
      mutant: null,
      medianProofMs: null
    }
  };
}

function runSpike(caseDef, { runner, replacementMode, testEnv, vitestBin, vitestConfig, jestBin, jestConfig, timeoutMs, linkNodeModules, setup }) {
  const effectiveTestEnv = { ...testEnv, ...caseDef.testEnv };
  const args = [
    scriptPath("dynamic-proof-spike.mjs"),
    "--root",
    caseDef.root,
    "--test",
    caseDef.test,
    "--target",
    caseDef.target,
    "--method",
    caseDef.method,
    "--replacement",
    caseDef.replacement,
    "--replacement-mode",
    caseDef.replacementMode ?? replacementMode,
    "--runner",
    caseDef.runner ?? runner,
    "--timeout-ms",
    String(timeoutMs),
    "--json"
  ];
  for (const [key, value] of Object.entries(effectiveTestEnv)) {
    args.push("--test-env", `${key}=${value}`);
  }
  if (vitestBin) {
    args.push("--vitest-bin", vitestBin);
  }
  const effectiveVitestConfig = caseDef.vitestConfig ?? vitestConfig;
  if (effectiveVitestConfig) {
    args.push("--vitest-config", effectiveVitestConfig);
  }
  if (jestBin) {
    args.push("--jest-bin", jestBin);
  }
  const effectiveJestConfig = caseDef.jestConfig ?? jestConfig;
  if (effectiveJestConfig) {
    args.push("--jest-config", effectiveJestConfig);
  }
  if (linkNodeModules) {
    args.push("--link-node-modules");
  }
  const started = performance.now();
  const result = spawnSync(process.execPath, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs * 3
  });
  const elapsedMs = Math.round(performance.now() - started);
  let parsed = null;
  try {
    parsed = JSON.parse((result.stdout ?? "").trim());
  } catch {
    // Keep parsed null; caller records process-level failure.
  }
  return {
    name: caseDef.name,
    repo: caseDef.repo,
    test: caseDef.test,
    target: caseDef.target,
    method: caseDef.method,
    expected: caseDef.expected,
    vitestConfig: caseDef.vitestConfig,
    jestConfig: caseDef.jestConfig,
    replacementMode: parsed?.replacementMode ?? caseDef.replacementMode ?? replacementMode,
    testEnv: parsed?.testEnv ?? Object.keys(effectiveTestEnv).sort(),
    runner: parsed?.runner ?? caseDef.runner ?? runner,
    setup,
    processExitCode: result.status ?? 1,
    processSignal: result.signal ?? null,
    processTimedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    elapsedMs,
    stderr: redactSecrets(result.stderr ?? "").trim(),
    result: parsed
  };
}

function redactSecrets(text) {
  return String(text)
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET[_-]?KEY|PASSPHRASE|CREDENTIAL|PIN|AUTH|COOKIE|SESSION)[A-Z0-9_]*=)[^\s'"]+/gi, "$1[REDACTED]")
    .replace(/(:\/\/[^:/@\s]+:)[^@/\s]+(@)/g, "$1[REDACTED]$2")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1[REDACTED]");
}

function median(values) {
  const sorted = values.filter(value => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1] + sorted[mid]) / 2) : sorted[mid];
}

function summarizeRepo(repo, cases) {
  const runnable = cases.filter(item => item.result?.baseline?.exitCode === 0);
  const proven = cases.filter(item => item.result?.status === "proven");
  const survived = cases.filter(item => item.result?.status === "associated_survived");
  const nonAssertion = cases.filter(item => item.result?.status === "associated_non_assertion_failure");
  const unrunnable = cases.filter(item => item.result?.status === "unrunnable" || !item.result);
  const falseProofs = cases.filter(item => item.expected && item.expected !== "proven" && item.result?.status === "proven");
  const completedProofRuns = cases.filter(item => item.result?.baseline?.exitCode === 0 && item.result?.mutant && Number.isFinite(item.result.medianProofMs));
  const runnerCounts = {};
  const unrunnableReasons = {};
  for (const item of cases) {
    const runner = item.runner ?? "unknown";
    runnerCounts[runner] = (runnerCounts[runner] ?? 0) + 1;
    if (item.result?.status === "unrunnable" || !item.result) {
      const reason = redactSecrets(item.result?.baseline?.failureSummary ?? item.result?.reason ?? item.stderr?.split("\n", 1)[0] ?? "no result");
      unrunnableReasons[reason] = (unrunnableReasons[reason] ?? 0) + 1;
    }
  }
  return {
    repo,
    cases: cases.length,
    runnable: runnable.length,
    runnablePct: cases.length === 0 ? 0 : Number(((runnable.length / cases.length) * 100).toFixed(1)),
    proven: proven.length,
    falseProofCount: falseProofs.length,
    associatedSurvived: survived.length,
    associatedNonAssertionFailure: nonAssertion.length,
    unrunnable: unrunnable.length,
    runners: runnerCounts,
    unrunnableReasons,
    medianProofMs: median(completedProofRuns.map(item => item.result.medianProofMs))
  };
}

function summarize(results) {
  const byRepo = new Map();
  for (const result of results) {
    const items = byRepo.get(result.repo) ?? [];
    items.push(result);
    byRepo.set(result.repo, items);
  }
  return [...byRepo.entries()].map(([repo, cases]) => summarizeRepo(repo, cases));
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const cases = readConfig(path.resolve(args.config));
  const vitestBin = args.vitestBin ? path.resolve(args.vitestBin) : null;
  const vitestConfig = args.vitestConfig ?? null;
  const jestBin = args.jestBin ? path.resolve(args.jestBin) : null;
  const timeoutMs = parseTimeoutMs(args.timeoutMs);
  const testEnv = parseTestEnv(args.testEnv);
  const setupCache = new Map();
  const results = cases.map(caseDef => {
    const effectiveRunner = caseDef.runner ?? args.runner;
    const key = setupCacheKey(caseDef);
    const setup = setupCache.get(key) ?? runSetupCommands(caseDef.root, caseDef.setupCommands, timeoutMs);
    setupCache.set(key, setup);
    if (setup.status === "failed") {
      return setupFailureResult(caseDef, setup, effectiveRunner, args.replacementMode);
    }
    return runSpike(caseDef, { runner: args.runner, replacementMode: args.replacementMode, testEnv, vitestBin, vitestConfig, jestBin, jestConfig: args.jestConfig ?? null, timeoutMs, linkNodeModules: args.linkNodeModules, setup });
  });
  const output = {
    generatedAt: new Date().toISOString(),
    cases: results,
    summary: summarize(results)
  };
  if (args.json) {
    process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  } else {
    for (const row of output.summary) {
      process.stdout.write(`${row.repo}: cases=${row.cases} runner=${JSON.stringify(row.runners)} runnable=${row.runnablePct}% proven=${row.proven} false_proofs=${row.falseProofCount} survived=${row.associatedSurvived} non_assert=${row.associatedNonAssertionFailure} median_ms=${row.medianProofMs ?? "n/a"}\n`);
    }
  }
  process.exitCode = results.some(result => !result.result) ? 1 : 0;
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
}
