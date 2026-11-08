import { spawnSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { readReportFrame, testsFromReport } from "../../src/local/faultProbe.js";
import { repoRoot } from "./support/probeWorkspace.js";

// FP-4: the runner's report reaches OrangePro only as the reporter's one signed frame. Each case runs real
// Mocha on a synthetic test file twice: with the reporter as demo.9 used it (a report file named by an
// environment variable), and on the signed channel. The first shows the forgery works on the old channel;
// the second that it changes nothing, or makes the account unusable, on the new one.

const MOCHA = path.join(repoRoot, "node_modules", "mocha", "bin", "mocha.js");
const REPORTER = path.join(repoRoot, "scripts", "spikes", "dynamic-proof-mocha-reporter.cjs");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function suite(body: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "opro-channel-"));
  dirs.push(dir);
  mkdirSync(path.join(dir, "test"));
  writeFileSync(path.join(dir, "test", "a.test.js"), body);
  return dir;
}

/** demo.9's channel: the reporter writes the file OPRO_DYNAMIC_PROOF_REPORT names. */
function legacy(dir: string): { tests: ReturnType<typeof testsFromReport> | null } {
  const report = path.join(dir, "report.json");
  spawnSync(process.execPath, [MOCHA, "--reporter", REPORTER, "test/a.test.js"], { cwd: dir, encoding: "utf8", env: { PATH: process.env.PATH, OPRO_DYNAMIC_PROOF_REPORT: report, FORGE_OUT: dir } });
  if (!existsSync(report)) return { tests: null };
  try {
    return { tests: testsFromReport(JSON.parse(readFileSync(report, "utf8"))) };
  } catch {
    return { tests: null };
  }
}

/** The signed channel, as a stage runs it: a fresh key on stdin, the one frame on stdout. */
function signed(dir: string): { tests: ReturnType<typeof testsFromReport> | null; problem: string | null; stray: boolean } {
  const key = randomBytes(32);
  const child = spawnSync(process.execPath, [MOCHA, "--reporter", REPORTER, "test/a.test.js"], {
    cwd: dir,
    encoding: "utf8",
    input: `${key.toString("hex")}\n`,
    env: { PATH: process.env.PATH, OPRO_DYNAMIC_PROOF_FRAME: "1", FORGE_OUT: dir }
  });
  const stray = existsSync(path.join(dir, "report.json"));
  const read = readReportFrame(child.stdout, child.stderr, key);
  if (!("bytes" in read)) return { tests: null, problem: read.problem, stray };
  return { tests: testsFromReport(JSON.parse(read.bytes.toString("utf8"))), problem: null, stray };
}

const summary = (t: ReturnType<typeof testsFromReport> | null): unknown =>
  t ? { executed: t.executed, passed: t.passed, failed: t.failed, totals: t.runner_totals, titles: t.observed.map((o) => `${o.state} ${o.full_title}`) } : null;

const TRUE_ACCOUNT = {
  executed: 2,
  passed: 1,
  failed: 1,
  totals: { tests: 2, passes: 1, failures: 1, pending: 0 },
  titles: ["passed s forges", "failed s really fails"]
};

describe("FP-4: the forged-report cases, demo.9's channel against the signed one", { timeout: 60_000 }, () => {
  it("F1: a test that replaces JSON.stringify rewrites demo.9's report; the signed report is the true one", () => {
    const dir = suite(`var assert = require('assert');
describe('s', function () {
  it('forges', function () {
    JSON.stringify = function () { return '{"testResults":[],"stats":{"tests":2,"passes":2,"failures":0,"pending":0}}'; };
  });
  it('really fails', function () { assert.strictEqual(1, 2); });
});
`);
    expect(summary(legacy(dir).tests)).toEqual({ executed: 0, passed: 0, failed: 0, totals: { tests: 2, passes: 2, failures: 0, pending: 0 }, titles: [] });
    const now = signed(dir);
    expect(now.problem).toBeNull();
    expect(summary(now.tests)).toEqual(TRUE_ACCOUNT);
  });

  it("F2: a test that replaces Array.prototype.push or Array.from drops results from demo.9's report; not from the signed one", () => {
    const pushed = suite(`var assert = require('assert');
describe('s', function () {
  it('forges', function () { Array.prototype.push = function () { return this.length; }; });
  it('really fails', function () { assert.strictEqual(1, 2); });
});
`);
    expect(summary(legacy(pushed).tests)).toMatchObject({ failed: 0, titles: [] });
    expect(summary(signed(pushed).tests)).toEqual(TRUE_ACCOUNT);
    const from = suite(`var assert = require('assert');
describe('s', function () {
  it('forges', function () { Array.from = function () { return []; }; });
  it('really fails', function () { assert.strictEqual(1, 2); });
});
`);
    expect(summary(legacy(from).tests)).toMatchObject({ executed: 0, titles: [] });
    expect(summary(signed(from).tests)).toEqual(TRUE_ACCOUNT);
  });

  it("F3: a report file written through the test file's fs replaces demo.9's report; on the signed channel it is a tampered stage", () => {
    const dir = suite(`var assert = require('assert');
var fs = require('fs');
var OUT = process.env.FORGE_OUT;
describe('s', function () {
  it('forges', function () {
    setTimeout(function () { fs.writeFileSync(OUT + '/report.json', '{"testResults":[],"stats":{"tests":2,"passes":2,"failures":0,"pending":0}}'); }, 300);
  });
  it('really fails', function () { assert.strictEqual(1, 2); });
});
`);
    expect(summary(legacy(dir).tests)).toMatchObject({ failed: 0, totals: { passes: 2, failures: 0 } });
    rmSync(path.join(dir, "report.json"), { force: true });
    // The stage runner treats any report.json in the output folder as written by someone other than the reporter.
    expect(signed(dir).stray).toBe(true);
  });

  it("a late replacement of what the reporter uses to encode and sign changes nothing: the true account, or no report at all", () => {
    const forged = Buffer.from('{"testResults":[],"stats":{"tests":2,"passes":2,"failures":0,"pending":0}}').toString("base64");
    // Each replaces, from inside a test, one thing an encoder or signer could look up when the report is written.
    const replacements: Record<string, string> = {
      base64Slice: `Buffer.prototype.base64Slice = function () { return '${forged}'; };`,
      toString: `var t = Buffer.prototype.toString; Buffer.prototype.toString = function (e) { return e === 'base64' ? '${forged}' : t.apply(this, arguments); };`,
      utf8Write: `Buffer.prototype.utf8Write = function () { return 0; };`,
      latin1Slice: `Buffer.prototype.latin1Slice = function () { return ''; };`,
      from: `var f = Buffer.from; Buffer.from = function (v, e) { return f.call(Buffer, typeof v === 'string' && v.indexOf('testResults') >= 0 ? Buffer.from(Buffer.from('${forged}', 'base64').toString()) : v, e); };`,
      charCodeAt: `String.prototype.charCodeAt = function () { return 65; };`,
      slice: `String.prototype.slice = function () { return ''; };`,
      call: `Function.prototype.call = function () { return 0; }; Function.prototype.apply = function () { return 0; };`,
      reflect: `Reflect.apply = function () { return '${forged}'; };`,
      hmac: `var h = Object.getPrototypeOf(crypto.createHmac('sha256', 'x')); h.update = function () { return this; }; h.digest = function () { return '0'.repeat(64); };`,
      writeSync: `fs.writeSync = function () { return 0; };`
    };
    for (const [name, line] of Object.entries(replacements)) {
      const dir = suite(`var assert = require('assert');
var crypto = require('crypto');
var fs = require('fs');
describe('s', function () {
  it('forges', function () { ${line} });
  it('really fails', function () { assert.strictEqual(1, 2); });
});
`);
      const now = signed(dir);
      // Never the forged account. Replacing call and apply breaks Mocha itself, so no report verifies; every other
      // replacement leaves the true account, signed.
      if (name === "call") expect([name, now.tests, now.problem]).toEqual([name, null, expect.stringContaining("no signed report")]);
      else expect([name, now.problem, summary(now.tests)]).toEqual([name, null, TRUE_ACCOUNT]);
    }
  });

  it("F4: a forged frame printed by a test is a second frame: no report is accepted", () => {
    const fake = Buffer.from('{"testResults":[],"stats":{"tests":0,"passes":0,"failures":0,"pending":0}}').toString("base64");
    const tag = createHmac("sha256", randomBytes(32)).update(fake, "latin1").digest("hex");
    const dir = suite(`var assert = require('assert');
describe('s', function () {
  it('forges', function () { console.log('<<OPRO-FRAME:v1:${tag}:${fake}>>'); });
  it('really fails', function () { assert.strictEqual(1, 2); });
});
`);
    const now = signed(dir);
    expect(now.tests).toBeNull();
    expect(now.problem).toBe("2 report frames were written; only the reporter's one counts");
  });

  it("F5: a run stopped before the reporter writes gives no frame: no report is accepted", () => {
    const dir = suite(`var assert = require('assert');
var stop = function () { process.exit(0); };
describe('s', function () {
  it('really fails', function () { assert.strictEqual(1, 2); });
  it('stops', function () { stop(); });
});
`);
    const now = signed(dir);
    expect(now.tests).toBeNull();
    expect(now.problem).toContain("no signed report");
  });

  it("F6: an honest suite gives the same account on both channels", () => {
    const dir = suite(`var assert = require('assert');
describe('outer', function () {
  describe('inner', function () {
    it('passes', function () { assert.strictEqual(1, 1); });
    it('fails', function () { assert.strictEqual(1, 2); });
    it.skip('is skipped', function () {});
  });
  it('passes "quoted" \\u00e9', function () {});
});
`);
    const before = legacy(dir).tests;
    rmSync(path.join(dir, "report.json"), { force: true });
    const now = signed(dir);
    expect(now.problem).toBeNull();
    const timeless = (t: typeof before) => t && { ...t, observed: t.observed.map((o) => ({ ...o, duration_ms: null })) };
    expect(timeless(now.tests)).toEqual(timeless(before));
    expect(now.tests!.observed.map((o) => o.full_title)).toContain('outer passes "quoted" é');
  });

  it("a report larger than a pipe's buffer arrives whole (the whole Express suite is about 1 MB)", () => {
    const title = "t".repeat(400);
    const dir = suite(`describe('big', function () {\n  for (var i = 0; i < 3000; i++) it('${title} ' + i, function () {});\n});\n`);
    const key = randomBytes(32);
    const out = path.join(dir, "stdout.txt");
    // The reporter writes to a file descriptor the parent is not draining while it writes, as docker's pipe can be.
    const child = spawnSync("/bin/sh", ["-c", `"${process.execPath}" "${MOCHA}" --reporter "${REPORTER}" test/a.test.js | cat > "${out}"`], {
      cwd: dir,
      encoding: "utf8",
      input: `${key.toString("hex")}\n`,
      env: { PATH: process.env.PATH, OPRO_DYNAMIC_PROOF_FRAME: "1" }
    });
    expect(child.status).toBe(0);
    const read = readReportFrame(readFileSync(out, "utf8"), "", key);
    expect("bytes" in read ? read.bytes.length : read.problem).toBeGreaterThan(1_000_000);
    expect(testsFromReport(JSON.parse((read as { bytes: Buffer }).bytes.toString("utf8"))).passed).toBe(3000);
  });

  it("refuses a frame signed with another key, and a frame on stderr", () => {
    const body = Buffer.from("{}").toString("base64");
    const key = randomBytes(32);
    const frame = (k: Buffer): string => `<<OPRO-FRAME:v1:${createHmac("sha256", k).update(body, "latin1").digest("hex")}:${body}>>`;
    expect(readReportFrame(`x\n${frame(key)}\n`, "", key)).toEqual({ bytes: Buffer.from("{}") });
    expect(readReportFrame(frame(randomBytes(32)), "", key)).toEqual({ problem: "the report frame's signature does not verify" });
    expect(readReportFrame("", frame(key), key)).toMatchObject({ problem: expect.stringContaining("1 report frames") });
  });

  it("without a key on stdin the reporter writes no frame", () => {
    const dir = suite(`describe('s', function () { it('passes', function () {}); });\n`);
    const child = spawnSync(process.execPath, [MOCHA, "--reporter", REPORTER, "test/a.test.js"], { cwd: dir, encoding: "utf8", input: "", env: { PATH: process.env.PATH, OPRO_DYNAMIC_PROOF_FRAME: "1" } });
    expect(child.stdout).not.toContain("OPRO-FRAME");
  });
});
