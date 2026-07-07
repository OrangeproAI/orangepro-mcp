import { execFileSync, spawnSync } from "node:child_process";
import { cpSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = path.join(root, "tests/local/__fixtures__/dynamic-proof/nest-like");
const script = path.join(root, "scripts/spikes/dynamic-proof-real-repo-cost.mjs");
const vitestBin = require.resolve("vitest/vitest.mjs");
const fakeJestBin = path.join(root, "tests/local/__fixtures__/dynamic-proof/fake-jest-bin.cjs");
const sentinelReturn = "return {\"id\":\"mutant-order\",\"total\":-1,\"source\":\"mutant\"};";

describe("dynamic proof real-repo cost runner", () => {
  it("summarizes runnable, proven, survived, and non-assertion outcomes by repo", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-real-cost-config-"));
    const config = path.join(tmp, "cases.json");
    writeFileSync(config, JSON.stringify({
      cases: [
        {
          repo: "fixture",
          root: fixtureRoot,
          test: "src/order.real.test.ts",
          target: "src/order.service.ts",
          method: "createOrder",
          replacement: sentinelReturn,
          expected: "proven"
        },
        {
          repo: "fixture",
          root: fixtureRoot,
          test: "src/order.substituted.test.ts",
          target: "src/order.service.ts",
          method: "createOrder",
          replacement: sentinelReturn,
          expected: "associated_survived"
        },
        {
          repo: "fixture",
          root: fixtureRoot,
          test: "src/order.real-list.test.ts",
          target: "src/order.service.ts",
          method: "listOrders",
          replacement: "return [];",
          replacementMode: "promise-json",
          expected: "proven"
        },
        {
          repo: "fixture",
          root: fixtureRoot,
          test: "src/order.crash-before-assert.test.ts",
          target: "src/order.service.ts",
          method: "createOrder",
          replacement: "return null;",
          expected: "associated_non_assertion_failure"
        },
        {
          repo: "fixture",
          root: fixtureRoot,
          test: "src/order.baseline-fails.test.ts",
          target: "src/order.service.ts",
          method: "createOrder",
          replacement: sentinelReturn,
          expected: "unrunnable"
        }
      ]
    }));

    const stdout = execFileSync(process.execPath, [
      script,
      "--config",
      config,
      "--vitest-bin",
      vitestBin,
      "--runner",
      "vitest",
      "--json"
    ], {
      cwd: root,
      encoding: "utf8"
    });

    const output = JSON.parse(stdout);
    const completedProofRuns = output.cases
      .filter((item: { result?: { baseline?: { exitCode?: number }; medianProofMs?: number } }) => item.result?.baseline?.exitCode === 0 && Number.isFinite(item.result?.medianProofMs))
      .map((item: { result: { medianProofMs: number } }) => item.result.medianProofMs)
      .sort((a: number, b: number) => a - b);
    const mid = Math.floor(completedProofRuns.length / 2);
    const expectedMedian = completedProofRuns.length % 2 === 0
      ? Math.round((completedProofRuns[mid - 1] + completedProofRuns[mid]) / 2)
      : completedProofRuns[mid];
    expect(output.summary).toEqual([
      expect.objectContaining({
        repo: "fixture",
        cases: 5,
        runnable: 4,
        runnablePct: 80,
        proven: 2,
        falseProofCount: 0,
        associatedSurvived: 1,
        associatedNonAssertionFailure: 1,
        unrunnable: 1,
        runners: { vitest: 5 },
        medianProofMs: expectedMedian
      })
    ]);
  }, 40_000);

  it("rejects invalid timeout values before spawning cases", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-real-cost-config-"));
    const config = path.join(tmp, "cases.json");
    writeFileSync(config, JSON.stringify({ cases: [] }));

    const result = spawnSync(process.execPath, [
      script,
      "--config",
      config,
      "--timeout-ms",
      "abc"
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--timeout-ms must be a positive integer");
  });

  it("validates expected statuses and still accepts an empty replacement body", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-real-cost-config-"));
    const invalidConfig = path.join(tmp, "invalid.json");
    writeFileSync(invalidConfig, JSON.stringify({
      cases: [{
        repo: "fixture",
        root: fixtureRoot,
        test: "src/order.real.test.ts",
        target: "src/order.service.ts",
        method: "createOrder",
        replacement: "",
        expected: "prooven"
      }]
    }));

    const invalid = spawnSync(process.execPath, [
      script,
      "--config",
      invalidConfig
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("invalid expected status");

    const validConfig = path.join(tmp, "valid.json");
    writeFileSync(validConfig, JSON.stringify({
      cases: [{
        repo: "fixture",
        root: fixtureRoot,
        test: "src/order.real.test.ts",
        target: "src/order.service.ts",
        method: "createOrder",
        replacement: "",
        expected: "proven"
      }]
    }));

    const valid = spawnSync(process.execPath, [
      script,
      "--config",
      validConfig,
      "--vitest-bin",
      vitestBin,
      "--runner",
      "vitest",
      "--json"
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });
    expect(valid.status).toBe(0);
    expect(JSON.parse(valid.stdout).summary[0]).toEqual(expect.objectContaining({
      cases: 1,
      proven: 1,
      falseProofCount: 0
    }));
  }, 20_000);

  it("rejects secret-looking testEnv config keys before spawning cases", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-real-cost-env-"));
    const config = path.join(tmp, "cases.json");
    writeFileSync(config, JSON.stringify({
      cases: [{
        repo: "fixture",
        root: fixtureRoot,
        test: "src/order.real.test.ts",
        target: "src/order.service.ts",
        method: "createOrder",
        replacement: sentinelReturn,
        expected: "proven",
        testEnv: {
          AWS_ACCESS_KEY_ID: "AKIA_TEST_SECRET_VALUE"
        }
      }]
    }));

    const result = spawnSync(process.execPath, [
      script,
      "--config",
      config,
      "--vitest-bin",
      path.join(fixtureRoot, "missing-vitest.mjs"),
      "--runner",
      "vitest",
      "--json"
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("secret-looking key is not allowed");
    expect(result.stderr).not.toContain("AKIA_TEST_SECRET_VALUE");
    expect(result.stderr).not.toContain("missing-vitest");
  });

  it("redacts credential-bearing URLs from persisted unrunnable summaries", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-real-cost-url-redact-"));
    const repo = path.join(tmp, "repo");
    const config = path.join(tmp, "cases.json");
    cpSync(fixtureRoot, repo, { recursive: true });
    writeFileSync(
      path.join(repo, "src/order.db-url-fail.test.ts"),
      "throw new Error('connection refused to postgres://admin:HUNTER2SECRET@localhost/test');\n"
    );
    writeFileSync(config, JSON.stringify({
      cases: [{
        repo: "db-url-redact",
        root: repo,
        test: "src/order.db-url-fail.test.ts",
        target: "src/order.service.ts",
        method: "createOrder",
        replacement: sentinelReturn,
        expected: "unrunnable",
        testEnv: {
          OPRO_TEST_DATABASE_URL: "postgres://admin:HUNTER2SECRET@localhost/test"
        }
      }]
    }));

    const stdout = execFileSync(process.execPath, [
      script,
      "--config",
      config,
      "--vitest-bin",
      vitestBin,
      "--runner",
      "vitest",
      "--json"
    ], {
      cwd: root,
      encoding: "utf8"
    });
    const output = JSON.parse(stdout);

    expect(stdout).not.toContain("HUNTER2SECRET");
    expect(output.cases[0].result.baseline.failureSummary).toContain("postgres://admin:[REDACTED]@localhost/test");
    expect(Object.keys(output.summary[0].unrunnableReasons)).toEqual([
      expect.stringContaining("postgres://admin:[REDACTED]@localhost/test")
    ]);
  }, 20_000);

  it("summarizes Jest runner cases", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-real-cost-config-"));
    const config = path.join(tmp, "cases.json");
    writeFileSync(config, JSON.stringify({
      cases: [{
        repo: "fixture-jest",
        root: fixtureRoot,
        test: "src/order.real.test.ts",
        target: "src/order.service.ts",
        method: "createOrder",
        replacement: sentinelReturn,
        expected: "proven",
        runner: "jest"
      }]
    }));

    const stdout = execFileSync(process.execPath, [
      script,
      "--config",
      config,
      "--jest-bin",
      fakeJestBin,
      "--json"
    ], {
      cwd: root,
      encoding: "utf8"
    });

    expect(JSON.parse(stdout).summary[0]).toEqual(expect.objectContaining({
      repo: "fixture-jest",
      cases: 1,
      runnable: 1,
      proven: 1,
      falseProofCount: 0,
      runners: { jest: 1 }
    }));
  }, 20_000);

  it("runs trusted setup commands before measuring a repo", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-real-cost-setup-"));
    const repo = path.join(tmp, "repo");
    const config = path.join(tmp, "cases.json");
    cpSync(fixtureRoot, repo, { recursive: true });
    writeFileSync(path.join(repo, "vitest.config.mjs"), "export default {};\n");
    writeFileSync(path.join(repo, "src/order.setup-marker.test.ts"), [
      "import { readFileSync } from \"node:fs\";",
      "import { describe, expect, it } from \"vitest\";",
      "import { OrderService } from \"./order.service\";",
      "",
      "describe(\"setup marker\", () => {",
      "  it(\"uses setup output and real service behavior\", async () => {",
      "    expect(readFileSync(new URL(\"../setup-marker.txt\", import.meta.url), \"utf8\")).toBe(\"ready\");",
      "    expect(process.env.OPRO_TEST_DATABASE_URL).toBe(\"sqlite://setup-fixture\");",
      "    const result = await new OrderService().createOrder({ total: 3 });",
      "    expect(result).toEqual({ id: \"real-order\", total: 3, source: \"real\" });",
      "  });",
      "});",
      ""
    ].join("\n"));
    writeFileSync(config, JSON.stringify({
      cases: [{
        repo: "setup-fixture",
        root: repo,
        test: "src/order.setup-marker.test.ts",
        target: "src/order.service.ts",
        method: "createOrder",
        replacement: sentinelReturn,
        expected: "proven",
        vitestConfig: "vitest.config.mjs",
        testEnv: {
          OPRO_TEST_DATABASE_URL: "sqlite://setup-fixture"
        },
        setupCommands: [{
          command: process.execPath,
          args: ["-e", "require('fs').writeFileSync('setup-marker.txt','ready')"]
        }]
      }]
    }));

    const stdout = execFileSync(process.execPath, [
      script,
      "--config",
      config,
      "--vitest-bin",
      vitestBin,
      "--runner",
      "vitest",
      "--json"
    ], {
      cwd: root,
      encoding: "utf8"
    });
    const output = JSON.parse(stdout);

    expect(output.cases[0].setup).toEqual(expect.objectContaining({
      status: "passed"
    }));
    expect(output.cases[0].vitestConfig).toBe("vitest.config.mjs");
    expect(output.cases[0].testEnv).toEqual(["OPRO_TEST_DATABASE_URL"]);
    expect(JSON.stringify(output)).not.toContain("sqlite://setup-fixture");
    expect(output.summary[0]).toEqual(expect.objectContaining({
      repo: "setup-fixture",
      cases: 1,
      runnable: 1,
      proven: 1,
      falseProofCount: 0
    }));
  }, 20_000);

  it("marks cases unrunnable when setup fails before proof execution", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-real-cost-setup-fail-"));
    const config = path.join(tmp, "cases.json");
    writeFileSync(config, JSON.stringify({
      cases: [{
        repo: "setup-fail-fixture",
        root: fixtureRoot,
        test: "src/order.real.test.ts",
        target: "src/order.service.ts",
        method: "createOrder",
        replacement: sentinelReturn,
        expected: "unrunnable",
        setupCommands: [{
          command: process.execPath,
          args: ["-e", "process.stderr.write('OPENAI_API_KEY=sk-test-secret-value\\n'); process.exit(7)"]
        }]
      }]
    }));

    const stdout = execFileSync(process.execPath, [
      script,
      "--config",
      config,
      "--vitest-bin",
      path.join(fixtureRoot, "missing-vitest.mjs"),
      "--runner",
      "vitest",
      "--json"
    ], {
      cwd: root,
      encoding: "utf8"
    });
    const output = JSON.parse(stdout);

    expect(output.cases[0].result.status).toBe("unrunnable");
    expect(output.cases[0].result.baseline.failureSummary).toContain("setup failed");
    expect(JSON.stringify(output)).not.toContain("sk-test-secret-value");
    expect(JSON.stringify(output)).not.toContain("missing-vitest");
    expect(output.summary[0]).toEqual(expect.objectContaining({
      repo: "setup-fail-fixture",
      cases: 1,
      runnable: 0,
      unrunnable: 1,
      proven: 0,
      falseProofCount: 0
    }));
  }, 20_000);
});
