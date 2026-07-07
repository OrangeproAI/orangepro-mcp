import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { opInit, opAnalyze } from "../../src/local/operations.js";
import { loadGraph } from "../../src/local/workspace.js";
import { preloadTreeSitter, __resetTreeSitterForTests } from "../../src/local/analyze/treeSitter/engine.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const DEPS = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };

function javaRepo(): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-tscache-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  // `public class` so the minimal regex fallback at least catches the CLASS — but the
  // regex extracts NO methods at all, so a METHOD name is the marker proving the
  // second result came from tree-sitter, not a stale shallow regex cache.
  writeFileSync(
    join(root, "src", "OwnerController.java"),
    ["public class OwnerController {", '  public String publicHandler() { return "x"; }', '  String packagePrivateHandler() { return "y"; }', "}", ""].join("\n")
  );
  return root;
}

function javaSymbolTitles(root: string): string[] {
  const g = loadGraph(join(root, ".orangepro", "graph.json"));
  return g.nodes.filter((n) => n.kind === "CodeSymbol" && /\.java$/.test(String(n.properties.file || ""))).map((n) => n.title ?? "");
}

describe("parse-cache must not serve pre-preload regex symbols after tree-sitter loads (Codex PR-1 CRITICAL)", () => {
  it("a re-analyze on unchanged content after preload yields the tree-sitter surface, not the cached regex one", async () => {
    __resetTreeSitterForTests(); // ensure java is NOT loaded for the first pass
    const root = javaRepo();
    opInit(root, DEPS);

    // 1. Analyze BEFORE preloading the Java grammar → shallow regex fallback, persisted to the parse cache.
    opAnalyze(root, { source: root }, DEPS);
    const first = javaSymbolTitles(root);
    expect(first).toContain("OwnerController"); // minimal regex catches the public class…
    expect(first).not.toContain("publicHandler"); // …but no methods (the shallow surface)

    // 2. Preload the Java grammar.
    await preloadTreeSitter(["java"]);

    // 3. Re-analyze the UNCHANGED content. The cache key is backend-tagged, so the
    //    `…#rx` entry is NOT served — extraction re-runs via tree-sitter.
    opAnalyze(root, { source: root }, DEPS);
    const second = javaSymbolTitles(root);
    expect(second).toContain("publicHandler");
    expect(second).toContain("packagePrivateHandler"); // tree-sitter, not the stale regex cache
  });
});
