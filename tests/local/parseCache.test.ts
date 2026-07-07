import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { ParseCache, PARSER_VERSION } from "../../src/local/analyze/parseCache.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";

// Adversarial matrix for Phase 5.4.2 (persistent parse cache). The invalidation story:
// content-hash + parser version key; changed busts, unchanged hits, version bump busts,
// and a deleted file can NEVER survive as a live denominator.

const dirs: string[] = [];
function repoWith(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "opro-pcache-"));
  dirs.push(dir);
  for (const [name, body] of Object.entries(files)) writeFileSync(join(dir, name), body);
  return dir;
}
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const SRC = { "a.ts": "export function a(): number { return 1; }\n", "b.ts": "export function b(): number { return 2; }\n" };
const analyze = (dir: string, cache: ParseCache) => analyzeRepo(dir, { readContent: true, parseCache: cache });

describe("persistent parse cache (Phase 5.4.2)", () => {
  it("an unchanged file HITS on a reloaded cache (no re-parse)", () => {
    const dir = repoWith(SRC);
    const c1 = new ParseCache();
    analyze(dir, c1);
    expect(c1.misses).toBeGreaterThan(0); // cold: all miss

    const c2 = new ParseCache(c1.toData()); // simulate persist → reload
    analyze(dir, c2);
    expect(c2.hits).toBeGreaterThan(0);
    expect(c2.misses).toBe(0); // warm: every parse output reused
    expect(c2.hitRate()).toBe(100);
  });

  it("a changed file (same path, new content) BUSTS and re-parses", () => {
    const dir = repoWith(SRC);
    const c1 = new ParseCache();
    analyze(dir, c1);

    writeFileSync(join(dir, "a.ts"), "export function a(): number { return 999; }\n"); // new content → new hash
    const c2 = new ParseCache(c1.toData());
    analyze(dir, c2);
    expect(c2.misses).toBeGreaterThan(0); // a.ts re-parsed
    expect(c2.hits).toBeGreaterThan(0); // b.ts still hit
  });

  it("bumping the parser version invalidates the whole cache", () => {
    const dir = repoWith(SRC);
    const c1 = new ParseCache();
    analyze(dir, c1);

    // A cache persisted under an older parser version must be ignored entirely.
    const stale = { version: PARSER_VERSION - 1, entries: c1.toData().entries };
    const c2 = new ParseCache(stale);
    analyze(dir, c2);
    expect(c2.hits).toBe(0); // nothing trusted
    expect(c2.misses).toBeGreaterThan(0);
  });

  it("an old-version Java cache (no trivial_accessor) misses and recomputes WITH it — boilerplate fix not bypassed (Codex #58 round-2)", async () => {
    await preloadTreeSitter(["java"]);
    const dir = repoWith({
      "Owner.java": "public class Owner { private String name; public String getName() { return name; } public boolean validate() { return name != null; } }\n"
    });
    // Warm run under the CURRENT parser version: getName is body-trivial → excluded.
    const c1 = new ParseCache();
    const f1 = analyze(dir, c1);
    expect(f1.nodes.find((n) => n.kind === "CodeSymbol" && n.title === "getName")?.denominator_eligible).toBe(false);

    // Simulate a PRE-FIX cache: same content, PREVIOUS parser version, symbols lack trivial_accessor.
    const data = c1.toData();
    for (const e of Object.values(data.entries)) {
      if (e.symbols) for (const s of e.symbols.symbols) delete (s as { trivial_accessor?: boolean }).trivial_accessor;
    }
    const stale = { version: PARSER_VERSION - 1, entries: data.entries };

    const c2 = new ParseCache(stale);
    const f2 = analyze(dir, c2);
    expect(c2.hits).toBe(0); // stale-version schema is not trusted
    expect(c2.misses).toBeGreaterThan(0); // recomputed
    // Recompute restored trivial_accessor → getName is excluded again (fix not bypassed).
    expect(f2.nodes.find((n) => n.kind === "CodeSymbol" && n.title === "getName")?.denominator_eligible).toBe(false);
    const javaEntry = Object.values(c2.toData().entries).find((e) => e.symbols?.symbols.some((s) => s.name === "getName"));
    expect(javaEntry?.symbols?.symbols.find((s) => s.name === "getName")?.trivial_accessor).toBe(true);
  });

  it("a deleted file cannot survive in the cache as a live denominator", () => {
    const dir = repoWith(SRC);
    const c1 = new ParseCache();
    analyze(dir, c1);
    const symKeysBefore = Object.keys(c1.toData().entries).filter((k) => k.startsWith("sym:"));
    expect(symKeysBefore.length).toBeGreaterThanOrEqual(2);

    const keysBefore = Object.keys(c1.toData().entries);
    rmSync(join(dir, "a.ts")); // a.ts deleted
    const c2 = new ParseCache(c1.toData());
    const frag = analyze(dir, c2);
    // a()'s symbol is gone from the graph (the deleted file is never walked)...
    expect(frag.nodes.some((n) => n.external_id.includes("a.ts#a"))).toBe(false);
    // ...and a.ts's entry is PRUNED from the persisted cache (only this-run keys survive),
    // so a stale parse output can never re-enter a future graph as a live denominator.
    const keysAfter = Object.keys(c2.toData().entries);
    expect(keysAfter.length).toBe(1); // only the surviving file (b.ts)
    expect(keysAfter.length).toBeLessThan(keysBefore.length);
    const prunedKey = keysBefore.find((k) => !keysAfter.includes(k));
    expect(prunedKey).toBeDefined(); // a.ts's content-hash key is gone
    expect(c2.hits).toBe(1); // b.ts hit; a.ts not re-parsed (it's gone)
  });

  it("a schema-INVALID persisted entry is dropped on load (miss + recompute)", () => {
    const dir = repoWith({ "u.ts": "export function loginUser(): number { return 1; }\n" });
    const c1 = new ParseCache();
    analyze(dir, c1);
    const data = c1.toData();
    const symKey = Object.keys(data.entries).find((k) => k.startsWith("sym:"))!;
    // Malformed shape: symbols is not an array.
    (data.entries[symKey] as { symbols: unknown }).symbols = { symbols: "nope", truncated: false };

    const c2 = new ParseCache(data);
    const frag = analyze(dir, c2);
    expect(frag.nodes.some((n) => n.external_id.includes("u.ts#loginUser"))).toBe(true);
    expect(c2.misses).toBeGreaterThan(0); // invalid entry was dropped → recomputed
  });

  it("records the cache hit-rate in analysis.parse_cache", () => {
    const dir = repoWith(SRC);
    const c1 = new ParseCache();
    const frag = analyze(dir, c1);
    expect(frag.analysis.parse_cache).toBeDefined();
    expect(frag.analysis.parse_cache?.misses).toBeGreaterThan(0);
    expect(frag.analysis.parse_cache?.hits).toBe(0);
  });
});
