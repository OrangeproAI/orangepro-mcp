#!/usr/bin/env node
// java-dynamic-proof-spike.mjs — Java dynamic-proof MECHANISM (J-1).
//
// Proves ONE simplest-shape method 0->1 on a single-module Maven + JUnit 5 project
// by mutation: it byte-copies the module into a hermetic sandbox, runs one target
// test via Surefire, mutates the target method body with a signature-derived
// sentinel (via java-mutate.mjs, tree-sitter Java AST), reruns the SAME test, and
// classifies from the STRUCTURED surefire report (target/surefire-reports/TEST-*.xml),
// never from stdout greps. It emits a JSON verdict mirroring the TS/JS and Go spikes:
// { status: "proven" | "associated_survived" | "unrunnable", ... }.
//
// TRUST: no false Proven. `proven` requires (a) baseline COMPILES, the target test
// PASSES, AND `mvn` exits 0 (a red build is not a clean baseline), (b) the mutant
// COMPILES, (c) the SAME target test FAILS, (d) the failure is a TRUSTED JUnit
// ASSERTION — org.opentest4j.AssertionFailedError / MultipleFailuresError by type,
// or a java.lang.AssertionError whose <failure> stack trace was raised by a trusted
// assertion API (org.junit./org.opentest4j./org.hamcrest./org.assertj.). An
// app-defined *AssertionError subclass or a bare `throw new AssertionError()` is NOT
// trusted. A <error> (NPE / RuntimeException / any other Throwable), a javac compile
// failure, a @BeforeEach/setup exception before the target, or no-test-run all
// classify as `unrunnable`, never `proven`. An equivalent-value mutation survives ->
// `associated_survived`. An ambiguous method name is refused -> `unrunnable`.
//
// PRODUCT-WIRED: `opro` routes Java dynamic proof through this script (operations.ts
// dynamicProofSpikePathFor("java")). The script itself writes no graph edges or
// product artifacts — it emits a JSON verdict; the orchestrator is the sole
// interpreter and the only place proof is minted. Pin: Maven + Surefire + JUnit 5
// (the Spring Boot default). Gradle / JUnit4 are later parsers.
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const DEFAULT_TIMEOUT_MS = 180_000;

function usage() {
  return [
    "Usage: node scripts/spikes/java-dynamic-proof-spike.mjs --root <maven-module> --test-class <FQCN or Class> --test-method <name> --target <rel.java> --method <name> [--mode sentinel|equivalent] [--maven-repo-local <dir>] [--json]",
    "",
    "--maven-repo-local points every run at ONE Maven local repo so immutable published deps (JUnit) resolve once. It is still isolated from your ~/.m2, holds no test code, and receives no ambient secrets. Omit it for a fresh per-run repo (maximally hermetic).",
    "",
    "Runs ONE Surefire target test on a byte-copy of a single-module Maven + JUnit 5 project, mutates the target method body via a signature-derived sentinel, reruns the SAME test, and classifies from the structured surefire report.",
    "J-1 scope: SIMPLEST SHAPE ONLY — a concrete non-void return, a single top-level return, no generics, no overloads. Equivalent-value mutations survive (associated_survived). Ambiguous names are refused (unrunnable).",
    "Product wiring: opro prove/auto-prove invokes this script for Java targets; it writes no graph edges or product artifacts itself — the caller interprets the JSON verdict."
  ].join("\n");
}

function parseArgs(argv) {
  const args = { json: false, mode: "sentinel" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`Missing value for ${arg}`);
    }
    args[key] = value;
    i += 1;
  }
  for (const required of ["root", "testClass", "testMethod", "target", "method"]) {
    if (!Object.prototype.hasOwnProperty.call(args, required)) {
      throw new Error(`Missing required --${required.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`);
    }
  }
  if (args.mode !== "sentinel" && args.mode !== "equivalent") {
    throw new Error("--mode must be sentinel or equivalent");
  }
  return args;
}

function parseTimeoutMs(value) {
  if (value === undefined) return DEFAULT_TIMEOUT_MS;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return parsed;
}

function isSecretEnvKey(key) {
  return /TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET[_-]?KEY|PASSPHRASE|CREDENTIAL|PIN|AUTH|COOKIE|SESSION/i.test(key);
}

function resolveInside(root, relOrAbs) {
  const resolved = path.resolve(root, relOrAbs);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes root: ${relOrAbs}`);
  }
  return resolved;
}

// Byte-copy the module into a temp sandbox. Never follow symlinks (a source-repo
// symlink must not leak an outside dir into the sandbox); exclude .git, .orangepro,
// node_modules (JS concept, irrelevant here), and any stale `target/` build dir so
// baseline/mutant surefire reports never mix. Local source is copied, never
// writable-symlinked.
function copyModuleRoot(root, label) {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), `opro-java-proof-${label}-`));
  const repoRoot = path.join(tmpRoot, "module");
  cpSync(root, repoRoot, {
    recursive: true,
    filter(source) {
      const name = path.basename(source);
      if (source !== root && lstatSync(source).isSymbolicLink()) {
        return false;
      }
      return name !== "node_modules" && name !== ".git" && name !== ".orangepro" && name !== "target";
    }
  });
  return { tmpRoot, repoRoot };
}

// A per-run hermetic Maven local repo inside the sandbox tmp dir, plus a sanitized
// allowlist env. No ambient secrets are forwarded to `mvn`: only a fixed set of
// process-control vars is passed, and any secret-looking key is stripped
// defensively. This keeps proofs deterministic and prevents credentials from
// reaching repo test code. Note: `mvn` may need network on first run to resolve
// JUnit; the fixtures use only JUnit 5 (commonly cached). If offline and uncached,
// the compile/run fails closed (unrunnable), never false-Proven.
function hermeticEnv(cacheRoot) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    JAVA_HOME: process.env.JAVA_HOME ?? "",
    LANG: process.env.LANG ?? "C",
    CI: "1",
    NO_COLOR: "1"
  };
  for (const key of Object.keys(env)) {
    if (isSecretEnvKey(key)) delete env[key];
  }
  return env;
}

function mvnBin() {
  return process.env.OPRO_MVN_BIN || "mvn";
}

// Resolve the developer's EXISTING Maven local repo so the sandbox module can
// resolve deps it already downloaded (a real `opro` user has built the repo).
// `$HOME/.m2/repository` is the Maven default; $MAVEN_REPO_LOCAL overrides it.
// Result is cached (queried once). Returns null if nothing resolvable exists, in
// which case we degrade to a per-run empty repo (self-contained fixtures with no
// external deps still resolve JUnit on first run). The repo is used READ-ONLY:
// with -o (offline, below) `mvn` never downloads and so never writes new artifacts
// into it — a missing dep errors out (unrunnable) instead of mutating the repo.
let cachedMavenRepo;
function resolveMavenRepo() {
  if (cachedMavenRepo !== undefined) {
    return cachedMavenRepo;
  }
  const dir = process.env.MAVEN_REPO_LOCAL
    || (process.env.HOME ? path.join(process.env.HOME, ".m2", "repository") : "");
  cachedMavenRepo = dir && existsSync(dir) ? dir : null;
  return cachedMavenRepo;
}

// Build-gating plugins that FAIL the build on the sentinel-mutated body's
// formatting (spring-javaformat), lint (checkstyle/spotless), or environment
// rules (enforcer). These are PROOF-RUNNER SETUP, not proof semantics: skipping
// them only lets the baseline+mutant COMPILE and the target test RUN. `compile`
// and the target `test` are NOT skipped, so Proven still closes ONLY on the
// trusted JUnit assertion the sentinel mutant trips (the unchanged classifier).
// Each flag is harmless when the target repo does not use that plugin.
const BUILD_GATE_SKIPS = [
  "-Dspring-javaformat.skip=true",
  "-Dcheckstyle.skip=true",
  "-Dspotless.check.skip=true",
  "-Denforcer.skip=true"
];

// A single `mvn test` invocation. `offline` runs -o (used with the reused read-only
// ~/.m2); otherwise mvn may resolve into `localRepo` (a per-run empty repo).
function invokeMvn({ repoRoot, testClass, testMethod, timeoutMs, cacheRoot, localRepo, offline }) {
  return spawnSync(
    mvnBin(),
    [
      "-q",
      ...(offline ? ["-o"] : []),
      "test",
      `-Dtest=${testClass}#${testMethod}`,
      "-Dsurefire.failIfNoSpecifiedTests=false",
      `-Dmaven.repo.local=${localRepo}`,
      ...BUILD_GATE_SKIPS,
      "-Dstyle.color=never"
    ],
    {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: timeoutMs,
      env: hermeticEnv(cacheRoot),
      maxBuffer: 32 * 1024 * 1024
    }
  );
}

// Offline mode fails when a plugin/dependency the module pins is not already in the
// reused ~/.m2 (mvn cannot download in -o). This is a RESOLUTION failure, distinct
// from a compile error or a test outcome (both of which produce a surefire report):
// mvn prints the well-known "offline mode … has not been downloaded" marker and no
// report exists. We detect that to fall back to an online per-run repo — never to
// reclassify a test result.
function isOfflineResolutionFailure(result, report) {
  if (report && report.targetCase) return false; // the test ran -> resolution succeeded
  const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /offline mode|Cannot access .* in offline mode|PluginResolutionException|Cannot resolve .* in offline mode/i.test(out);
}

// Run ONE target test through Surefire. -Dtest scopes to a single class#method and
// -Dsurefire.failIfNoSpecifiedTests=false keeps a no-match from erroring the run so
// we classify from the report, not the mvn exit code. When no explicit
// --maven-repo-local is given we FIRST reuse the developer's EXISTING ~/.m2 READ-ONLY
// with -o (offline) so a real repo's already-downloaded deps (Spring/Mockito/JUnit)
// resolve without any download mutating that repo. If that offline attempt cannot
// RESOLVE a pinned plugin/dep (a self-contained fixture pinning versions not in
// ~/.m2), we fall back to the original online per-run-repo behavior — a setup-only
// retry that never reclassifies a test outcome.
function runSurefire({ repoRoot, testClass, testMethod, timeoutMs, cacheRoot, mavenRepoLocal }) {
  const started = performance.now();
  // Default: reuse the developer's read-only ~/.m2 and run offline. A caller MAY
  // still pass an explicit --maven-repo-local (an isolated repo); when they do we
  // honor it and DO allow first-run resolution into it. Either way source is
  // byte-copied, never symlinked, and no ambient secrets reach mvn.
  const reuseDevRepo = mavenRepoLocal === undefined ? resolveMavenRepo() : null;
  let localRepo = mavenRepoLocal ?? reuseDevRepo ?? path.join(cacheRoot, "m2repo");
  let offline = Boolean(reuseDevRepo);
  if (!offline) mkdirSync(localRepo, { recursive: true });
  let result = invokeMvn({ repoRoot, testClass, testMethod, timeoutMs, cacheRoot, localRepo, offline });
  let report = readSurefireReport(repoRoot, testClass, testMethod);
  // Offline reuse could not resolve a pinned plugin/dep -> retry online into a
  // per-run empty repo (the pre-reuse behavior). Only fires when NO report exists,
  // so a real test result is never re-run.
  if (offline && isOfflineResolutionFailure(result, report)) {
    localRepo = path.join(cacheRoot, "m2repo");
    offline = false;
    mkdirSync(localRepo, { recursive: true });
    result = invokeMvn({ repoRoot, testClass, testMethod, timeoutMs, cacheRoot, localRepo, offline });
    report = readSurefireReport(repoRoot, testClass, testMethod);
  }
  const elapsedMs = Math.round(performance.now() - started);
  return {
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    // A javac compile failure produces NO surefire report for the class.
    compileFailed: detectCompileFailure(result, report),
    report,
    elapsedMs
  };
}

// A compile failure is when maven failed AND surefire never produced a testcase for
// the target (the class did not build, so no report exists). We rely on the
// STRUCTURED absence of a testcase, corroborated by the well-known maven markers, so
// a normal assertion failure (which DOES produce a report) is never mislabeled as a
// compile error.
function detectCompileFailure(result, report) {
  if (report && report.targetCase) return false; // the test ran -> it compiled
  const out = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  return /COMPILATION ERROR|BUILD FAILURE|Compilation failure|cannot find symbol|maven-compiler-plugin/i.test(out)
    || (result.status ?? 1) !== 0;
}

// Read the target's TEST-*.xml surefire report and locate the target <testcase>.
// Classification reads ONLY this structured XML: each <testcase> carries a
// <failure type="…"> (assertion) or <error type="…"> (other Throwable), or neither
// (passed). We do a tolerant, dependency-free XML scan (no XML lib) scoped to the
// single target testcase.
function readSurefireReport(repoRoot, testClass, testMethod) {
  const dir = path.join(repoRoot, "target", "surefire-reports");
  if (!existsSync(dir)) return null;
  const simpleClass = testClass.includes(".") ? testClass.slice(testClass.lastIndexOf(".") + 1) : testClass;
  let files;
  try {
    files = readdirSync(dir).filter((f) => /^TEST-.*\.xml$/.test(f));
  } catch {
    return null;
  }
  // Prefer the report whose file name matches the target class; fall back to any.
  const preferred = files.filter((f) => f === `TEST-${testClass}.xml` || f.endsWith(`.${simpleClass}.xml`) || f === `TEST-${simpleClass}.xml`);
  const candidates = preferred.length ? preferred : files;
  for (const file of candidates) {
    let xml;
    try {
      xml = readFileSync(path.join(dir, file), "utf8");
    } catch {
      continue;
    }
    const targetCase = findTestCase(xml, simpleClass, testMethod);
    if (targetCase) return { file, targetCase };
  }
  return null;
}

// Extract the target <testcase name="method" ...>…</testcase> and classify it.
// Returns { passed, failure, error } where failure/error carry their `type` attr.
function findTestCase(xml, simpleClass, testMethod) {
  // Match each testcase block (self-closing OR with a body).
  const re = /<testcase\b([^>]*?)(\/>|>([\s\S]*?)<\/testcase>)/g;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const attrs = m[1] || "";
    const inner = m[3] || "";
    const name = attrOf(attrs, "name");
    if (name !== testMethod) continue;
    // Optional classname guard: if present, it should reference the target class.
    const classname = attrOf(attrs, "classname");
    if (classname && simpleClass && !classname.endsWith(simpleClass)) continue;
    const failure = firstTag(inner, "failure");
    const error = firstTag(inner, "error");
    const skipped = /<skipped\b/.test(inner);
    return {
      name,
      classname,
      passed: !failure && !error && !skipped,
      skipped,
      failure: failure
        ? { type: attrOf(failure.attrs, "type"), message: attrOf(failure.attrs, "message"), stack: failure.text }
        : null,
      error: error ? { type: attrOf(error.attrs, "type"), message: attrOf(error.attrs, "message") } : null
    };
  }
  return null;
}

function attrOf(attrs, name) {
  const m = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return m ? decodeXml(m[1]) : undefined;
}

// Extract the first <tag …> element: its attribute string AND its body text (the
// decoded stack trace, empty for a self-closing element). The body is needed to
// attribute a bare java.lang.AssertionError to a trusted assertion API by its stack
// frames rather than trusting the `type` attr alone.
function firstTag(inner, tag) {
  const body = new RegExp(`<${tag}\\b([^>]*?)>([\\s\\S]*?)</${tag}>`, "i").exec(inner);
  if (body) return { attrs: body[1] || "", text: decodeXml(body[2] || "") };
  const selfClosing = new RegExp(`<${tag}\\b([^>]*?)/>`, "i").exec(inner);
  if (selfClosing) return { attrs: selfClosing[1] || "", text: "" };
  return null;
}

function decodeXml(s) {
  return String(s)
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&");
}

// Stack frames that identify a REAL assert*/assertThat from a trusted assertion
// library (JUnit4/5, OpenTest4J, Hamcrest, AssertJ). A bare `throw new
// AssertionError()` whose top frame is the test class itself has none of these.
const TRUSTED_ASSERTION_FRAME = /\bat\s+(?:org\.junit\.|org\.opentest4j\.|org\.hamcrest\.|org\.assertj\.)/;

// A <failure> is a TRUSTED assertion signal ONLY when it comes from a known
// JUnit/OpenTest4J assertion source. We do NOT trust `type` alone: an app-defined
// `com.myapp.FooAssertionError` must not pass just because its simple name ends in
// "AssertionError". Rules:
//   - org.opentest4j.AssertionFailedError / org.opentest4j.MultipleFailuresError —
//     unambiguous JUnit5/AssertJ types → trusted by type.
//   - java.lang.AssertionError — trusted ONLY when the <failure> stack trace shows a
//     frame from a trusted assertion API (a real assertEquals/assertThat raised it),
//     NOT a bare `throw new AssertionError()` from the test class.
//   - anything else (an app-defined *AssertionError subclass, a manually-thrown
//     java.lang.AssertionError with no trusted frame, an NPE, a plain
//     RuntimeException) is REJECTED.
function isAssertionFailure(failure) {
  if (!failure || typeof failure.type !== "string") return false;
  const type = failure.type;
  if (type === "org.opentest4j.AssertionFailedError" || type === "org.opentest4j.MultipleFailuresError") {
    return true;
  }
  if (type === "java.lang.AssertionError") {
    return TRUSTED_ASSERTION_FRAME.test(String(failure.stack ?? ""));
  }
  return false;
}

function failureSummary(run) {
  const tc = run.report?.targetCase;
  if (tc?.failure) return redactSecrets(`${tc.failure.type ?? "failure"}: ${tc.failure.message ?? ""}`.trim());
  if (tc?.error) return redactSecrets(`${tc.error.type ?? "error"}: ${tc.error.message ?? ""}`.trim());
  if (run.compileFailed) {
    const out = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
    const line = out.split(/\r?\n/).find((l) => /ERROR|error:|cannot find symbol|BUILD FAILURE/i.test(l));
    return line ? redactSecrets(line.trim()) : "compile failure";
  }
  const stderr = String(run.stderr ?? "").trim();
  return stderr ? redactSecrets(stderr.split("\n", 1)[0]) : null;
}

function redactSecrets(text) {
  return String(text)
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET[_-]?KEY|PASSPHRASE|CREDENTIAL|PIN|AUTH|COOKIE|SESSION)[A-Z0-9_]*=)[^\s'"]+/gi, "$1[REDACTED]")
    .replace(/(:\/\/[^:/@\s]+:)[^@/\s]+(@)/g, "$1[REDACTED]$2")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]");
}

// Run the AST mutator (node java-mutate.mjs). It prints MUTATE_ERROR:<code> to
// stderr on refusal; we classify on that marker.
function mutateMethod({ targetAbs, method, mode, timeoutMs }) {
  const helper = path.join(path.dirname(fileURLToPath(import.meta.url)), "java-mutate.mjs");
  const result = spawnSync(process.execPath, [helper, "--file", targetAbs, "--func", method, "--mode", mode], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024
  });
  const stderr = String(result.stderr ?? "");
  const marker = /MUTATE_ERROR:(\d+)/.exec(stderr);
  if (marker) {
    return { ok: false, code: Number(marker[1]), message: redactSecrets(stderr.split("\n").filter(Boolean).slice(-1)[0] ?? "") };
  }
  if ((result.status ?? 1) !== 0) {
    return { ok: false, code: 2, message: redactSecrets((stderr.split("\n", 1)[0] || "mutation failed").trim()) };
  }
  return { ok: true };
}

function mutateErrorReason(code) {
  switch (code) {
    case 3: return "target method name is ambiguous (more than one overload)";
    case 4: return "target method was not found";
    case 5: return "target is out of scope for J-1 (void, constructor, generic, type-variable return, or not a single top-level return)";
    case 6: return "target return type has no type-compatible sentinel (not mutable)";
    default: return "mutation could not be applied";
  }
}

// A GREEN baseline requires the target testcase to pass AND `mvn` to exit 0. A run
// where the target testcase passes but the overall build is RED (another failing
// test in the class, a verify-phase failure, etc.) is NOT a clean baseline —
// treating it as green would let the mutant "flip" a run that was never trustworthy.
// Fail closed to unrunnable.
function baselinePassed(run) {
  return !run.timedOut
    && !run.compileFailed
    && run.exitCode === 0
    && Boolean(run.report?.targetCase?.passed);
}

function classify({ baseline, mutant }) {
  // (a) baseline must compile AND the target test must pass.
  if (!baselinePassed(baseline)) {
    return { status: "unrunnable", proven: false, reason: "baseline target test did not compile+pass" };
  }
  // (b) mutant must compile.
  if (mutant.compileFailed) {
    return { status: "unrunnable", proven: false, reason: "mutant did not compile" };
  }
  if (mutant.timedOut) {
    return { status: "unrunnable", proven: false, reason: "mutant timed out" };
  }
  const tc = mutant.report?.targetCase;
  if (!tc) {
    return { status: "unrunnable", proven: false, reason: "mutant produced no report for the target test" };
  }
  // Equivalent-value mutation: the target test still passes -> survives.
  if (tc.passed) {
    return { status: "associated_survived", proven: false, reason: "mutated target did not change the test outcome" };
  }
  // (d) a NON-assertion failure (<error>, or a <failure> that is not an assertion)
  // is NOT a trusted signal — reject it.
  if (tc.error) {
    return { status: "unrunnable", proven: false, reason: `mutant threw ${tc.error.type ?? "a non-assertion error"}, not a test assertion` };
  }
  if (tc.failure && !isAssertionFailure(tc.failure)) {
    return { status: "unrunnable", proven: false, reason: `mutant failed with ${tc.failure.type ?? "a non-assertion failure"}, not an assertion` };
  }
  // (c) the SAME target test failed with a trusted ASSERTION.
  if (tc.failure && isAssertionFailure(tc.failure)) {
    return { status: "proven", proven: true, reason: "baseline passed and the mutant failed the same target test with an assertion" };
  }
  return { status: "unrunnable", proven: false, reason: "mutant did not fail the target test with a trusted assertion" };
}

function summarizeRun(run) {
  const tc = run.report?.targetCase ?? null;
  return {
    exitCode: run.exitCode,
    timedOut: run.timedOut,
    elapsedMs: run.elapsedMs,
    compileFailed: run.compileFailed,
    targetTestPassed: Boolean(tc?.passed),
    targetTestFailed: Boolean(tc && !tc.passed && !tc.skipped),
    failureType: tc?.failure?.type ?? tc?.error?.type ?? null,
    isAssertion: tc?.failure ? isAssertionFailure(tc.failure) : false,
    failureSummary: failureSummary(run)
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const targetAbs = resolveInside(root, args.target);
  const targetRel = path.relative(root, targetAbs);
  const timeoutMs = parseTimeoutMs(args.timeoutMs);

  const baselineCopy = copyModuleRoot(root, "baseline");
  const mutantCopy = copyModuleRoot(root, "mutant");
  try {
    const baseline = runSurefire({
      repoRoot: baselineCopy.repoRoot,
      testClass: args.testClass,
      testMethod: args.testMethod,
      timeoutMs,
      cacheRoot: baselineCopy.tmpRoot,
      mavenRepoLocal: args.mavenRepoLocal
    });

    const mutation = mutateMethod({
      targetAbs: path.join(mutantCopy.repoRoot, targetRel),
      method: args.method,
      mode: args.mode,
      timeoutMs
    });

    let verdict;
    let mutant = null;
    if (!mutation.ok) {
      verdict = { status: "unrunnable", proven: false, reason: mutateErrorReason(mutation.code) };
    } else {
      mutant = runSurefire({
        repoRoot: mutantCopy.repoRoot,
        testClass: args.testClass,
        testMethod: args.testMethod,
        timeoutMs,
        cacheRoot: mutantCopy.tmpRoot,
        mavenRepoLocal: args.mavenRepoLocal
      });
      verdict = classify({ baseline, mutant });
    }

    const output = {
      ...verdict,
      mode: args.mode,
      testClass: args.testClass,
      testMethod: args.testMethod,
      target: targetRel,
      method: args.method,
      baseline: summarizeRun(baseline),
      mutant: mutant ? summarizeRun(mutant) : { skipped: true, reason: mutation.message ?? null },
      medianProofMs: mutant ? Math.round((baseline.elapsedMs + mutant.elapsedMs) / 2) : baseline.elapsedMs
    };

    if (args.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      process.stdout.write(`${output.status}: ${output.reason}\n`);
      process.stdout.write(`baseline=${baseline.exitCode} mutant=${mutant ? mutant.exitCode : "skipped"} median_ms=${output.medianProofMs}\n`);
    }
    process.exitCode = output.status === "unrunnable" ? 2 : 0;
  } finally {
    rmSync(baselineCopy.tmpRoot, { recursive: true, force: true });
    rmSync(mutantCopy.tmpRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
}
