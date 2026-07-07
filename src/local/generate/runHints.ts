/**
 * Run hints for the calling agent (Cursor / Claude Code / Codex).
 *
 * OrangePro generates the test CODE; the agent already has shell access and is
 * the test runner. So `generate` returns, per test, a suggested path to write it
 * to inside the repo and a command to run it — the agent does the write + run +
 * report. OrangePro never writes to or runs anything in the repo.
 */
import { GeneratedTest } from "../graph/ontology.js";
import { looksJson, testsFileExt } from "./compareReport.js";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Directory (inside the developer's repo) the agent should write generated tests to. */
export const GENERATED_DIR = "orangepro_generated";

function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 60) || "test"
  );
}

function javaPackage(body: string): string | null {
  return body.match(/^\s*package\s+([A-Za-z_][A-Za-z0-9_.]*)\s*;/m)?.[1] ?? null;
}

function javaClassName(body: string, fallback: string): string {
  return body.match(/\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b/)?.[1] ?? fallback;
}

/** The linked existing test file this generated test was grounded on, if any. */
function linkedTestRef(test: GeneratedTest): string | null {
  for (const r of test.grounding?.source_refs ?? []) {
    if (/(\.(test|spec)\.[cm]?[jt]sx?$)|((^|\/)test\.[cm]?[jt]sx?$)|(_test\.[a-z]+$)|(_spec\.[a-z]+$)|((^|\/)test_[^/]+\.py$)/.test(r)) return r;
  }
  return null;
}

function isTsJsFramework(framework: string): boolean {
  const f = framework.toLowerCase();
  return f.includes("playwright") || f.includes("cypress") || f.includes("vitest") || f.includes("jest") || f.includes("mocha") || f.includes("ava");
}

function linkedTsJsTestExt(linked: string): string | null {
  const topLevel = linked.match(/(^|\/)test\.([cm]?[jt]sx?)$/i);
  if (topLevel) return `test.${topLevel[2]}`;
  const m = linked.match(/\.(test|spec|cy)\.([cm]?[jt]sx?)$/i);
  return m ? `${m[1]}.${m[2]}` : null;
}

function groundingFileRef(test: GeneratedTest, ext: RegExp): string | null {
  const refs = [...(test.grounding?.source_refs ?? []), ...(test.grounding?.entity_ids ?? [])];
  for (const ref of refs) {
    const rel = ref.startsWith("sym:") ? ref.slice("sym:".length).split("#")[0] : ref;
    if (ext.test(rel)) return rel;
  }
  return null;
}

/**
 * Suggested path inside the repo for the agent to write this test to.
 *
 * Grounded tests reuse the linked existing test's imports, which are often
 * RELATIVE to that test's directory (`./component`) — and monorepo test configs
 * resolve module roots per package. So the generated test goes NEXT TO the
 * linked test (same directory, `orangepro_generated_` prefix). Go is also
 * package-directory sensitive, so Go tests fall back to the related Go file's
 * directory rather than a new repo-root subpackage.
 */
export function suggestedTestPath(test: GeneratedTest, index: number): string {
  const linked = linkedTestRef(test);
  const ext = (linked && isTsJsFramework(test.framework_hint) && linkedTsJsTestExt(linked)) || testsFileExt(test.framework_hint, [test.body]);
  const stem = `${String(index + 1).padStart(2, "0")}_${slug(test.title)}`;
  if (ext === "java") {
    const className = javaClassName(test.body, `${stem.replace(/(^|_)([a-z0-9])/g, (_, _sep, c) => c.toUpperCase())}Test`);
    const pkg = javaPackage(test.body);
    return pkg ? `src/test/java/${pkg.replace(/\./g, "/")}/${className}.java` : `${GENERATED_DIR}/${className}.java`;
  }
  const file = ext === "go" ? `${stem}_test.go` : `${stem}.${ext}`;
  if (linked && linked.includes("/")) {
    return `${linked.slice(0, linked.lastIndexOf("/"))}/${GENERATED_DIR}_${file}`;
  }
  if (linked) return `${GENERATED_DIR}_${file}`;
  if (ext === "go") {
    const goRef = groundingFileRef(test, /\.go$/i);
    if (goRef && goRef.includes("/")) return `${goRef.slice(0, goRef.lastIndexOf("/"))}/${GENERATED_DIR}_${file}`;
    return `${GENERATED_DIR}_${file}`;
  }
  return `${GENERATED_DIR}/${file}`;
}

/**
 * Suggested command to run a written test. A hint — the agent should prefer the
 * repo's own configured command (package.json scripts / pyproject.toml) when it
 * differs.
 */
function packageManager(root: string): "npm" | "pnpm" | "yarn" {
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { packageManager?: string };
    if (pkg.packageManager?.startsWith("pnpm@")) return "pnpm";
    if (pkg.packageManager?.startsWith("yarn@")) return "yarn";
  } catch {
    /* fall through to lockfiles/default */
  }
  if (existsSync(join(root, "pnpm-lock.yaml"))) return "pnpm";
  if (existsSync(join(root, "yarn.lock"))) return "yarn";
  return "npm";
}

function frameworkScript(root: string, framework: string, path: string): string | null {
  let scripts: Record<string, string> = {};
  try {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { scripts?: Record<string, string> };
    scripts = pkg.scripts ?? {};
  } catch {
    return null;
  }
  const fw = framework.toLowerCase();
  const candidates = Object.entries(scripts)
    .filter(([, command]) => command.toLowerCase().includes(fw))
    .map(([name, command]) => {
      const n = name.toLowerCase();
      const c = command.toLowerCase();
      if (n.includes("watch") || c.includes("watch")) return { name, score: -1 };
      if (fw === "vitest" && /\bvitest\b/.test(c) && !/\brun\b/.test(c)) return { name, score: -1 };
      let score = 0;
      if (path.includes("/unit/") && n.includes("unit")) score += 40;
      if (/\brun\b/.test(c)) score += 20;
      if (n === "test") score += 15;
      if (n.startsWith(`test:${fw}`)) score += 12;
      if (n.includes(fw)) score += 8;
      if (n.startsWith("test")) score += 5;
      return { name, score };
    })
    .filter((c) => c.score >= 0)
    .sort((a, b) => b.score - a.score || a.name.localeCompare(b.name));
  return candidates[0]?.name ?? null;
}

function packageScriptCommand(root: string, framework: string, path: string): string | null {
  const script = frameworkScript(root, framework, path);
  if (!script) return null;
  const pm = packageManager(root);
  if (pm === "yarn") return `yarn ${script} ${path}`;
  return `${pm} run ${script} -- ${path}`;
}

function pytestMarkerFromBody(body?: string): string | null {
  if (!body) return null;
  const markers = [...body.matchAll(/@pytest\.mark\.([A-Za-z_][A-Za-z0-9_]*)\b/g)]
    .map((m) => m[1])
    .filter((m) => !["skip", "skipif", "xfail", "parametrize", "usefixtures", "filterwarnings", "timeout"].includes(m));
  return markers[0] ?? null;
}

function javaRunCommand(path: string, repoRoot?: string): string {
  const javaClass = path.match(/\/([^/]+)\.java$/)?.[1] ?? "GeneratedTest";
  if (!repoRoot) return `mvn test -Dtest=${javaClass}`;
  const testRoot = "/src/test/java/";
  const moduleRel = path.includes(testRoot) ? path.slice(0, path.indexOf(testRoot)) : "";
  const moduleRoot = join(repoRoot, moduleRel);
  if (existsSync(join(moduleRoot, "pom.xml"))) {
    const cmd = existsSync(join(moduleRoot, "mvnw")) ? "./mvnw" : "mvn";
    return `${cmd} test -Dtest=${javaClass}`;
  }
  if (existsSync(join(moduleRoot, "build.gradle")) || existsSync(join(moduleRoot, "build.gradle.kts"))) {
    const cmd = existsSync(join(moduleRoot, "gradlew")) ? "./gradlew" : "gradle";
    return `${cmd} test --tests ${javaClass}`;
  }
  const cmd = existsSync(join(repoRoot, "mvnw")) ? "./mvnw" : "mvn";
  return `${cmd} test -Dtest=${javaClass}`;
}

export function suggestedRunCommand(framework: string, path: string, repoRoot?: string, body?: string): string {
  const f = (framework || "").toLowerCase();
  if (repoRoot && (f.includes("playwright") || f.includes("cypress") || f.includes("vitest") || f.includes("jest") || f.includes("mocha") || f.includes("ava"))) {
    const scripted = packageScriptCommand(repoRoot, f.includes("playwright") ? "playwright" : f.includes("cypress") ? "cypress" : f.includes("vitest") ? "vitest" : f.includes("jest") ? "jest" : f.includes("mocha") ? "mocha" : "ava", path);
    if (scripted) return scripted;
  }
  if (f.includes("playwright")) return `npx playwright test ${path}`;
  if (f.includes("cypress")) return `npx cypress run --spec ${path}`;
  if (f.includes("vitest")) return `npx vitest run ${path}`;
  if (f.includes("jest")) return `npx jest ${path}`;
  if (f.includes("mocha")) return `npx mocha ${path}`;
  if (f.includes("ava")) return `npx ava ${path}`;
  if (f.includes("pytest") || f.includes("python")) {
    const marker = pytestMarkerFromBody(body);
    return marker ? `pytest ${path} -m ${marker}` : `pytest ${path}`;
  }
  if (f.includes("go")) return "go test ./...";
  if (f.includes("junit") || f.includes("java")) return javaRunCommand(path, repoRoot);
  return `<your repo's test command> ${path}`;
}

export interface RunHint {
  generated_test_id: string;
  title: string;
  framework: string;
  /** Exact CodeSymbol target for deterministic re-prove, present only for CodeSymbol-targeted drafts. */
  target_symbol_external_id?: string;
  /** Where the agent should write this test inside the repo. */
  suggested_path: string;
  /** How to run it once written (or use the repo's own test command). */
  run_command: string;
  /** Structured MCP handoff the agent can call after writing/running the test. */
  prove_run?: {
    tool: "orangepro_prove";
    args: { target_symbol: string; test_path: string; replacement: string; runner?: "vitest" | "jest" | "mocha" | "pytest" };
  };
  /** Structured MCP handoff for static diagnostic re-analysis; does not mint public Proven. */
  record_run?: {
    tool: "orangepro_record_run";
    args: { target_symbol: string; test_path: string };
  };
  /** Why deterministic re-prove handoff is unavailable for this draft. */
  handoff_note?: string;
}

function runnerForDynamicProof(framework: string): "vitest" | "jest" | "mocha" | "pytest" | undefined {
  const f = framework.toLowerCase();
  if (f.includes("vitest")) return "vitest";
  if (f.includes("jest")) return "jest";
  if (f.includes("mocha")) return "mocha";
  if (f.includes("pytest") || f.includes("python")) return "pytest";
  return undefined;
}

function symbolFile(target: string): string {
  return target.slice("sym:".length).split("#")[0] ?? "";
}

function supportsDynamicProof(target: string): boolean {
  return /\.(?:[cm]?[jt]sx?|py)$/i.test(symbolFile(target));
}

function replacementForDynamicProof(target: string): string {
  return /\.py$/i.test(symbolFile(target)) ? "return 0" : "return null;";
}

export function runHintsFor(tests: GeneratedTest[], repoRoot?: string, startIndex = 0): RunHint[] {
  return tests.map((t, i) => {
    const suggested_path = suggestedTestPath(t, i + startIndex);
    const target = t.target_symbol_external_id?.startsWith("sym:") ? t.target_symbol_external_id : undefined;
    const canProve = target ? supportsDynamicProof(target) : false;
    return {
      generated_test_id: t.id,
      title: t.title,
      framework: t.framework_hint,
      ...(target
        ? {
            target_symbol_external_id: target,
            ...(canProve
              ? {
                  prove_run: {
                    tool: "orangepro_prove" as const,
                    args: {
                      target_symbol: target,
                      test_path: suggested_path,
                      replacement: replacementForDynamicProof(target),
                      ...(runnerForDynamicProof(t.framework_hint) ? { runner: runnerForDynamicProof(t.framework_hint) } : {})
                    }
                  }
                }
              : {
                  handoff_note:
                    "Dynamic public Proven currently supports TS/JS/Python CodeSymbol targets only; use record_run for static diagnostics."
                }),
            record_run: {
              tool: "orangepro_record_run" as const,
              args: { target_symbol: target, test_path: suggested_path }
            }
          }
        : {
            handoff_note:
              "No deterministic re-prove target (target is not a code symbol); write/run the test, then record the outcome manually."
          }),
      suggested_path,
      run_command: suggestedRunCommand(t.framework_hint, suggested_path, repoRoot, t.body)
    };
  });
}

/**
 * A body that is a JSON/XML test-case spec rather than runnable framework code.
 * Run hints would mislead an agent into
 * "running" a spec file, so these are excluded. Reuses the SAME JSON detection as
 * the file-extension chooser (compareTestsExt → looksJson) so the two can never
 * disagree — including the prose-wrapped ```json case (gpt-5/reasoning models).
 */
function isSpecBody(body: string): boolean {
  return looksJson(body) || (body || "").trimStart().startsWith("<");
}

/**
 * Run hints for the RUNNABLE (framework-code) tests only. Excludes:
 *  - non-runnable grounded drafts (`runnable === false`): no validated import /
 *    assertion, so a run_command would mislead (PLAN 6.5);
 *  - spec-mode bodies (JSON/XML eval artifacts from comparison mode).
 * `runnable === undefined` is a legacy record, treated as runnable.
 */
export function runnableRunHintsFor(tests: GeneratedTest[], repoRoot?: string): RunHint[] {
  return runHintsFor(tests.filter((t) => t.runnable !== false && !isSpecBody(t.body)), repoRoot);
}

/**
 * Workflow for the calling agent. Returned alongside generated tests so the agent
 * knows to write → run → report using its own shell tools.
 */
export const AGENT_RUN_WORKFLOW: string[] = [
  "OrangePro returns the test code; YOUR agent runs it. Using your shell tools:",
  "1. Write each test's `body` to its `suggested_path` in the repo.",
  "2. Run its `run_command` from the package that owns the test's directory (monorepos: cd into that package first so the framework's module roots resolve) — or use the repo's own test command (npm test, pytest, npx playwright test).",
  "3. For public Proven, call `orangepro_prove` with the returned `prove_run` args after the test passes; it reruns baseline + sentinel-mutant and closes only on a dynamic assertion kill. `record_run` is static diagnostics only.",
  "4. Report pass/fail, error messages, and stack traces to the developer; propose a fix for failures.",
  "Runnable Python and Go drafts require local validation tools on PATH (`python3` for pytest syntax checks, `gofmt` for Go syntax checks). If those tools are missing, OrangePro safely returns drafts without run commands.",
  "Requires the repo's test framework + dependencies to already be installed. If a test fails to run for environment reasons (missing framework/deps), that's a local setup issue, not the generated test.",
  "Single-repo, local, free-tier. Clean reproducible CI runs (GitHub Actions) and multi-repo lifecycle Knowledge Graph are part of the hosted/paid OrangePro platform — upgrade for those."
];

/**
 * The keyless grounding contract, returned alongside generated tests. Tells the
 * agent that each test ships with VALIDATED evidence (real graph entities, not
 * generic guesses) and that it should ground its work in that evidence and report
 * back which entities it actually used.
 */
export const GROUNDING_CONTRACT: string[] = [
  "Each test carries `evidence`: grounding citations already VALIDATED against OrangePro's local graph (every `evidence_id` resolves to a real entity, with its kind, evidence_strength, and source_ref).",
  "Treat hard/reviewed evidence as proof; weak/candidate evidence is a hint to verify, not trust. `evidence_summary` reports proof coverage and any broken citations.",
  "Ground the test you keep in this evidence; when you accept or write a test, note which `evidence_id`s you used so OrangePro can record grounding-used vs grounding-ignored."
];
