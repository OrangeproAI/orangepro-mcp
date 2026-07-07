import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { deriveSubjectImport } from "../../src/local/generate/deriveImports.js";
import { resetResolverCaches } from "../../src/local/resolve/resolver.js";
import { resetExportIndexCache } from "../../src/local/resolve/exportIndex.js";
import { GraphNode, LocalGraph } from "../../src/local/graph/ontology.js";

const dirs: string[] = [];
afterEach(() => {
  resetResolverCaches();
  resetExportIndexCache();
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-derive-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(join(abs, ".."), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function graphFor(root: string): LocalGraph {
  return { workspace: { root } } as unknown as LocalGraph;
}

function behaviorFor(feature: string): GraphNode {
  return { properties: { feature }, title: feature } as unknown as GraphNode;
}

describe("deriveSubjectImport (PLAN 6.5 — resolver-derived imports)", () => {
  it("derives a VALIDATED relative import with a real export and a NodeNext .js ext", () => {
    const root = repo({
      "package.json": JSON.stringify({ name: "x" }),
      "src/cart.ts": "export function addToCart(n: number){ return n + 1 }\n"
    });
    const got = deriveSubjectImport(
      graphFor(root),
      behaviorFor("cart"),
      ["src/cart.ts"],
      "orangepro_generated/x.test.ts",
      "vitest"
    );
    expect(got).not.toBeNull();
    expect(got!.symbol).toBe("addToCart");
    expect(got!.source_file).toBe("src/cart.ts");
    // Relative specifier from orangepro_generated/ up to src/cart, NodeNext .js ext.
    expect(got!.line).toContain("addToCart");
    expect(got!.line).toMatch(/from "\.\.\/src\/cart\.js"/);
  });

  it("returns null (no fabrication) when the file exposes no runtime export", () => {
    const root = repo({
      "package.json": JSON.stringify({ name: "x" }),
      "src/types.ts": "export type Cart = { items: number };\n" // type-only: not a runnable subject
    });
    const got = deriveSubjectImport(graphFor(root), behaviorFor("cart"), ["src/types.ts"], "t/x.test.ts", "vitest");
    expect(got).toBeNull();
  });

  it("returns null when no candidate file resolves back to a real source", () => {
    const root = repo({ "package.json": JSON.stringify({ name: "x" }) });
    const got = deriveSubjectImport(graphFor(root), behaviorFor("ghost"), ["src/missing.ts"], "t/x.test.ts", "vitest");
    expect(got).toBeNull();
  });

  it("returns null for Python/Go (resolver handles TS/JS only)", () => {
    const root = repo({
      "package.json": JSON.stringify({ name: "x" }),
      "src/cart.ts": "export function addToCart(n: number){ return n + 1 }\n"
    });
    expect(deriveSubjectImport(graphFor(root), behaviorFor("cart"), ["src/cart.ts"], "t/x.test.py", "pytest")).toBeNull();
  });

  it("prefers a named export whose name relates to the behavior feature", () => {
    const root = repo({
      "package.json": JSON.stringify({ name: "x" }),
      "src/cart.ts": "export function unrelated(){ return 0 }\nexport function checkout(){ return 1 }\n"
    });
    const got = deriveSubjectImport(graphFor(root), behaviorFor("checkout"), ["src/cart.ts"], "g/x.test.ts", "vitest");
    expect(got).not.toBeNull();
    expect(got!.symbol).toBe("checkout");
  });
});
