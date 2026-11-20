/**
 * F2: a proof that cannot start says its cause in one line. The proof script's usage text is
 * printed only for a wrong command line, and never reaches the user as a "reason".
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { proofNotStartedMessage } from "../../src/local/operations.js";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/spikes/dynamic-proof-spike.mjs");
const mochaBin = require.resolve("mocha/bin/mocha.js");

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "opro-proof-start-"));
  mkdirSync(path.join(dir, "src"));
  mkdirSync(path.join(dir, "test"));
  writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "start-error", private: true, devDependencies: { mocha: "*" } }));
  // Two functions answer to the name `pick`: the name search must refuse, not guess.
  writeFileSync(path.join(dir, "src/pick.js"), "function pick(a) {\n  return a;\n}\nconst box = {\n  pick(a) {\n    return a;\n  }\n};\nmodule.exports = { pick, box };\n");
  writeFileSync(path.join(dir, "test/pick.test.js"), "const assert = require('node:assert');\nconst { pick } = require('../src/pick');\nit('picks', () => { assert.strictEqual(pick(1), 1); });\n");
  return dir;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}

describe("F2: the proof script's own errors", { timeout: 60_000 }, () => {
  it("names the cause on one line, with the caller's path, and prints no usage text", () => {
    const dir = repo();
    try {
      const result = run(["--root", dir, "--test", "test/pick.test.js", "--target", "src/pick.js", "--method", "pick", "--replacement", "return null;", "--runner", "mocha", "--mocha-bin", mochaBin, "--json"]);
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("Ambiguous method pick in src/pick.js: 2 matches\n");
      expect(result.stderr).not.toContain("Usage:");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("says a function it cannot find, on one line", () => {
    const dir = repo();
    try {
      const result = run(["--root", dir, "--test", "test/pick.test.js", "--target", "src/pick.js", "--method", "absent", "--replacement", "return null;", "--runner", "mocha", "--mocha-bin", mochaBin, "--json"]);
      expect(result.stderr).toBe("Could not find method absent in src/pick.js\n");
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it("still prints the usage text for a wrong command line", () => {
    const result = run(["--root", "."]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Usage:");
  });
});

describe("F2: what the kit relays", () => {
  it("is the script's first error line, and nothing else", () => {
    expect(proofNotStartedMessage("Ambiguous method parseURL in src/parse.ts: 2 matches\n", ""))
      .toBe("The proof could not start: Ambiguous method parseURL in src/parse.ts: 2 matches.");
  });

  it("never carries usage text, even from a script that printed it", () => {
    const stderr = "Missing required --test\n\nUsage: node scripts/spikes/dynamic-proof-spike.mjs --root <repo> ...\n--replacement must be inert: either empty or a single return of a JSON literal\n";
    const message = proofNotStartedMessage(stderr, "");
    expect(message).toBe("The proof could not start: Missing required --test.");
    expect(message).not.toMatch(/usage|must be inert/i);
  });

  it("says so plainly when the script printed nothing", () => {
    expect(proofNotStartedMessage("", "")).toBe("The proof could not start: the proof script ended without a result.");
  });
});
