import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { extractCalls } from "../../src/local/analyze/callGraph.js";
import { extractImports } from "../../src/local/resolve/importGraph.js";
import { opAnalyze, opInit } from "../../src/local/operations.js";
import { loadGraph, workspacePaths } from "../../src/local/workspace.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const pairs = (src: string) => extractCalls(src, false).map((c) => `${c.caller}->${c.callee}`).sort();
function file(text: string): string {
  const dir = mkdtempSync(path.join(tmpdir(), "opro-calls-"));
  dirs.push(dir);
  const f = path.join(dir, "a.js");
  writeFileSync(f, text);
  return f;
}
const bound = (text: string) => extractImports(file(text)).flatMap((i) => i.requireBindings ?? []).map((b) => `${b.local}=${b.imported}`);

describe("item 20: calls inside a local variable declaration", () => {
  it("belong to the enclosing function", () => {
    expect(pairs("function a() { const t = add(1, 2); return t; }")).toEqual(["a->add"]);
    expect(pairs("function a() { const { x } = load(); return x; }")).toEqual(["a->load"]);
  });
  it("a call to the local itself links nothing, and a local that shadows an outer function hides it", () => {
    expect(pairs("function a() { const h = () => inner(); h(); }")).toEqual(["a->inner"]);
    expect(pairs("function add() {}\nfunction a() { const add = make(); add(); }")).toEqual(["a->make"]);
  });
  it("nothing is recorded inside a namespace, which has no caller", () => {
    expect(pairs("namespace N { const x = f(); }")).toEqual([]);
  });
});

describe("item 19: functions written exports.name = function", () => {
  it("own their calls, in both spellings", () => {
    expect(pairs("exports.a = function () { b(); };")).toEqual(["a->b"]);
    expect(pairs("module.exports.a = () => b();")).toEqual(["a->b"]);
  });
  it("a bare call never means a sibling export, from any caller; a declared or imported name still links", () => {
    expect(pairs("exports.run = function () { return stop(); };\nexports.stop = function () {};")).toEqual([]);
    expect(pairs("function a() { const x = stop(); }\nexports.stop = function () {};")).toEqual([]);
    expect(pairs("function stop() {}\nexports.stop = stop;\nexports.run = function () { stop(); };")).toEqual(["run->stop"]);
    expect(pairs("import { stop } from './s';\nexports.stop = stop;\nexports.run = function () { stop(); };")).toEqual(["run->stop"]);
  });
  it("a name assigned twice, or also declared in the module, is not a caller", () => {
    expect(pairs("exports.a = function () { b(); };\nexports.a = function () { c(); };")).toEqual([]);
    expect(pairs("function a() { x(); }\nexports.a = function () { b(); };")).toEqual(["a->x"]);
  });
});

describe("item 17: names bound by require", () => {
  it("reads a member, a destructure and a rename", () => {
    expect(bound("var a = require('./x').a;")).toEqual(["a=a"]);
    expect(bound("const { a, b: c } = require('./x');")).toEqual(["a=a", "c=b"]);
  });
  it("leaves out a re-assigned name, a default value, a rest, a local require and a require inside a function", () => {
    expect(bound("var a = require('./x').a;\nfunction f() { a = 1; }")).toEqual([]);
    expect(bound("const { a = 1, ...r } = require('./x');")).toEqual([]);
    expect(bound("function require() {}\nvar a = require('./x').a;")).toEqual([]);
    expect(bound("function f() { const { a } = require('./x'); }")).toEqual([]);
  });
  it("keeps the ordinary import bindings empty, so test links and drafted imports do not change", () => {
    expect(extractImports(file("const { a } = require('./x');"))[0]).toMatchObject({ specifier: "./x", bindings: [], requireBindings: [{ local: "a", imported: "a" }] });
  });
});

describe("in the graph", () => {
  it("links a call through require, and gives no test evidence", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "opro-calls-"));
    dirs.push(dir);
    const put = (rel: string, text: string) => {
      mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      writeFileSync(path.join(dir, rel), text);
    };
    put("package.json", JSON.stringify({ name: "k", version: "1.0.0", main: "index.js" }));
    put("lib/util.js", "exports.total = function (a, b) { return a + b; };\n");
    put("index.js", "var total = require('./lib/util').total;\nexports.price = function (a) { const t = total(a, 1); return t * 2; };\n");
    const deps = { clock: () => "2026-11-22T00:00:00.000Z", env: {} };
    opInit(dir, deps);
    opAnalyze(dir, { source: dir }, deps);
    const graph = loadGraph(workspacePaths(dir).graphPath);
    expect(graph.edges.some((e) => e.relationship_type === "CALLS" && e.evidence_strength === "hard" && e.from_external_id === "sym:index.js#price" && e.to_external_id === "sym:lib/util.js#total")).toBe(true);
    expect(graph.edges.filter((e) => e.relationship_type === "TESTED_BY")).toEqual([]);
  });
});
