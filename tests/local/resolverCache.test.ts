import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { ResolverCache, computeResolverGate } from "../../src/local/resolve/resolverCache.js";
import { ResolvedImport } from "../../src/local/resolve/resolver.js";

// Adversarial matrix for Phase 5.4.3 (resolver cache). The invalidation story is a global
// gate (filesystem shape + resolution config). It must bust on anything that can change a
// resolution — new-file shadow, target moved, path-alias edit, package-export edit — and
// keep hits only when the shape is stable (content-only edits).

const dirs: string[] = [];
function tmp(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "opro-rcache-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const RES: ResolvedImport = { resolvedFileName: "/x/foo.ts", isExternal: false, resolved: true };

describe("ResolverCache gate behavior (Phase 5.4.3)", () => {
  it("reuses entries when the gate is unchanged (HIT)", () => {
    const c1 = new ResolverCache();
    c1.useGate("g1");
    c1.resolve("/dir", "./foo", () => RES); // miss → store
    expect(c1.misses).toBe(1);

    const c2 = new ResolverCache(JSON.parse(JSON.stringify(c1.toData())));
    c2.useGate("g1"); // same gate → entries survive
    const v = c2.resolve("/dir", "./foo", () => {
      throw new Error("compute must not run on a hit");
    });
    expect(v).toEqual(RES);
    expect(c2.hits).toBe(1);
  });

  it("discards ALL entries when the gate changes (BUST → re-resolve)", () => {
    const c1 = new ResolverCache();
    c1.useGate("g1");
    c1.resolve("/dir", "./foo", () => RES);

    const c2 = new ResolverCache(JSON.parse(JSON.stringify(c1.toData())));
    c2.useGate("g2-different"); // structural/config change
    let computed = false;
    c2.resolve("/dir", "./foo", () => {
      computed = true;
      return RES;
    });
    expect(computed).toBe(true); // had to re-resolve
    expect(c2.hits).toBe(0);
  });
});

describe("computeResolverGate invalidation triggers (Phase 5.4.3)", () => {
  const base = { "tsconfig.json": '{"compilerOptions":{}}', "package.json": '{"name":"x"}', "a.ts": "export const a=1;\n", "b.ts": "export const b=2;\n" };

  it("a NEW file (shadow class) changes the gate", () => {
    const dir = tmp(base);
    const g1 = computeResolverGate([join(dir, "a.ts"), join(dir, "b.ts"), join(dir, "tsconfig.json"), join(dir, "package.json")]);
    const g2 = computeResolverGate([join(dir, "a.ts"), join(dir, "b.ts"), join(dir, "a.tsx"), join(dir, "tsconfig.json"), join(dir, "package.json")]);
    expect(g2).not.toBe(g1);
  });

  it("a REMOVED/moved target changes the gate", () => {
    const dir = tmp(base);
    const g1 = computeResolverGate([join(dir, "a.ts"), join(dir, "b.ts"), join(dir, "tsconfig.json"), join(dir, "package.json")]);
    const g2 = computeResolverGate([join(dir, "b.ts"), join(dir, "tsconfig.json"), join(dir, "package.json")]);
    expect(g2).not.toBe(g1);
  });

  it("a tsconfig path-alias edit changes the gate", () => {
    const dir = tmp(base);
    const paths = [join(dir, "a.ts"), join(dir, "tsconfig.json"), join(dir, "package.json")];
    const g1 = computeResolverGate(paths);
    writeFileSync(join(dir, "tsconfig.json"), '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src/*"]}}}');
    const g2 = computeResolverGate(paths);
    expect(g2).not.toBe(g1);
  });

  it("a package.json exports edit changes the gate", () => {
    const dir = tmp(base);
    const paths = [join(dir, "a.ts"), join(dir, "tsconfig.json"), join(dir, "package.json")];
    const g1 = computeResolverGate(paths);
    writeFileSync(join(dir, "package.json"), '{"name":"x","exports":{".":"./a.ts"}}');
    const g2 = computeResolverGate(paths);
    expect(g2).not.toBe(g1);
  });

  it("a content-only edit to a non-config source file does NOT change the gate (stable shape → HIT)", () => {
    const dir = tmp(base);
    const paths = [join(dir, "a.ts"), join(dir, "tsconfig.json"), join(dir, "package.json")];
    const g1 = computeResolverGate(paths);
    writeFileSync(join(dir, "a.ts"), "export const a = 999;\n"); // same path, new content
    const g2 = computeResolverGate(paths);
    expect(g2).toBe(g1);
  });
});

describe("resolver cache end-to-end via analyzeRepo (Phase 5.4.3)", () => {
  it("a warm re-analyze of an unchanged repo reuses resolutions", () => {
    const dir = tmp({
      "tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}',
      "impl.ts": "export function impl(): number { return 1; }\n",
      "impl.test.ts": "import { impl } from './impl.js';\ntest('x', () => { expect(impl()).toBe(1); });\n"
    });
    const c1 = new ResolverCache();
    analyzeRepo(dir, { readContent: true, resolverCache: c1 });
    expect(c1.misses).toBeGreaterThan(0);

    const c2 = new ResolverCache(JSON.parse(JSON.stringify(c1.toData())));
    const frag = analyzeRepo(dir, { readContent: true, resolverCache: c2 });
    expect(c2.hits).toBeGreaterThan(0);
    expect(frag.analysis.resolver_cache?.hits).toBe(c2.hits);
  });

  it("editing ONLY tsconfig.json busts the gate in the analyzeRepo path (Codex finding 1)", () => {
    const dir = tmp({
      "tsconfig.json": '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}',
      "impl.ts": "export function impl(): number { return 1; }\n",
      "impl.test.ts": "import { impl } from './impl.js';\ntest('x', () => { expect(impl()).toBe(1); });\n"
    });
    const c1 = new ResolverCache();
    analyzeRepo(dir, { readContent: true, resolverCache: c1 });

    // Change ONLY tsconfig content — the gate must include it (it's skipped from resolveFiles),
    // so a warm run with the reloaded cache must DISCARD all entries (0 stale hits).
    writeFileSync(join(dir, "tsconfig.json"), '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext","strict":true}}');
    const c2 = new ResolverCache(JSON.parse(JSON.stringify(c1.toData())));
    analyzeRepo(dir, { readContent: true, resolverCache: c2 });
    expect(c2.hits).toBe(0); // tsconfig edit busted the gate (was a silent-stale bug)
  });

  it("editing an EXTENDED base config (tsconfig extends ./base.json) busts the gate (Codex round-4)", () => {
    const dir = tmp({
      "base.json": '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src1/*"]}}}',
      "tsconfig.json": '{"extends":"./base.json","compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"}}',
      "impl.ts": "export function impl(): number { return 1; }\n",
      "impl.test.ts": "import { impl } from './impl.js';\ntest('x', () => { expect(impl()).toBe(1); });\n"
    });
    const c1 = new ResolverCache();
    analyzeRepo(dir, { readContent: true, resolverCache: c1 });

    // Edit ONLY the extended base (not tsconfig.json) — it's a plain .json, so the gate must
    // hash it; the warm run must discard all entries (no silent stale resolution).
    writeFileSync(join(dir, "base.json"), '{"compilerOptions":{"baseUrl":".","paths":{"@/*":["src2/*"]}}}');
    const c2 = new ResolverCache(JSON.parse(JSON.stringify(c1.toData())));
    analyzeRepo(dir, { readContent: true, resolverCache: c2 });
    expect(c2.hits).toBe(0); // extended-base edit busted the gate
  });
});

describe("resolver cache validates shape on load (Codex finding 2)", () => {
  // The cache is trusted LOCAL WORKSPACE STATE (same boundary as graph.json): the gate handles
  // real staleness and shape validation handles corruption. We do NOT claim tamper-resistance —
  // a "target membership" check was tried and removed (it could not prove a same-gate entry
  // resolved to the RIGHT target, only that the target was *a* walked file = theater).
  it("drops a schema-INVALID persisted entry on load (miss + recompute)", () => {
    const c = new ResolverCache({ gate: "g", entries: { "/dir ./b": { resolved: "nope" } as unknown as ResolvedImport } });
    c.useGate("g");
    let computed = false;
    c.resolve("/dir", "./b", () => {
      computed = true;
      return RES;
    });
    expect(computed).toBe(true); // malformed entry was dropped → recomputed
  });

  it("drops an entry whose resolved/resolvedFileName disagree (resolved:true but no name)", () => {
    const c = new ResolverCache({
      gate: "g",
      entries: { "/dir ./b": { resolved: true, resolvedFileName: null, isExternal: false } as unknown as ResolvedImport }
    });
    c.useGate("g");
    let computed = false;
    c.resolve("/dir", "./b", () => {
      computed = true;
      return RES;
    });
    expect(computed).toBe(true);
  });
});
