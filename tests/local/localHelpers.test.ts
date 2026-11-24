import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { MAX_SYMBOLS_PER_FILE, extractSymbols, extractSymbolsWithMeta, listFunctionSites } from "../../src/local/analyze/symbols.js";
import { denominatorComposition } from "../../src/local/graph/factories.js";
import { rankRiskGaps } from "../../src/local/score/risk.js";
import { opAnalyze, opInit } from "../../src/local/operations.js";
import { loadGraph, workspacePaths } from "../../src/local/workspace.js";
import { opChangedTargets } from "../../src/local/changedTargets.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "opro-helpers-"));
  dirs.push(dir);
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    writeFileSync(path.join(dir, rel), text);
  }
  return dir;
}
const helperNames = (src: string) => extractSymbolsWithMeta(src, "typescript", { helpers: true }).symbols.filter((s) => s.seen_by === "local_helper").map((s) => s.name).sort();
const PKG = JSON.stringify({ name: "k", version: "1.0.0", main: "index.js" });
const SRC = "function round(a) { return Math.floor(a); }\nconst clamp = (a) => (a > 9 ? 9 : round(a));\nfunction unused(a) { return a + 1; }\nexports.price = function (a) { return clamp(a) * 2; };\n";

describe("which functions are helpers", () => {
  it("module-level functions no export reaches, and nothing else", () => {
    expect(helperNames("function a() {}\nconst b = () => 1;\nvar c = function () {};\nconst d = 1;\nexport function e() {}\nfunction outer() { function nested() {} }\nexport { outer };\n")).toEqual(["a", "b", "c"]);
  });
  it("asking what a file exports never returns them", () => {
    const src = "function hidden() {}\nexport function shown() { hidden(); }\n";
    expect(extractSymbols(src, "typescript").map((x) => x.name)).toEqual(["shown"]);
    expect(listFunctionSites(src).sites.map((x) => x.name)).toEqual(["shown"]);
  });
  it("a helper past the per-file limit does not report public symbols as lost", () => {
    const pub = Array.from({ length: MAX_SYMBOLS_PER_FILE }, (_, i) => `export function p${i}() {}`).join("\n");
    const out = extractSymbolsWithMeta(`${pub}\nfunction h() {}\n`, "typescript", { helpers: true });
    expect(out.truncated).toBe(false);
    expect(out.symbols.filter((s) => !s.seen_by)).toHaveLength(MAX_SYMBOLS_PER_FILE);
  });
});

describe("helpers in the graph", () => {
  const graph = () => analyzeRepo(repo({ "package.json": PKG, "index.js": SRC }), { readContent: true });
  it("are never counted, ranked or part of what was found to count", () => {
    const g = graph();
    const helpers = g.nodes.filter((n) => n.properties.seen_by === "local_helper");
    expect(helpers.map((n) => n.title).sort()).toEqual(["clamp", "round", "unused"]);
    expect(helpers.every((n) => n.denominator_eligible === false && n.properties.denominator_reason_code === "not_exported")).toBe(true);
    expect(denominatorComposition(g).code_symbols_total).toBe(1);
    const dir = repo({ "package.json": PKG, "index.js": SRC });
    const deps = { clock: () => "2026-11-22T00:00:00.000Z", env: {} };
    opInit(dir, deps);
    opAnalyze(dir, { source: dir }, deps);
    const ranked = rankRiskGaps(loadGraph(workspacePaths(dir).graphPath), { repoRoot: dir, limit: 100, includeAssociated: true }).map((r) => r.id);
    expect(ranked.some((id) => /#(clamp|round|unused)$/.test(id))).toBe(false);
  });
  it("their calls use the separate link, so no ordinary call link or score sees them", () => {
    const g = graph();
    const pairs = (type: string) => g.edges.filter((e) => e.relationship_type === type).map((e) => `${e.from_external_id.split("#")[1]}>${e.to_external_id.split("#")[1]}`).sort();
    expect(pairs("HELPER_CALLS")).toEqual(["clamp>round", "price>clamp"]);
    expect(pairs("CALLS")).toEqual([]);
  });
  it("a local that shadows a helper links nothing, and a same-named function elsewhere is not confused with it", () => {
    const g = analyzeRepo(repo({ "package.json": PKG, "index.js": "function run() {}\nexports.a = function () { const run = make(); return run(); };\n", "other.js": "function run() {}\nexports.b = function () { return run(); };\n" }), { readContent: true });
    expect(g.edges.filter((e) => e.relationship_type === "HELPER_CALLS").map((e) => `${e.from_external_id}>${e.to_external_id}`)).toEqual(["sym:other.js#b>sym:other.js#run"]);
  });
});

describe("a change inside a helper", () => {
  function changed(after: string) {
    const dir = repo({ "package.json": PKG, "index.js": SRC, ".gitignore": ".orangepro/\n.orangeproignore\n" });
    const git = (...a: string[]) => execFileSync("git", ["-c", "user.email=t@example.test", "-c", "user.name=t", ...a], { cwd: dir, encoding: "utf8" }).trim();
    git("init", "-q");
    git("add", "-A");
    git("commit", "-qm", "a");
    const base = git("rev-parse", "HEAD");
    writeFileSync(path.join(dir, "index.js"), after);
    git("commit", "-qam", "b");
    const merged = git("rev-parse", "HEAD");
    const deps = { clock: () => "2026-11-22T00:00:00.000Z", env: {} };
    opInit(dir, deps);
    opAnalyze(dir, { source: dir }, deps);
    const result = opChangedTargets(dir, { base, merged });
    if (!("targets" in result)) throw new Error(`changed-targets refused: ${result.refused}: ${result.message}`);
    return result;
  }
  it("is followed to the public function that calls it, through another helper", () => {
    const r = changed(SRC.replace("Math.floor", "Math.ceil"));
    expect(r.targets.map((t) => t.identity.name)).toEqual(["price"]);
    expect(r.targets[0]!.selection.reason).toContain("affected");
  });
  it("stays unknown when no counted function calls it, and is never a target itself", () => {
    const r = changed(SRC.replace("a + 1", "a + 2"));
    expect(r.targets).toEqual([]);
    expect(JSON.stringify(r.blocks)).toContain("no_caller_link");
  });
});
