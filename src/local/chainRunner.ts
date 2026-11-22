// The test runner of a chain stage (probe-fault, verify-test, export-tests, actions-run): which one a
// fixture names, what it may pass to it, the command line OrangePro builds, and the reporter that
// signs the stage's account. One description per runner; nothing here is chosen by guessing.

import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { OPRO_DIR } from "./boundary.js";
import { dynamicProofSpikePath } from "./operations.js";

export const CHAIN_RUNNERS = ["mocha", "vitest", "jest"] as const;
export type ChainRunnerName = (typeof CHAIN_RUNNERS)[number];

/** What the fixture's suite command gives a stage: the runner, its allowed options, and the whole suite's paths. */
export interface RunnerPlan {
  name: ChainRunnerName;
  options: string[];
  operands: string[];
}

type Refuse = (detail: string) => never;

export const insideRepoPath = (value: string): boolean => !isAbsolute(value) && !value.startsWith("-") && !value.split(/[\\/]/).includes("..");

/** Where OrangePro's own files are mounted in a stage's container. */
const OPRO_MOUNT = OPRO_DIR;
export const MOCHA_REPORTER_TARGET = `${OPRO_MOUNT}/mocha-reporter.cjs`;
const VITEST_REPORTER_TARGET = `${OPRO_MOUNT}/vitest-reporter.mjs`;
const JEST_REPORTER_TARGET = `${OPRO_MOUNT}/jest-reporter.cjs`;
const VITE_LOADER_TARGET = `${OPRO_MOUNT}/vite-loader.mjs`;

export const MOCHA_ENTRY = "node_modules/mocha/bin/mocha.js";
// Mocha would otherwise also read the repository's .mocharc* and package.json "mocha" key, which can add
// files to the selection, skip some, or not run tests at all (dry-run). Only the profile's options apply.
export const MOCHA_NO_REPO_CONFIG = ["--no-config", "--no-package"];
const VITEST_ENTRY = "node_modules/vitest/vitest.mjs";
const JEST_ENTRY = "node_modules/jest/bin/jest.js";

const ENTRY: Record<ChainRunnerName, string> = { mocha: MOCHA_ENTRY, vitest: VITEST_ENTRY, jest: JEST_ENTRY };
const DISPLAY: Record<ChainRunnerName, string> = { mocha: "Mocha", vitest: "Vitest", jest: "Jest" };
/** The major versions each new runner's stage was built and measured on. Mocha is taken as installed, as before. */
const SUPPORTED_MAJORS: Partial<Record<ChainRunnerName, number[]>> = { vitest: [4, 5], jest: [30] };

export const runnerDisplayName = (name: ChainRunnerName): string => DISPLAY[name];

// ── what a fixture may pass ──────────────────────────────────────────────────────

const MOCHA_VALUE_OPTIONS = new Set(["--require", "--ui", "--timeout"]);
const MOCHA_FLAG_OPTIONS = new Set(["--check-leaks", "--exit"]);

function mochaPlan(expanded: string[], refuse: Refuse): RunnerPlan {
  const options: string[] = [];
  const operands: string[] = [];
  for (let i = 1; i < expanded.length; i++) {
    const part = expanded[i] as string;
    if (!part.startsWith("-")) {
      if (!insideRepoPath(part)) refuse(`the test path ${part} is not inside the repository.`);
      operands.push(part);
      continue;
    }
    if (MOCHA_FLAG_OPTIONS.has(part)) {
      options.push(part);
      continue;
    }
    const value = expanded[i + 1];
    if (part === "--reporter") {
      if (typeof value !== "string") refuse("--reporter has no value.");
      i++;
      continue;
    }
    if (!MOCHA_VALUE_OPTIONS.has(part) || typeof value !== "string" || value.startsWith("-")) {
      return refuse(`${part} is not an option a probe takes from the repository (allowed: --require, --ui, --timeout, --check-leaks, --exit).`);
    }
    if (part === "--require" && !insideRepoPath(value)) refuse(`--require ${value} is not inside the repository.`);
    if (part === "--timeout" && !/^[1-9]\d*$/.test(value)) refuse(`--timeout ${value} is not a whole number of milliseconds.`);
    if (part === "--ui" && !/^[a-z-]+$/.test(value)) refuse(`--ui ${value} is not a Mocha interface name.`);
    options.push(part, value);
    i++;
  }
  return { name: "mocha", options, operands };
}

/**
 * Options of a Vitest or Jest suite command. `kept` are passed on (a path inside the repository, or a
 * plain name); `dropped` are the repository's own reporting and mode choices, which OrangePro replaces.
 */
function configuredPlan(
  name: "vitest" | "jest",
  expanded: string[],
  refuse: Refuse,
  rules: { paths: Set<string>; names: Set<string>; droppedFlags: Set<string>; droppedValues: Set<string>; words: Set<string> }
): RunnerPlan {
  const options: string[] = [];
  const operands: string[] = [];
  const allowed = [...rules.paths, ...rules.names].sort().join(", ");
  for (let i = 1; i < expanded.length; i++) {
    let part = expanded[i] as string;
    if (!part.startsWith("-")) {
      if (rules.words.has(part) && operands.length === 0 && options.length === 0) continue;
      if (!insideRepoPath(part)) refuse(`the test path ${part} is not inside the repository.`);
      operands.push(part);
      continue;
    }
    let value: string | undefined;
    const eq = part.indexOf("=");
    if (eq > 0) {
      value = part.slice(eq + 1);
      part = part.slice(0, eq);
    }
    if (rules.droppedFlags.has(part)) continue;
    if (rules.droppedValues.has(part)) {
      if (value === undefined) i++;
      continue;
    }
    if (!rules.paths.has(part) && !rules.names.has(part)) return refuse(`${part} is not an option a probe takes from the repository for ${DISPLAY[name]} (allowed: ${allowed}).`);
    if (value === undefined) {
      value = expanded[i + 1];
      i++;
    }
    if (typeof value !== "string" || value === "" || value.startsWith("-")) return refuse(`${part} has no value.`);
    if (rules.paths.has(part) && !insideRepoPath(value)) refuse(`${part} ${value} is not inside the repository.`);
    if (rules.names.has(part) && !/^[\w@./-]+$/.test(value)) refuse(`${part} ${value} is not a plain name.`);
    options.push(part, value);
  }
  return { name, options, operands };
}

const VITEST_RULES = {
  paths: new Set(["--config", "--dir"]),
  names: new Set(["--project"]),
  droppedFlags: new Set(["--run", "--typecheck", "--coverage", "--silent", "--no-color"]),
  droppedValues: new Set(["--reporter"]),
  words: new Set(["run"])
};
const JEST_RULES = {
  paths: new Set(["--config", "--rootDir"]),
  names: new Set(["--selectProjects"]),
  droppedFlags: new Set(["--ci", "--coverage", "--verbose", "--silent", "--no-color", "--colors", "--runInBand", "-i"]),
  droppedValues: new Set(["--reporters"]),
  words: new Set<string>()
};

/**
 * The runner and its options, from the fixture's full-suite command. Its first word names the runner.
 * Only options that say which tests there are and how the project is set up are taken; the repository's
 * reporter is replaced by OrangePro's. Anything else refuses the run.
 */
export function runnerPlanOf(expanded: unknown, refuse: Refuse): RunnerPlan {
  if (!Array.isArray(expanded) || expanded.length === 0 || !expanded.every((part) => typeof part === "string")) {
    return refuse("the fixture's commands.full_suite_expanded must be a test runner's command line (a list of strings).");
  }
  const words = expanded as string[];
  switch (words[0]) {
    case "mocha":
      return mochaPlan(words, refuse);
    case "vitest":
      return configuredPlan("vitest", words, refuse, VITEST_RULES);
    case "jest":
      return configuredPlan("jest", words, refuse, JEST_RULES);
    default:
      return refuse(`the fixture's commands.full_suite_expanded starts with \`${words[0]}\`; the runners a probe can run are ${CHAIN_RUNNERS.join(", ")}.`);
  }
}

// ── what is installed ────────────────────────────────────────────────────────────

/** The runner's installed version in the checkout's own node_modules, or why it cannot be used. */
export function installedRunner(sourceRoot: string, plan: RunnerPlan): { version: string } | { problem: string } {
  const pkgFile = join(sourceRoot, "node_modules", plan.name, "package.json");
  if (!existsSync(join(sourceRoot, ENTRY[plan.name])) || !existsSync(pkgFile)) return { problem: `${sourceRoot} has no node_modules/${plan.name}: install the fixture first (inside the boundary).` };
  let version = "unknown";
  try {
    version = String((JSON.parse(readFileSync(pkgFile, "utf8")) as { version?: unknown }).version ?? "unknown");
  } catch {
    version = "unknown";
  }
  const majors = SUPPORTED_MAJORS[plan.name];
  if (majors && !majors.includes(Number(version.split(".")[0]))) {
    return { problem: `${sourceRoot} has ${DISPLAY[plan.name]} ${version} installed; a probe runs ${DISPLAY[plan.name]} ${majors.join(" and ")} only.` };
  }
  return { version };
}

export const runnerEntryExists = (sourceRoot: string, plan: RunnerPlan): boolean => existsSync(join(sourceRoot, ENTRY[plan.name]));

// ── the command lines ────────────────────────────────────────────────────────────

/**
 * A test stage's command. `files` are the selected test files; null is the whole suite as the fixture
 * names it. Vitest and Jest load the repository's own config; the options after it are forced over it:
 * one try per test, no stop at the first failure, a focused test fails the run instead of narrowing it,
 * an empty run fails, and OrangePro's reporter is the only one.
 */
export function testArgv(plan: RunnerPlan, files: string[] | null): string[] {
  const paths = files ?? plan.operands;
  switch (plan.name) {
    case "mocha":
      return ["node", MOCHA_ENTRY, ...MOCHA_NO_REPO_CONFIG, ...plan.options, "--reporter", MOCHA_REPORTER_TARGET, ...paths];
    case "vitest":
      return [
        "node",
        VITEST_ENTRY,
        "run",
        ...paths,
        ...plan.options,
        "--configLoader",
        "runner",
        "--reporter",
        VITEST_REPORTER_TARGET,
        "--pool",
        "forks",
        "--retry",
        "0",
        "--bail",
        "0",
        "--allowOnly=false",
        "--passWithNoTests=false",
        "--coverage.enabled=false"
      ];
    case "jest":
      return [
        "node",
        JEST_ENTRY,
        ...plan.options,
        "--ci",
        "--reporters",
        JEST_REPORTER_TARGET,
        "--cacheDirectory",
        "/tmp/opro-jest-cache",
        "--bail=0",
        "--passWithNoTests=false",
        "--coverage=false",
        "--watchAll=false",
        // Every test file runs in a worker process, never in the reporter's: Jest uses workers whenever a
        // worker memory limit is set, and this one is never reached.
        "--workerIdleMemoryLimit=64G",
        ...(files ? ["--runTestsByPath", ...paths] : paths)
      ];
  }
}

const configOf = (plan: RunnerPlan): string[] => {
  const at = plan.options.indexOf("--config");
  return at >= 0 ? ["--config", plan.options[at + 1]!] : [];
};

/** The stage that asks the container whether the faulty file is still a program. */
export function syntaxArgv(plan: RunnerPlan, targetPosix: string): string[] {
  // A Vitest project's file goes through the project's own Vite: `node --check` cannot read TypeScript.
  if (plan.name === "vitest") return ["node", VITE_LOADER_TARGET, "--check", targetPosix, ...configOf(plan)];
  return ["node", "--check", targetPosix];
}

/** Where the witness is mounted: a Vitest project's witness is an ES module its Vite loads. */
export const witnessTarget = (plan: RunnerPlan): string => `${OPRO_MOUNT}/witness.${plan.name === "vitest" ? "mjs" : "cjs"}`;

export function witnessArgv(plan: RunnerPlan): string[] {
  if (plan.name === "vitest") return ["node", VITE_LOADER_TARGET, "--run", witnessTarget(plan), ...configOf(plan)];
  return ["node", witnessTarget(plan)];
}

// ── OrangePro's own files in the container ───────────────────────────────────────

const spike = (file: string): string => resolve(dirname(dynamicProofSpikePath()), file);

/** The reporter of the stage, and for Vitest the loader its syntax and witness stages use. */
export function runnerMounts(plan: RunnerPlan): Array<{ source: string; target: string; role: string }> {
  switch (plan.name) {
    case "mocha":
      return [{ source: spike("dynamic-proof-mocha-reporter.cjs"), target: MOCHA_REPORTER_TARGET, role: "<reporter>" }];
    case "vitest":
      return [
        { source: spike("chain-vitest-reporter.mjs"), target: VITEST_REPORTER_TARGET, role: "<reporter>" },
        { source: spike("chain-vite-loader.mjs"), target: VITE_LOADER_TARGET, role: "<loader>" }
      ];
    case "jest":
      return [{ source: spike("chain-jest-reporter.cjs"), target: JEST_REPORTER_TARGET, role: "<reporter>" }];
  }
}

// ── what a new test looks like ───────────────────────────────────────────────────

/** The calls that define one test in a file run by this runner. */
export function testCallNames(name: ChainRunnerName): string[] {
  return name === "mocha" ? ["it"] : ["it", "test"];
}
