import { cpSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

// The Java dynamic-proof spike (J-1) needs BOTH `java` and `mvn`. CI has neither,
// so the whole suite skips when either is absent (staying green) and RUNS locally
// where both are present. This is its OWN file so it does not affect the TS/JS or Go
// spike splits.
function javaAndMavenAvailable(): boolean {
  try {
    const java = spawnSync("java", ["-version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    if (java.status !== 0) return false;
    const mvn = spawnSync("mvn", ["-v"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    return mvn.status === 0 && /Apache Maven/.test(mvn.stdout ?? "");
  } catch {
    return false;
  }
}

const HAS_JAVA_MAVEN = javaAndMavenAvailable();
// Each case spawns the spike, which byte-copies the module twice, runs two Surefire
// passes (baseline + mutant, each a cold JVM + first-run JUnit resolution) plus a
// tree-sitter mutation. That comfortably exceeds vitest's 5s default.
const TEST_TIMEOUT = 240_000;
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const spike = path.join(root, "scripts/spikes/java-dynamic-proof-spike.mjs");
const fixtures = path.join(root, "tests/local/__fixtures__/java-proof");

// One shared Maven local repo for the whole file: JUnit resolves ONCE (prewarmed in
// beforeAll) instead of per run, so twelve cold JUnit downloads do not blow past
// vitest's worker RPC heartbeat. It is a temp dir, isolated from ~/.m2, holds only
// immutable published deps (no test code), and receives no ambient secrets — the
// spike's hermetic guarantees still hold. The spike defaults to a fresh per-run repo
// when --maven-repo-local is omitted.
const SHARED_M2 = HAS_JAVA_MAVEN ? mkdtempSync(path.join(tmpdir(), "opro-java-m2-")) : "";

type Verdict = {
  status: "proven" | "associated_survived" | "unrunnable";
  proven: boolean;
  reason: string;
  mode: string;
  baseline: { exitCode: number; compileFailed: boolean; targetTestPassed: boolean; failureSummary: string | null };
  mutant:
    | { skipped: true; reason: string | null }
    | {
        exitCode: number;
        compileFailed: boolean;
        targetTestPassed: boolean;
        targetTestFailed: boolean;
        failureType: string | null;
        isAssertion: boolean;
        failureSummary: string | null;
      };
};

function runSpike(
  rootDir: string,
  opts: {
    testClass?: string;
    testMethod: string;
    method: string;
    mode?: "sentinel" | "equivalent";
    extraEnv?: Record<string, string>;
  }
): { verdict: Verdict; status: number; stdout: string; stderr: string } {
  const args = [
    spike,
    "--root",
    rootDir,
    "--test-class",
    opts.testClass ?? "ai.orangepro.fixture.CalculatorTest",
    "--test-method",
    opts.testMethod,
    "--target",
    "src/main/java/ai/orangepro/fixture/Calculator.java",
    "--method",
    opts.method,
    "--maven-repo-local",
    SHARED_M2,
    "--json"
  ];
  if (opts.mode) {
    args.push("--mode", opts.mode);
  }
  const result = spawnSync(process.execPath, args, {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...(opts.extraEnv ?? {}) },
    stdio: ["ignore", "pipe", "pipe"]
  });
  return {
    verdict: JSON.parse(result.stdout) as Verdict,
    status: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? ""
  };
}

// The cases are independent (each spawns the spike against its own fixture in
// isolated temp sandboxes), so they run CONCURRENTLY. Serially, six ~15-25s cases
// exceed vitest's worker RPC heartbeat and the run is reported failed despite every
// assertion passing; concurrency keeps the file's wall time near the slowest case.
describe.skipIf(!HAS_JAVA_MAVEN)("java dynamic proof spike (J-1)", () => {
  // Resolve JUnit into the shared repo once before the proof cases run, so the
  // subsequent mvn invocations are cache hits rather than repeated cold downloads.
  beforeAll(() => {
    // Warm in a throwaway copy so no `target/` build dir dirties the checked-in
    // fixture. A prewarm failure (e.g. offline + uncached) is not fatal: each case
    // still runs and classifies (just slower, or fails closed as unrunnable).
    const warmDir = mkdtempSync(path.join(tmpdir(), "opro-java-warm-"));
    const warmRepo = path.join(warmDir, "module");
    cpSync(path.join(fixtures, "proven"), warmRepo, { recursive: true });
    spawnSync(
      "mvn",
      ["-q", "test", "-Dtest=ai.orangepro.fixture.CalculatorTest#addsTwoNumbers", "-Dsurefire.failIfNoSpecifiedTests=false", `-Dmaven.repo.local=${SHARED_M2}`],
      { cwd: warmRepo, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }
    );
  }, TEST_TIMEOUT);

  it("proves a simplest-shape method 0->1 when the sentinel kills a value assertion", () => {
    const { verdict, status } = runSpike(path.join(fixtures, "proven"), { testMethod: "addsTwoNumbers", method: "add" });

    expect(verdict.status).toBe("proven");
    expect(verdict.proven).toBe(true);
    expect(verdict.baseline.targetTestPassed).toBe(true);
    expect("targetTestFailed" in verdict.mutant && verdict.mutant.targetTestFailed).toBe(true);
    expect("isAssertion" in verdict.mutant && verdict.mutant.isAssertion).toBe(true);
    // The trusted signal is a real JUnit/opentest4j assertion class.
    expect("failureType" in verdict.mutant && verdict.mutant.failureType).toMatch(/AssertionFailedError|AssertionError/);
    expect(status).toBe(0);
  }, TEST_TIMEOUT);

  it("keeps an equivalent-value mutation associated_survived (no false Proven)", () => {
    const { verdict } = runSpike(path.join(fixtures, "proven"), { testMethod: "addsTwoNumbers", method: "add", mode: "equivalent" });

    expect(verdict.status).toBe("associated_survived");
    expect(verdict.proven).toBe(false);
    expect(verdict.baseline.targetTestPassed).toBe(true);
    expect("targetTestFailed" in verdict.mutant && verdict.mutant.targetTestFailed).toBe(false);
  }, TEST_TIMEOUT);

  it("refuses an ambiguous method name instead of mutating a decoy", () => {
    const { verdict, status } = runSpike(path.join(fixtures, "ambiguous"), { testMethod: "addsTwoNumbers", method: "add" });

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.reason).toMatch(/ambiguous/i);
    // The mutant is never run when the mutation is refused.
    expect("skipped" in verdict.mutant && verdict.mutant.skipped).toBe(true);
    expect(status).toBe(2);
  }, TEST_TIMEOUT);

  it("rejects a mutant compile failure as unrunnable, never proven", () => {
    const { verdict } = runSpike(path.join(fixtures, "compile-break"), { testMethod: "computesValue", method: "compute" });

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.baseline.targetTestPassed).toBe(true); // real code compiled + passed
    expect("compileFailed" in verdict.mutant && verdict.mutant.compileFailed).toBe(true);
    expect(verdict.reason).toMatch(/compile/i);
  }, TEST_TIMEOUT);

  it("rejects a runtime exception (non-assertion) as unrunnable, never proven", () => {
    const { verdict } = runSpike(path.join(fixtures, "runtime-exception"), { testMethod: "hasThreeValues", method: "values" });

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.baseline.targetTestPassed).toBe(true);
    // A NullPointerException surfaces as an <error>, not a <failure> assertion.
    expect("isAssertion" in verdict.mutant && verdict.mutant.isAssertion).toBe(false);
    expect("failureType" in verdict.mutant && verdict.mutant.failureType).toMatch(/NullPointerException/);
  }, TEST_TIMEOUT);

  it("rejects a setup precondition (@BeforeEach throws before the target) as unrunnable", () => {
    const { verdict } = runSpike(path.join(fixtures, "setup-fatal"), { testMethod: "addsTwoNumbers", method: "add" });

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    // The precondition fails the baseline itself, independent of any mutant.
    expect(verdict.baseline.targetTestPassed).toBe(false);
    expect(verdict.reason).toMatch(/baseline/i);
  }, TEST_TIMEOUT);

  // FIX 1: a GREEN baseline requires `mvn` exit 0, not just a passing target
  // testcase. Here the target testcase passes but @AfterAll throws, so the build is
  // red (exit nonzero). Without the exitCode===0 requirement the mutant's real
  // assertion failure would falsely "prove" a baseline that was never trustworthy.
  it("rejects a red baseline (target testcase passes but mvn exits nonzero) as unrunnable", () => {
    const { verdict } = runSpike(path.join(fixtures, "baseline-red"), { testMethod: "addsTwoNumbers", method: "add" });

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    // The target testcase itself passed, but the overall build was red.
    expect(verdict.baseline.targetTestPassed).toBe(true);
    expect(verdict.baseline.exitCode).not.toBe(0);
    expect(verdict.reason).toMatch(/baseline/i);
  }, TEST_TIMEOUT);

  // FIX 2: a bare `throw new AssertionError(...)` from the test class (top stack
  // frame is the test, no org.junit./org.opentest4j./org.hamcrest./org.assertj.
  // frame) is NOT a trusted assertion-API signal. The mutant fails the target test
  // with a java.lang.AssertionError, yet it must classify unrunnable, never proven.
  it("rejects a manually-thrown java.lang.AssertionError (not a trusted assertion API) as unrunnable", () => {
    const { verdict } = runSpike(path.join(fixtures, "manual-assertion-error"), { testMethod: "addsTwoNumbers", method: "add" });

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.baseline.targetTestPassed).toBe(true);
    // It DID fail the target test with an AssertionError type…
    expect("failureType" in verdict.mutant && verdict.mutant.failureType).toMatch(/AssertionError/);
    // …but the type is not attributable to a trusted assertion API via its stack.
    expect("isAssertion" in verdict.mutant && verdict.mutant.isAssertion).toBe(false);
    expect(verdict.reason).toMatch(/not an assertion/i);
  }, TEST_TIMEOUT);

  // FIX 3: a method whose only return is NESTED inside an if/loop/try (or which has
  // more than one return) is not the J-1 single-top-level-return shape. The mutator
  // refuses it, so the spike is unrunnable before any mutant runs.
  it("rejects a nested/multiple-return method (not the J-1 shape) as unrunnable", () => {
    const { verdict, status } = runSpike(path.join(fixtures, "nested-return"), { testMethod: "classifiesPositive", method: "classify" });

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.reason).toMatch(/out of scope|single top-level return|not a single/i);
    // The mutant is never run when the mutation is refused.
    expect("skipped" in verdict.mutant && verdict.mutant.skipped).toBe(true);
    expect(status).toBe(2);
  }, TEST_TIMEOUT);

  // FIX 3: a return type that is a type variable (the enclosing class's `T`, or a
  // method-level `<T>`) has no type-derived sentinel that is safe. The mutator
  // refuses it, so the spike is unrunnable before any mutant runs.
  it("rejects a type-variable (generic) return type as unrunnable", () => {
    const { verdict, status } = runSpike(path.join(fixtures, "generic-return"), { testMethod: "returnsTheValue", method: "identity" });

    expect(verdict.status).toBe("unrunnable");
    expect(verdict.proven).toBe(false);
    expect(verdict.reason).toMatch(/out of scope|generic|type[- ]variable/i);
    expect("skipped" in verdict.mutant && verdict.mutant.skipped).toBe(true);
    expect(status).toBe(2);
  }, TEST_TIMEOUT);

  it("does not forward ambient secrets into mvn / the JUnit test", () => {
    // A probe test in a temp copy records whether OPENAI_API_KEY reaches the JVM.
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-java-env-"));
    const repo = path.join(tmp, "module");
    cpSync(path.join(fixtures, "proven"), repo, { recursive: true });
    const probe = path.join(tmp, "seen.txt");
    const probeSrc = [
      "package ai.orangepro.fixture;",
      "",
      "import java.nio.file.Files;",
      "import java.nio.file.Path;",
      "import org.junit.jupiter.api.Test;",
      "",
      "class EnvProbeTest {",
      "    @Test",
      "    void probe() throws Exception {",
      '        String v = System.getenv("OPENAI_API_KEY");',
      `        Files.writeString(Path.of(${JSON.stringify(probe)}), "OPENAI_API_KEY=" + (v == null ? "" : v));`,
      "    }",
      "}",
      ""
    ].join("\n");
    writeFileSync(path.join(repo, "src/test/java/ai/orangepro/fixture/EnvProbeTest.java"), probeSrc);

    const result = spawnSync(process.execPath, [
      spike,
      "--root",
      repo,
      "--test-class",
      "ai.orangepro.fixture.EnvProbeTest",
      "--test-method",
      "probe",
      "--target",
      "src/main/java/ai/orangepro/fixture/Calculator.java",
      "--method",
      "add",
      "--maven-repo-local",
      SHARED_M2,
      "--json"
    ], {
      cwd: root,
      encoding: "utf8",
      env: { ...process.env, OPENAI_API_KEY: "sk-test-secret-value" },
      stdio: ["ignore", "pipe", "pipe"]
    });

    // The verdict is not the point here; the probe file is.
    expect(result.stdout).not.toContain("sk-test-secret-value");
    const seen = spawnSync("cat", [probe], { encoding: "utf8" }).stdout ?? "";
    expect(seen).toBe("OPENAI_API_KEY="); // ambient secret was stripped
    expect(seen).not.toContain("sk-test-secret-value");
  }, TEST_TIMEOUT);
}, { concurrent: true });
