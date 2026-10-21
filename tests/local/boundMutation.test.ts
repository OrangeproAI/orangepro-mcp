import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

import { autoProve, existingAssociatedTests } from "../../src/local/autoProve.js";
import { opChangedTargets } from "../../src/local/changedTargets.js";
import { describeTarget, mutationRouteFor, nameSearchBody, nameSearchPatterns, TARGET_RECORD_VERSION } from "../../src/local/contracts/targetRecord.js";
import type { TargetDescription, TargetRecord } from "../../src/local/contracts/targetRecord.js";
import { makeEdge, makeProofEdges } from "../../src/local/graph/factories.js";
import type { GraphNode } from "../../src/local/graph/ontology.js";
import { loadLedger } from "../../src/local/ledger.js";
import { opAnalyze, opDynamicProof, opInit, opProveLoop, ProofRefusalError } from "../../src/local/operations.js";
import type { DynamicProofRunner, ProveLoopOptions, ProveLoopResult } from "../../src/local/operations.js";
import { loadGraph, saveGraph, workspacePaths } from "../../src/local/workspace.js";

// Bound mutation (pre-registration A1, section G): a member written `owner.name = function`
// or `F.prototype.name = function` is changed by its exact position; two other shapes are
// refused by name; everything else keeps the name search. Every fixture below is synthetic,
// written into a temp folder by the test: nothing here is taken from a real repository.

const require = createRequire(import.meta.url);
const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(repoRoot, "scripts/spikes/dynamic-proof-spike.mjs");
const mochaBin = require.resolve("mocha/bin/mocha.js");
const deps = { clock: () => "2026-10-12T00:00:00Z", env: {} as NodeJS.ProcessEnv };
const KILL = "return -1;";

const tempDirs: string[] = [];
afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** A throwaway project: `files` maps a relative path to its exact bytes. */
function makeRepo(files: Record<string, string | Buffer>, label = "bound"): string {
  const dir = mkdtempSync(path.join(tmpdir(), `opro-${label}-`));
  tempDirs.push(dir);
  const all: Record<string, string | Buffer> = {
    "package.json": JSON.stringify({ name: "sample-shop", version: "1.0.0", main: "lib/index.js", devDependencies: { mocha: "*" } }, null, 2),
    ...files
  };
  for (const [rel, content] of Object.entries(all)) {
    const abs = path.join(dir, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return dir;
}

/** Every file under `dir` with its hash: "nothing was written" means this map did not change. */
function snapshot(dir: string): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name === ".orangepro" || entry.name === ".git") continue;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) walk(child);
      else if (entry.isFile()) out[path.relative(dir, child)] = sha256(readFileSync(child));
    }
  };
  walk(dir);
  return out;
}

function describeIn(repo: string, rel: string, symbol: string): TargetDescription {
  const described = describeTarget(readFileSync(path.join(repo, rel)), symbol);
  if (!described.ok) throw new Error(`fixture error: ${symbol} in ${rel} was refused as ${described.refused}`);
  return described.target;
}

interface Binding {
  fileSha256: string;
  statementStart: number;
  functionStart: number;
  bodyStart: number;
  bodyEnd: number;
  targets: string[];
}

function bindingOf(target: TargetDescription): Binding {
  if (!target.body || !target.targets) throw new Error("fixture error: not a bound target");
  return {
    fileSha256: target.file_sha256,
    statementStart: target.statement.bytes.start,
    functionStart: target.function.bytes.start,
    bodyStart: target.body.bytes.start,
    bodyEnd: target.body.bytes.end,
    targets: target.targets
  };
}

function bindingArgs(binding: Binding): string[] {
  return [
    "--bound-file-sha256",
    binding.fileSha256,
    "--bound-statement-start",
    String(binding.statementStart),
    "--bound-function-start",
    String(binding.functionStart),
    "--bound-body-start",
    String(binding.bodyStart),
    "--bound-body-end",
    String(binding.bodyEnd),
    ...binding.targets.flatMap((name) => ["--bound-target", name])
  ];
}

interface SpikeJson {
  status: string;
  proven: boolean;
  reason: string;
  refusal?: string;
  diff?: string;
  bound?: { fileSha256: string; mutatedSha256: string; changedBytes: { start: number; end: number }; targets: string[] };
  checkout?: { sha256: string; unchanged: boolean };
  mutant?: { exitCode: number; assertionFailure: boolean };
  runner?: string;
  test?: string;
  target?: string;
  method?: string;
}

function runSpike(args: string[]): { status: number | null; stderr: string; json: SpikeJson } {
  const run = spawnSync(process.execPath, [script, ...args, "--json"], { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let json: SpikeJson;
  try {
    json = JSON.parse(run.stdout) as SpikeJson;
  } catch {
    throw new Error(`spike did not return JSON (exit ${run.status}): ${run.stderr.slice(0, 400)}`);
  }
  return { status: run.status, stderr: run.stderr, json };
}

function previewArgs(repo: string, rel: string, binding: Binding, replacement = KILL): string[] {
  return ["--root", repo, "--target", rel, "--method", "m", "--replacement", replacement, ...bindingArgs(binding), "--preview"];
}

/** The first and last changed line of a one-hunk unified diff, in the old file's numbering. */
function changedOldLines(diff: string): { first: number; last: number } {
  const lines = diff.split("\n");
  const header = lines.findIndex((line) => line.startsWith("@@"));
  const start = Number(/^@@ -(\d+),/.exec(lines[header]!)![1]);
  const body = lines.slice(header + 1);
  const firstChange = body.findIndex((line) => line.startsWith("-") || line.startsWith("+"));
  const removed = body.filter((line) => line.startsWith("-")).length;
  return { first: start + firstChange, last: start + firstChange + Math.max(removed, 1) - 1 };
}

// ── The shapes that take the bound path ─────────────────────────────────────────────

const NON_ASCII_COMMENT = "// café — 日本語 ✓";

interface PositiveCase {
  title: string;
  symbol: string;
  targets: string[];
  lib: string;
  test: string;
}

const POSITIVE_CASES: PositiveCase[] = [
  {
    title: "an unnamed member on an Object.create owner, under JSDoc that repeats the signature",
    symbol: "basket.total",
    targets: ["basket.total"],
    lib: [
      "'use strict';",
      "",
      "var basket = Object.create(null);",
      "module.exports = basket;",
      "",
      "/**",
      " * basket.total = function (items) { return 0; }",
      " *",
      " *     basket.total(items) {",
      " */",
      "basket.total = function (items) {",
      "  return items.reduce(function (sum, item) { return sum + item.price; }, 0);",
      "};",
      ""
    ].join("\n"),
    test: "assert.equal(lib.total([{ price: 2 }, { price: 3 }]), 5);"
  },
  {
    title: "a named member on `var a = exports = module.exports = {}`",
    symbol: "shelf.count",
    targets: ["shelf.count"],
    lib: ["var shelf = exports = module.exports = {};", "", "shelf.count = function count(items) {", "  return items.length + 1;", "};", ""].join("\n"),
    test: "assert.equal(lib.count([1, 2]), 3);"
  },
  {
    title: "a two-name member (`a.x = a.y = function y(){}`)",
    symbol: "shelf.len",
    targets: ["shelf.size", "shelf.len"],
    lib: ["var shelf = module.exports = {};", "", "shelf.size = shelf.len = function len(items) {", "  return items.length * 2;", "};", ""].join("\n"),
    test: "assert.equal(lib.size([1, 2]), 4);"
  },
  {
    title: "a prototype member",
    symbol: "Crate.weigh",
    targets: ["Crate.prototype.weigh"],
    lib: [
      "module.exports = Crate;",
      "",
      "function Crate(parts) {",
      "  this.parts = parts;",
      "}",
      "",
      "Crate.prototype.weigh = function weigh() {",
      "  return this.parts.reduce(function (a, b) { return a + b; }, 0);",
      "};",
      ""
    ].join("\n"),
    test: "assert.equal(new lib([1, 2]).weigh(), 3);"
  },
  {
    title: "a call inside a default parameter",
    symbol: "shelf.pick",
    targets: ["shelf.pick"],
    lib: [
      "var shelf = module.exports = {};",
      "",
      "function choose(option) { return option; }",
      "",
      "shelf.pick = function (first, second = choose({ n: 1 })) {",
      "  return first + second.n;",
      "};",
      ""
    ].join("\n"),
    test: "assert.equal(lib.pick(1), 2);"
  },
  {
    title: "balanced braces inside a string, a regex and a template",
    symbol: "shelf.wrap",
    targets: ["shelf.wrap"],
    lib: [
      "var shelf = module.exports = {};",
      "",
      "shelf.wrap = function (name) {",
      '  var open = "{}";',
      "  var shape = /[{}]/;",
      "  var text = `{${name}}`;",
      "  return shape.test(open) ? text : name;",
      "};",
      ""
    ].join("\n"),
    test: 'assert.equal(lib.wrap("a"), "{a}");'
  },
  {
    title: "non-ASCII text and CRLF before the target",
    symbol: "shelf.greet",
    targets: ["shelf.greet"],
    lib: [NON_ASCII_COMMENT, "var shelf = module.exports = {};", "", "shelf.greet = function (name) {", "  return 'héllo ' + name;", "};", ""].join("\r\n"),
    test: "assert.equal(lib.greet('x'), 'héllo x');"
  }
];

function positiveRepo(c: PositiveCase): string {
  return makeRepo({
    "lib/thing.js": c.lib,
    "test/thing.test.js": [
      "const assert = require('node:assert/strict');",
      "const lib = require('../lib/thing');",
      "describe('thing', () => {",
      `  it('keeps its behaviour', () => { ${c.test} });`,
      "});",
      ""
    ].join("\n")
  });
}

describe("bound mutation — the script changes exactly the recorded bytes", { timeout: 120_000 }, () => {
  for (const c of POSITIVE_CASES) {
    it(`previews and proves ${c.title}`, () => {
      const repo = positiveRepo(c);
      const rel = "lib/thing.js";
      const before = snapshot(repo);
      const original = readFileSync(path.join(repo, rel));
      const target = describeIn(repo, rel, c.symbol);
      expect(target.mutation_route).toBe("bound");
      expect(target.targets).toEqual(c.targets);
      const binding = bindingOf(target);
      // The body span is the braces and what is between them, in raw bytes.
      expect(original[binding.bodyStart]).toBe(0x7b);
      expect(original[binding.bodyEnd - 1]).toBe(0x7d);

      const preview = runSpike(previewArgs(repo, rel, binding));
      expect(preview.status).toBe(0);
      expect(preview.json.status).toBe("preview");
      expect(preview.json.proven).toBe(false);
      expect(preview.json.bound?.changedBytes).toEqual({ start: binding.bodyStart, end: binding.bodyEnd });
      // prefix + replacement + suffix: every byte outside the body is the original byte.
      const expected = Buffer.concat([original.subarray(0, binding.bodyStart), Buffer.from(`{\n  ${KILL}\n}`), original.subarray(binding.bodyEnd)]);
      expect(preview.json.bound?.mutatedSha256).toBe(sha256(expected));
      const changed = changedOldLines(preview.json.diff ?? "");
      expect(changed.first).toBeGreaterThanOrEqual(target.body!.lines.start);
      expect(changed.last).toBeLessThanOrEqual(target.body!.lines.end);
      expect(preview.json.diff).toContain(`+  ${KILL}`);
      expect(preview.json.checkout).toEqual({ sha256: target.file_sha256, unchanged: true });
      expect(snapshot(repo)).toEqual(before);

      // The same binding through a real test run: the repository's own test catches the change.
      const proof = runSpike([
        "--root", repo, "--test", "test/thing.test.js", "--target", rel, "--method", "m", "--replacement", KILL,
        "--runner", "mocha", "--mocha-bin", mochaBin, ...bindingArgs(binding)
      ]);
      expect(proof.json.status).toBe("proven");
      expect(proof.json.mutant?.assertionFailure).toBe(true);
      expect(proof.json.bound?.mutatedSha256).toBe(sha256(expected));
      expect(proof.json.checkout).toEqual({ sha256: target.file_sha256, unchanged: true });
      expect(snapshot(repo)).toEqual(before);
    });
  }

  it("keeps the statement's indentation and leaves a neighbour with the same property alone", () => {
    const lib = [
      "var shelf = module.exports = {};",
      "var other = {};",
      "",
      "other.count = function (items) {",
      "  return 0;",
      "};",
      "",
      "if (true) {",
      "  shelf.noop = 1;",
      "}",
      "",
      "shelf.count = function (items) {",
      "  return items.length + 1;",
      "};",
      ""
    ].join("\n");
    const repo = makeRepo({ "lib/thing.js": lib });
    const target = describeIn(repo, "lib/thing.js", "shelf.count");
    const preview = runSpike(previewArgs(repo, "lib/thing.js", bindingOf(target)));
    expect(preview.json.status).toBe("preview");
    const changed = changedOldLines(preview.json.diff ?? "");
    expect(changed).toEqual({ first: 13, last: 13 });
    expect(preview.json.diff).not.toMatch(/^[-+].*return 0;/m);
  });

  it("accepts a statement that follows a byte order mark or a no-break space: white space is not part of a name", () => {
    const member = "shelf.count = function (items) {\n  return items.length;\n};\n";
    const cases: Record<string, Buffer> = {
      "a byte order mark, then the statement": Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(`${member}var shelf = module.exports = {};\n`)]),
      "no-break spaces before the statement": Buffer.from(`var shelf = module.exports = {};\n  ${member}`)
    };
    for (const [label, lib] of Object.entries(cases)) {
      const repo = makeRepo({ "lib/thing.js": lib }, "bound-space");
      const binding = bindingOf(describeIn(repo, "lib/thing.js", "shelf.count"));
      // The byte before the statement is not ASCII in either file.
      expect(lib[binding.statementStart - 1], label).toBeGreaterThanOrEqual(0x80);
      const preview = runSpike(previewArgs(repo, "lib/thing.js", binding));
      expect(preview.json.status, label).toBe("preview");
      expect(preview.json.bound?.changedBytes, label).toEqual({ start: binding.bodyStart, end: binding.bodyEnd });
    }
  });

  it("prints only the diff without --json, and a survivor stays a survivor", () => {
    const c = POSITIVE_CASES[1]!;
    const repo = positiveRepo(c);
    const binding = bindingOf(describeIn(repo, "lib/thing.js", c.symbol));
    const plain = spawnSync(process.execPath, [script, ...previewArgs(repo, "lib/thing.js", binding)], { cwd: repoRoot, encoding: "utf8" });
    expect(plain.status).toBe(0);
    expect(plain.stdout.startsWith("--- a/lib/thing.js\n+++ b/lib/thing.js\n@@ ")).toBe(true);

    // A replacement the test cannot tell from the original is not a proof.
    const survived = runSpike([
      "--root", repo, "--test", "test/thing.test.js", "--target", "lib/thing.js", "--method", "count", "--replacement", "return 3;",
      "--runner", "mocha", "--mocha-bin", mochaBin, ...bindingArgs(binding)
    ]);
    expect(survived.json.status).toBe("associated_survived");
    expect(survived.json.proven).toBe(false);
  });
});

// ── Refusals: each one named, nothing written ───────────────────────────────────────

const PLAIN_LIB = [
  "var shelf = module.exports = {};",
  "var other = {};",
  "",
  "other.count = function (items) {",
  "  return 0;",
  "};",
  "",
  "function unrelated(items) {",
  "  return 1;",
  "}",
  "",
  "shelf.count = function (items) {",
  "  return items.length + 1;",
  "};",
  ""
].join("\n");

/** Spans of a function found by plain text search (ASCII fixtures only): what a wrong binding would carry. */
function spansAt(source: string, statementMarker: string): Pick<Binding, "statementStart" | "functionStart" | "bodyStart" | "bodyEnd"> {
  const statementStart = source.indexOf(statementMarker);
  const functionStart = source.indexOf("function", statementStart);
  const bodyStart = source.indexOf("{", functionStart);
  let depth = 0;
  let bodyEnd = -1;
  for (let i = bodyStart; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) {
      bodyEnd = i + 1;
      break;
    }
  }
  return { statementStart, functionStart, bodyStart, bodyEnd };
}

function expectRefused(repo: string, args: string[], code: string): SpikeJson {
  const before = snapshot(repo);
  const out = runSpike(args);
  expect(out.json).toMatchObject({ status: "refused", proven: false, refusal: code });
  expect(out.json.reason).toContain(`bound mutation refused (${code})`);
  expect(out.status).toBe(2);
  expect(snapshot(repo)).toEqual(before);
  return out.json;
}

/** `spansAt` on raw bytes, for a fixture with non-ASCII text; `skip` moves the statement start that many bytes into the marker. */
function byteSpansAt(bytes: Buffer, statementMarker: string, skip = 0): Pick<Binding, "statementStart" | "functionStart" | "bodyStart" | "bodyEnd"> {
  const at = bytes.indexOf(statementMarker);
  const functionStart = bytes.indexOf("function", at);
  const bodyStart = bytes.indexOf("{", functionStart);
  // The bodies these fixtures point at hold no nested braces.
  return { statementStart: at + skip, functionStart, bodyStart, bodyEnd: bytes.indexOf("}", bodyStart) + 1 };
}

describe("bound mutation — named refusals, nothing written", { timeout: 120_000 }, () => {
  it("stale hash: the file changed after the binding was made, or the recorded hash is another file's", () => {
    const repo = makeRepo({ "lib/thing.js": PLAIN_LIB });
    const binding = bindingOf(describeIn(repo, "lib/thing.js", "shelf.count"));
    expectRefused(repo, previewArgs(repo, "lib/thing.js", { ...binding, fileSha256: sha256(Buffer.from("another file")) }), "stale_hash");
    writeFileSync(path.join(repo, "lib/thing.js"), `${PLAIN_LIB}// edited later\n`);
    expectRefused(repo, previewArgs(repo, "lib/thing.js", binding), "stale_hash");
  });

  it("a span moved by one byte, in either direction, for each of the four offsets", () => {
    const repo = makeRepo({ "lib/thing.js": PLAIN_LIB });
    const binding = bindingOf(describeIn(repo, "lib/thing.js", "shelf.count"));
    const moved: Array<[keyof Binding, string]> = [
      ["statementStart", "prefix_mismatch"],
      ["functionStart", "prefix_mismatch"],
      ["bodyStart", "brace_scan_mismatch"],
      ["bodyEnd", "brace_scan_mismatch"]
    ];
    for (const [field, code] of moved) {
      for (const delta of [-1, 1]) {
        expectRefused(repo, previewArgs(repo, "lib/thing.js", { ...binding, [field]: (binding[field] as number) + delta }), code);
      }
    }
  });

  it("the same property on another owner, and an unrelated function in the same file", () => {
    const repo = makeRepo({ "lib/thing.js": PLAIN_LIB });
    const binding = bindingOf(describeIn(repo, "lib/thing.js", "shelf.count"));
    expectRefused(repo, previewArgs(repo, "lib/thing.js", { ...binding, ...spansAt(PLAIN_LIB, "other.count =") }), "prefix_mismatch");
    expectRefused(repo, previewArgs(repo, "lib/thing.js", { ...binding, ...spansAt(PLAIN_LIB, "function unrelated") }), "prefix_mismatch");
    // The honest spans with another owner's name recorded are refused the same way.
    expectRefused(repo, previewArgs(repo, "lib/thing.js", { ...binding, targets: ["other.count"] }), "prefix_mismatch");
  });

  it("a statement that starts inside a longer name or a member chain: the tail of another owner's statement", () => {
    const lib = [
      "var shelf = module.exports = {};",
      "var bookshelf = {};",
      "var $shelf = {};",
      "var éshelf = {};",
      "var store = { shelf: {} };",
      "bookshelf.count = function (items) {",
      "  return 100;",
      "};",
      "$shelf.count = function (items) {",
      "  return 200;",
      "};",
      "éshelf.count = function (items) {",
      "  return 300;",
      "};",
      "store.shelf.count = function (items) {",
      "  return 400;",
      "};",
      "shelf.count = function (items) {",
      "  return items.length + 1;",
      "};",
      ""
    ].join("\n");
    const repo = makeRepo({
      "lib/thing.js": lib,
      // Never run: the refusal comes before any copy.
      "test/books.test.js": "const assert = require('node:assert/strict');\nrequire('../lib/thing');\ndescribe('books', () => { it('holds', () => { assert.ok(true); }); });\n"
    });
    const bytes = readFileSync(path.join(repo, "lib/thing.js"));
    const binding = bindingOf(describeIn(repo, "lib/thing.js", "shelf.count"));
    expect(binding.targets).toEqual(["shelf.count"]);
    // Each forged statement start leaves exactly `shelf.count = ` before the function: only the byte before it gives it away.
    const forged: Array<[string, number]> = [
      ["bookshelf.count =", "book".length],
      ["$shelf.count =", "$".length],
      ["éshelf.count =", Buffer.byteLength("é")],
      ["store.shelf.count =", "store.".length]
    ];
    for (const [marker, skip] of forged) {
      const spans = byteSpansAt(bytes, marker, skip);
      expect(bytes.subarray(spans.statementStart, spans.functionStart).toString("utf8"), marker).toBe("shelf.count = ");
      const refused = expectRefused(repo, previewArgs(repo, "lib/thing.js", { ...binding, ...spans }), "prefix_mismatch");
      expect(refused.reason, marker).toContain("does not begin at the start of a name");
    }
    // A full run with such a binding is refused before any copy: another owner's function is never credited.
    expectRefused(
      repo,
      [
        "--root", repo, "--test", "test/books.test.js", "--target", "lib/thing.js", "--method", "count", "--replacement", KILL,
        "--runner", "mocha", "--mocha-bin", mochaBin, ...bindingArgs({ ...binding, ...byteSpansAt(bytes, "bookshelf.count =", "book".length) })
      ],
      "prefix_mismatch"
    );
  });

  it("a body span that is not the first block after the parameters: a later function's body, a nested block, a block in a comment", () => {
    const lib = [
      "var shelf = module.exports = {};",
      "",
      "shelf.count = function (items) {",
      "  if (items) { return items.length; }",
      "  return 0;",
      "};",
      "/* { return 'in a comment'; } */",
      "shelf.other = function (items) {",
      "  return 'other';",
      "};",
      ""
    ].join("\n");
    const repo = makeRepo({ "lib/thing.js": lib });
    const binding = bindingOf(describeIn(repo, "lib/thing.js", "shelf.count"));
    // Each block is balanced, so the brace count alone ends where the forged span says.
    for (const block of ["{\n  return 'other';\n}", "{ return items.length; }", "{ return 'in a comment'; }"]) {
      const bodyStart = lib.indexOf(block);
      expect(bodyStart, block).toBeGreaterThan(binding.bodyStart);
      const refused = expectRefused(repo, previewArgs(repo, "lib/thing.js", { ...binding, bodyStart, bodyEnd: bodyStart + block.length }), "brace_scan_mismatch");
      expect(refused.reason, block).toContain("not the first block after the function's parameters");
    }
    // Braces inside the parameter list are not a body: a default value and a destructured parameter still pass.
    const withDefaults = ["var shelf = module.exports = {};", "", "shelf.count = function (items, opts = { deep: { n: 1 } }, { extra } = {}) {", "  return items.length + opts.deep.n;", "};", ""].join("\n");
    const defaultsRepo = makeRepo({ "lib/thing.js": withDefaults });
    expect(runSpike(previewArgs(defaultsRepo, "lib/thing.js", bindingOf(describeIn(defaultsRepo, "lib/thing.js", "shelf.count")))).json.status).toBe("preview");
  });

  it("a target or a root the caller named wrongly, and a rejected replacement, are named refusals in JSON", () => {
    const repo = makeRepo({ "lib/thing.js": PLAIN_LIB });
    const binding = bindingOf(describeIn(repo, "lib/thing.js", "shelf.count"));
    const cases: Array<[string, string[]]> = [
      ["a target path that escapes the root", previewArgs(repo, "../outside.js", binding)],
      ["an absolute target outside the root", previewArgs(repo, path.join(path.dirname(repo), "outside.js"), binding)],
      ["a missing target", previewArgs(repo, "lib/nope.js", binding)],
      ["a target that is a directory", previewArgs(repo, "lib", binding)],
      ["a missing root", previewArgs(path.join(repo, "no-such-root"), "lib/thing.js", binding)],
      ["a rejected replacement", previewArgs(repo, "lib/thing.js", binding, "process.exit(1)")],
      [
        "a test path that escapes the root, in a full run",
        ["--root", repo, "--test", "../outside.test.js", "--target", "lib/thing.js", "--method", "count", "--replacement", KILL, ...bindingArgs(binding)]
      ]
    ];
    for (const [label, args] of cases) {
      expect(expectRefused(repo, args, "invalid_binding").refusal, label).toBe("invalid_binding");
    }
    // Without --json the same refusal is one line on stderr and exit code 2, with no usage text.
    const plain = spawnSync(process.execPath, [script, ...previewArgs(repo, "lib/nope.js", binding)], { cwd: repoRoot, encoding: "utf8" });
    expect(plain.status).toBe(2);
    expect(plain.stdout).toBe("");
    expect(plain.stderr.trim()).toMatch(/^bound mutation refused \(invalid_binding\): --target lib\/nope\.js is not a file/);
    expect(plain.stderr).not.toContain("Usage:");
  });

  it("one unbalanced brace in a string, a regex, a template and a comment", () => {
    const bodies: Record<string, string> = {
      string: '  var open = "{";',
      regex: "  var shape = /\\{/;",
      template: "  var text = `{`;",
      comment: "  // an opening brace { with no partner"
    };
    for (const [where, line] of Object.entries(bodies)) {
      const lib = ["var shelf = module.exports = {};", "", "shelf.count = function (items) {", line, "  return items.length + 1;", "};", "", "shelf.later = function () {", "  return 2;", "};", ""].join("\n");
      const repo = makeRepo({ "lib/thing.js": lib }, `brace-${where}`);
      // The parser reads the function correctly; the raw count does not end where the parser says.
      expectRefused(repo, previewArgs(repo, "lib/thing.js", bindingOf(describeIn(repo, "lib/thing.js", "shelf.count"))), "brace_scan_mismatch");
    }
  });

  it("a file that is not valid UTF-8", () => {
    const repo = makeRepo({ "lib/thing.js": `// x marks the byte\n${PLAIN_LIB}` });
    const abs = path.join(repo, "lib/thing.js");
    const binding = bindingOf(describeIn(repo, "lib/thing.js", "shelf.count"));
    const bytes = readFileSync(abs);
    bytes[3] = 0xff; // the "x" in the comment: same length, so every offset still points at the same place
    writeFileSync(abs, bytes);
    expect(describeTarget(bytes, "shelf.count")).toEqual({ ok: false, refused: "not_utf8" });
    expectRefused(repo, previewArgs(repo, "lib/thing.js", { ...binding, fileSha256: sha256(bytes) }), "not_utf8");
  });

  it("a symlinked source root, and a target reached through a symlink inside the root", () => {
    const repo = makeRepo({ "lib/thing.js": PLAIN_LIB });
    const binding = bindingOf(describeIn(repo, "lib/thing.js", "shelf.count"));
    const holder = mkdtempSync(path.join(tmpdir(), "opro-bound-link-"));
    tempDirs.push(holder);
    const linkedRoot = path.join(holder, "linked-root");
    symlinkSync(repo, linkedRoot, "dir");
    const before = snapshot(repo);
    const viaRoot = runSpike(previewArgs(linkedRoot, "lib/thing.js", binding));
    expect(viaRoot.json).toMatchObject({ status: "refused", refusal: "symlinked_target" });
    // A full run is refused before any copy as well.
    const fullRun = runSpike(["--root", linkedRoot, "--test", "test/none.test.js", "--target", "lib/thing.js", "--method", "count", "--replacement", KILL, ...bindingArgs(binding)]);
    expect(fullRun.json).toMatchObject({ status: "refused", refusal: "symlinked_target" });

    symlinkSync(path.join(repo, "lib"), path.join(repo, "alias"), "dir");
    const viaDir = runSpike(previewArgs(repo, "alias/thing.js", binding));
    expect(viaDir.json).toMatchObject({ status: "refused", refusal: "symlinked_target" });
    expect(snapshot(repo)).toEqual(before);
  });

  it("an incomplete or malformed binding, and a preview without one", () => {
    const repo = makeRepo({ "lib/thing.js": PLAIN_LIB });
    const binding = bindingOf(describeIn(repo, "lib/thing.js", "shelf.count"));
    const base = ["--root", repo, "--target", "lib/thing.js", "--method", "count", "--replacement", KILL];
    expectRefused(repo, [...base, "--bound-file-sha256", binding.fileSha256, "--preview"], "invalid_binding");
    expectRefused(repo, previewArgs(repo, "lib/thing.js", { ...binding, targets: ["count"] }), "invalid_binding");
    expectRefused(repo, previewArgs(repo, "lib/thing.js", { ...binding, bodyEnd: PLAIN_LIB.length + 50 }), "invalid_binding");
    const before = snapshot(repo);
    const noBinding = runSpike([...base, "--preview"]);
    expect(noBinding.json).toMatchObject({ status: "refused", refusal: "preview_requires_bound" });

    // Without --json a refusal is one line on stderr, still exit code 2.
    const plain = spawnSync(process.execPath, [script, ...previewArgs(repo, "lib/thing.js", { ...binding, bodyStart: binding.bodyStart + 1 })], { cwd: repoRoot, encoding: "utf8" });
    expect(plain.status).toBe(2);
    expect(plain.stdout).toBe("");
    expect(plain.stderr.trim()).toMatch(/^bound mutation refused \(brace_scan_mismatch\): /);
    expect(snapshot(repo)).toEqual(before);
  });

  it("write_outside_copy: a target that the copy only links to (under a linked node_modules) is never written", () => {
    const kit = ["var kit = module.exports = {};", "", "kit.count = function (items) {", "  return items.length + 1;", "};", ""].join("\n");
    const repo = makeRepo({
      "node_modules/kit/index.js": kit,
      "test/kit.test.js": [
        "const assert = require('node:assert/strict');",
        "const kit = require('kit');",
        "describe('kit', () => { it('counts', () => { assert.equal(kit.count([1]), 2); }); });",
        ""
      ].join("\n")
    });
    const binding = bindingOf(describeIn(repo, "node_modules/kit/index.js", "kit.count"));
    // With --link-node-modules the mutant copy's node_modules is a link to the checkout's: the file
    // "in the copy" is the checkout file itself.
    expectRefused(
      repo,
      [
        "--root", repo, "--test", "test/kit.test.js", "--target", "node_modules/kit/index.js", "--method", "count", "--replacement", KILL,
        "--runner", "mocha", "--mocha-bin", mochaBin, "--link-node-modules", ...bindingArgs(binding)
      ],
      "write_outside_copy"
    );
  });

  it("checkout_modified: the checkout file is hashed again after the run, and a change fails it", () => {
    const repo = makeRepo({ "lib/thing.js": PLAIN_LIB });
    const abs = path.join(repo, "lib/thing.js");
    // A test that reaches back into the source checkout by absolute path while it runs in the copy.
    writeFileSync(
      path.join(repo, "test-writer.test.js"),
      [
        "const assert = require('node:assert/strict');",
        "const fs = require('node:fs');",
        "const lib = require('./lib/thing');",
        "describe('writer', () => {",
        `  it('counts', () => { fs.appendFileSync(${JSON.stringify(abs)}, '// touched\\n'); assert.equal(lib.count([1]), 2); });`,
        "});",
        ""
      ].join("\n")
    );
    const binding = bindingOf(describeIn(repo, "lib/thing.js", "shelf.count"));
    const out = runSpike([
      "--root", repo, "--test", "test-writer.test.js", "--target", "lib/thing.js", "--method", "count", "--replacement", KILL,
      "--runner", "mocha", "--mocha-bin", mochaBin, ...bindingArgs(binding)
    ]);
    expect(out.json).toMatchObject({ status: "refused", proven: false, refusal: "checkout_modified" });
    expect(out.status).toBe(2);
  });
});

// ── opDynamicProof: the route is decided by re-parsing the file ─────────────────────

const ENTRY = ["'use strict';", "exports.basket = require('./basket');", "exports.Crate = require('./crate');", "exports.tools = require('./tools');", ""].join("\n");
const BASKET = [
  "'use strict';",
  "",
  "var basket = Object.create(null);",
  "module.exports = basket;",
  "",
  "basket.total = function (items) {",
  "  return items.reduce(function (sum, item) { return sum + item.price; }, 0);",
  "};",
  "",
  "basket.twice = (n) => n * 2;",
  ""
].join("\n");
const CRATE = [
  "'use strict';",
  "module.exports = Crate;",
  "function Crate(parts) { this.parts = parts; }",
  "Crate.prototype.weigh = function weigh() {",
  "  return this.parts.reduce(function (a, b) { return a + b; }, 0);",
  "};",
  ""
].join("\n");
// `get: function` beside an unrelated `function forget`: a search for `get(` finds `forget(`.
const TOOLS = [
  "'use strict';",
  "function forget(key) {",
  "  return 'gone:' + key;",
  "}",
  "module.exports = {",
  "  get: function (key) { return 'value:' + key + forget(key); },",
  "  put(key) { return 'put:' + key; }",
  "};",
  ""
].join("\n");
// `validate: function` beside a private `function validate`: a search for `validate(` finds the private one.
const CHECKS = [
  "'use strict';",
  "function validate(input) {",
  "  return input != null;",
  "}",
  "module.exports = {",
  "  validate: function (input) { return validate(input) && input.length > 0; },",
  "  measure: function (input) { return input.length + 1; }",
  "};",
  ""
].join("\n");
const PLAIN_TS = ["export function createOrder(id: string): string {", "  return `order-${id}`;", "}", ""].join("\n");
const BASKET_TEST = [
  "const assert = require('node:assert/strict');",
  "const basket = require('../lib/basket');",
  "describe('basket', () => {",
  "  it('adds prices', () => { assert.equal(basket.total([{ price: 2 }, { price: 3 }]), 5); });",
  "});",
  ""
].join("\n");

const SHOP_FILES: Record<string, string> = {
  "lib/index.js": ENTRY,
  "lib/basket.js": BASKET,
  "lib/crate.js": CRATE,
  "lib/tools.js": TOOLS,
  "lib/checks.js": CHECKS,
  "lib/orders.ts": PLAIN_TS,
  "test/basket.test.js": BASKET_TEST
};

function makeWorkspace(files: Record<string, string | Buffer> = SHOP_FILES, label = "bound-ws"): string {
  const dir = makeRepo(files, label);
  opInit(dir, deps);
  opAnalyze(dir, { source: dir }, deps);
  return dir;
}

const PROVEN_JSON = JSON.stringify({
  status: "proven",
  proven: true,
  reason: "baseline passed and mutant failed at an assertion",
  runner: "mocha",
  replacementMode: "return-json",
  baseline: { exitCode: 0, timedOut: false, failureSummary: null },
  mutant: { exitCode: 1, timedOut: false, assertionFailure: true },
  medianProofMs: 5
});

/** What the real script adds on the bound path: the file hash and the body span it was sent. Empty for the name search. */
function boundEcho(args: string[]): { bound?: { fileSha256: string; changedBytes: { start: number; end: number } } } {
  const valueOf = (flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const fileSha256 = valueOf("--bound-file-sha256");
  if (fileSha256 === undefined) return {};
  return { bound: { fileSha256, changedBytes: { start: Number(valueOf("--bound-body-start")), end: Number(valueOf("--bound-body-end")) } } };
}

/** A runner that records what it was asked and answers "proven"; `calls` stays empty when a refusal comes first. */
function recordingRunner(): { calls: string[][]; runner: DynamicProofRunner } {
  const calls: string[][] = [];
  return {
    calls,
    runner: (args) => {
      calls.push(args);
      return { exitCode: 0, stderr: "", stdout: JSON.stringify({ ...JSON.parse(PROVEN_JSON), ...boundEcho(args) }) };
    }
  };
}

/**
 * Runs `fn`, expects a named refusal, and checks that no file of any fixture made so far
 * changed while it ran. `writesByDesign` is for the two cases whose runner edits the checkout.
 */
function refusalOf(fn: () => unknown, opts: { writesByDesign?: boolean } = {}): ProofRefusalError {
  const before = opts.writesByDesign ? null : tempDirs.map(snapshot);
  let refusal: ProofRefusalError | null = null;
  try {
    fn();
  } catch (error) {
    if (!(error instanceof ProofRefusalError)) throw error;
    refusal = error;
  }
  if (!refusal) throw new Error("expected a named refusal, but the call returned");
  if (before) expect(tempDirs.map(snapshot)).toEqual(before);
  return refusal;
}

describe("opDynamicProof — routing by re-parsing the target file", { timeout: 120_000 }, () => {
  it("sends a prototype or exported-object member down the bound path with its exact binding", () => {
    const W = makeWorkspace();
    for (const [symbolId, rel, name] of [
      ["sym:lib/basket.js#basket.total", "lib/basket.js", "basket.total"],
      ["sym:lib/crate.js#Crate.weigh", "lib/crate.js", "Crate.weigh"]
    ] as const) {
      const { calls, runner } = recordingRunner();
      const result = opDynamicProof(W, { target_symbol: symbolId, source: W, test_path: "test/basket.test.js", replacement: KILL, runner: "mocha" }, { ...deps, dynamicProofRunner: runner });
      const binding = bindingOf(describeIn(W, rel, name));
      const method = name.split(".").pop()!;
      expect(calls).toEqual([[
        "--root", W, "--test", "test/basket.test.js", "--target", rel, "--method", method, "--replacement", KILL,
        "--replacement-mode", "return-json", "--runner", "mocha", "--json", ...bindingArgs(binding)
      ]]);
      expect(result.oracle.mutation_route).toBe("bound");
      expect(result.record).toMatchObject({ target_symbol: symbolId, closed: true, status: "reproven" });
    }
  });

  it("leaves a function the name search handles on today's path, with today's arguments", () => {
    const W = makeWorkspace();
    const { calls, runner } = recordingRunner();
    const result = opDynamicProof(
      W,
      { target_symbol: "sym:lib/orders.ts#createOrder", source: W, test_path: "test/basket.test.js", replacement: "return null;", runner: "vitest" },
      { ...deps, dynamicProofRunner: runner }
    );
    expect(calls).toEqual([[
      "--root", W, "--test", "test/basket.test.js", "--target", "lib/orders.ts", "--method", "createOrder", "--replacement", "return null;",
      "--replacement-mode", "return-json", "--runner", "vitest", "--json"
    ]]);
    expect(result.oracle).not.toHaveProperty("mutation_route");
    expect(result.record.closed).toBe(true);
  });

  it("refuses `get: function` beside `function forget`, and `validate: function` beside a private `function validate`, as unsupported_shape", () => {
    const W = makeWorkspace();
    // The collision emits no symbol (`name_collision`). Name it in the graph anyway, as a stale or
    // hand-made graph could: the refusal must not depend on the analyzer having left it out.
    const graphPath = workspacePaths(W).graphPath;
    const graph = loadGraph(graphPath);
    const measure = graph.nodes.find((n) => n.external_id === "sym:lib/checks.js#measure");
    expect(measure).toBeDefined();
    expect(graph.nodes.some((n) => n.external_id === "sym:lib/checks.js#validate")).toBe(false);
    graph.nodes.push({ ...(measure as GraphNode), id: "CodeSymbol:validate-by-hand", external_id: "sym:lib/checks.js#validate", title: "validate" });
    saveGraph(graphPath, graph);
    expect(mutationRouteFor(Buffer.from(TOOLS), "get")).toBe("unsupported_shape");
    expect(mutationRouteFor(Buffer.from(CHECKS), "validate")).toBe("unsupported_shape");
    expect(mutationRouteFor(Buffer.from(TOOLS), "put")).toBe("name_search");

    const before = snapshot(W);
    for (const symbolId of ["sym:lib/tools.js#get", "sym:lib/checks.js#validate", "sym:lib/checks.js#measure"]) {
      const { calls, runner } = recordingRunner();
      const refusal = refusalOf(() =>
        opDynamicProof(W, { target_symbol: symbolId, source: W, test_path: "test/basket.test.js", replacement: KILL }, { ...deps, dynamicProofRunner: runner })
      );
      expect(refusal.code).toBe("unsupported_shape");
      expect(refusal.message).toContain("prove refused (unsupported_shape)");
      expect(calls).toEqual([]); // refused before any search or copy
    }
    expect(snapshot(W)).toEqual(before); // `forget` and the private `validate` are untouched
    expect(loadLedger(W).records).toEqual([]);
    // The wrapper refuses the same way.
    expect(refusalOf(() => opProveLoop(W, { target_symbol: "sym:lib/tools.js#get", source: W, test_path: "test/basket.test.js", replacement: KILL }, deps)).code).toBe("unsupported_shape");
  });

  it("refuses an object-literal method with a quoted key beside a function whose name ends the same way, before any search", () => {
    // The search for `name(` cannot match `"name"(key) {`; it matches the tail of `function rename(key) {`.
    const tools = (key: string): string =>
      ["'use strict';", "function rename(key) {", "  return 'renamed:' + key;", "}", "module.exports = {", `  ${key}(key) { return 'name:' + key; },`, "  relabel(key) { return rename(key); }", "};", ""].join("\n");
    for (const key of ['"name"', "'name'", "async 'name'", "*'name'"]) {
      expect(mutationRouteFor(Buffer.from(tools(key)), "name"), key).toBe("unsupported_shape");
      expect(describeTarget(Buffer.from(tools(key)), "name"), key).toMatchObject({ ok: true, target: { shape_form: "literal_inline", fn_kind: "method", mutation_route: "unsupported_shape" } });
    }
    // The quoted key alone decides it: with no other function in the file the route is the same.
    expect(mutationRouteFor(Buffer.from('module.exports = {\n  "name"(key) { return key; }\n};\n'), "name")).toBe("unsupported_shape");
    expect(mutationRouteFor(Buffer.from("module.exports = {\n  name(key) { return key; }\n};\n"), "name")).toBe("name_search");

    const W = makeWorkspace({
      "lib/index.js": "exports.tools = require('./tools');\n",
      "lib/tools.js": tools('"name"'),
      // Never calls `tools.name`: a proof from this test would be a proof of `rename`.
      "test/relabel.test.js": "const assert = require('node:assert/strict');\nconst tools = require('../lib/tools');\ndescribe('tools', () => { it('relabels', () => { assert.equal(tools.relabel('a'), 'renamed:a'); }); });\n"
    });
    expect(loadGraph(workspacePaths(W).graphPath).nodes.some((n) => n.external_id === "sym:lib/tools.js#name")).toBe(true);
    const before = snapshot(W);
    const opts = { target_symbol: "sym:lib/tools.js#name", source: W, test_path: "test/relabel.test.js", replacement: KILL, runner: "mocha" } as const;
    const { calls, runner } = recordingRunner();
    const refusal = refusalOf(() => opDynamicProof(W, opts, { ...deps, dynamicProofRunner: runner }));
    expect(refusal.code).toBe("unsupported_shape");
    expect(calls).toEqual([]);
    // The real script is never started either, and the wrapper refuses the same way.
    expect(refusalOf(() => opDynamicProof(W, opts, deps)).code).toBe("unsupported_shape");
    expect(refusalOf(() => opProveLoop(W, opts, deps)).code).toBe("unsupported_shape");
    expect(loadLedger(W).records).toEqual([]);
    expect(snapshot(W)).toEqual(before); // `rename` is untouched
  });

  it("does not credit a runner that never confirms the bound route", () => {
    const W = makeWorkspace();
    const opts = { target_symbol: "sym:lib/basket.js#basket.total", source: W, test_path: "test/basket.test.js", replacement: KILL, runner: "mocha" } as const;
    const binding = bindingOf(describeIn(W, "lib/basket.js", "basket.total"));
    const honest = { fileSha256: binding.fileSha256, changedBytes: { start: binding.bodyStart, end: binding.bodyEnd } };
    const answering = (bound: unknown, extra: Record<string, unknown> = {}): { calls: string[][]; runner: DynamicProofRunner } => {
      const calls: string[][] = [];
      return {
        calls,
        runner: (args) => {
          calls.push(args);
          return { exitCode: 0, stderr: "", stdout: JSON.stringify({ ...JSON.parse(PROVEN_JSON), ...extra, ...(bound === undefined ? {} : { bound }) }) };
        }
      };
    };
    const unconfirmed: Array<[string, unknown]> = [
      ["a runner that ignores the binding arguments, as an older script does: no bound block", undefined],
      ["another file hash", { ...honest, fileSha256: "0".repeat(64) }],
      ["another body span", { ...honest, changedBytes: { start: honest.changedBytes.start, end: honest.changedBytes.end - 1 } }],
      ["a hash without a span", { fileSha256: honest.fileSha256 }]
    ];
    for (const [label, bound] of unconfirmed) {
      const { calls, runner } = answering(bound);
      const refusal = refusalOf(() => opDynamicProof(W, opts, { ...deps, dynamicProofRunner: runner }));
      expect(refusal.code, label).toBe("binding_not_confirmed");
      // The binding was sent; the answer did not confirm it.
      expect(calls[0], label).toContain("--bound-file-sha256");
    }
    // A preview that does not come back confirmed is refused the same way.
    const unconfirmedPreview = answering(undefined, { status: "preview", proven: false, diff: "" });
    expect(refusalOf(() => opDynamicProof(W, { target_symbol: opts.target_symbol, source: W, replacement: KILL, preview: true }, { ...deps, dynamicProofRunner: unconfirmedPreview.runner })).code).toBe(
      "binding_not_confirmed"
    );
    expect(loadLedger(W).records).toEqual([]);

    // The same answer with the block the script really returns is credited as bound.
    const result = opDynamicProof(W, opts, { ...deps, dynamicProofRunner: answering(honest).runner });
    expect(result.oracle.mutation_route).toBe("bound");
    expect(result.record.closed).toBe(true);
  });

  it("the loop refuses an unsupported shape before its setup commands run, and runs them for a function it can prove", () => {
    const W = makeWorkspace();
    const marker = path.join(W, "setup-ran.txt");
    const setup = [{ command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] }];
    const { calls, runner } = recordingRunner();
    const loopDeps = { ...deps, dynamicProofRunner: runner, suppressBehaviorReportRefresh: true };
    const refusal = refusalOf(() =>
      opProveLoop(W, { target_symbol: "sym:lib/tools.js#get", source: W, test_path: "test/basket.test.js", replacement: KILL, setup_commands: setup }, loopDeps)
    );
    expect(refusal.code).toBe("unsupported_shape");
    expect(existsSync(marker)).toBe(false);
    expect(calls).toEqual([]);

    const proved = opProveLoop(W, { target_symbol: "sym:lib/basket.js#basket.total", source: W, test_path: "test/basket.test.js", replacement: KILL, setup_commands: setup }, loopDeps);
    expect(existsSync(marker)).toBe(true);
    expect(proved).toMatchObject({ record: { closed: true }, oracle: { mutation_route: "bound" } });
    expect(calls).toHaveLength(1);
  });

  it("refuses an arrow member without a body in braces, by name", () => {
    const W = makeWorkspace();
    const { calls, runner } = recordingRunner();
    const refusal = refusalOf(() =>
      opDynamicProof(W, { target_symbol: "sym:lib/basket.js#basket.twice", source: W, test_path: "test/basket.test.js", replacement: KILL }, { ...deps, dynamicProofRunner: runner })
    );
    expect(refusal.code).toBe("no_block_body");
    expect(calls).toEqual([]);
  });

  it("previews a bound target: the diff only, no test run, no ledger record, checkout unchanged", () => {
    const W = makeWorkspace();
    const before = snapshot(W);
    const target = describeIn(W, "lib/basket.js", "basket.total");
    const preview = opDynamicProof(W, { target_symbol: "sym:lib/basket.js#basket.total", source: W, replacement: KILL, preview: true }, deps);
    expect(preview).toMatchObject({
      preview: true,
      target_symbol: "sym:lib/basket.js#basket.total",
      target: "lib/basket.js",
      mutation_route: "bound",
      file_sha256: target.file_sha256,
      changed_bytes: target.body!.bytes,
      checkout_unchanged: true
    });
    const changed = changedOldLines(preview.diff);
    expect(changed.first).toBeGreaterThanOrEqual(target.body!.lines.start);
    expect(changed.last).toBeLessThanOrEqual(target.body!.lines.end);
    expect(preview.diff).toContain(`+  ${KILL}`);
    expect(preview).not.toHaveProperty("record");
    expect(loadLedger(W).records).toEqual([]);
    expect(snapshot(W)).toEqual(before);

    // A preview exists on the bound path only.
    const { calls, runner } = recordingRunner();
    const refusal = refusalOf(() =>
      opDynamicProof(W, { target_symbol: "sym:lib/orders.ts#createOrder", source: W, replacement: KILL, preview: true }, { ...deps, dynamicProofRunner: runner })
    );
    expect(refusal.code).toBe("preview_requires_bound");
    expect(calls).toEqual([]);
  });

  it("proves a bound member end to end with the real script, and leaves the checkout as it was", () => {
    const W = makeWorkspace();
    const before = snapshot(W);
    const result = opDynamicProof(W, { target_symbol: "sym:lib/basket.js#basket.total", source: W, test_path: "test/basket.test.js", replacement: KILL, runner: "mocha" }, deps);
    expect(result.oracle).toMatchObject({ status: "proven", proven: true, mutation_route: "bound" });
    expect(result.record).toMatchObject({ closed: true, status: "reproven", dynamic_proof: { oracle_version: "orangepro.targeted_mutation_oracle.v4" } });
    expect(snapshot(W)).toEqual(before);
  });

  it("turns a refusal from the script into a named error and writes no ledger record", () => {
    const lib = ["var shelf = module.exports = {};", "", "shelf.count = function (items) {", '  var open = "{";', "  return items.length + 1;", "};", ""].join("\n");
    const W = makeWorkspace({ "lib/index.js": "exports.shelf = require('./shelf');\n", "lib/shelf.js": lib });
    const before = snapshot(W);
    // The real script, through preview and through a full run: both stop at the brace check.
    expect(refusalOf(() => opDynamicProof(W, { target_symbol: "sym:lib/shelf.js#shelf.count", source: W, replacement: KILL, preview: true }, deps)).code).toBe("brace_scan_mismatch");
    const full = refusalOf(() => opDynamicProof(W, { target_symbol: "sym:lib/shelf.js#shelf.count", source: W, test_path: "lib/index.js", replacement: KILL, runner: "mocha" }, deps));
    expect(full.code).toBe("brace_scan_mismatch");
    expect(full.message).toBe("prove refused (brace_scan_mismatch): a raw brace count from the body's opening brace does not end at the recorded end of the body");
    expect(loadLedger(W).records).toEqual([]);
    expect(snapshot(W)).toEqual(before);
  });

  it("fails the run as checkout_modified when the checkout file differs after the attempt, even after an error", () => {
    const W = makeWorkspace();
    const abs = path.join(W, "lib/basket.js");
    const original = readFileSync(abs);
    const touching: DynamicProofRunner = () => {
      writeFileSync(abs, Buffer.concat([original, Buffer.from("// touched\n")]));
      return { exitCode: 0, stderr: "", stdout: PROVEN_JSON };
    };
    const opts = { target_symbol: "sym:lib/basket.js#basket.total", source: W, test_path: "test/basket.test.js", replacement: KILL } as const;
    expect(refusalOf(() => opDynamicProof(W, opts, { ...deps, dynamicProofRunner: touching }), { writesByDesign: true }).code).toBe("checkout_modified");
    writeFileSync(abs, original);
    const crashing: DynamicProofRunner = () => {
      writeFileSync(abs, Buffer.concat([original, Buffer.from("// touched\n")]));
      throw new Error("runner crashed");
    };
    expect(refusalOf(() => opDynamicProof(W, opts, { ...deps, dynamicProofRunner: crashing }), { writesByDesign: true }).code).toBe("checkout_modified");
    writeFileSync(abs, original);
    expect(loadLedger(W).records).toEqual([]);
  });

  it("U+2028 before the target refuses a bound member and leaves a name-search function on today's path", () => {
    const separator = String.fromCharCode(0x2028);
    const lib = [
      `/* a line separator ${separator} inside a comment */`,
      "var shelf = module.exports = {};",
      "",
      "shelf.count = function (items) {",
      "  return items.length + 1;",
      "};",
      ""
    ].join("\n");
    const ts = [`/* a line separator ${separator} inside a comment */`, PLAIN_TS].join("\n");
    const W = makeWorkspace({ "lib/index.js": "exports.shelf = require('./shelf');\n", "lib/shelf.js": lib, "lib/orders.ts": ts });
    expect(describeTarget(Buffer.from(lib), "shelf.count")).toEqual({ ok: false, refused: "line_rule_mismatch" });
    const before = snapshot(W);
    const bound = recordingRunner();
    const refusal = refusalOf(() =>
      opDynamicProof(W, { target_symbol: "sym:lib/shelf.js#shelf.count", source: W, test_path: "lib/index.js", replacement: KILL }, { ...deps, dynamicProofRunner: bound.runner })
    );
    expect(refusal.code).toBe("line_rule_mismatch");
    expect(bound.calls).toEqual([]);
    expect(snapshot(W)).toEqual(before);

    const named = recordingRunner();
    opDynamicProof(W, { target_symbol: "sym:lib/orders.ts#createOrder", source: W, test_path: "lib/index.js", replacement: "return null;" }, { ...deps, dynamicProofRunner: named.runner });
    expect(named.calls).toHaveLength(1);
    expect(named.calls[0]).not.toContain("--bound-file-sha256");
  });

  it("a file that is not valid UTF-8 refuses a bound member as not_utf8", () => {
    const lib = Buffer.from(["// x marks the byte", "var shelf = module.exports = {};", "", "shelf.count = function (items) {", "  return items.length + 1;", "};", ""].join("\n"));
    lib[3] = 0xff;
    const W = makeWorkspace({ "lib/index.js": "exports.shelf = require('./shelf');\n", "lib/shelf.js": lib });
    const { calls, runner } = recordingRunner();
    const refusal = refusalOf(() =>
      opDynamicProof(W, { target_symbol: "sym:lib/shelf.js#shelf.count", source: W, test_path: "lib/index.js", replacement: KILL }, { ...deps, dynamicProofRunner: runner })
    );
    expect(refusal.code).toBe("not_utf8");
    expect(calls).toEqual([]);
  });
});

// ── The name search: a linked source root, and which new functions may use it ───────

describe("name search — a symlinked source root is copied, never written through", { timeout: 120_000 }, () => {
  const CALC = ["'use strict';", "function twice(n) {", "  return n * 2;", "}", "module.exports = { twice };", ""].join("\n");
  const CALC_TEST = [
    "const assert = require('node:assert/strict');",
    "const calc = require('../lib/calc');",
    "describe('calc', () => { it('doubles', () => { assert.equal(calc.twice(2), 4); }); });",
    ""
  ].join("\n");
  const linkTo = (repo: string): string => {
    const holder = mkdtempSync(path.join(tmpdir(), "opro-name-link-"));
    tempDirs.push(holder);
    const link = path.join(holder, "linked-root");
    symlinkSync(repo, link, "dir");
    return link;
  };
  const searchArgs = (root: string): string[] => [
    "--root", root, "--test", "test/calc.test.js", "--target", "lib/calc.js", "--method", "twice", "--replacement", KILL, "--runner", "mocha", "--mocha-bin", mochaBin
  ];
  const verdict = ({ status, proven, reason, runner, test, target, method, mutant }: SpikeJson): unknown => ({
    status, proven, reason, runner, test, target, method, assertionFailure: mutant?.assertionFailure
  });

  it("the script proves through the link and the checkout file keeps its hash", () => {
    const repo = makeRepo({ "lib/calc.js": CALC, "test/calc.test.js": CALC_TEST }, "name-link");
    const before = snapshot(repo);
    const direct = runSpike(searchArgs(repo));
    expect(direct.json.status).toBe("proven");
    const linked = runSpike(searchArgs(linkTo(repo)));
    expect(linked.status).toBe(0);
    expect(sha256(readFileSync(path.join(repo, "lib/calc.js")))).toBe(sha256(Buffer.from(CALC)));
    expect(snapshot(repo)).toEqual(before);
    // The answer is the one the real path gives: same verdict, same relative paths, no binding.
    expect(verdict(linked.json)).toEqual(verdict(direct.json));
    expect(linked.json).toMatchObject({ test: "test/calc.test.js", target: "lib/calc.js" });
    expect(linked.json).not.toHaveProperty("bound");

    // A root that is a real folder under a linked parent is used as given, as before.
    const underLinkedParent = path.join(linkTo(path.dirname(repo)), path.basename(repo));
    expect(verdict(runSpike(searchArgs(underLinkedParent)).json)).toEqual(verdict(direct.json));
    expect(snapshot(repo)).toEqual(before);
  });

  it("opDynamicProof with the source given as a link proves and leaves the user's file unchanged", () => {
    const repo = makeRepo({ "lib/index.js": "exports.calc = require('./calc');\n", "lib/calc.js": CALC, "test/calc.test.js": CALC_TEST }, "name-link-op");
    const link = linkTo(repo);
    opInit(link, deps);
    opAnalyze(link, { source: link }, deps);
    const before = snapshot(repo);
    // `twice` is visible only through the exported literal, and the search lands on its own body.
    expect(mutationRouteFor(Buffer.from(CALC), "twice")).toBe("name_search");
    const result = opDynamicProof(link, { target_symbol: "sym:lib/calc.js#twice", source: link, test_path: "test/calc.test.js", replacement: KILL, runner: "mocha" }, deps);
    expect(result.oracle).toMatchObject({ status: "proven", proven: true });
    expect(result.oracle).not.toHaveProperty("mutation_route");
    expect(result.record).toMatchObject({ target_symbol: "sym:lib/calc.js#twice", closed: true });
    expect(readFileSync(path.join(repo, "lib/calc.js"), "utf8")).toBe(CALC);
    expect(snapshot(repo)).toEqual(before);
  });
});

describe("name search — a newly visible function uses it only when the search lands on its own body", { timeout: 120_000 }, () => {
  // The search stops at the first `)` and has no word boundary: it does not match `put(key = d()) {`
  // and it does match the tail of `function input(key) {`.
  const HELPERS = ["function d() { return 'k'; }", "function input(key) {", "  return 'in:' + key;", "}"];
  const WRONG_TARGET: Record<string, string> = {
    "an exported-literal method": [...HELPERS, "module.exports = {", "  put(key = d()) { return 'put:' + key; },", "  read(key) { return input(key); }", "};", ""].join("\n"),
    "an exported-literal reference": [...HELPERS, "function put(key = d()) {", "  return 'put:' + key;", "}", "module.exports = { put, read: function (key) { return input(key); } };", ""].join("\n"),
    "an export list": [...HELPERS, "function put(key = d()) {", "  return 'put:' + key;", "}", "export { put };", ""].join("\n")
  };

  it("repeats the script's own search patterns, so the route cannot drift from the runner", () => {
    const source = readFileSync(script, "utf8");
    const methodTemplate = /const methodRe = new RegExp\(`([^`]+)`, "gm"\);/.exec(source)?.[1];
    const freeFnTemplate = /const freeFnRe = new RegExp\(\s*`([^`]+)`,\s*"gm"\s*\);/.exec(source)?.[1];
    expect(methodTemplate).toBeDefined();
    expect(freeFnTemplate).toBeDefined();
    // Evaluate the script's template literals as the script does, with a stand-in for the escaped name.
    const evaluate = (template: string): string => new Function("escaped", `return \`${template}\`;`)("NAME") as string;
    expect(nameSearchPatterns("NAME")).toEqual({ method: evaluate(methodTemplate!), freeFn: evaluate(freeFnTemplate!) });
  });

  it("finds what the search would replace: one definition, or nothing when there are none or several", () => {
    const body = (src: string, open: string): [number, number] => {
      const start = src.indexOf(open) + open.length - 1;
      return [start, src.indexOf("}", start) + 1];
    };
    const plain = "function twice(n) {\n  return n * 2;\n}\nexport { twice };\n";
    expect(nameSearchBody(plain, "twice")).toEqual(body(plain, "function twice(n) {"));
    const arrow = "const twice = (n) => {\n  return n * 2;\n};\nexport { twice };\n";
    expect(nameSearchBody(arrow, "twice")).toEqual(body(arrow, "const twice = (n) => {"));
    expect(nameSearchBody("const twice = (n) => n * 2;\nexport { twice };\n", "twice")).toBeNull();
    expect(nameSearchBody("function twice(n) {\n  return 1;\n}\nfunction retwice(n) {\n  return 2;\n}\n", "twice")).toBeNull();
    for (const [label, src] of Object.entries(WRONG_TARGET)) {
      expect(nameSearchBody(src, "put"), label).toEqual(body(src, "function input(key) {"));
    }
  });

  it("routes a new function to unsupported_shape when the search would change another function, find several, or find none", () => {
    for (const [label, src] of Object.entries(WRONG_TARGET)) {
      expect(mutationRouteFor(Buffer.from(src), "put"), label).toBe("unsupported_shape");
    }
    // Several matches (`open(a) {` is also the tail of `reopen(a) {`), and no match (the function has another name).
    expect(mutationRouteFor(Buffer.from("class Box {\n  open(a) { return a; }\n  reopen(a) { return a; }\n}\nexport { Box };\n"), "Box.open")).toBe("unsupported_shape");
    expect(mutationRouteFor(Buffer.from("const run = function start(x) { return x; };\nmodule.exports = { run };\n"), "run")).toBe("unsupported_shape");
    expect(mutationRouteFor(Buffer.from("const twice = (n) => n * 2;\nexport { twice };\n"), "twice")).toBe("unsupported_shape");
    // A return type written with braces: the search would cut at the type's brace.
    expect(mutationRouteFor(Buffer.from("function box(n: number): { n: number } {\n  return { n };\n}\nexport { box };\n"), "box")).toBe("unsupported_shape");

    // With nothing in the search's way, each new shape keeps the name search.
    const found: Array<[string, string]> = [
      ["function twice(n) {\n  return n * 2;\n}\nexport { twice };\n", "twice"],
      ["const twice = (n) => {\n  return n * 2;\n};\nexport { twice as double };\n", "twice"],
      ["function twice(n) {\n  return n * 2;\n}\nmodule.exports = { double: twice };\n", "twice"],
      ["module.exports = {\n  put(key) { return 'put:' + key; },\n  async take(key) { return key; }\n};\n", "put"],
      ["module.exports = {\n  put(key) { return 'put:' + key; },\n  async take(key) { return key; }\n};\n", "take"],
      ["class Box {\n  open(a) { return a; }\n}\nexport { Box };\n", "Box.open"]
    ];
    for (const [src, name] of found) expect(mutationRouteFor(Buffer.from(src), name), `${name} in ${JSON.stringify(src)}`).toBe("name_search");

    // A function 0.2.58 already sees keeps today's route, whatever the search would do with it.
    const released = [...HELPERS, "export function put(key = d()) {", "  return 'put:' + key;", "}", ""].join("\n");
    expect(mutationRouteFor(Buffer.from(released), "put")).toBe("name_search");
    expect(mutationRouteFor(Buffer.from("export class Box {\n  open(a) { return a; }\n  reopen(a) { return a; }\n}\n"), "Box.open")).toBe("name_search");
  });

  it("opDynamicProof and the loop refuse such a function before any runner starts, and leave a 0.2.58 function on today's path", () => {
    const released = [...HELPERS, "export function put(key = d()) {", "  return 'put:' + key;", "}", ""].join("\n");
    const W = makeWorkspace({
      "lib/index.js": "exports.tools = require('./tools');\n",
      "lib/tools.js": WRONG_TARGET["an exported-literal method"]!,
      "lib/released.ts": released,
      "test/tools.test.js": "const assert = require('node:assert/strict');\nconst tools = require('../lib/tools');\ndescribe('tools', () => { it('reads', () => { assert.equal(tools.read('a'), 'in:a'); }); });\n"
    });
    const before = snapshot(W);
    const opts = { target_symbol: "sym:lib/tools.js#put", source: W, test_path: "test/tools.test.js", replacement: KILL, runner: "mocha" } as const;
    const refused = recordingRunner();
    expect(refusalOf(() => opDynamicProof(W, opts, { ...deps, dynamicProofRunner: refused.runner })).code).toBe("unsupported_shape");
    expect(refused.calls).toEqual([]);
    // With the real script as well: the test never calls `put`, and nothing is credited to it.
    expect(refusalOf(() => opDynamicProof(W, opts, deps)).code).toBe("unsupported_shape");
    expect(refusalOf(() => opProveLoop(W, opts, deps)).code).toBe("unsupported_shape");
    expect(loadLedger(W).records).toEqual([]);
    expect(snapshot(W)).toEqual(before);

    const today = recordingRunner();
    opDynamicProof(W, { ...opts, target_symbol: "sym:lib/released.ts#put", runner: "vitest" }, { ...deps, dynamicProofRunner: today.runner });
    expect(today.calls).toEqual([[
      "--root", W, "--test", "test/tools.test.js", "--target", "lib/released.ts", "--method", "put", "--replacement", KILL,
      "--replacement-mode", "return-json", "--runner", "vitest", "--json"
    ]]);
  });
});

// ── Records: a claim, rebuilt and compared ──────────────────────────────────────────

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.name=Sample Author", "-c", "user.email=author@example.test", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  }).trim();
}

function commitAll(repo: string, message: string): string {
  git(repo, "add", "-A");
  git(repo, "commit", "-q", "-m", message);
  return git(repo, "rev-parse", "HEAD");
}

function analyzed(repo: string): void {
  opAnalyze(repo, { source: repo }, deps);
}

const SELECTION: TargetRecord["selection"] = {
  base_commit: "0".repeat(40),
  mode: "first_parent",
  blocks: [],
  reason: "text_changed",
  rank: 1,
  uncertainty: [],
  text_changed: true,
  change_kind: "text_not_classified"
};

function recordFor(repo: string, rel: string, symbol: string, commit: string, packageRoot = ""): TargetRecord {
  return {
    version: TARGET_RECORD_VERSION,
    identity: { ...describeIn(repo, rel, symbol), merged_commit: commit, package_root: packageRoot, file: rel, symbol_id: `sym:${rel}#${symbol}` },
    selection: SELECTION
  };
}

const TWO_PACKAGES: Record<string, string> = {
  ".gitignore": ".orangepro/\n.orangeproignore\n",
  "packages/first/package.json": JSON.stringify({ name: "first", version: "1.0.0", main: "lib/index.js" }),
  "packages/first/lib/index.js": "exports.shelf = require('./shelf');\n",
  "packages/first/lib/shelf.js": ["var shelf = module.exports = {};", "", "shelf.count = function (items) {", "  return items.length + 1;", "};", ""].join("\n"),
  "packages/second/package.json": JSON.stringify({ name: "second", version: "1.0.0", main: "lib/index.js" }),
  "packages/second/lib/index.js": "exports.shelf = require('./shelf');\n",
  "packages/second/lib/shelf.js": ["var shelf = module.exports = {};", "", "shelf.count = function (items) {", "  return items.length + 1;", "};", ""].join("\n"),
  "notes.txt": "first note\n"
};
const FIRST = "packages/first/lib/shelf.js";
const SECOND = "packages/second/lib/shelf.js";

const SHELF_BEFORE = ["var shelf = module.exports = {};", "", "shelf.count = function (items) {", "  return items.length;", "};", ""].join("\n");

// Two commits: `base` holds the earlier body of both shelves, `commit` (HEAD, analysed) the current one,
// so `shelf.count` in each package is a real target of the change base → commit.
function recordWorkspace(): { repo: string; base: string; commit: string } {
  const repo = makeRepo({ ...TWO_PACKAGES, [FIRST]: SHELF_BEFORE, [SECOND]: SHELF_BEFORE }, "bound-record");
  git(repo, "init", "-q");
  const base = commitAll(repo, "before");
  writeFileSync(path.join(repo, FIRST), TWO_PACKAGES[FIRST]!);
  writeFileSync(path.join(repo, SECOND), TWO_PACKAGES[SECOND]!);
  const commit = commitAll(repo, "first");
  opInit(repo, deps);
  analyzed(repo);
  return { repo, base, commit };
}

/** The record `opChangedTargets` writes for one function of the change `base` → HEAD: what a proof run must be handed. */
function realRecord(W: string, base: string, symbolId: string): TargetRecord {
  const changed = opChangedTargets(W, { base, merged: git(W, "rev-parse", "HEAD"), range: true, limit: 50 });
  if (changed.status !== "ok") throw new Error(`fixture error: changed-targets refused (${changed.refused})`);
  const record = changed.targets.find((t) => t.identity.symbol_id === symbolId);
  if (!record) throw new Error(`fixture error: ${symbolId} is not a target of ${base}..HEAD`);
  return record;
}

function proveWithRecord(repo: string, rel: string, record: TargetRecord): string[][] {
  const { calls, runner } = recordingRunner();
  opDynamicProof(
    repo,
    { target_symbol: `sym:${rel}#shelf.count`, source: repo, test_path: "notes.txt", replacement: KILL, target_record: record },
    { ...deps, dynamicProofRunner: runner }
  );
  return calls;
}

describe("opDynamicProof — a target record is a claim", { timeout: 120_000 }, () => {
  it("accepts a record that matches the file, HEAD and the graph, and binds the mutation to it", () => {
    const { repo, base, commit } = recordWorkspace();
    expect(loadGraph(workspacePaths(repo).graphPath).manifest.git?.commit).toBe(commit);
    const record = realRecord(repo, base, `sym:${FIRST}#shelf.count`);
    expect(record.identity).toMatchObject({ merged_commit: commit, package_root: "packages/first", file: FIRST });
    const calls = proveWithRecord(repo, FIRST, record);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(expect.arrayContaining(["--bound-file-sha256", record.identity.file_sha256, "--bound-target", "shelf.count"]));
    // The selection half is rebuilt as well: a rank, a block list or a reason the record did not earn is refused.
    for (const selection of [
      { ...record.selection, rank: (record.selection.rank ?? 0) + 1 },
      { ...record.selection, blocks: [] },
      { ...record.selection, reason: "new_function" as const }
    ]) {
      expect(refusalOf(() => proveWithRecord(repo, FIRST, { ...record, selection })).code).toBe("stale_record");
    }
    // The same record through preview and through the wrapper.
    const preview = opDynamicProof(repo, { target_symbol: `sym:${FIRST}#shelf.count`, source: repo, replacement: KILL, preview: true, target_record: record }, deps);
    expect(preview.changed_bytes).toEqual(record.identity.body!.bytes);
    const { calls: loopCalls, runner } = recordingRunner();
    opProveLoop(repo, { target_symbol: `sym:${FIRST}#shelf.count`, source: repo, test_path: "notes.txt", replacement: KILL, target_record: record }, { ...deps, dynamicProofRunner: runner, suppressBehaviorReportRefresh: true });
    expect(loopCalls).toHaveLength(1);
  });

  it("refuses a record that differs in any identity field, without starting the runner", () => {
    const { repo, commit } = recordWorkspace();
    const good = recordFor(repo, FIRST, "shelf.count", commit, "packages/first");
    const body = good.identity.body!;
    const tampered: Array<[string, TargetRecord]> = [
      ["a span moved by one byte", { ...good, identity: { ...good.identity, body: { ...body, bytes: { start: body.bytes.start + 1, end: body.bytes.end } } } }],
      ["another function hash", { ...good, identity: { ...good.identity, function_sha256: "0".repeat(64) } }],
      ["another file hash", { ...good, identity: { ...good.identity, file_sha256: "0".repeat(64) } }],
      ["another target name", { ...good, identity: { ...good.identity, targets: ["other.count"] } }],
      ["another package root", { ...good, identity: { ...good.identity, package_root: "" } }],
      ["another route", { ...good, identity: { ...good.identity, mutation_route: "name_search" } }],
      ["a field nobody can rebuild", { ...good, identity: { ...good.identity, extra_claim: true } as TargetRecord["identity"] }],
      ["another record version", { ...good, version: "orangepro.target_record.v0" as TargetRecord["version"] }],
      // The same name in a second package whose file is byte-identical: the bytes agree, the place does not.
      ["the twin file in another package", recordFor(repo, SECOND, "shelf.count", commit, "packages/second")]
    ];
    expect(readFileSync(path.join(repo, FIRST)).equals(readFileSync(path.join(repo, SECOND)))).toBe(true);
    const before = snapshot(repo);
    for (const [label, record] of tampered) {
      const { calls, runner } = recordingRunner();
      const refusal = refusalOf(() =>
        opDynamicProof(repo, { target_symbol: `sym:${FIRST}#shelf.count`, source: repo, test_path: "notes.txt", replacement: KILL, target_record: record }, { ...deps, dynamicProofRunner: runner })
      );
      expect(refusal.code, label).toBe("stale_record");
      expect(calls, label).toEqual([]);
    }
    expect(snapshot(repo)).toEqual(before);
    expect(loadLedger(repo).records).toEqual([]);
  });

  it("refuses a record made at another commit: changed file, unchanged file, and a graph built elsewhere", () => {
    const { repo, base } = recordWorkspace();
    const firstRecord = realRecord(repo, base, `sym:${FIRST}#shelf.count`);
    const untouchedRecord = realRecord(repo, base, `sym:${SECOND}#shelf.count`);

    // (c) HEAD moves, the graph does not: a record claiming the new HEAD is refused on the graph's commit.
    writeFileSync(path.join(repo, "notes.txt"), "second note\n");
    const second = commitAll(repo, "second");
    const claimsSecond: TargetRecord = { ...untouchedRecord, identity: { ...untouchedRecord.identity, merged_commit: second } };
    expect(refusalOf(() => proveWithRecord(repo, SECOND, claimsSecond)).message).toContain("the graph was built at");
    // …and the record made at the graph's commit is refused on HEAD.
    expect(refusalOf(() => proveWithRecord(repo, SECOND, untouchedRecord)).message).toContain("HEAD of the source checkout is");

    // (b) The graph is rebuilt at the new commit. The file is byte-identical at both commits; the old record is still
    // refused, and so is the old record with only its commit rewritten (its selection was made for another change).
    analyzed(repo);
    expect(refusalOf(() => proveWithRecord(repo, SECOND, untouchedRecord)).code).toBe("stale_record");
    expect(proveWithRecord(repo, SECOND, realRecord(repo, base, `sym:${SECOND}#shelf.count`))).toHaveLength(1);

    // (a) The target itself changes in a third commit: the first commit's record is refused there too.
    writeFileSync(path.join(repo, FIRST), ["var shelf = module.exports = {};", "", "shelf.count = function (items) {", "  return items.length + 2;", "};", ""].join("\n"));
    const third = commitAll(repo, "third");
    analyzed(repo);
    expect(refusalOf(() => proveWithRecord(repo, FIRST, firstRecord)).code).toBe("stale_record");
    expect(refusalOf(() => proveWithRecord(repo, FIRST, { ...firstRecord, identity: { ...firstRecord.identity, merged_commit: third } })).message).toContain("differs from the file, git or the graph in");
    expect(proveWithRecord(repo, FIRST, realRecord(repo, base, `sym:${FIRST}#shelf.count`))).toHaveLength(1);
  });

  it("refuses a record when the graph has no hash for the file, and keeps skipping that check without a record", () => {
    const { repo, commit } = recordWorkspace();
    const record = recordFor(repo, FIRST, "shelf.count", commit, "packages/first");
    const graphPath = workspacePaths(repo).graphPath;
    const graph = loadGraph(graphPath);
    delete graph.manifest.files[FIRST];
    saveGraph(graphPath, graph);

    const refused = recordingRunner();
    const refusal = refusalOf(() =>
      opDynamicProof(repo, { target_symbol: `sym:${FIRST}#shelf.count`, source: repo, test_path: "notes.txt", replacement: KILL, target_record: record }, { ...deps, dynamicProofRunner: refused.runner })
    );
    expect(refusal.code).toBe("missing_manifest_hash");
    expect(refused.calls).toEqual([]);

    const plain = recordingRunner();
    opDynamicProof(repo, { target_symbol: `sym:${FIRST}#shelf.count`, source: repo, test_path: "notes.txt", replacement: KILL }, { ...deps, dynamicProofRunner: plain.runner });
    expect(plain.calls).toHaveLength(1);
  });

  it("with a scan root below the repository root, the record's file is git's path and a same-named file above is another file", () => {
    const repo = makeRepo({ ...TWO_PACKAGES, [FIRST]: SHELF_BEFORE, "lib/shelf.js": SHELF_BEFORE, "lib/index.js": "exports.shelf = require('./shelf');\n" }, "bound-subroot");
    git(repo, "init", "-q");
    const base = commitAll(repo, "before");
    writeFileSync(path.join(repo, FIRST), TWO_PACKAGES[FIRST]!);
    writeFileSync(path.join(repo, "lib/shelf.js"), TWO_PACKAGES[FIRST]!);
    commitAll(repo, "first");
    const W = path.join(repo, "packages/first");
    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);
    const real = realRecord(W, base, "sym:lib/shelf.js#shelf.count");
    expect(real.identity).toMatchObject({ file: FIRST, package_root: "packages/first" });
    const prove = (record: TargetRecord): string[][] => {
      const { calls, runner } = recordingRunner();
      opDynamicProof(W, { target_symbol: "sym:lib/shelf.js#shelf.count", source: W, test_path: "lib/index.js", replacement: KILL, target_record: record }, { ...deps, dynamicProofRunner: runner });
      return calls;
    };
    expect(prove(real)).toHaveLength(1);
    // The file of the same name above the scan root has the same bytes and is still not this file.
    expect(readFileSync(path.join(repo, "lib/shelf.js")).equals(readFileSync(path.join(W, "lib/shelf.js")))).toBe(true);
    expect(refusalOf(() => prove({ ...real, identity: { ...real.identity, file: "lib/shelf.js", package_root: "" } })).code).toBe("stale_record");
  });

  it("checks the helper half of a record: the helper's bytes, and a link path made of calls the graph has", () => {
    // `shelf.inner` is documented private, so it is not counted: a change inside it is followed to its
    // counted caller `shelf.count`, and the record for that caller carries the helper it was reached through.
    const libWith = (factor: number): string =>
      [
        "var shelf = module.exports = {};",
        "",
        "/**",
        " * @private",
        " */",
        "shelf.inner = function (n) {",
        `  return n * ${factor};`,
        "};",
        "",
        "shelf.count = function (items) {",
        "  return this.inner(items.length) + 2;",
        "};",
        ""
      ].join("\n");
    const repo = makeRepo({ ".gitignore": ".orangepro/\n.orangeproignore\n", "lib/index.js": "exports.shelf = require('./shelf');\n", "lib/shelf.js": libWith(2) }, "bound-helper");
    git(repo, "init", "-q");
    const before = commitAll(repo, "before");
    writeFileSync(path.join(repo, "lib/shelf.js"), libWith(3));
    commitAll(repo, "first");
    opInit(repo, deps);
    analyzed(repo);
    const helperId = "sym:lib/shelf.js#shelf.inner";
    const targetId = "sym:lib/shelf.js#shelf.count";
    const helper = describeIn(repo, "lib/shelf.js", "shelf.inner");
    const base = realRecord(repo, before, targetId);
    const via = { symbol_id: helperId, function: helper.function, function_sha256: helper.function_sha256, path: [helperId, targetId] };
    expect(base.identity.via_helper).toEqual(via);
    expect(base.selection).toMatchObject({ reason: "affected_through", text_changed: false, uncertainty: ["via_helper"] });
    const withVia = (viaHelper: unknown): TargetRecord => ({ ...base, identity: { ...base.identity, via_helper: viaHelper as TargetRecord["identity"]["via_helper"] } });
    const prove = (record: TargetRecord): string[][] => {
      const { calls, runner } = recordingRunner();
      opDynamicProof(repo, { target_symbol: targetId, source: repo, test_path: "lib/index.js", replacement: KILL, target_record: record }, { ...deps, dynamicProofRunner: runner });
      return calls;
    };
    expect(prove(withVia(via))).toHaveLength(1);
    for (const wrong of [
      { ...via, function_sha256: "0".repeat(64) },
      { ...via, function: { ...helper.function, bytes: { start: helper.function.bytes.start + 1, end: helper.function.bytes.end } } },
      { ...via, path: [targetId, helperId] },
      { ...via, path: [helperId, "sym:lib/shelf.js#shelf.nowhere", targetId] },
      { ...via, symbol_id: "sym:lib/shelf.js#shelf.nowhere", path: ["sym:lib/shelf.js#shelf.nowhere", targetId] },
      { ...via, path: [helperId] }
    ]) {
      expect(refusalOf(() => prove(withVia(wrong))).message).toContain("differs from the file, git or the graph in: via_helper");
    }
  });

  it("the loop refuses a stale record before its setup commands run, and runs them for an honest one", () => {
    const { repo, base } = recordWorkspace();
    const record = realRecord(repo, base, `sym:${FIRST}#shelf.count`);
    const stale: TargetRecord = { ...record, identity: { ...record.identity, merged_commit: base } };
    const marker = path.join(repo, "setup-ran.txt");
    const setup = [{ command: process.execPath, args: ["-e", `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "ran")`] }];
    const { calls, runner } = recordingRunner();
    const loop = (targetRecord: TargetRecord): ProveLoopResult =>
      opProveLoop(
        repo,
        { target_symbol: `sym:${FIRST}#shelf.count`, source: repo, test_path: "notes.txt", replacement: KILL, target_record: targetRecord, setup_commands: setup },
        { ...deps, dynamicProofRunner: runner, suppressBehaviorReportRefresh: true }
      );
    expect(refusalOf(() => loop(stale)).code).toBe("stale_record");
    expect(existsSync(marker)).toBe(false);
    expect(calls).toEqual([]);
    expect(loadLedger(repo).records).toEqual([]);

    expect(loop(record)).toMatchObject({ record: { closed: true } });
    expect(existsSync(marker)).toBe(true);
    expect(calls).toHaveLength(1);
  });

  it("accepts a record exactly as `opChangedTargets` writes it, also after a JSON round trip", () => {
    const repo = makeRepo(TWO_PACKAGES, "bound-changed");
    git(repo, "init", "-q");
    const base = commitAll(repo, "first");
    writeFileSync(path.join(repo, FIRST), ["var shelf = module.exports = {};", "", "shelf.count = function (items) {", "  return items.length + 2;", "};", ""].join("\n"));
    const merged = commitAll(repo, "second");
    opInit(repo, deps);
    analyzed(repo);
    const changed = opChangedTargets(repo, { base, merged });
    if (changed.status !== "ok") throw new Error(`fixture error: changed-targets refused (${changed.refused})`);
    expect(changed.targets.map((t) => t.identity.symbol_id)).toEqual([`sym:${FIRST}#shelf.count`]);
    const record = JSON.parse(JSON.stringify(changed.targets[0])) as TargetRecord;
    expect(record.identity).toMatchObject({ file: FIRST, package_root: "packages/first", merged_commit: merged, mutation_route: "bound" });
    const preview = opDynamicProof(repo, { target_symbol: record.identity.symbol_id, source: repo, replacement: KILL, preview: true, target_record: record }, deps);
    expect(preview.changed_bytes).toEqual(record.identity.body!.bytes);
    expect(preview.file_sha256).toBe(record.identity.file_sha256);
  });
});

// ── The `prove` command ─────────────────────────────────────────────────────────────

describe("opro prove — --preview, --target-record and a named refusal in JSON", { timeout: 120_000 }, () => {
  const tsxLoader = require.resolve("tsx");
  const cli = (cwd: string, args: string[]): { status: number | null; stdout: string; stderr: string } => {
    const run = spawnSync(process.execPath, ["--import", tsxLoader, path.join(repoRoot, "src/local/cli.ts"), ...args], {
      cwd,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" }
    });
    return { status: run.status, stdout: run.stdout, stderr: run.stderr };
  };

  it("prints the diff for a bound target named only by its record, and reports a refusal with its code", () => {
    const { repo, base } = recordWorkspace();
    const before = snapshot(repo);
    const recordPath = path.join(mkdtempSync(path.join(tmpdir(), "opro-bound-rec-")), "record.json");
    tempDirs.push(path.dirname(recordPath));
    const real = realRecord(repo, base, `sym:${FIRST}#shelf.count`);
    writeFileSync(recordPath, JSON.stringify(real));

    // --source names the checkout by the path the graph was built with: the child's own cwd is the
    // real path, and on macOS the temp folder is reached through a link.
    const shown = cli(repo, ["prove", "--source", repo, "--target-record", recordPath, "--replacement", KILL, "--preview"]);
    expect(shown.stderr).toBe("");
    expect(shown.status).toBe(0);
    expect(shown.stdout.startsWith(`--- a/${FIRST}\n+++ b/${FIRST}\n@@ `)).toBe(true);
    expect(shown.stdout).toContain(`+  ${KILL}`);

    writeFileSync(recordPath, JSON.stringify({ ...real, identity: { ...real.identity, merged_commit: "1".repeat(40) } }));
    const stale = cli(repo, ["prove", "--source", repo, "--target-record", recordPath, "--replacement", KILL, "--preview", "--json"]);
    expect(stale.status).toBe(1);
    expect(JSON.parse(stale.stdout)).toMatchObject({ refusal: "stale_record", error: expect.stringContaining("prove refused (stale_record)") });
    expect(snapshot(repo)).toEqual(before);
    expect(loadLedger(repo).records).toEqual([]);
  });

  it("prove-loop checks --target-record, rejects --preview, names a refusal in JSON and refuses before setup", () => {
    const repo = makeRepo(
      {
        ".gitignore": ".orangepro/\n.orangeproignore\n",
        "lib/index.js": "exports.shelf = require('./shelf');\nexports.tools = require('./tools');\n",
        "lib/shelf.js": SHELF_BEFORE,
        "lib/tools.js": "module.exports = {\n  get: function (key) { return 'value:' + key; }\n};\n",
        "test/shelf.test.js": "const assert = require('node:assert/strict');\nconst shelf = require('../lib/shelf');\ndescribe('shelf', () => { it('counts', () => { assert.equal(shelf.count([1, 2]), 3); }); });\n"
      },
      "bound-loop-cli"
    );
    git(repo, "init", "-q");
    const base = commitAll(repo, "before");
    writeFileSync(path.join(repo, "lib/shelf.js"), TWO_PACKAGES[FIRST]!);
    commitAll(repo, "first");
    opInit(repo, deps);
    analyzed(repo);
    const real = realRecord(repo, base, "sym:lib/shelf.js#shelf.count");
    const records = mkdtempSync(path.join(tmpdir(), "opro-bound-rec-"));
    tempDirs.push(records);
    const good = path.join(records, "record.json");
    const stale = path.join(records, "stale.json");
    writeFileSync(good, JSON.stringify(real));
    writeFileSync(stale, JSON.stringify({ ...real, identity: { ...real.identity, merged_commit: base } }));
    const before = snapshot(repo);
    const loop = (...args: string[]) => cli(repo, ["prove-loop", "--source", repo, "--test", "test/shelf.test.js", "--replacement", KILL, "--runner", "mocha", ...args, "--json"]);

    // A stale record is refused as `opro prove` refuses it; before this the flag was dropped and the proof credited.
    const refusedStale = loop("--target-record", stale);
    expect(refusedStale.status).toBe(1);
    expect(JSON.parse(refusedStale.stdout)).toMatchObject({ refusal: "stale_record", error: expect.stringContaining("prove refused (stale_record)") });

    // A preview belongs to `opro prove`: the loop says so instead of running the test.
    const preview = loop("--target-symbol", "sym:lib/shelf.js#shelf.count", "--preview");
    expect(preview.status).toBe(1);
    const previewError = JSON.parse(preview.stdout) as { error: string; refusal?: string };
    expect(previewError.error).toContain("opro prove --preview");
    expect(previewError).not.toHaveProperty("refusal");

    // A refusal known before setup comes before it: the setup command never runs.
    const unsupported = loop("--target-symbol", "sym:lib/tools.js#get", "--setup", "touch setup-ran.txt");
    expect(unsupported.status).toBe(1);
    expect(JSON.parse(unsupported.stdout)).toMatchObject({ refusal: "unsupported_shape", error: expect.stringContaining("prove refused (unsupported_shape)") });
    expect(existsSync(path.join(repo, "setup-ran.txt"))).toBe(false);

    expect(loadLedger(repo).records).toEqual([]);
    expect(snapshot(repo)).toEqual(before);

    // The honest record, naming the symbol on its own, is checked and then proved by its exact position.
    const proved = loop("--target-record", good);
    expect(proved.stderr).toBe("");
    expect(proved.status).toBe(0);
    expect(JSON.parse(proved.stdout)).toMatchObject({
      record: { target_symbol: "sym:lib/shelf.js#shelf.count", closed: true },
      oracle: { status: "proven", mutation_route: "bound" }
    });
    expect(loadLedger(repo).records).toHaveLength(1);
    expect(snapshot(repo)).toEqual(before);
  });
});

// ── Auto-prove lanes ────────────────────────────────────────────────────────────────

describe("auto-prove — the two new reasons and the refused shapes", { timeout: 120_000 }, () => {
  function hardLinked(W: string, symbolId: string, testRel: string, mutate?: (node: GraphNode) => void): void {
    const graphPath = workspacePaths(W).graphPath;
    const graph = loadGraph(graphPath);
    const node = graph.nodes.find((n) => n.external_id === symbolId);
    if (!node) throw new Error(`fixture error: ${symbolId} is not in the graph`);
    if (!graph.nodes.some((n) => n.external_id === `test:${testRel}` && n.kind === "TestCase")) throw new Error(`fixture error: test:${testRel} is not a TestCase`);
    mutate?.(node);
    graph.edges.push(...makeProofEdges({ testRel, symId: symbolId, provenance: node.provenance, lastVerified: 1 }));
    saveGraph(graphPath, graph);
  }

  it("the existing-tests lane refuses a hard-linked function recorded as trivial_body or documented_private", () => {
    const W = makeWorkspace();
    const linked = (reason?: string): boolean => {
      hardLinked(W, "sym:lib/crate.js#Crate.weigh", "test/basket.test.js", (node) => {
        if (reason) node.properties.denominator_reason_code = reason;
        else delete node.properties.denominator_reason_code;
      });
      const graph = loadGraph(workspacePaths(W).graphPath);
      return existingAssociatedTests(graph, new Map(graph.nodes.map((n) => [n.external_id, n]))).has("sym:lib/crate.js#Crate.weigh");
    };
    expect(linked()).toBe(true);
    // Unchanged: a hard link still admits a function that is merely below the entry-point bar.
    expect(linked("not_entry_point_adjacent")).toBe(true);
    expect(linked("infra_behavior_surface")).toBe(false);
    expect(linked("trivial_body")).toBe(false);
    expect(linked("documented_private")).toBe(false);
  });

  it("skips a refused shape by name before the prove loop is called, and still attempts its neighbours", async () => {
    const W = makeWorkspace();
    hardLinked(W, "sym:lib/tools.js#get", "test/basket.test.js");
    hardLinked(W, "sym:lib/basket.js#basket.total", "test/basket.test.js");
    const asked: string[] = [];
    const proveLoop = (_root: string, opts: ProveLoopOptions): ProveLoopResult => {
      asked.push(opts.target_symbol ?? "");
      return { status: "unrunnable", reason: "not run in this test" };
    };
    const result = await autoProve(W, { existingOnly: true }, { ...deps, proveLoop });
    expect(asked).toEqual(["sym:lib/basket.js#basket.total"]);
    expect(result.attempted).toBe(1);
    const skip = result.skipped.find((s) => s.target_symbol === "sym:lib/tools.js#get");
    expect(skip).toMatchObject({ category: "mutation_unsupported", language: "typescript" });
    expect(skip?.reason.startsWith("unsupported_shape: ")).toBe(true);
  });

  it("skips a quoted-key method and a new function the search would miss, and still attempts the method the search finds", async () => {
    const W = makeWorkspace({
      "lib/index.js": "exports.tools = require('./tools');\n",
      "lib/tools.js": [
        "'use strict';",
        "function d() { return 'k'; }",
        "function rename(key) {",
        "  return 'renamed:' + key;",
        "}",
        "module.exports = {",
        "  \"name\"(key) { return 'name:' + key; },",
        "  me(key = d()) { return 'me:' + key; },",
        "  relabel(key) { return rename(key); }",
        "};",
        ""
      ].join("\n"),
      "test/tools.test.js": "const assert = require('node:assert/strict');\nconst tools = require('../lib/tools');\ndescribe('tools', () => { it('relabels', () => { assert.equal(tools.relabel('a'), 'renamed:a'); }); });\n"
    });
    // `name(` is found only as the tail of `rename(key) {`, and so is `me(`.
    for (const name of ["name", "me", "relabel"]) hardLinked(W, `sym:lib/tools.js#${name}`, "test/tools.test.js");
    const asked: string[] = [];
    const proveLoop = (_root: string, opts: ProveLoopOptions): ProveLoopResult => {
      asked.push(opts.target_symbol ?? "");
      return { status: "unrunnable", reason: "not run in this test" };
    };
    const result = await autoProve(W, { existingOnly: true }, { ...deps, proveLoop });
    expect(asked).toEqual(["sym:lib/tools.js#relabel"]);
    for (const name of ["name", "me"]) {
      const skip = result.skipped.find((s) => s.target_symbol === `sym:lib/tools.js#${name}`);
      expect(skip, name).toMatchObject({ category: "mutation_unsupported", language: "typescript" });
      expect(skip?.reason.startsWith("unsupported_shape: "), name).toBe(true);
    }
  });
});
