import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  gitBytes,
  opChangedTargets,
  renderChangedTargets,
  verifyTargetRecord,
  type ChangedTargetsOk,
  type ChangedTargetsRefused,
  type ChangedTargetsResult
} from "../../src/local/changedTargets.js";
import { parseArgs } from "../../src/local/cliArgs.js";
import { describeTarget, sha256Hex } from "../../src/local/contracts/targetRecord.js";
import { opAnalyze, opInit } from "../../src/local/operations.js";

// Every case builds a real git repository with invented code, commits a base and
// a merged tree, analyses the merged commit and maps the change.

const NO_USER_CONFIG = "/definitely/not/here.json";
const DEPS = { clock: () => "2026-06-07T00:00:00Z", env: { ORANGEPRO_USER_CONFIG: NO_USER_CONFIG } as NodeJS.ProcessEnv };

const dirs: string[] = [];
beforeAll(() => {
  vi.stubEnv("ORANGEPRO_USER_CONFIG", NO_USER_CONFIG);
});
afterAll(() => {
  vi.unstubAllEnvs();
});
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function git(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "-c", "commit.gpgsign=false", ...args], {
    cwd,
    stdio: ["ignore", "pipe", "ignore"]
  })
    .toString()
    .trim();
}

type Tree = Record<string, string | null>;

function write(root: string, tree: Tree): void {
  for (const [rel, content] of Object.entries(tree)) {
    const abs = join(root, rel);
    if (content === null) {
      rmSync(abs);
      continue;
    }
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

/** Commits exactly the given paths (plus anything already staged), never the kit's own workspace files. */
function commit(root: string, tree: Tree, message: string): string {
  write(root, tree);
  git(root, "add", "-A", "--", ...Object.keys(tree));
  git(root, "commit", "-q", "-m", message);
  return git(root, "rev-parse", "HEAD");
}

function emptyRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "opro-changed-targets-"));
  dirs.push(root);
  git(root, "init", "-q");
  // Keep bytes as written, whatever the machine's own git settings say.
  git(root, "config", "core.autocrlf", "false");
  return root;
}

/** A repository whose HEAD is `merged` and whose first parent is `base`. */
function repo(baseTree: Tree, mergedTree: Tree): { root: string; base: string; merged: string } {
  const root = emptyRepo();
  const base = commit(root, baseTree, "base");
  const merged = commit(root, mergedTree, "merged");
  return { root, base, merged };
}

/** Analyse inside the checkout, as `opro analyze .` does: `.orangepro/` and `.orangeproignore` appear, untracked. */
function analyze(root: string, scanRoot: string = root): void {
  opInit(root, DEPS);
  opAnalyze(root, { source: scanRoot }, DEPS);
}

function ok(result: ChangedTargetsResult): ChangedTargetsOk {
  if (result.status !== "ok") throw new Error(`refused: ${result.refused} — ${result.message} ${(result.paths ?? []).join(", ")}`);
  return result;
}

function refused(result: ChangedTargetsResult): ChangedTargetsRefused {
  if (result.status !== "refused") throw new Error("expected a refusal, got a result");
  return result;
}

function changed(repoAt: { root: string; base: string; merged: string }, opts: { range?: boolean; limit?: number } = {}): ChangedTargetsOk {
  return ok(opChangedTargets(repoAt.root, { base: repoAt.base, merged: repoAt.merged, ...opts }));
}

/** 1-based line of the first line containing `needle`. */
function lineOf(text: string, needle: string): number {
  const at = text.indexOf(needle);
  if (at < 0) throw new Error(`fixture does not contain: ${needle}`);
  return text.slice(0, at).split("\n").length;
}

function swap(text: string, from: string, to: string): string {
  if (!text.includes(from)) throw new Error(`fixture does not contain: ${from}`);
  return text.replace(from, to);
}

// ---- A CommonJS library: an entry file hands out an object whose methods are assigned one by one ----

const PACKAGE_JSON = JSON.stringify({ name: "parcel-desk", version: "1.0.0", main: "index.js" }, null, 2) + "\n";

const ENTRY_JS = `'use strict';

exports = module.exports = {};

exports.label = require('./lib/label');
`;

// A non-ASCII comment and one CRLF line sit before the functions, so byte offsets
// and UTF-16 offsets differ and a carriage return before a line feed is harmless.
const LABEL_JS = `'use strict';

var os = require('os');

// Étiquettes — printed on every parcel.
var EOL = os.EOL;\r
var label = Object.create(null);

module.exports = label;

/**
 * Build the printed line for one parcel.
 */
label.compose = function (name, weight) {
  var line = name + ' ' + weight;
  if (weight > 30) {
    line += ' HEAVY';
  }
  return this.pad(line) + EOL;
};

/**
 * Pad a line to the printer's width.
 * @private
 */
label.pad = function (text) {
  var out = String(text);
  while (out.length < 8) out += '.';
  return out;
};

/**
 * @private
 */
label.stamp = function (text) {
  return '[' + text + ']';
};

label.summary = function (items) {
  var total = 0;
  for (var i = 0; i < items.length; i++) total += items[i].weight;
  return total > 100 ? 'pallet' : 'box';
};

function clamp(n) {
  return n < 0 ? 0 : n;
}
`;

const DESK_BASE: Tree = { "package.json": PACKAGE_JSON, "index.js": ENTRY_JS, "lib/label.js": LABEL_JS };
const COMPOSE = "sym:lib/label.js#label.compose";
const PAD = "sym:lib/label.js#label.pad";
const STAMP = "sym:lib/label.js#label.stamp";
const SUMMARY = "sym:lib/label.js#label.summary";

// ---- An ES-module library: counted entry functions that call helpers in other files ----

const COURIER_PACKAGE = JSON.stringify({ name: "courier-kit", version: "1.0.0", type: "module", main: "index.js" }, null, 2) + "\n";

const COURIER_INDEX = `import { padCode } from "./lib/text.js";
import * as text from "./lib/text.js";
import { lanePlan } from "./lib/plan.js";

export function formatParcel(parcel) {
  if (parcel.weight > 30) {
    return padCode(parcel.code) + " HEAVY";
  }
  return padCode(parcel.code);
}

export function planDelivery(parcel) {
  return lanePlan(parcel.zone) + ":" + parcel.code;
}

export function shortCode(parcel) {
  return parcel.code.length > 4 ? text.trimCode(parcel.code) : parcel.code;
}

export function priceOf(parcel) {
  return parcel.weight > 10 ? 12 : 5;
}

export function etaOf(parcel) {
  return parcel.zone === "far" ? 5 : 2;
}

export function zoneOf(parcel) {
  const far = parcel.distance > 100;
  const name = far ? "far" : "near";
  return name + ":" + parcel.code;
}
`;

const COURIER_TEXT = `export function padCode(code) {
  let out = String(code);
  while (out.length < 6) out = "0" + out;
  return out;
}

export function trimCode(code) {
  return String(code).replace(/^0+/, "");
}
`;

const COURIER_PLAN = `import { hubName } from "./hub.js";

export function lanePlan(zone) {
  return hubName(zone) + "/lane-" + (zone === "far" ? 2 : 1);
}
`;

const COURIER_HUB = `export function hubName(zone) {
  return zone === "far" ? "north" : "south";
}
`;

const COURIER_BASE: Tree = {
  "package.json": COURIER_PACKAGE,
  "index.js": COURIER_INDEX,
  "lib/text.js": COURIER_TEXT,
  "lib/plan.js": COURIER_PLAN,
  "lib/hub.js": COURIER_HUB
};

describe("opro changed-targets", { timeout: 120_000 }, () => {
  it("maps a changed line inside a member to one record that matches the file byte for byte", () => {
    const mergedText = swap(LABEL_JS, "' HEAVY'", "' VERY HEAVY'");
    const at = repo(DESK_BASE, { "lib/label.js": mergedText });
    analyze(at.root);
    const result = changed(at);

    expect(result).toMatchObject({ base: at.base, merged: at.merged, mode: "first_parent", complete: true, limit: 3 });
    expect(result.files).toEqual([{ path: "lib/label.js", change: "M", status: "blocks", blocks: 1 }]);
    const line = lineOf(mergedText, "VERY HEAVY");
    const block = { file: "lib/label.js", new_start: line, new_count: 1, old_start: line, old_count: 1 };
    expect(result.blocks).toEqual([{ ...block, status: "mapped", symbols: [COMPOSE] }]);
    expect(result.listed).toEqual([]);
    expect(result.targets).toHaveLength(1);

    const [record] = result.targets;
    const bytes = readFileSync(join(at.root, "lib/label.js"));
    const described = describeTarget(bytes, "label.compose");
    if (!described.ok) throw new Error(described.refused);
    expect(record.identity).toEqual({
      merged_commit: at.merged,
      package_root: "",
      file: "lib/label.js",
      symbol_id: COMPOSE,
      ...described.target
    });
    expect(record.identity).toMatchObject({ owner: "label", property: "compose", mutation_route: "bound", file_sha256: sha256Hex(bytes) });
    // Half-open raw-byte offsets: the slice is the function, and the non-ASCII comment moved it.
    const { start, end } = record.identity.function.bytes;
    const fnText = bytes.subarray(start, end).toString("utf8");
    expect(fnText.startsWith("function (name, weight) {")).toBe(true);
    expect(fnText.endsWith("}")).toBe(true);
    expect(sha256Hex(bytes.subarray(start, end))).toBe(record.identity.function_sha256);
    expect(start).toBeGreaterThan(mergedText.indexOf("function (name, weight)"));
    expect(record.identity.function.lines).toEqual({ start: lineOf(mergedText, "label.compose ="), end: lineOf(mergedText, "return this.pad(line)") + 1 });

    expect(record.selection).toEqual({
      base_commit: at.base,
      mode: "first_parent",
      blocks: [block],
      reason: "text_changed",
      rank: record.selection.rank,
      uncertainty: [],
      text_changed: true,
      change_kind: "text_not_classified"
    });
    expect(record.selection.rank).toBeGreaterThanOrEqual(1);
  });

  it("does not let a removed module-level statement hide behind a function changed in the same hunk", () => {
    const before = ["var steps = [];", "", "function ready() { return steps.length > 0; }", "", "steps.push('init');", "exports.total = function (rows) {", "  return rows.length;", "};", ""].join("\n");
    // One hunk: the module-level statement goes, and the function's first line changes.
    const after = ["var steps = [];", "", "function ready() { return steps.length > 0; }", "", "exports.total = function (rows, extra) {", "  return rows.length;", "};", ""].join("\n");
    const at = repo({ "package.json": JSON.stringify({ name: "x", main: "index.js" }), "index.js": before }, { "index.js": after });
    analyze(at.root);
    const result = changed(at);
    expect(result.blocks.map((block) => [block.status, block.unknown, block.symbols])).toEqual([["unknown", "module_level", ["sym:index.js#total"]]]);
    expect(result.complete).toBe(false);
    expect(result.targets.map((target) => target.identity.symbol_id)).toEqual(["sym:index.js#total"]);
  });

  it("reports a module-level change as unknown and marks the run incomplete", () => {
    const mergedText = swap(LABEL_JS, "var os = require('os');", "var os = require('node:os');");
    const at = repo(DESK_BASE, { "lib/label.js": mergedText });
    analyze(at.root);
    const result = changed(at);

    expect(result.complete).toBe(false);
    expect(result.blocks).toEqual([{ file: "lib/label.js", new_start: 3, new_count: 1, old_start: 3, old_count: 1, status: "unknown", unknown: "module_level" }]);
    expect(result.targets).toEqual([]);
    expect(result.listed).toEqual([]);
  });

  it("ignores the blank line that separates a new function: the block is mapped, nothing is unknown", () => {
    const merged = `${COURIER_INDEX}\nexport function sizeOf(parcel) {\n  return parcel.width > 9 ? "wide" : "slim";\n}\n`;
    const at = repo(COURIER_BASE, { "index.js": merged });
    analyze(at.root);
    const result = changed(at);

    const blank = lineOf(merged, "export function sizeOf") - 1;
    expect(result.blocks).toEqual([
      { file: "index.js", new_start: blank, new_count: 4, old_start: blank - 1, old_count: 0, status: "mapped", symbols: ["sym:index.js#sizeOf"] }
    ]);
    expect(result.complete).toBe(true);
    expect(result.targets.map((record) => [record.identity.symbol_id, record.selection.reason, record.selection.uncertainty])).toEqual([
      ["sym:index.js#sizeOf", "new_function", []]
    ]);
    expect(result.listed).toEqual([]);
  });

  it("lists a block made only of blank and comment lines as non_code: not unknown, and no function is mapped", () => {
    const base = [
      ["    line += ' HEAVY';", "    // heavy parcels are flagged\n    line += ' HEAVY';"],
      ["  return out;\n};", "  return out;\n  // the printer cuts longer lines\n};"],
      ["module.exports = label;\n", "module.exports = label;\n\n"]
    ].reduce((text, [from, to]) => swap(text, from, to), LABEL_JS);
    const merged = [
      // A JSDoc block above a function, a comment inside a body, a comment before a closing brace,
      // and one of two blank lines between statements.
      ["Build the printed line for one parcel.", "Build the printed line for one parcel label."],
      ["heavy parcels are flagged", "heavy parcels get a flag"],
      ["the printer cuts longer lines", "the printer cuts longer lines off"],
      ["module.exports = label;\n\n\n", "module.exports = label;\n\n"]
    ].reduce((text, [from, to]) => swap(text, from, to), base);
    const at = repo({ ...DESK_BASE, "lib/label.js": base }, { "lib/label.js": merged });
    analyze(at.root);
    const result = changed(at);

    expect(result.files).toEqual([{ path: "lib/label.js", change: "M", status: "blocks", blocks: 4 }]);
    expect(result.blocks.map((block) => [block.status, block.symbols, block.unknown])).toEqual(new Array(4).fill(["non_code", undefined, undefined]));
    expect(result.blocks.filter((block) => block.new_count === 0 && block.old_count === 1)).toHaveLength(1);
    expect(result.complete).toBe(true);
    expect(result.targets).toEqual([]);
    expect(result.listed).toEqual([]);
    expect(renderChangedTargets(result).filter((line) => line.endsWith("  non_code"))).toHaveLength(4);
  });

  it("still reads removed code, and text that only looks like a comment, as code", () => {
    const base = `const unit = "kg";

export function banner(parcel) {
  const text = \`Parcel \${parcel.code}
// printed as it is, not a comment
\`;
  return parcel.weight > 30 ? text + "HEAVY" : text;
}

export function footer(parcel) {
  const text = \`-- \${parcel.zone}
end\`;
  return text.length > 12 ? text : text + "!";
}

export function priceOf(parcel) {
  const fee = parcel.weight > 10 ? 12 : 5;
  record(fee);
  return fee;
}

function record(fee) {
  return fee + unit;
}
`;
    const merged = [
      // Inside a template literal: a line that starts with `//`, and an empty line, are part of the string.
      ["// printed as it is, not a comment", "// printed twice, still not a comment"],
      ["-- ${parcel.zone}\nend`", "-- ${parcel.zone}\n\nend`"],
      // A statement turned into a comment, inside a function and at module level.
      ["  record(fee);\n", "  // record(fee);\n"],
      ['const unit = "kg";\n', '// const unit = "kg";\n']
    ].reduce((text, [from, to]) => swap(text, from, to), base);
    const at = repo({ "package.json": COURIER_PACKAGE, "index.js": base }, { "index.js": merged });
    analyze(at.root);
    const result = changed(at);

    expect(result.blocks.map((block) => [block.new_start, block.status, block.unknown, block.symbols])).toEqual([
      [1, "unknown", "module_level", undefined],
      [lineOf(merged, "// printed twice"), "mapped", undefined, ["sym:index.js#banner"]],
      [lineOf(merged, "end`") - 1, "mapped", undefined, ["sym:index.js#footer"]],
      [lineOf(merged, "// record(fee);"), "mapped", undefined, ["sym:index.js#priceOf"]]
    ]);
    expect(result.complete).toBe(false);
    expect(result.targets.map((record) => [record.identity.symbol_id, record.selection.reason]).sort()).toEqual([
      ["sym:index.js#banner", "text_changed"],
      ["sym:index.js#footer", "text_changed"],
      ["sym:index.js#priceOf", "text_changed"]
    ]);
  });

  it("maps a change inside the implementation of an overloaded function to that function", () => {
    const base = `export function parseSize(value: string): number;
export function parseSize(value: number): number;
export function parseSize(value: string | number): number {
  const size = typeof value === "string" ? value.length : value;
  return size > 10 ? 10 : size;
}
`;
    const at = repo(
      { "package.json": JSON.stringify({ name: "size-kit", version: "1.0.0", main: "index.ts" }, null, 2) + "\n", "index.ts": base },
      { "index.ts": swap(base, "size > 10 ? 10 : size", "size > 12 ? 12 : size") }
    );
    analyze(at.root);
    const result = changed(at);

    expect(result.blocks).toEqual([
      { file: "index.ts", new_start: 5, new_count: 1, old_start: 5, old_count: 1, status: "mapped", symbols: ["sym:index.ts#parseSize"] }
    ]);
    expect(result.complete).toBe(true);
    expect(result.targets).toHaveLength(1);
    // The record binds the declaration that has the body, not the first signature.
    expect(result.targets[0].identity).toMatchObject({ symbol_id: "sym:index.ts#parseSize", name: "parseSize", fn_kind: "declaration" });
    expect(result.targets[0].identity.function.lines).toEqual({ start: 3, end: 6 });
    expect(result.targets[0].selection).toMatchObject({ reason: "text_changed", text_changed: true });
  });

  it("names a function that is not a symbol, and a shape the kit does not map, instead of guessing", () => {
    const base = `${LABEL_JS}
function attach(target, name, fn) {
  target[name] = fn;
}

attach(label, 'weigh', function (parcel) {
  return parcel.weight * 2;
});
`;
    const merged = swap(swap(base, "return n < 0 ? 0 : n;", "return n < 1 ? 1 : n;"), "parcel.weight * 2", "parcel.weight * 3");
    const at = repo({ ...DESK_BASE, "lib/label.js": base }, { "lib/label.js": merged });
    analyze(at.root);
    const result = changed(at);

    expect(result.complete).toBe(false);
    expect(result.blocks.map((block) => [block.new_start, block.status, block.unknown])).toEqual([
      [lineOf(merged, "n < 1 ? 1 : n"), "unknown", "unrecognised_function"],
      [lineOf(merged, "parcel.weight * 3"), "unknown", "unsupported_shape"]
    ]);
    expect(result.targets).toEqual([]);
  });

  it("does not select a function that only moved: identical text is listed as overlap_text_unchanged", () => {
    const priceOf = `export function priceOf(parcel) {\n  return parcel.weight > 10 ? 12 : 5;\n}\n`;
    const zoneOf = `export function zoneOf(parcel) {\n  const far = parcel.distance > 100;\n  const name = far ? "far" : "near";\n  return name + ":" + parcel.code;\n}\n`;
    const at = repo(
      { "package.json": COURIER_PACKAGE, "index.js": `${priceOf}\n${zoneOf}` },
      { "index.js": `${zoneOf}\n${priceOf}` }
    );
    analyze(at.root);
    const result = changed(at);

    expect(result.targets).toEqual([]);
    expect(result.listed).toHaveLength(1);
    expect(result.listed[0]).toMatchObject({ symbol_id: "sym:index.js#priceOf", reason: "overlap_text_unchanged", text_changed: false });
    expect(result.listed[0].change).toBeUndefined();
    expect(result.listed[0].blocks).toHaveLength(1);
  });

  it("reports a deleted function as symbol_removed", () => {
    const merged = COURIER_INDEX.replace(/export function etaOf[\s\S]*?\n}\n\n/, "");
    expect(merged).not.toContain("etaOf");
    const at = repo(COURIER_BASE, { "index.js": merged });
    analyze(at.root);
    const result = changed(at);

    expect(result.complete).toBe(false);
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]).toMatchObject({ status: "unknown", unknown: "symbol_removed", removed: ["etaOf"], new_count: 0, old_count: 4 });
    expect(result.blocks[0].symbols).toBeUndefined();
    expect(result.targets).toEqual([]);
    expect(result.listed).toEqual([]);
  });

  it("maps lines removed inside a function to it, and lines removed between functions to none", () => {
    const base = swap(COURIER_INDEX, `  const far = parcel.distance > 100;\n`, `  const far = parcel.distance > 100;\n  const unused = 1;\n`);
    const at = repo({ ...COURIER_BASE, "index.js": base }, { "index.js": COURIER_INDEX });
    analyze(at.root);
    const result = changed(at);

    expect(result.complete).toBe(true);
    expect(result.blocks).toEqual([
      { file: "index.js", new_start: lineOf(COURIER_INDEX, "const far ="), new_count: 0, old_start: lineOf(base, "const unused"), old_count: 1, status: "mapped", symbols: ["sym:index.js#zoneOf"] }
    ]);
    expect(result.targets.map((record) => [record.identity.symbol_id, record.selection.reason])).toEqual([["sym:index.js#zoneOf", "text_changed"]]);
  });

  it("gives every changed file a row, also when it has no lines to read", () => {
    const base: Tree = {
      ...DESK_BASE,
      "bin/pack.js": "#!/usr/bin/env node\n'use strict';\nconsole.log('pack');\n",
      "lib/old-name.js": "'use strict';\n\nexports.weigh = function (parcel) {\n  return parcel.weight * 2;\n};\n",
      "lib/gone.js": "'use strict';\n\nexports.drop = function (parcel) {\n  return parcel.weight > 0;\n};\n",
      "styles/desk.css": ".desk { color: black; }\n",
      "examples/demo.js": "'use strict';\n\nexports.demo = function () {\n  return 1;\n};\n",
      "README.md": "# Parcel desk\n\nPrints labels.\n",
      "test/label.test.js": "'use strict';\n\nit('pads', function () {\n  return 1;\n});\n"
    };
    const root = emptyRepo();
    const baseCommit = commit(root, base, "base");
    chmodSync(join(root, "bin/pack.js"), 0o755);
    git(root, "add", "bin/pack.js");
    git(root, "mv", "lib/old-name.js", "lib/new-name.js");
    const merged = commit(
      root,
      {
        "lib/gone.js": null,
        "styles/desk.css": ".desk { color: navy; }\n",
        "examples/demo.js": "'use strict';\n\nexports.demo = function () {\n  return 2;\n};\n",
        "README.md": "# Parcel desk\n\nPrints parcel labels.\n",
        "package.json": swap(PACKAGE_JSON, "1.0.0", "1.0.1"),
        "test/label.test.js": "'use strict';\n\nit('pads', function () {\n  return 2;\n});\n"
      },
      "merged"
    );
    analyze(root);
    const result = changed({ root, base: baseCommit, merged });

    expect(result.complete).toBe(false);
    expect(result.files).toEqual([
      { path: "README.md", change: "M", status: "blocks", blocks: 1 },
      { path: "bin/pack.js", change: "M", status: "unknown", unknown: "mode_only", blocks: 0 },
      { path: "examples/demo.js", change: "M", status: "unknown", unknown: "file_not_scanned", blocks: 0 },
      { path: "lib/gone.js", change: "D", status: "unknown", unknown: "file_deleted", blocks: 0 },
      { path: "lib/new-name.js", old_path: "lib/old-name.js", change: "R", status: "unknown", unknown: "no_text_diff", blocks: 0 },
      { path: "package.json", change: "M", status: "blocks", blocks: 1 },
      { path: "styles/desk.css", change: "M", status: "unknown", unknown: "other_language", blocks: 0 },
      { path: "test/label.test.js", change: "M", status: "blocks", blocks: 1 }
    ]);
    expect(result.blocks.map((block) => [block.file, block.status])).toEqual([
      ["README.md", "doc_file"],
      ["package.json", "config_file"],
      ["test/label.test.js", "test_file"]
    ]);
    expect(result.targets).toEqual([]);
    expect(result.listed).toEqual([]);
  });

  it("matches paths in git's terms when the scan root is a sub-directory with a same-named file above it", () => {
    const pkg = (name: string): string => JSON.stringify({ name, version: "1.0.0", type: "module", main: "index.js" }, null, 2) + "\n";
    const outer = `export function priceOf(parcel) {\n  return parcel.weight > 10 ? 12 : 5;\n}\n`;
    const inner = `export function priceOf(parcel) {\n  return parcel.weight > 20 ? 30 : 9;\n}\n`;
    const at = repo(
      { "package.json": pkg("outer"), "index.js": outer, "packages/inner/package.json": pkg("inner"), "packages/inner/index.js": inner },
      { "index.js": swap(outer, "12 : 5", "13 : 5"), "packages/inner/index.js": swap(inner, "30 : 9", "31 : 9") }
    );
    // The workspace is the repository root; only the sub-directory is analysed.
    analyze(at.root, join(at.root, "packages/inner"));
    const result = changed(at);

    expect(result.files).toEqual([
      { path: "index.js", change: "M", status: "unknown", unknown: "outside_scan_root", blocks: 0 },
      { path: "packages/inner/index.js", change: "M", status: "blocks", blocks: 1 }
    ]);
    expect(result.blocks).toEqual([
      { file: "packages/inner/index.js", new_start: 2, new_count: 1, old_start: 2, old_count: 1, status: "mapped", symbols: ["sym:index.js#priceOf"] }
    ]);
    expect(result.targets).toHaveLength(1);
    const innerBytes = readFileSync(join(at.root, "packages/inner/index.js"));
    expect(result.targets[0].identity).toMatchObject({
      file: "packages/inner/index.js",
      package_root: "packages/inner",
      symbol_id: "sym:index.js#priceOf",
      file_sha256: sha256Hex(innerBytes)
    });
    expect(result.targets[0].identity.file_sha256).not.toBe(sha256Hex(readFileSync(join(at.root, "index.js"))));
  });

  it("accepts the kit's own workspace files in the checkout and refuses any other untracked or modified file", () => {
    const at = repo(DESK_BASE, { "lib/label.js": swap(LABEL_JS, "' HEAVY'", "' VERY HEAVY'") });
    analyze(at.root);
    // Analysing inside the checkout leaves the workspace files untracked: plain `git status` is not empty.
    expect(existsSync(join(at.root, ".orangepro", "graph.json"))).toBe(true);
    expect(existsSync(join(at.root, ".orangeproignore"))).toBe(true);
    expect(git(at.root, "status", "--porcelain")).not.toBe("");
    expect(changed(at).targets).toHaveLength(1);

    writeFileSync(join(at.root, "lib/extra.js"), "'use strict';\n\nexports.extra = function () {\n  return 1;\n};\n");
    const untracked = refused(opChangedTargets(at.root, { base: at.base, merged: at.merged }));
    expect(untracked).toMatchObject({ refused: "dirty_tree", paths: ["lib/extra.js"] });

    rmSync(join(at.root, "lib/extra.js"));
    expect(changed(at).targets).toHaveLength(1);
    writeFileSync(join(at.root, "index.js"), `${ENTRY_JS}\n// edited\n`);
    expect(refused(opChangedTargets(at.root, { base: at.base, merged: at.merged }))).toMatchObject({ refused: "dirty_tree", paths: ["index.js"] });
  });

  it("refuses unless both ids are commits, base is the first parent, and HEAD and the graph are the merged commit", () => {
    const root = emptyRepo();
    const first = commit(root, DESK_BASE, "first");
    const second = commit(root, { "lib/label.js": swap(LABEL_JS, "' HEAVY'", "' VERY HEAVY'") }, "second");
    const code = (opts: { base?: string; merged?: string; range?: boolean }): string => refused(opChangedTargets(root, opts)).refused;

    expect(code({ base: first, merged: second })).toBe("graph_missing");
    analyze(root);
    expect(code({ base: first })).toBe("missing_argument");
    expect(code({ base: "main", merged: second })).toBe("base_not_a_commit");
    expect(code({ base: "0".repeat(40), merged: second })).toBe("base_not_a_commit");
    expect(code({ base: first, merged: "HEAD" })).toBe("merged_not_a_commit");
    expect(code({ base: second, merged: first, range: true })).toBe("base_not_ancestor");
    // A unique abbreviation is the same commit; the result carries the full ids.
    expect(ok(opChangedTargets(root, { base: first.slice(0, 10), merged: second.slice(0, 10) }))).toMatchObject({ base: first, merged: second });

    const third = commit(root, { "lib/label.js": swap(LABEL_JS, "' HEAVY'", "' EXTRA HEAVY'") }, "third");
    // The graph was built at `second`.
    expect(code({ base: second, merged: third })).toBe("graph_commit_mismatch");
    expect(code({ base: first, merged: second })).toBe("head_mismatch");
    analyze(root);
    expect(code({ base: first, merged: third })).toBe("not_first_parent");
    const ranged = ok(opChangedTargets(root, { base: first, merged: third, range: true }));
    expect(ranged.mode).toBe("range");
    expect(ranged.targets.map((record) => [record.identity.symbol_id, record.selection.mode])).toEqual([[COMPOSE, "range"]]);
  });

  it("refuses when the graph was built from other bytes than the commit holds", () => {
    const mergedText = swap(LABEL_JS, "' HEAVY'", "' VERY HEAVY'");
    const at = repo(DESK_BASE, { "lib/label.js": mergedText });
    // Analysed while the file carried an uncommitted edit, which was then undone.
    writeFileSync(join(at.root, "lib/label.js"), swap(mergedText, "'pallet'", "'crate'"));
    analyze(at.root);
    writeFileSync(join(at.root, "lib/label.js"), mergedText);

    expect(refused(opChangedTargets(at.root, { base: at.base, merged: at.merged }))).toMatchObject({ refused: "file_hash_mismatch", paths: ["lib/label.js"] });
    analyze(at.root);
    expect(changed(at).targets).toHaveLength(1);
  });

  it("refuses a source that is not a git checkout", () => {
    const root = mkdtempSync(join(tmpdir(), "opro-changed-targets-plain-"));
    dirs.push(root);
    write(root, DESK_BASE);
    analyze(root);
    expect(refused(opChangedTargets(root, { base: "a".repeat(40), merged: "b".repeat(40) })).refused).toBe("not_a_git_repo");
  });

  it("refuses a file whose lines git and the parser would count differently", () => {
    // U+2028 is a line break to the TypeScript scanner and an ordinary character to git.
    const separator = String.fromCharCode(0x2028);
    const mergedText = swap(swap(LABEL_JS, "printed on every parcel.", `printed on every parcel.${separator} Twice.`), "' HEAVY'", "' VERY HEAVY'");
    const at = repo(DESK_BASE, { "lib/label.js": mergedText });
    analyze(at.root);
    expect(refused(opChangedTargets(at.root, { base: at.base, merged: at.merged }))).toMatchObject({ refused: "line_rule_mismatch", paths: ["lib/label.js"] });
  });

  it("follows a changed helper to the counted functions that call it, two steps at most", () => {
    const at = repo(COURIER_BASE, {
      "lib/hub.js": swap(COURIER_HUB, '"north"', '"north-hub"'),
      "lib/text.js": swap(swap(COURIER_TEXT, "out.length < 6", "out.length < 8"), "/^0+/", "/^0*/")
    });
    analyze(at.root);
    const result = changed(at);
    const hub = "sym:lib/hub.js#hubName";
    const pad = "sym:lib/text.js#padCode";
    const trim = "sym:lib/text.js#trimCode";

    // padCode is called by formatParcel; hubName is called by lanePlan (not counted), which planDelivery calls.
    expect(result.targets.map((record) => record.identity.symbol_id).sort()).toEqual(["sym:index.js#formatParcel", "sym:index.js#planDelivery"]);
    const plan = result.targets.find((record) => record.identity.symbol_id === "sym:index.js#planDelivery");
    const format = result.targets.find((record) => record.identity.symbol_id === "sym:index.js#formatParcel");
    if (!plan || !format) throw new Error("missing target");

    const hubBytes = readFileSync(join(at.root, "lib/hub.js"));
    const hubDescribed = describeTarget(hubBytes, "hubName");
    const planDescribed = describeTarget(readFileSync(join(at.root, "index.js")), "planDelivery");
    if (!hubDescribed.ok || !planDescribed.ok) throw new Error("fixture not describable");
    // The record binds the caller in its own, unchanged file, and names the helper it was reached through.
    expect(plan.identity).toEqual({
      merged_commit: at.merged,
      package_root: "",
      file: "index.js",
      symbol_id: "sym:index.js#planDelivery",
      ...planDescribed.target,
      via_helper: {
        symbol_id: hub,
        function: hubDescribed.target.function,
        function_sha256: hubDescribed.target.function_sha256,
        path: [hub, "sym:lib/plan.js#lanePlan", "sym:index.js#planDelivery"]
      }
    });
    expect(plan.selection).toMatchObject({
      reason: "affected_through",
      text_changed: false,
      uncertainty: ["via_helper"],
      blocks: [{ file: "lib/hub.js", new_start: 2, new_count: 1, old_start: 2, old_count: 1 }]
    });
    expect(format.identity.via_helper).toMatchObject({ symbol_id: pad, path: [pad, "sym:index.js#formatParcel"] });
    expect(format.selection).toMatchObject({ reason: "affected_through", text_changed: false, uncertainty: ["via_helper"] });
    expect(verifyTargetRecord(at.root, plan)).toEqual({ ok: true });
    const otherPath = JSON.parse(JSON.stringify(plan)) as typeof plan;
    (otherPath.identity.via_helper as { path: string[] }).path = [hub, "sym:index.js#planDelivery"];
    expect(verifyTargetRecord(at.root, otherPath)).toMatchObject({ ok: false, refused: "record_mismatch" });

    // A helper with no hard caller: the kit found no link. The weak (candidate) callers are counted, never followed.
    const trimBlock = result.blocks.find((block) => block.symbols?.includes(trim));
    expect(trimBlock).toMatchObject({ status: "unknown", unknown: "no_caller_link", weak_callers: 1 });
    expect(result.blocks.filter((block) => block.status === "unknown")).toHaveLength(1);
    expect(result.complete).toBe(false);

    const listed = new Map(result.listed.map((fn) => [fn.symbol_id, fn]));
    expect([...listed.keys()]).toEqual([hub, pad, trim]);
    expect(listed.get(hub)).toMatchObject({ reason: "not_counted", rank: null, followed: true, callers: ["sym:index.js#planDelivery"], uncertainty: ["not_counted"] });
    expect(listed.get(pad)).toMatchObject({ reason: "not_counted", followed: true, callers: ["sym:index.js#formatParcel"] });
    expect(listed.get(trim)).toMatchObject({ reason: "not_counted", followed: true, callers: [] });
  });

  it("lists a caller that is also directly changed once, as directly changed", () => {
    const at = repo(DESK_BASE, {
      "lib/label.js": swap(swap(swap(LABEL_JS, "' HEAVY'", "' VERY HEAVY'"), "out.length < 8", "out.length < 10"), "'[' + text + ']'", "'<' + text + '>'")
    });
    analyze(at.root);
    const result = changed(at);

    expect(result.targets.map((record) => [record.identity.symbol_id, record.selection.reason, record.selection.text_changed])).toEqual([
      [COMPOSE, "text_changed", true]
    ]);
    expect(result.targets[0].identity.via_helper).toBeUndefined();
    // label.pad is documented private and called through `this` by label.compose; label.stamp has no caller.
    expect(result.listed.map((fn) => [fn.symbol_id, fn.reason, fn.callers])).toEqual([
      [PAD, "not_counted", [COMPOSE]],
      [STAMP, "not_counted", []]
    ]);
    expect(result.blocks.map((block) => [block.symbols, block.status, block.unknown])).toEqual([
      [[COMPOSE], "mapped", undefined],
      [[PAD], "mapped", undefined],
      [[STAMP], "unknown", "no_caller_link"]
    ]);
  });

  it("cuts at three by rank and lists the rest as beyond_cut", () => {
    const merged = [
      ['" HEAVY"', '" VERY HEAVY"'],
      ["? 12 : 5", "? 14 : 5"],
      ["? 5 : 2", "? 6 : 2"],
      ["> 100;", "> 120;"],
      ['":" + parcel.code;\n}\n\nexport function shortCode', '"/" + parcel.code;\n}\n\nexport function shortCode']
    ].reduce((text, [from, to]) => swap(text, from, to), COURIER_INDEX);
    const at = repo(COURIER_BASE, { "index.js": merged });
    analyze(at.root);
    const result = changed(at);

    expect(result.complete).toBe(true);
    expect(result.targets).toHaveLength(3);
    const ranks = result.targets.map((record) => record.selection.rank as number);
    expect(ranks).toEqual([...ranks].sort((a, b) => a - b));
    const beyond = result.listed.filter((fn) => fn.reason === "beyond_cut");
    expect(beyond).toHaveLength(2);
    expect(result.listed).toHaveLength(2);
    for (const fn of beyond) {
      expect(fn.rank as number).toBeGreaterThan(ranks[2]);
      expect(fn).toMatchObject({ text_changed: true, change: "text_changed" });
    }
    const all = [...result.targets.map((record) => record.identity.symbol_id), ...beyond.map((fn) => fn.symbol_id)].sort();
    expect(all).toEqual(["etaOf", "formatParcel", "planDelivery", "priceOf", "zoneOf"].map((name) => `sym:index.js#${name}`).sort());

    // The cut is the last step: a different limit moves the cut and nothing else.
    const one = changed(at, { limit: 1 });
    expect(one.targets).toEqual(result.targets.slice(0, 1));
    expect(one.listed.filter((fn) => fn.reason === "beyond_cut")).toHaveLength(4);
    const five = changed(at, { limit: 5 });
    expect(five.targets.slice(0, 3)).toEqual(result.targets);
    expect(five.listed).toEqual([]);
  });

  it("compares a renamed file with its old path, so only the edited function is changed", () => {
    const tags = `'use strict';\n\nexports.createTag = function (parcel) {\n  return parcel.code + '-' + parcel.zone;\n};\n\nexports.createSeal = function (parcel) {\n  return parcel.code.length > 4 ? 'long' : 'short';\n};\n`;
    const root = emptyRepo();
    const base = commit(root, { ...DESK_BASE, "lib/tags.js": tags }, "base");
    git(root, "mv", "lib/tags.js", "lib/markers.js");
    const merged = commit(root, { "lib/markers.js": swap(tags, "? 'long' : 'short'", "? 'wide' : 'short'") }, "merged");
    analyze(root);
    const result = changed({ root, base, merged });

    expect(result.files).toEqual([{ path: "lib/markers.js", old_path: "lib/tags.js", change: "R", status: "blocks", blocks: 1 }]);
    expect(result.blocks).toEqual([
      { file: "lib/markers.js", new_start: 8, new_count: 1, old_start: 8, old_count: 1, status: "mapped", symbols: ["sym:lib/markers.js#createSeal"] }
    ]);
    expect(result.targets.map((record) => [record.identity.symbol_id, record.selection.reason])).toEqual([["sym:lib/markers.js#createSeal", "text_changed"]]);
    expect(result.listed).toEqual([]);
    expect(result.complete).toBe(true);
  });

  it("lists a changed function the ranking leaves out with its one reason, and does not follow it", () => {
    const legacy = `'use strict';\n\nexports.createCrate = function (size) {\n  return size > 10 ? 'large' : 'small';\n};\n`;
    const stub = `'use strict';\n\nexports.createStub = function (size) {\n  return size > 1 ? 'two' : 'one';\n};\n`;
    const at = repo(
      { ...COURIER_BASE, "lib/legacy/crate.js": legacy, "lib/__mocks__/stub.js": stub },
      {
        "index.js": swap(COURIER_INDEX, "? 12 : 5", "? 14 : 5"),
        "lib/legacy/crate.js": swap(legacy, "'large'", "'huge'"),
        "lib/__mocks__/stub.js": swap(stub, "'two'", "'many'")
      }
    );
    opInit(at.root, DEPS);
    const configPath = join(at.root, ".orangepro", "config.json");
    writeFileSync(
      configPath,
      JSON.stringify({
        ...JSON.parse(readFileSync(configPath, "utf8")),
        classification: { rank_exclude_paths: ["lib/legacy/*"] },
        overrides: [{ symbol: "sym:index.js#priceOf", action: "suppress", reason: "priced by the carrier contract" }]
      })
    );
    analyze(at.root);
    const result = changed(at);

    expect(result.targets).toEqual([]);
    expect(result.complete).toBe(true);
    expect(result.blocks.map((block) => block.status)).toEqual(["mapped", "mapped", "mapped"]);
    expect(result.listed.map((fn) => [fn.symbol_id, fn.reason, fn.detail, fn.rank, fn.followed])).toEqual([
      ["sym:index.js#priceOf", "suppressed_by_config", undefined, null, undefined],
      ["sym:lib/__mocks__/stub.js#createStub", "not_counted", "test_code", null, undefined],
      ["sym:lib/legacy/crate.js#createCrate", "rank_excluded", undefined, null, undefined]
    ]);
  });

  it("flags a block that crosses a function boundary on each function it maps to", () => {
    const base = `export function priceOf(parcel) {\n  return parcel.weight > 10 ? 12 : 5;\n}\nexport function etaOf(parcel) {\n  return parcel.zone === "far" ? 5 : 2;\n}\n`;
    const merged = `export function priceOf(parcel) {\n  return parcel.weight > 10 ? 14 : 5;\n} // price\nexport function etaOf(order) {\n  return order.zone === "far" ? 5 : 2;\n}\n`;
    const at = repo({ "package.json": COURIER_PACKAGE, "index.js": base }, { "index.js": merged });
    analyze(at.root);
    const result = changed(at);

    expect(result.blocks).toEqual([
      { file: "index.js", new_start: 2, new_count: 4, old_start: 2, old_count: 4, status: "mapped", symbols: ["sym:index.js#etaOf", "sym:index.js#priceOf"], spans_boundary: true }
    ]);
    expect(result.targets.map((record) => record.identity.symbol_id).sort()).toEqual(["sym:index.js#etaOf", "sym:index.js#priceOf"]);
    for (const record of result.targets) expect(record.selection.uncertainty).toEqual(["hunk_spans_boundary"]);
  });

  it("notes when a member's owner is handed to a call at module level", () => {
    const base = `${LABEL_JS}\nfunction seal(target) {\n  return Object.freeze(target);\n}\n\nseal(label);\n`;
    const at = repo({ ...DESK_BASE, "lib/label.js": base }, { "lib/label.js": swap(base, "' HEAVY'", "' VERY HEAVY'") });
    analyze(at.root);
    const result = changed(at);
    expect(result.targets.map((record) => [record.identity.symbol_id, record.selection.uncertainty])).toEqual([[COMPOSE, ["owner_passed_to_call"]]]);
  });

  it("treats a new function as changed, and a whole new file as new functions", () => {
    const added = `'use strict';\n\nvar crate = Object.create(null);\n\nmodule.exports = crate;\n\ncrate.fits = function (item, size) {\n  return item.size <= size;\n};\n`;
    const at = repo(DESK_BASE, { "lib/crate.js": added, "index.js": `${ENTRY_JS}exports.crate = require('./lib/crate');\n` });
    analyze(at.root);
    const result = changed(at);

    expect(result.files).toEqual([
      { path: "index.js", change: "M", status: "blocks", blocks: 1 },
      { path: "lib/crate.js", change: "A", status: "blocks", blocks: 1 }
    ]);
    expect(result.targets.map((record) => [record.identity.symbol_id, record.selection.reason, record.selection.text_changed])).toEqual([
      ["sym:lib/crate.js#crate.fits", "new_function", true]
    ]);
    // The new file's other lines, and the entry file's new line, are module level.
    expect(result.complete).toBe(false);
    expect(result.blocks.map((block) => [block.file, block.status, block.unknown, block.spans_boundary])).toEqual([
      ["index.js", "unknown", "module_level", undefined],
      ["lib/crate.js", "unknown", "module_level", true]
    ]);
  });

  it("gives byte-identical output on a second run, with no absolute path or clock time in it", () => {
    const at = repo(COURIER_BASE, {
      "index.js": swap(COURIER_INDEX, "? 12 : 5", "? 14 : 5"),
      "lib/hub.js": swap(COURIER_HUB, '"north"', '"north-hub"'),
      "lib/text.js": swap(COURIER_TEXT, "/^0+/", "/^0*/")
    });
    analyze(at.root);
    const first = JSON.stringify(changed(at), null, 2);
    const second = JSON.stringify(changed(at), null, 2);
    expect(second).toBe(first);
    expect(first).not.toContain(at.root);
    expect(first).not.toContain(tmpdir());
    expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}T\d{2}:/);
    expect(renderChangedTargets(changed(at))).toEqual(renderChangedTargets(JSON.parse(first) as ChangedTargetsOk));
  });

  it("only reads: every git call is one of a few read-only commands, with the pinned diff options", () => {
    const at = repo(DESK_BASE, { "lib/label.js": swap(LABEL_JS, "' HEAVY'", "' VERY HEAVY'") });
    analyze(at.root);
    const before = git(at.root, "status", "--porcelain", "--untracked-files=all");
    const calls: string[][] = [];
    const result = ok(
      opChangedTargets(at.root, { base: at.base, merged: at.merged }, {
        git: (cwd, args) => {
          calls.push(args);
          return gitBytes(cwd, args);
        }
      })
    );
    expect(result.targets).toHaveLength(1);
    expect(git(at.root, "status", "--porcelain", "--untracked-files=all")).toBe(before);

    const globals = ["--no-pager", "--no-optional-locks", "-c", "core.quotePath=false"];
    const commands = new Set<string>();
    for (const args of calls) {
      expect(args.slice(0, globals.length)).toEqual(globals);
      const rest = args.slice(globals.length).filter((arg) => arg !== "--literal-pathspecs");
      commands.add(rest[0]);
    }
    expect([...commands].sort()).toEqual(["cat-file", "diff", "ls-tree", "rev-parse", "status"]);
    // Every file the graph was analysed from is compared with the commit through one listing of its tree.
    expect(calls.filter((args) => args.includes("ls-tree"))).toEqual([[...globals, "ls-tree", "-r", "-z", "--full-tree", at.merged]]);
    const blockDiff = calls.find((args) => args.includes("-U0"));
    expect(blockDiff).toEqual([
      ...globals,
      "--literal-pathspecs",
      "diff",
      "-U0",
      "--inter-hunk-context=0",
      "--diff-algorithm=myers",
      "--no-indent-heuristic",
      "--no-ext-diff",
      "--no-textconv",
      "-M50%",
      "--no-color",
      at.base,
      at.merged,
      "--",
      "lib/label.js"
    ]);
    expect(calls.find((args) => args.includes("--raw"))).toEqual([...globals, "diff", "--raw", "-z", "--no-abbrev", "-M50%", at.base, at.merged]);
  });

  it("checks a record handed back: any difference, another commit or another graph is refused", () => {
    const root = emptyRepo();
    const base = commit(root, DESK_BASE, "base");
    const merged = commit(root, { "lib/label.js": swap(LABEL_JS, "' HEAVY'", "' VERY HEAVY'") }, "merged");
    analyze(root);
    const [record] = changed({ root, base, merged }).targets;
    expect(verifyTargetRecord(root, record)).toEqual({ ok: true });
    // Key order and a round trip through JSON do not matter; content does.
    expect(verifyTargetRecord(root, JSON.parse(JSON.stringify(record)))).toEqual({ ok: true });

    const moved = JSON.parse(JSON.stringify(record)) as typeof record;
    moved.identity.function.bytes.start += 1;
    expect(verifyTargetRecord(root, moved)).toMatchObject({ ok: false, refused: "record_mismatch" });
    const reranked = JSON.parse(JSON.stringify(record)) as typeof record;
    reranked.selection.rank = (record.selection.rank as number) + 1;
    expect(verifyTargetRecord(root, reranked)).toMatchObject({ ok: false, refused: "record_mismatch" });
    const renamed = JSON.parse(JSON.stringify(record)) as typeof record;
    renamed.identity.symbol_id = SUMMARY;
    expect(verifyTargetRecord(root, renamed)).toMatchObject({ ok: false, refused: "record_not_found" });
    expect(verifyTargetRecord(root, { ...record, version: "other" } as unknown as typeof record)).toMatchObject({ ok: false, refused: "record_version" });

    // Other work in the checkout refuses the check unless the caller says it belongs there;
    // a file the record depends on is compared with the commit either way.
    writeFileSync(join(root, "lib/label.extra.test.js"), "'use strict';\n");
    expect(verifyTargetRecord(root, record)).toMatchObject({ ok: false, refused: "dirty_tree" });
    expect(verifyTargetRecord(root, record, { cleanTree: false })).toEqual({ ok: true });
    const committed = readFileSync(join(root, "lib/label.js"));
    writeFileSync(join(root, "lib/label.js"), `${committed.toString("utf8")}\n// edited\n`);
    expect(verifyTargetRecord(root, record, { cleanTree: false })).toMatchObject({ ok: false, refused: "file_hash_mismatch" });
    writeFileSync(join(root, "lib/label.js"), committed);
    rmSync(join(root, "lib/label.extra.test.js"));
    expect(verifyTargetRecord(root, record)).toEqual({ ok: true });

    // The next commit leaves lib/label.js byte-identical; the record is still refused, because the commit differs.
    const later = commit(root, { "README.md": "# Parcel desk\n" }, "later");
    expect(verifyTargetRecord(root, record)).toMatchObject({ ok: false, refused: "head_mismatch" });
    analyze(root);
    expect(verifyTargetRecord(root, record)).toMatchObject({ ok: false, refused: "head_mismatch" });
    // Back on the record's commit, with the graph rebuilt at another one.
    git(root, "checkout", "-q", merged);
    expect(verifyTargetRecord(root, record)).toMatchObject({ ok: false, refused: "graph_commit_mismatch" });
    analyze(root);
    expect(verifyTargetRecord(root, record)).toEqual({ ok: true });
    expect(later).not.toBe(merged);
  });

  it("reports code a comment delimiter switches off or on, although the block's own lines are only comment text", () => {
    const run = (baseText: string, mergedText: string, extra: Tree = {}): ChangedTargetsOk => {
      const at = repo({ ...DESK_BASE, ...extra, "lib/label.js": baseText }, { "lib/label.js": mergedText });
      analyze(at.root);
      return changed(at);
    };
    const seen = (result: ChangedTargetsOk): unknown[] => result.blocks.map((block) => [block.status, block.unknown, block.differs, block.symbols]);
    const flagged = (names?: string[]): unknown[] => ["unknown", "comment_changes_code", names, undefined];

    // A whole exported function between a `/*` line and a `*/` line: git shows two one-line additions.
    const summaryOff = swap(swap(LABEL_JS, "label.summary = function", "/*\nlabel.summary = function"), "'pallet' : 'box';\n};\n", "'pallet' : 'box';\n};\n*/\n");
    const off = run(LABEL_JS, summaryOff);
    expect(off.blocks.map((block) => [block.new_count, block.old_count])).toEqual([[1, 0], [1, 0]]);
    expect(seen(off)).toEqual([flagged(["label.summary"]), flagged(["label.summary"])]);
    expect(off.complete).toBe(false);
    expect(off.targets).toEqual([]);
    expect(renderChangedTargets(off).filter((line) => line.endsWith("  unknown: comment_changes_code  (differs: label.summary)"))).toHaveLength(2);

    // The reverse: the two delimiter lines are removed and the function exists again.
    const on = run(summaryOff, LABEL_JS);
    expect(on.blocks.map((block) => [block.new_count, block.old_count])).toEqual([[0, 1], [0, 1]]);
    expect(seen(on)).toEqual([flagged(["label.summary"]), flagged(["label.summary"])]);
    expect(on.complete).toBe(false);

    // A statement inside a counted function: its code differs, and no block maps to it.
    const heavy = "  if (weight > 30) {\n    line += ' HEAVY';\n  }\n";
    const inside = run(LABEL_JS, swap(LABEL_JS, heavy, `  /*\n${heavy}  */\n`));
    expect(seen(inside)).toEqual([flagged(["label.compose"]), flagged(["label.compose"])]);
    expect(inside.complete).toBe(false);
    expect(inside.targets).toEqual([]);

    // A call at module level, inside no symbol at all.
    const withCall = swap(LABEL_JS, "module.exports = label;\n", "module.exports = label;\n\nos.hostname();\n");
    const outside = run(withCall, swap(withCall, "os.hostname();\n", "/*\nos.hostname();\n*/\n"));
    expect(seen(outside)).toEqual([flagged(), flagged()]);
    expect(outside.complete).toBe(false);

    // A tag that changes what a function is: label.stamp stops being documented private.
    const untagged = run(LABEL_JS, swap(LABEL_JS, "/**\n * @private\n */\nlabel.stamp", "/**\n * Frames a text.\n */\nlabel.stamp"));
    expect(seen(untagged)).toEqual([flagged(["label.stamp"])]);
    expect(untagged.complete).toBe(false);

    // Words in the same kind of comment, with the tag left alone, change none of this.
    const reworded = run(LABEL_JS, swap(LABEL_JS, "Pad a line to the printer's width.", "Pad a line to the full width of the printer."));
    expect(seen(reworded)).toEqual([["non_code", undefined, undefined, undefined]]);
    expect(reworded.complete).toBe(true);
  });

  it("says so when a change inside one function makes another symbol of the file disappear", () => {
    // A second write to a member, inside another member's body: the kit no longer names label.pad.
    const at = repo(DESK_BASE, { "lib/label.js": swap(LABEL_JS, "  var total = 0;\n", "  var total = 0;\n  label.pad = String;\n") });
    analyze(at.root);
    const result = changed(at);

    expect(result.blocks.map((block) => [block.status, block.unknown, block.differs, block.symbols])).toEqual([
      ["unknown", "unmapped_change", ["label.pad"], [SUMMARY]]
    ]);
    expect(result.complete).toBe(false);
    expect(result.targets.map((record) => [record.identity.symbol_id, record.selection.reason])).toEqual([[SUMMARY, "text_changed"]]);
  });

  it("refuses a graph analysed from a file the commit does not hold, whether or not the change touches it", () => {
    const at = repo(COURIER_BASE, { "lib/text.js": swap(COURIER_TEXT, "out.length < 6", "out.length < 8") });
    const run = (): ChangedTargetsResult => opChangedTargets(at.root, { base: at.base, merged: at.merged });
    const clean = (): string => git(at.root, "status", "--porcelain", "--untracked-files=all", "--", "lib");
    const planPath = join(at.root, "lib/plan.js");
    const edited = swap(COURIER_PLAN, "hubName(zone) +", "String(zone) +");

    // An unchanged file carried an edit while the graph was built; the edit was undone afterwards.
    writeFileSync(planPath, edited);
    analyze(at.root);
    writeFileSync(planPath, COURIER_PLAN);
    expect(clean()).toBe("");
    const stale = refused(run());
    expect(stale).toMatchObject({ refused: "graph_not_from_commit", paths: ["lib/plan.js"] });
    expect(stale.message).toContain("the graph was built from different bytes");
    analyze(at.root);
    expect(ok(run()).targets).toHaveLength(1);

    // The same edit, kept, and hidden from `git status`.
    writeFileSync(planPath, edited);
    git(at.root, "update-index", "--assume-unchanged", "lib/plan.js");
    analyze(at.root);
    expect(clean()).toBe("");
    const hidden = refused(run());
    expect(hidden).toMatchObject({ refused: "graph_not_from_commit", paths: ["lib/plan.js"] });
    expect(hidden.message).toContain("the working file differs from the commit");
    git(at.root, "update-index", "--no-assume-unchanged", "lib/plan.js");
    writeFileSync(planPath, COURIER_PLAN);

    // An untracked file git is told to ignore: the kit scans it all the same.
    appendFileSync(join(at.root, ".git/info/exclude"), "\nlib/scratch.js\n");
    writeFileSync(join(at.root, "lib/scratch.js"), `export function scratch(code) {\n  return code + "?";\n}\n`);
    analyze(at.root);
    expect(clean()).toBe("");
    const foreign = refused(run());
    expect(foreign).toMatchObject({ refused: "graph_not_from_commit", paths: ["lib/scratch.js"] });
    expect(foreign.message).toContain("the merged commit does not have the file");
    rmSync(join(at.root, "lib/scratch.js"));
    analyze(at.root);
    expect(ok(run()).targets).toHaveLength(1);
  });

  it("does not refuse over the files of a checked-out submodule: the commit holds them through its link", () => {
    const sub = emptyRepo();
    commit(sub, { "index.js": "'use strict';\n\nexports.unit = function () {\n  return 'kg';\n};\n" }, "unit");
    const root = emptyRepo();
    git(root, "-c", "protocol.file.allow=always", "submodule", "add", "-q", sub, "deps/unit");
    const base = commit(root, DESK_BASE, "base");
    const merged = commit(root, { "lib/label.js": swap(LABEL_JS, "' HEAVY'", "' VERY HEAVY'") }, "merged");
    analyze(root);

    // The kit scans the submodule's files; the merged tree lists the link only.
    const graph = JSON.parse(readFileSync(join(root, ".orangepro", "graph.json"), "utf8")) as { manifest: { files: Record<string, unknown> } };
    expect(Object.keys(graph.manifest.files)).toContain("deps/unit/index.js");
    expect(git(root, "ls-tree", "-r", "--name-only", merged).split("\n")).toContain("deps/unit");
    expect(changed({ root, base, merged }).targets.map((record) => record.identity.symbol_id)).toEqual([COMPOSE]);

    // An edit inside the submodule is other work in the checkout, as it was before.
    writeFileSync(join(root, "deps/unit/index.js"), "'use strict';\n");
    expect(refused(opChangedTargets(root, { base, merged }))).toMatchObject({ refused: "dirty_tree", paths: ["deps/unit"] });
  });

  it("lists a caller that is not a function, never selects it, and does not refuse the run", () => {
    // A const bound to a call result is counted and linked as a caller, but a record binds a function.
    const index = `import { padCode } from "./lib/text.js";
import { wrap } from "./lib/wrap.js";

const Badge = wrap(function (parcel) {
  return padCode(parcel.code) + "!";
});

export function formatParcel(parcel) {
  return padCode(parcel.code);
}

export default Badge;
`;
    const at = repo(
      { "package.json": COURIER_PACKAGE, "index.js": index, "lib/text.js": COURIER_TEXT, "lib/wrap.js": `export function wrap(render) {\n  return render;\n}\n` },
      { "lib/text.js": swap(COURIER_TEXT, "out.length < 6", "out.length < 8") }
    );
    analyze(at.root);
    const pad = "sym:lib/text.js#padCode";
    const badge = "sym:index.js#Badge";

    // Wherever the cut falls, the outcome for Badge is the same.
    for (const limit of [1, 3]) {
      const result = changed(at, { limit });
      expect(result.targets.map((record) => [record.identity.symbol_id, record.selection.reason])).toEqual([["sym:index.js#formatParcel", "affected_through"]]);
      expect(result.blocks.map((block) => [block.status, block.unknown, block.symbols])).toEqual([["unknown", "unsupported_shape", [pad]]]);
      expect(result.complete).toBe(false);
      const listed = result.listed.find((fn) => fn.symbol_id === badge);
      expect(listed).toMatchObject({ reason: "unsupported_shape", text_changed: false, change: "affected_through", affected_through: [pad], path: [pad, badge], steps: 1 });
      expect(listed?.rank).toBeGreaterThanOrEqual(1);
    }
  });

  it("gives a code file renamed to a test, a document or a place outside the scan root a row of its own", () => {
    const tags = `'use strict';\n\nexports.createTag = function (parcel) {\n  return parcel.code + '-' + parcel.zone;\n};\n\nexports.createSeal = function (parcel) {\n  return parcel.code.length > 4 ? 'long' : 'short';\n};\n\nexports.createMark = function (parcel) {\n  return parcel.zone === 'far' ? 'F' : 'N';\n};\n`;
    const moved = (to: string): ChangedTargetsOk => {
      const root = emptyRepo();
      const base = commit(root, { ...DESK_BASE, "lib/tags.js": tags }, "base");
      mkdirSync(dirname(join(root, to)), { recursive: true });
      git(root, "mv", "lib/tags.js", to);
      const merged = commit(root, { [to]: swap(tags, "? 'long' : 'short'", "? 'wide' : 'short'") }, "merged");
      analyze(root);
      return changed({ root, base, merged });
    };
    const lost = { path: "lib/tags.js", change: "R", status: "unknown", unknown: "file_deleted", blocks: 0 };

    const toTest = moved("test/tags.js");
    expect(toTest.files).toEqual([lost, { path: "test/tags.js", old_path: "lib/tags.js", change: "R", status: "blocks", blocks: 1 }]);
    expect(toTest.blocks.map((block) => block.status)).toEqual(["test_file"]);
    expect(toTest.complete).toBe(false);
    expect(renderChangedTargets(toTest)).toContain("  R  lib/tags.js  unknown: file_deleted");

    const toDoc = moved("docs/tags.md");
    expect(toDoc.files).toEqual([{ path: "docs/tags.md", old_path: "lib/tags.js", change: "R", status: "blocks", blocks: 1 }, lost]);
    expect(toDoc.blocks.map((block) => block.status)).toEqual(["doc_file"]);
    expect(toDoc.complete).toBe(false);

    // Out of the analysed sub-directory, into the rest of the repository.
    const pkg = JSON.stringify({ name: "inner", version: "1.0.0", main: "index.js" }, null, 2) + "\n";
    const root = emptyRepo();
    const base = commit(root, { "packages/inner/package.json": pkg, "packages/inner/index.js": ENTRY_JS, "packages/inner/lib/tags.js": tags }, "base");
    mkdirSync(join(root, "tools"), { recursive: true });
    git(root, "mv", "packages/inner/lib/tags.js", "tools/tags.js");
    const merged = commit(root, { "tools/tags.js": swap(tags, "? 'long' : 'short'", "? 'wide' : 'short'") }, "merged");
    analyze(root, join(root, "packages/inner"));
    expect(changed({ root, base, merged }).files).toEqual([
      { path: "packages/inner/lib/tags.js", change: "R", status: "unknown", unknown: "file_deleted", blocks: 0 },
      { path: "tools/tags.js", old_path: "packages/inner/lib/tags.js", change: "R", status: "unknown", unknown: "outside_scan_root", blocks: 0 }
    ]);
  });

  it("reports code beside a function on its first or last line as module level when it is not the base's", () => {
    const extra = `\nlabel.title = label.heading = function (text) {\n  return String(text).toUpperCase();\n};\n\nlabel.width = function (text) {\n  return String(text).length;\n}; label.limit = 5;\n`;
    const base = `${LABEL_JS}${extra}`;
    // A public name is withdrawn on the function's first line (the symbol keeps its own name,
    // label.heading); a second statement changes on another function's last line.
    const merged = swap(swap(base, "label.title = label.heading = function", "label.heading = function"), "label.limit = 5;", "label.limit = 6;");
    const at = repo({ ...DESK_BASE, "lib/label.js": base }, { "lib/label.js": merged });
    analyze(at.root);
    const result = changed(at);
    const heading = "sym:lib/label.js#label.heading";
    const width = "sym:lib/label.js#label.width";

    expect(result.blocks.map((block) => [block.new_start, block.status, block.unknown, block.symbols])).toEqual([
      [lineOf(merged, "label.heading = function"), "unknown", "module_level", [heading]],
      [lineOf(merged, "label.limit = 6;"), "unknown", "module_level", [width]]
    ]);
    expect(result.complete).toBe(false);
    // Neither function's own text changed: listed, never a target.
    expect(result.targets).toEqual([]);
    expect(result.listed.map((fn) => [fn.symbol_id, fn.reason])).toEqual([[heading, "overlap_text_unchanged"], [width, "overlap_text_unchanged"]]);

    // The same on a line where the function's own text changed too: it is a target, and the line is still module level.
    const both = swap(base, "label.title = label.heading = function (text) {", "label.heading = function (text, locale) {");
    const bothAt = repo({ ...DESK_BASE, "lib/label.js": base }, { "lib/label.js": both });
    analyze(bothAt.root);
    const changedToo = changed(bothAt);
    expect(changedToo.blocks.map((block) => [block.status, block.unknown, block.symbols])).toEqual([["unknown", "module_level", [heading]]]);
    expect(changedToo.targets.map((record) => [record.identity.symbol_id, record.selection.reason])).toEqual([[heading, "text_changed"]]);
  });

  it("does not take a moved member, a neighbour on the same line or a separator for code beside a function", () => {
    // A member that only moved: its assignment target moved with it and is the same code.
    const members = (order: string[]): string => `'use strict';\n\n${order.map((name) => `exports.${name} = function (parcel) {\n  return parcel.${name} > 1 ? '${name}' : 'none';\n};\n`).join("\n")}`;
    const movedAt = repo({ "package.json": PACKAGE_JSON, "index.js": members(["weight", "width", "depth"]) }, { "index.js": members(["width", "depth", "weight"]) });
    analyze(movedAt.root);
    const moved = changed(movedAt);
    expect(moved.blocks.filter((block) => block.symbols !== undefined).map((block) => [block.status, block.symbols])).toEqual([["mapped", ["sym:index.js#weight"]]]);
    expect(moved.listed.map((fn) => [fn.symbol_id, fn.reason])).toEqual([["sym:index.js#weight", "overlap_text_unchanged"]]);
    expect(moved.targets).toEqual([]);

    // Two functions on one line: the change in one is not code beside the other.
    const pair = `export const inc = (n) => n + 1, dec = (n) => n - 1;\n`;
    const pairAt = repo({ "package.json": COURIER_PACKAGE, "index.js": pair }, { "index.js": swap(pair, "n - 1", "n - 2") });
    analyze(pairAt.root);
    const paired = changed(pairAt);
    expect(paired.blocks.map((block) => [block.status, block.symbols])).toEqual([["mapped", ["sym:index.js#dec", "sym:index.js#inc"]]]);
    expect(paired.complete).toBe(true);
    expect(paired.targets.map((record) => record.identity.symbol_id)).toEqual(["sym:index.js#dec"]);

    // The comma the last method of an exported literal gains when another is added after it.
    const literal = `'use strict';\n\nmodule.exports = {\n  weigh: function (parcel) {\n    return parcel.weight * 2;\n  }\n};\n`;
    const longer = swap(literal, "  }\n};\n", "  },\n  price: function (parcel) {\n    return parcel.weight > 10 ? 12 : 5;\n  }\n};\n");
    const literalAt = repo({ "package.json": PACKAGE_JSON, "index.js": literal }, { "index.js": longer });
    analyze(literalAt.root);
    const appended = changed(literalAt);
    expect(appended.blocks.map((block) => [block.status, block.symbols, block.spans_boundary])).toEqual([["mapped", ["sym:index.js#price", "sym:index.js#weigh"], true]]);
    expect(appended.complete).toBe(true);
    expect(appended.targets.map((record) => [record.identity.symbol_id, record.selection.reason])).toEqual([["sym:index.js#price", "new_function"]]);
  });

  it("keeps a '#' in a directory name out of the symbol's name", () => {
    const route = `export function routeOf(parcel) {\n  return parcel.zone === "far" ? "north" : "south";\n}\n`;
    const pkg = JSON.stringify({ name: "courier-kit", version: "1.0.0", type: "module", main: "lib/lane#2/route.js" }, null, 2) + "\n";
    const at = repo({ "package.json": pkg, "lib/lane#2/route.js": route }, { "lib/lane#2/route.js": swap(route, '"north"', '"north-hub"') });
    analyze(at.root);
    const result = changed(at);

    expect(result.targets.map((record) => [record.identity.symbol_id, record.identity.name, record.identity.file])).toEqual([
      ["sym:lib/lane#2/route.js#routeOf", "routeOf", "lib/lane#2/route.js"]
    ]);
    expect(verifyTargetRecord(at.root, result.targets[0])).toEqual({ ok: true });
    const table = renderChangedTargets(result).join("\n");
    expect(table).toContain("lib/lane#2/route.js:2  mapped  → routeOf");
    expect(table).toMatch(/1\. routeOf {2}lib\/lane#2\/route\.js:1-3 {2}rank 1 {2}text_changed/);
  });

  it("takes a JSX file's function spans from the grammar that reads it, and maps nothing when none does", () => {
    const pkg = (main: string): string => JSON.stringify({ name: "parcel-board", version: "1.0.0", type: "module", main }, null, 2) + "\n";
    const jsx = `export function Menu({ items }) {\n  return <ul>{items.map((item) => <li key={item}>{item}</li>)}</ul>;\n}\n\nconst LIMIT = 5;\n\nexport function Pager({ page }) {\n  return page < LIMIT ? page + 1 : page;\n}\n`;
    // Plain TypeScript stops at the JSX and would end Menu at line 9; the TSX grammar reads the file.
    const at = repo({ "package.json": pkg("src/board.jsx"), "src/board.jsx": jsx }, { "src/board.jsx": swap(swap(jsx, "const LIMIT = 5;", "const LIMIT = 50;"), "page + 1", "page + 2") });
    analyze(at.root);
    const result = changed(at);
    const pager = "sym:src/board.jsx#Pager";

    expect(result.blocks.map((block) => [block.new_start, block.status, block.unknown, block.symbols])).toEqual([
      [5, "unknown", "module_level", undefined],
      [8, "mapped", undefined, [pager]]
    ]);
    expect(result.complete).toBe(false);
    // Menu's text is the same at base: it is neither a target nor listed.
    expect(result.targets.map((record) => [record.identity.symbol_id, record.identity.function.lines, record.identity.body?.lines])).toEqual([
      [pager, { start: 7, end: 9 }, { start: 7, end: 9 }]
    ]);
    expect(result.listed).toEqual([]);
    const described = describeTarget(readFileSync(join(at.root, "src/board.jsx")), "Pager");
    if (!described.ok) throw new Error(described.refused);
    expect(result.targets[0].identity.function_sha256).toBe(described.target.function_sha256);

    // Neither grammar reads this one: plain TypeScript stops at the JSX, TSX at the generic arrow.
    // Its symbols have no span to map to, and its comment lines are not vouched for.
    const mixed = `export const pick = <T>(value: T) => value;\n\n${jsx}`;
    const none = repo(
      { "package.json": pkg("src/board.tsx"), "src/board.tsx": mixed },
      { "src/board.tsx": swap(swap(mixed, "page + 1", "page + 2"), "export function Menu", "// the menu\nexport function Menu") }
    );
    analyze(none.root);
    const unread = changed(none);
    expect(unread.blocks.map((block) => [block.status, block.symbols])).toEqual([["unknown", undefined], ["unknown", undefined]]);
    expect(unread.complete).toBe(false);
    expect(unread.targets).toEqual([]);
    expect(unread.listed).toEqual([]);
  });

  it("rebuilds a record the way it says it was made: from the first parent, or over a range", () => {
    const second = swap(LABEL_JS, "' HEAVY'", "' VERY HEAVY'");
    const root = emptyRepo();
    const first = commit(root, DESK_BASE, "first");
    const middle = commit(root, { "lib/label.js": second }, "second");
    const third = commit(root, { "lib/label.js": swap(second, "'pallet'", "'crate'") }, "third");
    analyze(root);
    const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

    // The merged change (second → third) touches label.summary only.
    const own = changed({ root, base: middle, merged: third });
    expect(own.targets.map((record) => [record.identity.symbol_id, record.selection.mode])).toEqual([[SUMMARY, "first_parent"]]);
    expect(verifyTargetRecord(root, own.targets[0])).toEqual({ ok: true });
    const olderBase = copy(own.targets[0]);
    olderBase.selection.base_commit = first;
    expect(verifyTargetRecord(root, olderBase)).toMatchObject({ ok: false, refused: "not_first_parent" });

    // label.compose was changed one commit earlier: only a range names it, and its record says so.
    const ranged = ok(opChangedTargets(root, { base: first, merged: third, range: true }));
    const compose = ranged.targets.find((record) => record.identity.symbol_id === COMPOSE);
    if (!compose) throw new Error("missing target");
    expect(compose.selection).toMatchObject({ base_commit: first, mode: "range", reason: "text_changed" });
    expect(verifyTargetRecord(root, compose)).toEqual({ ok: true });
    // The same record presented as the merged change itself: its base is not the first parent.
    const claimed = copy(compose);
    claimed.selection.mode = "first_parent";
    expect(verifyTargetRecord(root, claimed)).toMatchObject({ ok: false, refused: "not_first_parent" });
    const unlabelled = copy(compose) as unknown as { selection: Record<string, unknown> };
    delete unlabelled.selection.mode;
    expect(verifyTargetRecord(root, unlabelled as unknown as typeof compose)).toMatchObject({ ok: false, refused: "record_version" });
  });

  it("checks a record in a checkout that holds other work: an edited test file is accepted, an edited code file is not", () => {
    const testFile = "'use strict';\n\nit('pads', function () {\n  return 1;\n});\n";
    // The merge touches the function and, as a fix usually does, its test file.
    const at = repo(
      { ...DESK_BASE, "test/label.test.js": testFile },
      { "lib/label.js": swap(LABEL_JS, "' HEAVY'", "' VERY HEAVY'"), "test/label.test.js": `${testFile}// touched by the same change\n` }
    );
    analyze(at.root);
    const result = changed(at);
    expect(result.blocks.map((block) => block.status)).toEqual(["mapped", "test_file"]);
    const [record] = result.targets;
    const check = (): unknown => verifyTargetRecord(at.root, record, { cleanTree: false });

    // A new test is appended where the kit's own pointer would put it.
    appendFileSync(join(at.root, "test/label.test.js"), "\nit('flags heavy parcels', function () {\n  return 2;\n});\n");
    expect(verifyTargetRecord(at.root, record)).toMatchObject({ ok: false, refused: "dirty_tree" });
    expect(check()).toEqual({ ok: true });
    // Analysing again with the new test in place does not change the answer.
    analyze(at.root);
    expect(check()).toEqual({ ok: true });

    // Code is still compared with the commit: a file the change does not touch, and the target's own.
    writeFileSync(join(at.root, "index.js"), `${ENTRY_JS}\n// edited\n`);
    expect(check()).toMatchObject({ ok: false, refused: "graph_not_from_commit" });
    writeFileSync(join(at.root, "index.js"), ENTRY_JS);
    expect(check()).toEqual({ ok: true });
    appendFileSync(join(at.root, "lib/label.js"), "\n// edited\n");
    expect(check()).toMatchObject({ ok: false, refused: "file_hash_mismatch" });
  });

  it("is wired into the CLI: a table by default, the full result with --json, a failing exit for a refusal", () => {
    expect(parseArgs(["--base", "abc123", "--merged", "def456", "--range", "--limit", "2", "--json"]).flags).toEqual({
      base: "abc123",
      merged: "def456",
      range: true,
      limit: "2",
      json: true
    });

    const at = repo(DESK_BASE, { "lib/label.js": swap(LABEL_JS, "' HEAVY'", "' VERY HEAVY'") });
    analyze(at.root);
    const here = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const loader = createRequire(import.meta.url).resolve("tsx");
    const cli = (...args: string[]) =>
      spawnSync(process.execPath, ["--import", loader, join(here, "src/local/cli.ts"), "changed-targets", ...args], {
        cwd: at.root,
        encoding: "utf8",
        env: { ...process.env, NODE_NO_WARNINGS: "1", ORANGEPRO_USER_CONFIG: NO_USER_CONFIG }
      });

    const json = cli("--base", at.base, "--merged", at.merged, "--json");
    expect(json.status).toBe(0);
    expect(JSON.parse(json.stdout)).toEqual(JSON.parse(JSON.stringify(changed(at))));

    const table = cli("--base", at.base, "--merged", at.merged);
    expect(table.status).toBe(0);
    expect(table.stdout).toBe(renderChangedTargets(changed(at)).join("\n") + "\n");
    expect(table.stdout).toContain("Complete: every changed line is accounted for.");
    expect(table.stdout).toContain(`lib/label.js:${lineOf(swap(LABEL_JS, "' HEAVY'", "' VERY HEAVY'"), "VERY HEAVY")}  mapped  → label.compose`);
    expect(table.stdout).toMatch(/1\. label\.compose {2}lib\/label\.js:\d+-\d+ {2}rank \d+ {2}text_changed/);

    const refusal = cli("--base", at.merged, "--merged", at.base, "--json");
    expect(refusal.status).toBe(1);
    expect(JSON.parse(refusal.stdout)).toMatchObject({ status: "refused", refused: "not_first_parent" });
  });
});
