import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-may-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const mayCalls = (root: string) =>
  analyzeRepo(root, { readContent: true }).candidate_edges.filter((e) => e.relationship_type === "MAY_CALL");
const mayPairs = (root: string) => mayCalls(root).map((e) => `${e.from_external_id} -> ${e.to_external_id}`);

describe("MAY_CALL — heuristic call hints (Layer 1, PR 2)", () => {
  it("0.65 — IMPORT-ANCHORED: imported qualifier + unique member in the imported module", () => {
    const root = repo({
      "src/api.ts": "export class Api {\n  fetchUser() { return 1; }\n}\nexport const api = new Api();\n",
      "src/svc.ts": "import { api } from './api';\nexport function load() { return api.fetchUser(); }\n"
    });
    const e = mayCalls(root);
    const hit = e.find((x) => x.to_external_id === "sym:src/api.ts#Api.fetchUser");
    expect(hit).toBeDefined();
    expect(hit!.from_external_id).toBe("sym:src/svc.ts#load");
    expect(hit!.evidence_strength).toBe("weak");
    expect(hit!.confidence).toBe(0.65);
    expect(hit!.reason).toMatch(/Imported-binding member match/);
  });

  it("0.65 — NO edge when the qualifier is imported from a DIFFERENT module than the member (Codex anchor)", () => {
    const root = repo({
      "src/thing.ts": "export class Thing {\n  process() { return 1; }\n}\n", // unique *.process member
      "src/other.ts": "export const helper = { x: 1 };\n",
      "src/svc.ts": "import { helper } from './other';\nexport function run() { return helper.process(); }\n"
    });
    // helper is imported from ./other, but Thing.process is in ./thing → not anchored → no edge.
    expect(mayPairs(root).some((p) => p.includes(".process"))).toBe(false);
  });

  it("0.65 — NO edge for a generic method on a non-imported (local/module) object", () => {
    const root = repo({
      "src/store.ts": "export class Store {\n  get() { return 1; }\n}\n", // unique *.get member
      "src/svc.ts": "const cache = new Map();\nexport function run() { return cache.get('k'); }\n"
    });
    // cache is a local Map — no import binding → generic .get() is NOT attributed to Store.get.
    expect(mayPairs(root).some((p) => p.includes(".get"))).toBe(false);
  });

  it("0.65 — ambiguous member name (two classes) emits NO edge", () => {
    const root = repo({
      "src/a.ts": "export class A {\n  save() { return 1; }\n}\nexport const a = new A();\n",
      "src/b.ts": "export class B {\n  save() { return 2; }\n}\n",
      "src/svc.ts": "import { a } from './a';\nexport function run() { return a.save(); }\n"
    });
    expect(mayPairs(root).some((p) => p.includes(".save"))).toBe(false); // ambiguous → none
  });

  it("0.55 — ns.method() resolves to an export of the namespace-imported module", () => {
    const root = repo({
      "src/mod.ts": "export function doThing() { return 1; }\n",
      "src/svc.ts": "import * as mod from './mod';\nexport function run() { return mod.doThing(); }\n"
    });
    const hit = mayCalls(root).find((x) => x.to_external_id === "sym:src/mod.ts#doThing");
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe(0.55);
    expect(hit!.reason).toMatch(/Import-scoped MAY_CALL/);
  });

  it("0.45 — free call through a barrel resolves to the resolver-backed terminal", () => {
    const root = repo({
      "src/impl.ts": "export function saveUser() { return 1; }\n",
      "src/barrel.ts": "export * from './impl';\n",
      "src/svc.ts": "import { saveUser } from './barrel';\nexport function run() { return saveUser(); }\n"
    });
    const hit = mayCalls(root).find((x) => x.to_external_id === "sym:src/impl.ts#saveUser");
    expect(hit).toBeDefined();
    expect(hit!.confidence).toBe(0.45);
    expect(hit!.reason).toMatch(/barrel/);
  });

  it("a param-local obj.method() is NOT a MAY_CALL (shadowed qualifier — weaker, dropped)", () => {
    const root = repo({
      "src/store.ts": "export class Store {\n  flush() { return 1; }\n}\n",
      "src/svc.ts": "export function run(store: any) { return store.flush(); }\n"
    });
    expect(mayPairs(root).some((p) => p.includes(".flush"))).toBe(false);
  });

  it("an exact CALLS pair is never also emitted as MAY_CALL", () => {
    const root = repo({ "src/a.ts": "export function h() { return 1; }\nexport function r() { return h(); }\n" });
    const frag = analyzeRepo(root, { readContent: true });
    expect(frag.edges.some((e) => e.relationship_type === "CALLS" && e.from_external_id === "sym:src/a.ts#r")).toBe(true);
    expect(frag.candidate_edges.some((e) => e.relationship_type === "MAY_CALL")).toBe(false);
  });

  it("MAY_CALL is candidate-only and invisible to coverage (no hard edge, weak strength)", () => {
    const root = repo({
      "src/mod.ts": "export function doThing() { return 1; }\n",
      "src/svc.ts": "import * as mod from './mod';\nexport function run() { return mod.doThing(); }\n"
    });
    const frag = analyzeRepo(root, { readContent: true });
    const may = frag.candidate_edges.filter((e) => e.relationship_type === "MAY_CALL");
    expect(may.length).toBeGreaterThan(0);
    expect(may.every((e) => e.evidence_strength === "weak")).toBe(true);
    // never a hard edge, never TESTED_BY/COVERS
    expect(frag.edges.some((e) => (e.relationship_type as string) === "MAY_CALL")).toBe(false);
    expect(frag.edges.some((e) => e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS")).toBe(false);
  });

  it("every MAY_CALL endpoint is a real emitted CodeSymbol (no dangling)", () => {
    const root = repo({
      "src/mod.ts": "export function doThing() { return 1; }\n",
      "src/svc.ts": "import * as mod from './mod';\nexport function run() { return mod.doThing(); }\n"
    });
    const frag = analyzeRepo(root, { readContent: true });
    const ids = new Set(frag.nodes.filter((n) => n.kind === "CodeSymbol").map((n) => n.external_id));
    for (const e of frag.candidate_edges.filter((x) => x.relationship_type === "MAY_CALL")) {
      expect(ids.has(e.from_external_id)).toBe(true);
      expect(ids.has(e.to_external_id)).toBe(true);
    }
  });
});
