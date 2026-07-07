import { execFileSync, spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fixtureRoot = path.join(root, "tests/local/__fixtures__/dynamic-proof/nest-like");
const script = path.join(root, "scripts/spikes/dynamic-proof-spike.mjs");
const vitestBin = require.resolve("vitest/vitest.mjs");
const mochaBin = require.resolve("mocha/bin/mocha.js");
const fakeJestBin = path.join(root, "tests/local/__fixtures__/dynamic-proof/fake-jest-bin.cjs");
const sentinelReturn = "return {\"id\":\"mutant-order\",\"total\":-1,\"source\":\"mutant\"};";

// M-1 monorepo fixture: packages/svc/tsconfig.json extends ../../tsconfig.json (the Medplum shape).
const monoExtendsFixture = path.join(root, "tests/local/__fixtures__/dynamic-proof/mono-extends");
const monoExtendsPkg = path.join(monoExtendsFixture, "packages/svc");
const calcSentinel = "return {\"value\":-1,\"source\":\"mutant\"};";
const calcEquivalent = "return {\"value\":5,\"source\":\"real\"};";

// M-2 monorepo fixture: packages/a imports packages/b SOURCE via the "@b/*" tsconfig paths alias (the nest shape).
const monoPathsFixture = path.join(root, "tests/local/__fixtures__/dynamic-proof/mono-paths");
const monoPathsPkg = path.join(monoPathsFixture, "packages/a");
const ordersSentinel = "return {\"value\":-1,\"source\":\"mutant\"};";
const ordersEquivalent = "return {\"value\":110,\"source\":\"real\"};";

function runSpike(
  testFile: string,
  replacement = sentinelReturn,
  target = "src/order.service.ts",
  extraArgs: string[] = ["--runner", "vitest"],
  method = "createOrder"
) {
  const stdout = execFileSync(process.execPath, [
    script,
    "--root",
    fixtureRoot,
    "--test",
    `src/${testFile}`,
    "--target",
    target,
    "--method",
    method,
    "--replacement",
    replacement,
    "--vitest-bin",
    vitestBin,
    "--jest-bin",
    fakeJestBin,
    ...extraArgs,
    "--json"
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(stdout) as {
    status: string;
    proven: boolean;
    reason: string;
    runner: string;
    replacementMode: string;
    testEnv: string[];
    baseline: { exitCode: number };
    mutant: { exitCode: number; assertionFailure: boolean };
  };
}

function runSpikeProcess(testFile: string, replacement: string) {
  return spawnSync(process.execPath, [
    script,
    "--root",
    fixtureRoot,
    "--test",
    `src/${testFile}`,
    "--target",
    "src/order.service.ts",
    "--method",
    "createOrder",
    "--replacement",
    replacement,
    "--vitest-bin",
    vitestBin,
    "--jest-bin",
    fakeJestBin,
    "--runner",
    "vitest",
    "--json"
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}

function runSpikeWithRoot(
  rootDir: string,
  testFile: string,
  replacement: string,
  target = "src/order.service.ts",
  extraArgs: string[] = ["--runner", "vitest"],
  method = "createOrder"
) {
  const stdout = execFileSync(process.execPath, [
    script,
    "--root",
    rootDir,
    "--test",
    `src/${testFile}`,
    "--target",
    target,
    "--method",
    method,
    "--replacement",
    replacement,
    "--vitest-bin",
    vitestBin,
    "--jest-bin",
    fakeJestBin,
    ...extraArgs,
    "--json"
  ], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(stdout) as {
    status: string;
    proven: boolean;
    runner: string;
    vitestConfig: string | null;
    jestConfig: string | null;
    mutant: { assertionFailure: boolean };
  };
}

describe("dynamic proof spike", () => {
  const realBindingCases = [
    "order.real.test.ts",
    "order.real-helper.test.ts",
    "order.real-getter.test.ts"
  ];

  it.each(realBindingCases)("marks %s as proven when mutating the real body kills the assertion", testFile => {
    const result = runSpike(testFile);

    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.baseline.exitCode).toBe(0);
    expect(result.mutant.assertionFailure).toBe(true);
  });

  const substitutedBindingCases = [
    "order.substituted.test.ts",
    "order.use-class.test.ts",
    "order.override-provider.test.ts",
    "order.instance-assign.test.ts",
    "order.object-assign.test.ts",
    "order.prototype-patch.test.ts",
    "order.container-stash.test.ts",
    "order.reflect-set.test.ts",
    "order.define-property.test.ts",
    "order.map-stash.test.ts"
  ];

  it.each(substitutedBindingCases)("keeps %s associated when mutating the real body does not affect the test", testFile => {
    const result = runSpike(testFile);

    expect(result.status).toBe("associated_survived");
    expect(result.proven).toBe(false);
    expect(result.baseline.exitCode).toBe(0);
    expect(result.mutant.exitCode).toBe(0);
  }, 10_000);

  it("does not count a pre-assertion runtime failure as proof", () => {
    const result = runSpike("order.crash-before-assert.test.ts", "return null;");

    expect(result.status).toBe("associated_non_assertion_failure");
    expect(result.proven).toBe(false);
    expect(result.mutant.assertionFailure).toBe(false);
  });

  it("does not count a lifecycle hook assertion as proof", () => {
    const result = runSpike("order.hook-assert.test.ts", "return null;");

    expect(result.status).toBe("associated_non_assertion_failure");
    expect(result.proven).toBe(false);
    expect(result.mutant.assertionFailure).toBe(false);
  });

  it("requires the same runner-reported test to pass baseline and fail the mutant", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-exact-test-"));
    const repo = path.join(tmp, "repo");
    mkdirSync(path.join(repo, "src"), { recursive: true });
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({ name: "exact-test-binding", private: true, type: "module" }));
    writeFileSync(path.join(repo, "src/order.service.ts"), [
      "export class OrderService {",
      "  createOrder() {",
      "    return { id: \"real-order\" };",
      "  }",
      "}"
    ].join("\n"));
    writeFileSync(path.join(repo, "src/exact-binding.test.ts"), [
      "import assert from \"node:assert/strict\";",
      "it(\"target test\", () => { assert.ok(true); });",
      "it(\"unrelated test\", () => { assert.equal(1, 2); });"
    ].join("\n"));
    const fakeVitest = path.join(tmp, "fake-vitest.mjs");
    writeFileSync(fakeVitest, [
      "import { readFileSync, writeFileSync } from 'node:fs';",
      "import path from 'node:path';",
      "const mutated = readFileSync('src/order.service.ts', 'utf8').includes('return null');",
      "const testAbs = path.resolve('src/exact-binding.test.ts');",
      "const report = mutated ? { testResults: [{ name: testAbs, assertionResults: [{",
      "  ancestorTitles: [],",
      "  fullName: 'unrelated test',",
      "  title: 'unrelated test',",
      "  status: 'failed',",
      "  failureMessages: [`AssertionError: unrelated failed\\n    at ${testAbs}:3:31`],",
      "  failureDetails: [{ name: 'AssertionError', actual: 1, expected: 2, operator: 'strictEqual', showDiff: true, ok: false, diff: 'Expected: 2\\nReceived: 1' }]",
      "}] }] } : { testResults: [{ name: testAbs, assertionResults: [{",
      "  ancestorTitles: [],",
      "  fullName: 'target test',",
      "  title: 'target test',",
      "  status: 'passed',",
      "  failureMessages: [],",
      "  failureDetails: []",
      "}] }] };",
      "writeFileSync(process.env.OPRO_DYNAMIC_PROOF_REPORT, JSON.stringify(report));",
      "process.exit(mutated ? 1 : 0);"
    ].join("\n"));

    const run = spawnSync(process.execPath, [
      script,
      "--root", repo,
      "--test", "src/exact-binding.test.ts",
      "--target", "src/order.service.ts",
      "--method", "createOrder",
      "--replacement", "return null;",
      "--runner", "vitest",
      "--vitest-bin", fakeVitest,
      "--json"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.status).toBe("associated_non_assertion_failure");
    expect(result.proven).toBe(false);
    expect(result.mutant.assertionFailure).toBe(false);
  });

  it("passes explicit non-secret test env to baseline and mutant runs", () => {
    const result = runSpike(
      "order.env.test.ts",
      sentinelReturn,
      "src/order.service.ts",
      ["--runner", "vitest", "--test-env", "OPRO_TEST_DATABASE_URL=sqlite://local-test-db"]
    );

    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.testEnv).toEqual(["OPRO_TEST_DATABASE_URL"]);
    expect(result.mutant.assertionFailure).toBe(true);
  });

  it("rejects secret-looking explicit test env keys before spawning the baseline runner", () => {
    const result = spawnSync(process.execPath, [
      script,
      "--root",
      fixtureRoot,
      "--test",
      "src/order.env.test.ts",
      "--target",
      "src/order.service.ts",
      "--method",
      "createOrder",
      "--replacement",
      sentinelReturn,
      "--test-env",
      "OPENAI_API_KEY=sk-test-secret-value",
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
    expect(result.stderr).toContain("Secret-looking --test-env key is not allowed");
    expect(result.stderr).not.toContain("sk-test-secret-value");
    expect(result.stderr).not.toContain("missing-vitest");
  });

  it("redacts credential-bearing URLs from failure summaries", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-url-redact-"));
    const repo = path.join(tmp, "repo");
    cpSync(fixtureRoot, repo, { recursive: true });
    writeFileSync(
      path.join(repo, "src/order.db-url-fail.test.ts"),
      "throw new Error('connection refused to postgres://admin:HUNTER2SECRET@localhost/test');\n"
    );

    const result = spawnSync(process.execPath, [
      script,
      "--root",
      repo,
      "--test",
      "src/order.db-url-fail.test.ts",
      "--target",
      "src/order.service.ts",
      "--method",
      "createOrder",
      "--replacement",
      sentinelReturn,
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

    expect(result.status).toBe(2);
    expect(result.stdout).not.toContain("HUNTER2SECRET");
    expect(result.stdout).toContain("postgres://admin:[REDACTED]@localhost/test");
    expect(JSON.parse(result.stdout).baseline.failureSummary).toContain("postgres://admin:[REDACTED]@localhost/test");
  });

  it("proves Promise-returning methods with a tool-generated promise sentinel", () => {
    const result = runSpike(
      "order.real-list.test.ts",
      "return [];",
      "src/order.service.ts",
      ["--runner", "vitest", "--replacement-mode", "promise-json"],
      "listOrders"
    );

    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.replacementMode).toBe("promise-json");
    expect(result.mutant.assertionFailure).toBe(true);
  });

  it("rejects executable replacement bodies before running the mutant", () => {
    const result = runSpikeProcess("order.real.test.ts", "throw new Error(\"expected order to be persisted\");");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--replacement must be an inert sentinel");
  });

  it("rejects multiline return sentinels that would trigger ASI", () => {
    const result = runSpikeProcess("order.real.test.ts", "return\n[1,2,3];");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--replacement must be an inert sentinel");
  });

  it("rejects whitespace-before-newline return sentinels that would trigger ASI", () => {
    const result = runSpikeProcess("order.real.test.ts", "return \n[1,2,3];");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--replacement must be an inert sentinel");
  });

  it("rejects multi-statement return sentinels with a precise error", () => {
    const result = runSpikeProcess("order.real.test.ts", "return 1; console.log(\"owned\");");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--replacement must be a single return of a JSON literal");
  });

  it("rejects oversized replacement literals before running tests", () => {
    const result = runSpikeProcess("order.real.test.ts", `return "${"x".repeat(8193)}";`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--replacement is too large");
  });

  it("validates the replacement before spawning the baseline runner", () => {
    const result = spawnSync(process.execPath, [
      script,
      "--root",
      fixtureRoot,
      "--test",
      "src/order.real.test.ts",
      "--target",
      "src/order.service.ts",
      "--method",
      "createOrder",
      "--replacement",
      "return\n[1,2,3];",
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
    expect(result.stderr).toContain("--replacement must be an inert sentinel");
    expect(result.stderr).not.toContain("missing-vitest");
  });

  it("reports a clear error when the selected runner binary is missing", () => {
    const result = spawnSync(process.execPath, [
      script,
      "--root",
      fixtureRoot,
      "--test",
      "src/order.real.test.ts",
      "--target",
      "src/order.service.ts",
      "--method",
      "createOrder",
      "--replacement",
      sentinelReturn,
      "--jest-bin",
      path.join(fixtureRoot, "missing-jest.js"),
      "--runner",
      "jest",
      "--json"
    ], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"]
    });

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("jest runner binary not found");
  });

  it("rejects deeply nested replacement literals", () => {
    const result = runSpikeProcess("order.real.test.ts", `return ${"[".repeat(30)}0${"]".repeat(30)};`);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--replacement JSON literal is too deeply nested");
  });

  it("rejects prototype-shaped replacement keys", () => {
    const result = runSpikeProcess("order.real.test.ts", "return {\"__proto__\":null};");

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--replacement JSON literal may not include prototype-shaped keys");
  });

  it("rejects implementation-thrown AssertionError replacements", () => {
    const result = runSpikeProcess(
      "order.unrelated-assert.test.ts",
      "const assert = await import(\"node:assert\"); throw new assert.AssertionError({ message: \"expected order to persist\", actual: false, expected: true, operator: \"strictEqual\" });"
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--replacement must be an inert sentinel");
  });

  it("does not trust a fabricated assertion stack from the mutated implementation", () => {
    const testSource = readFileSync(path.join(fixtureRoot, "src/order.real.test.ts"), "utf8");
    const assertionLine = testSource.split(/\r?\n/).findIndex(line => line.includes("expect(result).toEqual")) + 1;
    const result = runSpikeProcess(
      "order.real.test.ts",
      `const error = new Error("AssertionError: spoofed proof"); error.name = "AssertionError"; error.actual = "mutant"; error.expected = "real"; error.operator = "toBe"; error.showDiff = true; error.ok = false; error.diff = "Expected: real\\nReceived: mutant"; error.stack = "AssertionError: spoofed proof\\n    at ${process.cwd()}/src/order.real.test.ts:${assertionLine}:5"; throw error;`
    );

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--replacement must be an inert sentinel");
  });

  it("refuses ambiguous method targets instead of mutating a decoy method", () => {
    expect(() => runSpike(
      "order.decoy.test.ts",
      sentinelReturn,
      "src/order.decoy.service.ts"
    )).toThrow(/Ambiguous method createOrder/);
  });

  it("does not preserve source-repo symlinks into the mutant copy", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-symlink-"));
    const repo = path.join(tmp, "repo");
    const outside = path.join(tmp, "outside");
    cpSync(fixtureRoot, repo, { recursive: true });
    mkdirSync(outside);
    symlinkSync(outside, path.join(repo, "leak"), "dir");

    const result = runSpikeWithRoot(
      repo,
      "order.real.test.ts",
      "return null;"
    );

    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(existsSync(path.join(outside, "marker.txt"))).toBe(false);
  });

  it("does not pass ambient API keys into repo test execution", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-env-"));
    const repo = path.join(tmp, "repo");
    cpSync(fixtureRoot, repo, { recursive: true });
    writeFileSync(path.join(repo, "vitest.config.mjs"), "throw new Error(`OPENAI_API_KEY=${process.env.OPENAI_API_KEY}`);\n");

    const run = spawnSync(process.execPath, [
      script,
      "--root",
      repo,
      "--test",
      "src/order.real.test.ts",
      "--target",
      "src/order.service.ts",
      "--method",
      "createOrder",
      "--replacement",
      sentinelReturn,
      "--vitest-bin",
      vitestBin,
      "--jest-bin",
      fakeJestBin,
      "--json"
    ], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...process.env,
        OPENAI_API_KEY: "sk-test-secret-value"
      },
      stdio: ["ignore", "pipe", "pipe"]
    });

    expect(run.status).toBe(2);
    const result = JSON.parse(run.stdout);
    expect(result.status).toBe("unrunnable");
    expect(JSON.stringify(result)).not.toContain("sk-test-secret-value");
  });

  it("runs the same sentinel proof flow through an explicit Jest runner", () => {
    const result = runSpike("order.real.test.ts", sentinelReturn, "src/order.service.ts", ["--runner", "jest"]);

    expect(result.runner).toBe("jest");
    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.mutant.assertionFailure).toBe(true);
  });

  it("auto-detects Jest from repo config", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-jest-"));
    const repo = path.join(tmp, "repo");
    cpSync(fixtureRoot, repo, { recursive: true });
    writeFileSync(path.join(repo, "jest.config.cjs"), "module.exports = {};\n");

    const result = runSpikeWithRoot(
      repo,
      "order.real.test.ts",
      sentinelReturn,
      "src/order.service.ts",
      ["--runner", "auto"]
    );

    expect(result.runner).toBe("jest");
    expect(result.status).toBe("proven");
  });

  it("auto-detects Jest from common scoped Jest packages", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-jest-package-"));
    const repo = path.join(tmp, "repo");
    cpSync(fixtureRoot, repo, { recursive: true });
    writeFileSync(path.join(repo, "package.json"), JSON.stringify({
      name: "jest-package-detect",
      devDependencies: {
        "@jest/core": "29.0.0"
      }
    }));

    const result = runSpikeWithRoot(
      repo,
      "order.real.test.ts",
      sentinelReturn,
      "src/order.service.ts",
      ["--runner", "auto"]
    );

    expect(result.runner).toBe("jest");
    expect(result.status).toBe("proven");
  });

  it("runs Jest with an explicit config path without overriding rootDir", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-jest-config-"));
    const repo = path.join(tmp, "repo");
    cpSync(fixtureRoot, repo, { recursive: true });
    writeFileSync(path.join(repo, "jest.config.cjs"), "module.exports = { rootDir: '.' };\n");

    const result = runSpikeWithRoot(
      repo,
      "order.real.test.ts",
      sentinelReturn,
      "src/order.service.ts",
      ["--runner", "jest", "--jest-config", "jest.config.cjs"]
    );

    expect(result.runner).toBe("jest");
    expect(result.jestConfig).toBe("jest.config.cjs");
    expect(result.status).toBe("proven");
  });

  it("runs the sentinel proof flow through an explicit Mocha runner", () => {
    const repo = path.join(root, "tests/local/__fixtures__/dynamic-proof/mocha-like");
    const run = spawnSync(process.execPath, [
      script,
      "--root", repo,
      "--test", "test/cart.test.js",
      "--target", "src/cart.service.js",
      "--method", "total",
      "--replacement", "return -1;",
      "--runner", "mocha",
      "--mocha-bin", mochaBin,
      "--json"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.runner).toBe("mocha");
    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.mutant.assertionFailure).toBe(true);
  });

  it("auto-detects Mocha and closes only through the same assertion gate", () => {
    const repo = path.join(root, "tests/local/__fixtures__/dynamic-proof/mocha-like");
    const run = spawnSync(process.execPath, [
      script,
      "--root", repo,
      "--test", "test/cart.test.js",
      "--target", "src/cart.service.js",
      "--method", "total",
      "--replacement", "return -1;",
      "--mocha-bin", mochaBin,
      "--json"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.runner).toBe("mocha");
    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.mutant.assertionFailure).toBe(true);
  });

  it("keeps Mocha mutant-only non-assertion failures out of Proven", () => {
    const repo = path.join(root, "tests/local/__fixtures__/dynamic-proof/mocha-like");
    const run = spawnSync(process.execPath, [
      script,
      "--root", repo,
      "--test", "test/cart.test.js",
      "--target", "src/cart.service.js",
      "--method", "explode",
      "--replacement", "return \"mutant\";",
      "--runner", "mocha",
      "--mocha-bin", mochaBin,
      "--json"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.runner).toBe("mocha");
    expect(result.status).toBe("associated_non_assertion_failure");
    expect(result.proven).toBe(false);
    expect(result.mutant.assertionFailure).toBe(false);
  });

  it("keeps Mocha hook assertions out of Proven", () => {
    const repo = path.join(root, "tests/local/__fixtures__/dynamic-proof/mocha-like");
    const run = spawnSync(process.execPath, [
      script,
      "--root", repo,
      "--test", "test/cart-hook.test.js",
      "--target", "src/cart.service.js",
      "--method", "total",
      "--replacement", "return 0;",
      "--runner", "mocha",
      "--mocha-bin", mochaBin,
      "--json"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.runner).toBe("mocha");
    expect(result.status).toBe("associated_non_assertion_failure");
    expect(result.proven).toBe(false);
    expect(result.mutant.assertionFailure).toBe(false);
  });

  it("attributes Mocha assertion stack frames relative to the workspace root", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-mocha-ws-"));
    try {
      const mono = path.join(tmp, "mono");
      const svc = path.join(mono, "packages/svc");
      mkdirSync(path.join(svc, "src"), { recursive: true });
      mkdirSync(path.join(svc, "test"), { recursive: true });
      writeFileSync(path.join(mono, "package.json"), JSON.stringify({ private: true, workspaces: ["packages/*"] }));
      writeFileSync(path.join(svc, "package.json"), JSON.stringify({ name: "@ws/mocha-svc", type: "module", devDependencies: { mocha: "*" } }));
      writeFileSync(path.join(svc, "src/value.js"), [
        "export class ValueService {",
        "  get() {",
        "    return 7;",
        "  }",
        "}"
      ].join("\n"));
      writeFileSync(path.join(svc, "test/value.test.js"), [
        "import assert from 'node:assert/strict';",
        "import { ValueService } from '../src/value.js';",
        "describe('ValueService', () => {",
        "  it('asserts the concrete value', () => {",
        "    assert.equal(new ValueService().get(), 7);",
        "  });",
        "});"
      ].join("\n"));

      const run = spawnSync(process.execPath, [
        script,
        "--root", svc,
        "--test", "test/value.test.js",
        "--target", "src/value.js",
        "--method", "get",
        "--replacement", "return 0;",
        "--runner", "mocha",
        "--mocha-bin", mochaBin,
        "--json"
      ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

      expect(run.status).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result.runner).toBe("mocha");
      expect(result.status).toBe("proven");
      expect(result.proven).toBe(true);
      expect(result.mutant.assertionFailure).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("runs Vitest with an explicit config path", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-vitest-config-"));
    const repo = path.join(tmp, "repo");
    cpSync(fixtureRoot, repo, { recursive: true });
    writeFileSync(path.join(repo, "vitest.config.mjs"), "export default {};\n");

    const result = runSpikeWithRoot(
      repo,
      "order.real.test.ts",
      sentinelReturn,
      "src/order.service.ts",
      ["--runner", "vitest", "--vitest-config", "vitest.config.mjs"]
    );

    expect(result.runner).toBe("vitest");
    expect(result.vitestConfig).toBe("vitest.config.mjs");
    expect(result.status).toBe("proven");
  });

  // ── R-2 (Codex correction #2): NODE_OPTIONS flag allowlist AT THE SPIKE BOUNDARY ──
  function spawnWithTestEnv(testEnvEntry: string, vitestBinPath: string) {
    return spawnSync(process.execPath, [
      script,
      "--root", fixtureRoot,
      "--test", "src/order.env.test.ts",
      "--target", "src/order.service.ts",
      "--method", "createOrder",
      "--replacement", sentinelReturn,
      "--test-env", testEnvEntry,
      "--vitest-bin", vitestBinPath,
      "--runner", "vitest",
      "--json"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  it("rejects a NODE_OPTIONS --test-env carrying a non-allowlisted flag (--require) BEFORE spawning", () => {
    // Missing vitest bin: if the allowlist did NOT reject first, we'd see a bin error instead.
    const result = spawnWithTestEnv("NODE_OPTIONS=--require=/tmp/evil.js", path.join(fixtureRoot, "missing-vitest.mjs"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NODE_OPTIONS only permits");
    expect(result.stderr).not.toContain("missing-vitest"); // rejected before the runner-bin check
  });

  it("rejects a NODE_OPTIONS value mixing an allowed and a non-allowed flag", () => {
    const result = spawnWithTestEnv("NODE_OPTIONS=--experimental-sqlite --import=/tmp/x.js", path.join(fixtureRoot, "missing-vitest.mjs"));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("NODE_OPTIONS only permits");
  });

  // --experimental-sqlite is a valid NODE_OPTIONS flag only on Node >= 22.5; on older Node (e.g. CI's
  // Node 20) it is rejected outright, so this "forward + run green" assertion only applies where the
  // runner Node accepts it. The allowlist itself (accept the flag, reject --require/--import) is
  // covered Node-independently by the reject tests above.
  it.skipIf(!process.allowedNodeEnvironmentFlags.has("--experimental-sqlite"))(
    "accepts NODE_OPTIONS=--experimental-sqlite (allowlisted) and forwards it to the runner",
    () => {
      const result = runSpike(
        "order.real.test.ts",
        sentinelReturn,
        "src/order.service.ts",
        ["--runner", "vitest", "--test-env", "NODE_OPTIONS=--experimental-sqlite"]
      );
      expect(result.status).toBe("proven");
      expect(result.testEnv).toContain("NODE_OPTIONS");
    }
  );

  it("sanitizedEnv drops ambient process.env.NODE_OPTIONS (never forwarded to the proof fork)", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-nodeopts-"));
    const repo = path.join(tmp, "repo");
    cpSync(fixtureRoot, repo, { recursive: true });
    const probe = path.join(tmp, "probe.txt");
    // The vitest config (loaded inside the proof fork) records the fork's NODE_OPTIONS.
    writeFileSync(
      path.join(repo, "vitest.config.mjs"),
      `import { writeFileSync } from 'node:fs';\nwriteFileSync(${JSON.stringify(probe)}, 'NODE_OPTIONS=' + (process.env.NODE_OPTIONS ?? 'UNSET'));\nexport default {};\n`
    );
    const run = spawnSync(process.execPath, [
      script,
      "--root", repo,
      "--test", "src/order.real.test.ts",
      "--target", "src/order.service.ts",
      "--method", "createOrder",
      "--replacement", sentinelReturn,
      "--vitest-bin", vitestBin,
      "--jest-bin", fakeJestBin,
      "--json"
    ], {
      cwd: root,
      encoding: "utf8",
      // Ambient NODE_OPTIONS on the SPIKE process (a benign, NODE_OPTIONS-legal flag).
      env: { ...process.env, NODE_OPTIONS: "--max-http-header-size=1234" },
      stdio: ["ignore", "pipe", "pipe"]
    });
    expect(run.status).toBe(0);
    const seen = readFileSync(probe, "utf8");
    expect(seen).toBe("NODE_OPTIONS=UNSET"); // ambient value stripped
    expect(seen).not.toContain("1234");
  });
});

// ── Free-function mutator: name-bound block functions (arrow-const block + function expression) ──
// Post-#180 v5 generates runnable tests for free/exported functions. The locator now UNIONs methodRe with a
// name-bound freeFnRe so those shapes become closed proofs, under the SAME cross-form ambiguity guard.
describe("dynamic proof spike — free-function mutator", () => {
  const freeFnFixture = path.join(root, "tests/local/__fixtures__/dynamic-proof/free-fn");
  const freeFnKill = "return {\"value\":-1,\"source\":\"mutant\"};";
  const freeFnEquivalent = "return {\"value\":5,\"source\":\"real\"};";

  it("proves an arrow-const block free function (0→1) with an inert killing sentinel", () => {
    const result = runSpikeWithRoot(
      freeFnFixture,
      "compute-arrow.test.ts",
      freeFnKill,
      "src/compute-arrow.ts",
      ["--runner", "vitest"],
      "compute"
    );

    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.mutant.assertionFailure).toBe(true);
  });

  it("proves a function-expression free function bound to a const", () => {
    const result = runSpikeWithRoot(
      freeFnFixture,
      "compute-fnexpr.test.ts",
      freeFnKill,
      "src/compute-fnexpr.ts",
      ["--runner", "vitest"],
      "compute"
    );

    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.mutant.assertionFailure).toBe(true);
  });

  it("keeps an equivalent-value mutation of a free function associated (survives, no false proof)", () => {
    const result = runSpikeWithRoot(
      freeFnFixture,
      "compute-arrow.test.ts",
      freeFnEquivalent,
      "src/compute-arrow.ts",
      ["--runner", "vitest"],
      "compute"
    );

    expect(result.status).toBe("associated_survived");
    expect(result.proven).toBe(false);
    expect(result.mutant.assertionFailure).toBe(false);
  });

  it("stays honestly unrunnable for an expression-body arrow (no block to mutate — fail safe)", () => {
    expect(() => runSpikeWithRoot(
      freeFnFixture,
      "compute-expr-arrow.test.ts",
      freeFnKill,
      "src/compute-expr-arrow.ts",
      ["--runner", "vitest"],
      "compute"
    )).toThrow(/Could not find method compute/);
  });

  it("refuses an ambiguous free-function name (a const AND a method of the same name) instead of mutating a decoy", () => {
    expect(() => runSpikeWithRoot(
      freeFnFixture,
      "compute-ambiguous.test.ts",
      freeFnKill,
      "src/compute-ambiguous.ts",
      ["--runner", "vitest"],
      "compute"
    )).toThrow(/Ambiguous method compute/);
  });
});

describe("dynamic proof spike — monorepo tsconfig extends (M-1)", () => {
  it("mirrors the extends chain so a monorepo package baseline transforms and an inert sentinel proves", () => {
    const result = runSpikeWithRoot(
      monoExtendsPkg,
      "calc.test.ts",
      calcSentinel,
      "src/calc.service.ts",
      ["--runner", "vitest"],
      "add"
    );

    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.mutant.assertionFailure).toBe(true);
  });

  it("keeps an equivalent-value mutation of the same monorepo target associated (survives)", () => {
    const result = runSpikeWithRoot(
      monoExtendsPkg,
      "calc.test.ts",
      calcEquivalent,
      "src/calc.service.ts",
      ["--runner", "vitest"],
      "add"
    );

    expect(result.status).toBe("associated_survived");
    expect(result.proven).toBe(false);
  });

  it("copies parent configs as bytes: a write-through to the mirrored parent leaves the source tree byte-unchanged", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-mono-canary-"));
    const repo = path.join(tmp, "mono");
    cpSync(monoExtendsFixture, repo, { recursive: true });
    const parentBefore = readFileSync(path.join(repo, "tsconfig.json"), "utf8");

    const result = runSpikeWithRoot(
      path.join(repo, "packages/svc"),
      "canary.test.ts",
      calcSentinel,
      "src/calc.service.ts",
      ["--runner", "vitest"],
      "add"
    );

    // The run actually executed (baseline green, inert sentinel killed the assertion)…
    expect(result.status).toBe("proven");
    // …yet the source parent config and its directory are untouched — the mirror is copy, not symlink.
    expect(readFileSync(path.join(repo, "tsconfig.json"), "utf8")).toBe(parentBefore);
    expect(existsSync(path.join(repo, "CANARY_WROTE_HERE.txt"))).toBe(false);
  });

  it("resolves bare-module extends via node_modules without mirroring a parent config", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-mono-bare-"));
    const pkg = path.join(tmp, "pkg");
    cpSync(monoExtendsPkg, pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "tsconfig.json"),
      JSON.stringify({ extends: "@fixturebase/tsconfig/tsconfig.json", compilerOptions: {} })
    );
    const baseDir = path.join(pkg, "node_modules/@fixturebase/tsconfig");
    mkdirSync(baseDir, { recursive: true });
    writeFileSync(path.join(baseDir, "package.json"), JSON.stringify({ name: "@fixturebase/tsconfig", version: "1.0.0" }));
    writeFileSync(
      path.join(baseDir, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { target: "ES2021", module: "ESNext", moduleResolution: "Bundler", strict: true } })
    );

    const result = runSpikeWithRoot(
      pkg,
      "calc.test.ts",
      calcSentinel,
      "src/calc.service.ts",
      ["--runner", "vitest", "--link-node-modules"],
      "add"
    );

    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
  });

  it("mirrors nothing for an unresolvable extends (fail-safe) so the baseline stays honestly unrunnable", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-mono-failsafe-"));
    const pkg = path.join(tmp, "pkg");
    cpSync(monoExtendsPkg, pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "tsconfig.json"),
      JSON.stringify({ extends: "../missing-base.json", compilerOptions: {} })
    );

    const run = spawnSync(process.execPath, [
      script,
      "--root", pkg,
      "--test", "src/calc.test.ts",
      "--target", "src/calc.service.ts",
      "--method", "add",
      "--replacement", calcSentinel,
      "--vitest-bin", vitestBin,
      "--jest-bin", fakeJestBin,
      "--runner", "vitest",
      "--json"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(run.status).toBe(2);
    const result = JSON.parse(run.stdout);
    expect(result.status).toBe("unrunnable");
    expect(result.proven).toBe(false);
  });

  it("mirrors nothing for an ABSOLUTE extends (fail-safe) — only relative parents are mirrored", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-mono-abs-"));
    const pkg = path.join(tmp, "pkg");
    cpSync(monoExtendsPkg, pkg, { recursive: true });
    writeFileSync(
      path.join(pkg, "tsconfig.json"),
      JSON.stringify({ extends: "/nonexistent/opro-abs-base.json", compilerOptions: {} })
    );
    const run = spawnSync(process.execPath, [
      script, "--root", pkg, "--test", "src/calc.test.ts", "--target", "src/calc.service.ts",
      "--method", "add", "--replacement", calcSentinel, "--vitest-bin", vitestBin,
      "--jest-bin", fakeJestBin, "--runner", "vitest", "--json"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("unrunnable");
  });

  it("mirrors nothing for an over-DEPTH extends chain (fail-safe) so the baseline stays honestly unrunnable", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-mono-depth-"));
    const pkg = path.join(tmp, "pkg");
    cpSync(monoExtendsPkg, pkg, { recursive: true });
    writeFileSync(path.join(pkg, "tsconfig.json"), JSON.stringify({ extends: "../c0.json", compilerOptions: {} }));
    const chain = 10; // > TSCONFIG_EXTENDS_MAX_DEPTH (8) → TsconfigMirrorAbort → mirror nothing
    for (let i = 0; i < chain; i++) {
      const cfg = i < chain - 1 ? { extends: `./c${i + 1}.json`, compilerOptions: {} } : { compilerOptions: {} };
      writeFileSync(path.join(tmp, `c${i}.json`), JSON.stringify(cfg));
    }
    const run = spawnSync(process.execPath, [
      script, "--root", pkg, "--test", "src/calc.test.ts", "--target", "src/calc.service.ts",
      "--method", "add", "--replacement", calcSentinel, "--vitest-bin", vitestBin,
      "--jest-bin", fakeJestBin, "--runner", "vitest", "--json"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("unrunnable");
  });
});

describe("dynamic proof spike — monorepo tsconfig paths alias (M-2)", () => {
  it("copies the aliased sibling source + injects resolve.alias so a paths-alias package proves", () => {
    const result = runSpikeWithRoot(
      monoPathsPkg,
      "orders.test.ts",
      ordersSentinel,
      "src/orders.service.ts",
      ["--runner", "vitest"],
      "total"
    );

    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.mutant.assertionFailure).toBe(true);
  });

  it("keeps an equivalent-value mutation of the same paths-alias target associated (survives)", () => {
    const result = runSpikeWithRoot(
      monoPathsPkg,
      "orders.test.ts",
      ordersEquivalent,
      "src/orders.service.ts",
      ["--runner", "vitest"],
      "total"
    );

    expect(result.status).toBe("associated_survived");
    expect(result.proven).toBe(false);
  });

  it("copies aliased sibling source as bytes: a write-through leaves the sibling source byte-unchanged", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-mono-paths-canary-"));
    const repo = path.join(tmp, "mono");
    cpSync(monoPathsFixture, repo, { recursive: true });
    const taxBefore = readFileSync(path.join(repo, "packages/b/src/tax.ts"), "utf8");

    const result = runSpikeWithRoot(
      path.join(repo, "packages/a"),
      "canary.test.ts",
      ordersSentinel,
      "src/orders.service.ts",
      ["--runner", "vitest"],
      "total"
    );

    // The run actually executed (baseline green via the injected alias, sentinel killed the assertion)…
    expect(result.status).toBe("proven");
    // …yet the source sibling package is untouched — the mirror copies bytes, never a writable symlink.
    expect(readFileSync(path.join(repo, "packages/b/src/tax.ts"), "utf8")).toBe(taxBefore);
    expect(existsSync(path.join(repo, "packages/b/src/CANARY_WROTE_HERE.txt"))).toBe(false);
  });

  it("mirrors nothing for an unresolvable paths target (fail-safe) so the baseline stays honestly unrunnable", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-mono-paths-failsafe-"));
    const mono = path.join(tmp, "mono");
    cpSync(monoPathsFixture, mono, { recursive: true });
    writeFileSync(
      path.join(mono, "packages/a/tsconfig.json"),
      JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", paths: { "@b/*": ["../nonexistent/src/*"] } } })
    );
    const run = spawnSync(process.execPath, [
      script, "--root", path.join(mono, "packages/a"), "--test", "src/orders.test.ts",
      "--target", "src/orders.service.ts", "--method", "total", "--replacement", ordersSentinel,
      "--vitest-bin", vitestBin, "--jest-bin", fakeJestBin, "--runner", "vitest", "--json"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("unrunnable");
  });

  it("mirrors nothing when paths aliases exceed the entry cap (fail-safe)", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-mono-paths-cap-"));
    const mono = path.join(tmp, "mono");
    cpSync(monoPathsFixture, mono, { recursive: true });
    const paths: Record<string, string[]> = { "@b/*": ["../b/src/*"] };
    for (let i = 0; i < 200; i += 1) {
      paths[`@k${i}/*`] = ["../b/src/*"]; // 201 > TSCONFIG_MAX_PATH_ENTRIES (64) → abort → mirror nothing
    }
    writeFileSync(
      path.join(mono, "packages/a/tsconfig.json"),
      JSON.stringify({ compilerOptions: { moduleResolution: "Bundler", paths } })
    );
    const run = spawnSync(process.execPath, [
      script, "--root", path.join(mono, "packages/a"), "--test", "src/orders.test.ts",
      "--target", "src/orders.service.ts", "--method", "total", "--replacement", ordersSentinel,
      "--vitest-bin", vitestBin, "--jest-bin", fakeJestBin, "--runner", "vitest", "--json"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
    expect(run.status).toBe(2);
    expect(JSON.parse(run.stdout).status).toBe("unrunnable");
  });
});

// ── M-3 (aspect 1): resolve the runner + dependency cache from the TS/JS WORKSPACE ROOT ──
// When a focused monorepo package carries no local node_modules and the runner + deps are hoisted to
// the workspace root, the sandbox must detect that root, link its (read-only) node_modules at an
// ancestor of the package copy, and resolve the runner binary from there. No sibling SOURCE is copied.
describe("dynamic proof spike — workspace-root runner resolution (M-3)", () => {
  const monoWorkspaceFixture = path.join(root, "tests/local/__fixtures__/dynamic-proof/mono-workspace");
  const wsSvcRel = "packages/svc";
  const toolNodeModules = path.dirname(path.dirname(vitestBin)); // <toolRoot>/node_modules
  const wsSentinel = "return {\"value\":-1,\"source\":\"mutant\"};";
  const wsEquivalent = "return {\"value\":6,\"source\":\"real\"};";

  // Build a monorepo checkout whose runner + deps are HOISTED to the workspace root: the package copy
  // carries NO local node_modules; vitest and the bare `@wsdep/base` dep live only at <root>/node_modules.
  function setupHoistedVitestWorkspace() {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-ws-vitest-"));
    const mono = path.join(tmp, "mono");
    cpSync(monoWorkspaceFixture, mono, { recursive: true });
    const nodeModules = path.join(mono, "node_modules");
    mkdirSync(nodeModules, { recursive: true });
    for (const entry of readdirSync(toolNodeModules)) {
      if (entry === "@wsdep") continue;
      symlinkSync(path.join(toolNodeModules, entry), path.join(nodeModules, entry), "dir");
    }
    const dep = path.join(nodeModules, "@wsdep/base");
    mkdirSync(dep, { recursive: true });
    writeFileSync(path.join(dep, "package.json"), JSON.stringify({ name: "@wsdep/base", version: "1.0.0", type: "module", main: "index.js" }));
    writeFileSync(path.join(dep, "index.js"), "export const offset = 1;\n");
    return { tmp, mono };
  }

  function runWorkspaceSpike(mono: string, opts: { test?: string; replacement: string; runner?: string; link?: boolean }) {
    const args = [
      script,
      "--root", path.join(mono, wsSvcRel),
      "--test", opts.test ?? "src/calc.test.ts",
      "--target", "src/calc.service.ts",
      "--method", "add",
      "--replacement", opts.replacement,
      "--runner", opts.runner ?? "vitest",
      ...(opts.link === false ? [] : ["--link-node-modules"]),
      "--json"
    ];
    return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  it("resolves the hoisted vitest + workspace-root dependency cache so the package proves (0→1)", () => {
    const { tmp, mono } = setupHoistedVitestWorkspace();
    try {
      const run = runWorkspaceSpike(mono, { replacement: wsSentinel });
      expect(run.status).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("proven");
      expect(result.proven).toBe(true);
      expect(result.mutant.assertionFailure).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("treats a Lerna-only root as the workspace root for hoisted runner resolution", () => {
    const { tmp, mono } = setupHoistedVitestWorkspace();
    try {
      const rootPkgPath = path.join(mono, "package.json");
      const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
      delete rootPkg.workspaces;
      writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);
      writeFileSync(path.join(mono, "lerna.json"), JSON.stringify({ packages: ["packages/*"], version: "independent" }));

      const run = runWorkspaceSpike(mono, { replacement: wsSentinel });
      expect(run.status).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("proven");
      expect(result.proven).toBe(true);
      expect(result.mutant.assertionFailure).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps an equivalent-value mutation of the same workspace target associated (survives)", () => {
    const { tmp, mono } = setupHoistedVitestWorkspace();
    try {
      const run = runWorkspaceSpike(mono, { replacement: wsEquivalent });
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("associated_survived");
      expect(result.proven).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("stays honestly unrunnable when the workspace-root node_modules is NOT linked (link is load-bearing)", () => {
    const { tmp, mono } = setupHoistedVitestWorkspace();
    try {
      const run = runWorkspaceSpike(mono, { replacement: wsSentinel, link: false });
      expect(run.status).toBe(2);
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("unrunnable");
      expect(result.proven).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("links the workspace-root node_modules read-only: a write-through leaves the source workspace byte-unchanged", () => {
    const { tmp, mono } = setupHoistedVitestWorkspace();
    try {
      const rootPkgBefore = readFileSync(path.join(mono, "package.json"), "utf8");
      const run = runWorkspaceSpike(mono, { test: "src/canary.test.ts", replacement: wsSentinel });
      const result = JSON.parse(run.stdout);
      // The run actually executed (baseline green via the hoisted dep, sentinel killed the assertion)…
      expect(result.status).toBe("proven");
      // …yet the source workspace root is untouched — only the read-only node_modules is symlinked.
      expect(readFileSync(path.join(mono, "package.json"), "utf8")).toBe(rootPkgBefore);
      expect(existsSync(path.join(mono, "CANARY_WROTE_HERE.txt"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails closed with a clear runner reason when the workspace runner is missing entirely", () => {
    const { tmp, mono } = setupHoistedVitestWorkspace();
    try {
      // jest is present nowhere (package-local, workspace-root, or tool root) → resolution fails closed.
      const run = runWorkspaceSpike(mono, { replacement: wsSentinel, runner: "jest" });
      expect(run.status).toBe(1);
      expect(run.stderr).toContain("jest runner binary not found");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  // The real Medusa shape: a focused package whose ONLY runner (jest) is hoisted to the workspace root.
  it("resolves a jest runner hoisted to the workspace-root node_modules and proves the package", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-ws-jest-"));
    try {
      const mono = path.join(tmp, "mono");
      const svc = path.join(mono, "packages/svc");
      cpSync(fixtureRoot, svc, { recursive: true }); // nest-like package, no local node_modules
      writeFileSync(path.join(mono, "package.json"), JSON.stringify({ name: "mono-ws-jest", private: true, workspaces: ["packages/*"] }));
      const jestBinDir = path.join(mono, "node_modules/jest/bin");
      mkdirSync(jestBinDir, { recursive: true });
      copyFileSync(fakeJestBin, path.join(jestBinDir, "jest.js"));

      const run = spawnSync(process.execPath, [
        script,
        "--root", svc,
        "--test", "src/order.real.test.ts",
        "--target", "src/order.service.ts",
        "--method", "createOrder",
        "--replacement", sentinelReturn,
        "--runner", "jest",
        "--link-node-modules",
        "--json"
      ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

      expect(run.status).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result.runner).toBe("jest");
      expect(result.status).toBe("proven");
      expect(result.mutant.assertionFailure).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats a single-package repo with no workspace as a no-op (fallback resolves the package unchanged)", () => {
    // The base nest-like fixture has no workspace ancestor: detectWorkspaceRoot falls back to the package
    // root, so the proof flow is the pre-M-3 path (proven, unchanged).
    const result = runSpike("order.real.test.ts");
    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
  });
});

// ── M-3 (aspect 2): copy SIBLING workspace package output/source + runner-config helpers ──
// A focused package imports sibling workspace packages by package NAME (declared in its deps). The isolated
// single-package sandbox can't resolve those bare imports (no node_modules, not a published package), so
// aspect-2 copies the sibling's BUILT output (or SOURCE) as bytes into the sandbox and injects a
// package-name resolver alias. This is the first slice that copies sibling package bytes, so every case
// pins isolation (byte copy, never a writable symlink), built-vs-source preference, subpath precedence, and
// the fail-closed behavior for anything outside the declared closure.
describe("dynamic proof spike — workspace package resolution (M-3 aspect 2)", () => {
  const monoWsPkgFixture = path.join(root, "tests/local/__fixtures__/dynamic-proof/mono-ws-pkg");
  const wsPkgA = path.join(monoWsPkgFixture, "packages/a");
  const wsSentinel = "return {\"value\":-1,\"source\":\"mutant\"};";

  function runWsPkgSpike(rootDir: string, opts: {
    test: string;
    target: string;
    method: string;
    replacement?: string;
    extraArgs?: string[];
  }) {
    const args = [
      script,
      "--root", rootDir,
      "--test", `src/${opts.test}`,
      "--target", `src/${opts.target}`,
      "--method", opts.method,
      "--replacement", opts.replacement ?? wsSentinel,
      "--vitest-bin", vitestBin,
      "--jest-bin", fakeJestBin,
      "--runner", "vitest",
      ...(opts.extraArgs ?? []),
      "--json"
    ];
    return spawnSync(process.execPath, args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  }

  it("copies a sibling's BUILT output + aliases the package name so a bare import proves (0→1)", () => {
    // WITHOUT aspect-2 this baseline is `Cannot find package '@wspkg/b'` (asserted by the fail-closed cases
    // below). WITH aspect-2 the built dist is copied + aliased, transforms run, and the killing sentinel
    // closes Proven. base=1 comes from the BUILT dist/index.js (b's SOURCE decoy sets base=999), pinning
    // the built-vs-source preference.
    const run = runWsPkgSpike(wsPkgA, { test: "calc.test.ts", target: "calc.service.ts", method: "add" });
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.mutant.assertionFailure).toBe(true);
  }, 20_000);

  it("copies root-level runtime package segments for a declared sibling whose main is index.js", () => {
    const run = runWsPkgSpike(wsPkgA, {
      test: "root-entry.test.ts",
      target: "root-entry.service.ts",
      method: "value",
      replacement: "return 0;"
    });
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.mutant.assertionFailure).toBe(true);
  }, 20_000);

  it("mirrors TS project-reference metadata for built and type-only siblings", () => {
    // Medplum/Vite/OXC shape: a package tsconfig references sibling projects. Some referenced siblings
    // are runtime packages copied as built output; others are type-only and intentionally have no runtime
    // entry. The sandbox must still mirror their tsconfig/package metadata so setup-file transforms can
    // load the project graph. Metadata only: no type-only runtime bytes are copied or credited as evidence.
    const run = runWsPkgSpike(wsPkgA, {
      test: "reference-metadata.test.ts",
      target: "reference-metadata.service.ts",
      method: "check",
      replacement: "return {\"builtSiblingConfig\":false,\"typeOnlySiblingConfig\":false};"
    });
    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout);
    expect(result.status).toBe("proven");
    expect(result.proven).toBe(true);
    expect(result.mutant.assertionFailure).toBe(true);
  }, 20_000);

  it("uses Lerna package globs for declared sibling package resolution", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-lerna-ws-pkg-"));
    try {
      const mono = path.join(tmp, "mono");
      cpSync(monoWsPkgFixture, mono, { recursive: true });
      const rootPkgPath = path.join(mono, "package.json");
      const rootPkg = JSON.parse(readFileSync(rootPkgPath, "utf8"));
      delete rootPkg.workspaces;
      writeFileSync(rootPkgPath, `${JSON.stringify(rootPkg, null, 2)}\n`);
      writeFileSync(path.join(mono, "lerna.json"), JSON.stringify({ packages: ["packages/*"], version: "independent" }));

      const run = runWsPkgSpike(path.join(mono, "packages/a"), {
        test: "calc.test.ts",
        target: "calc.service.ts",
        method: "add"
      });
      expect(run.status).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("proven");
      expect(result.proven).toBe(true);
      expect(result.mutant.assertionFailure).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("source-copies a declared workspace sibling with no runtime entry but a source index", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-source-entry-ws-pkg-"));
    try {
      const mono = path.join(tmp, "mono");
      cpSync(monoWsPkgFixture, mono, { recursive: true });
      const bPkgPath = path.join(mono, "packages/b/package.json");
      const bPkg = JSON.parse(readFileSync(bPkgPath, "utf8"));
      delete bPkg.main;
      delete bPkg.module;
      delete bPkg.exports;
      writeFileSync(bPkgPath, `${JSON.stringify(bPkg, null, 2)}\n`);
      writeFileSync(path.join(mono, "packages/b/src/index.ts"), "export const base = 1;\n");

      const run = runWsPkgSpike(path.join(mono, "packages/a"), {
        test: "calc.test.ts",
        target: "calc.service.ts",
        method: "add"
      });
      expect(run.status).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("proven");
      expect(result.proven).toBe(true);
      expect(result.mutant.assertionFailure).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("source-copies top-level source segments for source-only sibling subpath imports", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-dynamic-source-subpath-ws-pkg-"));
    try {
      const mono = path.join(tmp, "mono");
      cpSync(monoWsPkgFixture, mono, { recursive: true });
      const bPkgPath = path.join(mono, "packages/b/package.json");
      const bPkg = JSON.parse(readFileSync(bPkgPath, "utf8"));
      delete bPkg.main;
      delete bPkg.module;
      delete bPkg.exports;
      writeFileSync(bPkgPath, `${JSON.stringify(bPkg, null, 2)}\n`);
      mkdirSync(path.join(mono, "packages/b/utils"), { recursive: true });
      writeFileSync(path.join(mono, "packages/b/utils/index.ts"), "export const offset = 4;\n");
      writeFileSync(path.join(mono, "packages/a/src/subcalc.service.ts"), [
        "import { offset } from \"@wspkg/b/utils\";",
        "export class SubCalcService {",
        "  add(a: number, b: number) {",
        "    return { value: a + b + offset, source: \"real\" as const };",
        "  }",
        "}"
      ].join("\n"));
      writeFileSync(path.join(mono, "packages/a/src/subcalc.test.ts"), [
        "import { describe, expect, it } from \"vitest\";",
        "import { SubCalcService } from \"./subcalc.service\";",
        "describe(\"SubCalcService\", () => {",
        "  it(\"asserts the source-only sibling subpath result\", () => {",
        "    expect(new SubCalcService().add(2, 3)).toEqual({ value: 9, source: \"real\" });",
        "  });",
        "});"
      ].join("\n"));

      const run = runWsPkgSpike(path.join(mono, "packages/a"), {
        test: "subcalc.test.ts",
        target: "subcalc.service.ts",
        method: "add"
      });
      expect(run.status).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("proven");
      expect(result.proven).toBe(true);
      expect(result.mutant.assertionFailure).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("keeps an equivalent-value mutation of the same built-sibling target associated (survives, falseProofCount 0)", () => {
    const run = runWsPkgSpike(wsPkgA, {
      test: "calc.test.ts",
      target: "calc.service.ts",
      method: "add",
      replacement: "return {\"value\":6,\"source\":\"real\"};"
    });
    const result = JSON.parse(run.stdout);
    expect(result.status).toBe("associated_survived");
    expect(result.proven).toBe(false);
  }, 20_000);

  it("falls back to copying a SOURCE-only sibling (src + tsconfig) so its bare import proves", () => {
    // @wspkg/src-only's package.json main points at src/index.ts (no built output); aspect-2 copies its src
    // + tsconfig and aliases the package name to the copied source entry (greet=7 → compute(3)=10).
    const run = runWsPkgSpike(wsPkgA, { test: "srconly.test.ts", target: "srconly.service.ts", method: "compute" });
    const result = JSON.parse(run.stdout);
    expect(result.status).toBe("proven");
    expect(result.mutant.assertionFailure).toBe(true);
  }, 20_000);

  it("honors `exports` subpaths and makes the copied-sibling subpath alias win over workspace-root node_modules", () => {
    // Link a workspace-root node_modules whose @wspkg/b/extra DECOY exports bonus=999. The copied-sibling
    // subpath alias (bonus=5) must win, so bump(10)===15 and the baseline is green; if node_modules won the
    // baseline would be red (unrunnable). Proven ⟹ the copied subpath alias took precedence.
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-ws-subpath-"));
    try {
      const mono = path.join(tmp, "mono");
      cpSync(monoWsPkgFixture, mono, { recursive: true });
      const decoy = path.join(mono, "node_modules/@wspkg/b");
      mkdirSync(path.join(decoy, "dist"), { recursive: true });
      writeFileSync(path.join(decoy, "package.json"), JSON.stringify({
        name: "@wspkg/b", version: "9.9.9", type: "module", main: "dist/index.js",
        exports: { ".": "./dist/index.js", "./extra": "./dist/extra.js" }
      }));
      writeFileSync(path.join(decoy, "dist/index.js"), "export const base = 999;\n");
      writeFileSync(path.join(decoy, "dist/extra.js"), "export const bonus = 999;\n");

      const run = runWsPkgSpike(path.join(mono, "packages/a"), {
        test: "subpath.test.ts", target: "subpath.service.ts", method: "bump", extraArgs: ["--link-node-modules"]
      });
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("proven");
      expect(result.mutant.assertionFailure).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("copies sibling bytes: a write-through into the copied sibling leaves the REAL sibling byte-unchanged", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-ws-canary-"));
    try {
      const mono = path.join(tmp, "mono");
      cpSync(monoWsPkgFixture, mono, { recursive: true });
      const distBefore = readFileSync(path.join(mono, "packages/b/dist/index.js"), "utf8");

      const run = runWsPkgSpike(path.join(mono, "packages/a"), {
        test: "canary.test.ts", target: "calc.service.ts", method: "add"
      });
      const result = JSON.parse(run.stdout);
      // The run actually executed (baseline green via the copied sibling, sentinel killed the assertion)…
      expect(result.status).toBe("proven");
      // …yet the source sibling package is untouched — aspect-2 copies bytes, never a writable symlink.
      expect(readFileSync(path.join(mono, "packages/b/dist/index.js"), "utf8")).toBe(distBefore);
      expect(existsSync(path.join(mono, "packages/b/CANARY_WROTE_HERE.txt"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails closed (unrunnable) when a declared sibling's entry resolves to neither built output nor source", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-ws-unresolved-"));
    try {
      const mono = path.join(tmp, "mono");
      cpSync(monoWsPkgFixture, mono, { recursive: true });
      // @wspkg/b's entry now points at a file that does not exist → workspace_package_unresolved → mirror
      // nothing → the bare `@wspkg/b` import stays unresolved → honest unrunnable, never a false proof.
      writeFileSync(path.join(mono, "packages/b/package.json"), JSON.stringify({
        name: "@wspkg/b", version: "0.0.0", type: "module", main: "dist/missing.js"
      }));
      rmSync(path.join(mono, "packages/b/dist"), { recursive: true, force: true });

      const run = runWsPkgSpike(path.join(mono, "packages/a"), {
        test: "calc.test.ts", target: "calc.service.ts", method: "add"
      });
      expect(run.status).toBe(2);
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("unrunnable");
      expect(result.proven).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails closed (unrunnable) when the declared sibling closure exceeds the package cap", () => {
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-ws-overcap-"));
    try {
      const mono = path.join(tmp, "mono");
      cpSync(monoWsPkgFixture, mono, { recursive: true });
      // Declare 33 sibling deps (> SIBLING_MAX_PACKAGES 32) → over-cap → mirror nothing → unrunnable.
      const deps: Record<string, string> = { "@wspkg/b": "*", "@wspkg/src-only": "*" };
      for (let i = 0; i < 31; i += 1) {
        const name = `@wspkg/k${i}`;
        deps[name] = "*";
        const pkgDir = path.join(mono, `packages/k${i}`);
        mkdirSync(pkgDir, { recursive: true });
        writeFileSync(path.join(pkgDir, "package.json"), JSON.stringify({ name, version: "0.0.0", main: "index.js" }));
        writeFileSync(path.join(pkgDir, "index.js"), "export const k = 0;\n");
      }
      const aPkg = JSON.parse(readFileSync(path.join(mono, "packages/a/package.json"), "utf8"));
      aPkg.dependencies = deps;
      writeFileSync(path.join(mono, "packages/a/package.json"), JSON.stringify(aPkg));

      const run = runWsPkgSpike(path.join(mono, "packages/a"), {
        test: "calc.test.ts", target: "calc.service.ts", method: "add"
      });
      expect(run.status).toBe(2);
      expect(JSON.parse(run.stdout).status).toBe("unrunnable");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("does NOT copy a published (non-workspace) dep or an undeclared workspace package", () => {
    // @wspkg/b is a DECLARED workspace member (copied). `left-pad` is a published dep (not a workspace
    // member) and @wspkg/undeclared is a member the target does not declare — neither is copied, so the
    // proof still runs purely off the declared, copied @wspkg/b.
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-ws-scope-"));
    try {
      const mono = path.join(tmp, "mono");
      cpSync(monoWsPkgFixture, mono, { recursive: true });
      const aPkg = JSON.parse(readFileSync(path.join(mono, "packages/a/package.json"), "utf8"));
      aPkg.dependencies = { "@wspkg/b": "*", "@wspkg/src-only": "*", "left-pad": "^1.3.0" };
      writeFileSync(path.join(mono, "packages/a/package.json"), JSON.stringify(aPkg));
      // An undeclared workspace member with a broken entry: it must NOT be copied (a's deps don't list it),
      // so its broken entry cannot abort the mirror.
      const undecl = path.join(mono, "packages/undeclared");
      mkdirSync(undecl, { recursive: true });
      writeFileSync(path.join(undecl, "package.json"), JSON.stringify({ name: "@wspkg/undeclared", main: "missing.js" }));

      const run = runWsPkgSpike(path.join(mono, "packages/a"), {
        test: "calc.test.ts", target: "calc.service.ts", method: "add"
      });
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("proven");
      expect(result.proven).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("skips a DECLARED type-only workspace sibling (types, no runtime entry) without aborting the mirror", () => {
    // Medplum shape: packages/agent declares @medplum/fhirtypes (type-only: `types`, no runtime main) as a
    // dev dep. Before this fix planSiblingCopy aborted the WHOLE sibling mirror on it, so runtime siblings
    // like @medplum/core were never copied → unrunnable. Now the type-only package is skipped (never runtime
    // evidence) and the runtime sibling @wspkg/b still copies + aliases + proves.
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-ws-typeonly-"));
    try {
      const mono = path.join(tmp, "mono");
      cpSync(monoWsPkgFixture, mono, { recursive: true });
      const aPkg = JSON.parse(readFileSync(path.join(mono, "packages/a/package.json"), "utf8"));
      aPkg.dependencies = { "@wspkg/b": "*" };
      aPkg.devDependencies = { "@wspkg/types": "*" };
      writeFileSync(path.join(mono, "packages/a/package.json"), JSON.stringify(aPkg));
      // A DECLARED, type-only workspace member: `types` only, NO runtime main/module/exports.
      const typesOnly = path.join(mono, "packages/types");
      mkdirSync(path.join(typesOnly, "dist"), { recursive: true });
      writeFileSync(path.join(typesOnly, "package.json"), JSON.stringify({ name: "@wspkg/types", version: "0.0.0", types: "dist/index.d.ts" }));
      writeFileSync(path.join(typesOnly, "dist/index.d.ts"), "export type Id = string;\n");

      const run = runWsPkgSpike(path.join(mono, "packages/a"), { test: "calc.test.ts", target: "calc.service.ts", method: "add" });
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("proven");
      expect(result.proven).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("skips a type-only sibling with a BLANK `main` (the real Medplum @medplum/fhirtypes shape)", () => {
    // Codex #184: @medplum/fhirtypes ships `{ "main": "", "types": "dist/index.d.ts" }`. A BLANK main is NOT
    // a runtime entry, so it must be treated type-only (skipped), not runtime-unresolved — else it aborts the
    // mirror and @medplum/core never copies. Before the blank-field fix isTypeOnlyPackage returned false here.
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-ws-typeonly-blankmain-"));
    try {
      const mono = path.join(tmp, "mono");
      cpSync(monoWsPkgFixture, mono, { recursive: true });
      const aPkg = JSON.parse(readFileSync(path.join(mono, "packages/a/package.json"), "utf8"));
      aPkg.dependencies = { "@wspkg/b": "*" };
      aPkg.devDependencies = { "@wspkg/types": "*" };
      writeFileSync(path.join(mono, "packages/a/package.json"), JSON.stringify(aPkg));
      const typesOnly = path.join(mono, "packages/types");
      mkdirSync(path.join(typesOnly, "dist"), { recursive: true });
      // Exactly Medplum's shape: blank main + a types field, no module/exports.
      writeFileSync(path.join(typesOnly, "package.json"), JSON.stringify({ name: "@wspkg/types", version: "0.0.0", main: "", types: "dist/index.d.ts" }));
      writeFileSync(path.join(typesOnly, "dist/index.d.ts"), "export type Id = string;\n");

      const run = runWsPkgSpike(path.join(mono, "packages/a"), { test: "calc.test.ts", target: "calc.service.ts", method: "add" });
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("proven");
      expect(result.proven).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("still fails closed when a DECLARED sibling has a runtime entry that cannot be resolved", () => {
    // The type-only skip is NOT a blanket "ignore unresolved siblings": a package that DECLARES a runtime
    // entry (main) we cannot resolve on disk is a genuine blocker → it must still abort the mirror → honest
    // unrunnable, never a guessed proof.
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-ws-brokenrt-"));
    try {
      const mono = path.join(tmp, "mono");
      cpSync(monoWsPkgFixture, mono, { recursive: true });
      const aPkg = JSON.parse(readFileSync(path.join(mono, "packages/a/package.json"), "utf8"));
      aPkg.dependencies = { "@wspkg/b": "*", "@wspkg/brokenrt": "*" };
      writeFileSync(path.join(mono, "packages/a/package.json"), JSON.stringify(aPkg));
      const broken = path.join(mono, "packages/brokenrt");
      mkdirSync(broken, { recursive: true });
      // DECLARES a runtime main, but dist/index.js does not exist → genuine runtime-unresolved (not type-only).
      writeFileSync(path.join(broken, "package.json"), JSON.stringify({ name: "@wspkg/brokenrt", version: "0.0.0", main: "dist/index.js" }));

      const run = runWsPkgSpike(path.join(mono, "packages/a"), { test: "calc.test.ts", target: "calc.service.ts", method: "add" });
      expect(run.status).toBe(2);
      expect(JSON.parse(run.stdout).status).toBe("unrunnable");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("copies a workspace-root runner-config helper required by RELATIVE path so the baseline runs (§4a)", () => {
    // The Medusa shape: a package-local runner config requires a workspace-root helper by relative path.
    // aspect-2 copies that helper into the mirrored location so the config loads and the baseline runs.
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-ws-cfg-helper-"));
    try {
      const mono = path.join(tmp, "mono");
      const svc = path.join(mono, "packages/svc");
      cpSync(fixtureRoot, svc, { recursive: true });
      writeFileSync(path.join(mono, "package.json"), JSON.stringify({ name: "mono-cfg", private: true, workspaces: ["packages/*"] }));
      writeFileSync(path.join(mono, "define_vitest_config.mjs"), "export default {};\n");
      writeFileSync(path.join(svc, "vitest.config.mjs"), "import base from \"../../define_vitest_config.mjs\";\nexport default base;\n");

      const run = spawnSync(process.execPath, [
        script,
        "--root", svc,
        "--test", "src/order.real.test.ts",
        "--target", "src/order.service.ts",
        "--method", "createOrder",
        "--replacement", sentinelReturn,
        "--vitest-bin", vitestBin,
        "--jest-bin", fakeJestBin,
        "--runner", "vitest",
        "--json"
      ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

      expect(run.status).toBe(0);
      const result = JSON.parse(run.stdout);
      expect(result.status).toBe("proven");
      expect(result.mutant.assertionFailure).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails closed (unrunnable) when the required runner-config helper is missing", () => {
    // Same shape, but the workspace-root helper does not exist → nothing to copy → the package-local config
    // fails to load → honest unrunnable.
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-ws-cfg-missing-"));
    try {
      const mono = path.join(tmp, "mono");
      const svc = path.join(mono, "packages/svc");
      cpSync(fixtureRoot, svc, { recursive: true });
      writeFileSync(path.join(mono, "package.json"), JSON.stringify({ name: "mono-cfg", private: true, workspaces: ["packages/*"] }));
      writeFileSync(path.join(svc, "vitest.config.mjs"), "import base from \"../../define_vitest_config.mjs\";\nexport default base;\n");

      const run = spawnSync(process.execPath, [
        script,
        "--root", svc,
        "--test", "src/order.real.test.ts",
        "--target", "src/order.service.ts",
        "--method", "createOrder",
        "--replacement", sentinelReturn,
        "--vitest-bin", vitestBin,
        "--jest-bin", fakeJestBin,
        "--runner", "vitest",
        "--json"
      ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

      expect(run.status).toBe(2);
      expect(JSON.parse(run.stdout).status).toBe("unrunnable");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("fails closed (unrunnable) when the runner-config helper closure exceeds the byte cap", () => {
    // An over-cap (> 2 MiB) helper aborts the config-helper mirror → nothing copied → config load fails →
    // unrunnable. Proves the cap is load-bearing and fails closed rather than copying an unbounded blob.
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-ws-cfg-overcap-"));
    try {
      const mono = path.join(tmp, "mono");
      const svc = path.join(mono, "packages/svc");
      cpSync(fixtureRoot, svc, { recursive: true });
      writeFileSync(path.join(mono, "package.json"), JSON.stringify({ name: "mono-cfg", private: true, workspaces: ["packages/*"] }));
      const pad = "// pad\n".repeat(340_000); // > 2 MiB
      writeFileSync(path.join(mono, "define_vitest_config.mjs"), `${pad}export default {};\n`);
      writeFileSync(path.join(svc, "vitest.config.mjs"), "import base from \"../../define_vitest_config.mjs\";\nexport default base;\n");

      const run = spawnSync(process.execPath, [
        script,
        "--root", svc,
        "--test", "src/order.real.test.ts",
        "--target", "src/order.service.ts",
        "--method", "createOrder",
        "--replacement", sentinelReturn,
        "--vitest-bin", vitestBin,
        "--jest-bin", fakeJestBin,
        "--runner", "vitest",
        "--json"
      ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

      expect(run.status).toBe(2);
      expect(JSON.parse(run.stdout).status).toBe("unrunnable");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);

  it("still copies the runner-config helper when an UNRELATED workspace sibling fails to resolve (§4a independent of siblings)", () => {
    // Codex #182: sibling planning and §4a config-helper collection used to share one try/catch, so an
    // unresolved/over-cap sibling zeroed BOTH — dropping a helper the baseline needs. They are now split;
    // svc declares a workspace sibling @brk/broken it never imports (its entry is unresolvable → the sibling
    // mirror aborts), yet the config helper still copies and the target proves.
    const tmp = mkdtempSync(path.join(tmpdir(), "opro-ws-cfg-sibling-abort-"));
    try {
      const mono = path.join(tmp, "mono");
      const svc = path.join(mono, "packages/svc");
      cpSync(fixtureRoot, svc, { recursive: true });
      writeFileSync(path.join(mono, "package.json"), JSON.stringify({ name: "mono-cfg", private: true, workspaces: ["packages/*"] }));
      writeFileSync(path.join(svc, "package.json"), JSON.stringify({ name: "@wsvc/svc", private: true, dependencies: { "@brk/broken": "*" } }));
      const broken = path.join(mono, "packages/broken");
      mkdirSync(broken, { recursive: true });
      writeFileSync(path.join(broken, "package.json"), JSON.stringify({ name: "@brk/broken", version: "0.0.0", main: "dist/nope.js" }));
      writeFileSync(path.join(mono, "define_vitest_config.mjs"), "export default {};\n");
      writeFileSync(path.join(svc, "vitest.config.mjs"), "import base from \"../../define_vitest_config.mjs\";\nexport default base;\n");

      const run = spawnSync(process.execPath, [
        script,
        "--root", svc,
        "--test", "src/order.real.test.ts",
        "--target", "src/order.service.ts",
        "--method", "createOrder",
        "--replacement", sentinelReturn,
        "--vitest-bin", vitestBin,
        "--jest-bin", fakeJestBin,
        "--runner", "vitest",
        "--json"
      ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

      expect(run.status).toBe(0);
      expect(JSON.parse(run.stdout).status).toBe("proven");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 20_000);
});
