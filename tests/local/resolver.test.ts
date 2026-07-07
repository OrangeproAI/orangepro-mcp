import { describe, it, expect, beforeEach } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  resolveImport,
  loadTsConfigFor,
  resetResolverCaches
} from "../../src/local/resolve/resolver.js";
import {
  classifySpecifier,
  classifyContextFor,
  extractSpecifiers,
  extractImports,
  buildImportGraph,
  type ClassifyContext,
  type ImportEdge
} from "../../src/local/resolve/importGraph.js";

const FIX = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/resolver");
const TEST_FILE = resolve(FIX, "impl.test.ts");
const SERVICE_FILE = resolve(FIX, "service.ts");
const IMPL_TS = resolve(FIX, "impl.ts");
const UTIL_INDEX_TS = resolve(FIX, "util/index.ts");
const MODEL_TS = resolve(FIX, "model.ts");
const SETUP_TEST_TS = resolve(FIX, "setup.test.ts");
const STYLES = resolve(FIX, "styles.scss");

const BUN = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/resolver-bundler");
const FEATURE_TEST = resolve(BUN, "src/feature.test.ts");
const BUN_FOO = resolve(BUN, "src/app/foo.ts");
const BUN_UTIL = resolve(BUN, "src/util.ts");

beforeEach(() => {
  resetResolverCaches();
});

describe("resolver — ts.resolveModuleName", () => {
  it("resolves a NodeNext .js specifier to the sibling .ts terminal (the core proof)", () => {
    const r = resolveImport("./impl.js", TEST_FILE);
    expect(r.resolved).toBe(true);
    expect(r.isExternal).toBe(false);
    expect(r.resolvedFileName).toBe(IMPL_TS);
    // wrong-terminal guard: it must NOT land on the test file, service, or util.
    expect(r.resolvedFileName).not.toBe(TEST_FILE);
    expect(r.resolvedFileName).not.toBe(SERVICE_FILE);
    expect(r.resolvedFileName).not.toBe(UTIL_INDEX_TS);
    expect(r.resolvedFileName).not.toBe(STYLES);
  });

  it("resolves an extensionless / index import to util/index.ts", () => {
    const r = resolveImport("./util", TEST_FILE);
    expect(r.resolved).toBe(true);
    expect(r.resolvedFileName).toBe(UTIL_INDEX_TS);
  });

  it("flags a bare external import as external", () => {
    const r = resolveImport("vitest", TEST_FILE);
    // vitest is installed in the workspace, so it resolves but is external.
    expect(r.isExternal).toBe(true);
  });

  it("resolves a node: builtin without an internal terminal", () => {
    const r = resolveImport("node:path", TEST_FILE);
    // node builtins have no internal .ts terminal; never counted as internal.
    expect(r.resolved).toBe(false);
  });

  it("loadTsConfigFor finds the fixture tsconfig and caches the scope by path", () => {
    const a = loadTsConfigFor(TEST_FILE);
    const b = loadTsConfigFor(IMPL_TS);
    expect(a.configPath).toBe(resolve(FIX, "tsconfig.json"));
    expect(a).toBe(b); // same scope object (cached by resolved tsconfig path)
  });
});

describe("classifySpecifier", () => {
  const ctx: ClassifyContext = { pathAliasKeys: ["@app/*"], baseUrlTopLevel: new Set(["components"]) };

  it("classifies each specifier into the right category", () => {
    expect(classifySpecifier("./impl.js")).toBe("rel-js-specifier");
    expect(classifySpecifier("../impl.ts")).toBe("rel-ts-ext");
    expect(classifySpecifier("./util")).toBe("rel-extensionless");
    expect(classifySpecifier("./styles.scss")).toBe("asset");
    expect(classifySpecifier("./icon.png")).toBe("asset");
    expect(classifySpecifier("node:path")).toBe("node-builtin");
    expect(classifySpecifier("vitest")).toBe("bare-external");
  });

  it("uses tsconfig context for path-alias and baseUrl-internal", () => {
    expect(classifySpecifier("@app/foo", ctx)).toBe("path-alias");
    expect(classifySpecifier("components/Button", ctx)).toBe("baseurl-internal");
    expect(classifySpecifier("react", ctx)).toBe("bare-external");
  });

  it("wildcard alias is a prefix match; an EXACT alias matches only itself (no false positive)", () => {
    const wild: ClassifyContext = { pathAliasKeys: ["@app/*"], baseUrlTopLevel: new Set() };
    // wildcard "@app/*" prefix-matches sub-paths but not an unrelated scope.
    expect(classifySpecifier("@app/foo", wild)).toBe("path-alias");
    expect(classifySpecifier("@apple/x", wild)).toBe("bare-external");

    const exact: ClassifyContext = { pathAliasKeys: ["@app"], baseUrlTopLevel: new Set() };
    expect(classifySpecifier("@app", exact)).toBe("path-alias");
    expect(classifySpecifier("@apple/x", exact)).toBe("bare-external"); // not a prefix match
    expect(classifySpecifier("@app/foo", exact)).toBe("bare-external"); // exact alias, not a prefix
  });
});

describe("extractSpecifiers / extractImports", () => {
  it("lists every import specifier in the fixture test file", () => {
    const specs = extractSpecifiers(TEST_FILE);
    expect(specs).toEqual(
      expect.arrayContaining([
        "./impl.js",
        "./util",
        "./model.js",
        "./setup.test.js",
        "./styles.scss",
        "node:path",
        "vitest"
      ])
    );
  });

  it("flags `import type` as kind=type and value imports as kind=runtime", () => {
    const bySpec = new Map(extractImports(TEST_FILE).map((i) => [i.specifier, i.kind]));
    expect(bySpec.get("./model.js")).toBe("type"); // `import type { Model }`
    expect(bySpec.get("./impl.js")).toBe("runtime");
    expect(bySpec.get("./util")).toBe("runtime");
    expect(bySpec.get("./styles.scss")).toBe("runtime"); // side-effect import runs code
  });
});

describe("buildImportGraph — gate metrics", () => {
  const files: { path: string; role: "test" | "source" }[] = [
    { path: TEST_FILE, role: "test" },
    { path: SERVICE_FILE, role: "source" },
    { path: IMPL_TS, role: "source" },
    { path: UTIL_INDEX_TS, role: "source" }
  ];
  const build = () => buildImportGraph(files, { repoRoot: FIX });

  const findEdge = (edges: ImportEdge[], from: string, spec: string): ImportEdge | undefined =>
    edges.find((e) => e.from === from && e.specifier === spec);

  it("resolves the .js specifier edge to the correct .ts terminal", () => {
    const { edges } = build();
    const jsEdge = findEdge(edges, TEST_FILE, "./impl.js");
    expect(jsEdge).toBeDefined();
    expect(jsEdge?.category).toBe("rel-js-specifier");
    expect(jsEdge?.importKind).toBe("runtime");
    expect(jsEdge?.resolved).toBe(true);
    expect(jsEdge?.target).toBe(IMPL_TS);
    expect(jsEdge?.targetRole).toBe("source");
  });

  it("test_to_source counts only runtime test->source imports (excludes type-only + test->test)", () => {
    const { metrics } = build();
    // test file has 4 internal imports: ./impl.js + ./util (runtime->source, COUNT),
    // ./model.js (type-only, EXCLUDED), ./setup.test.js (test->test, EXCLUDED).
    expect(metrics.test_to_source.n).toBe(2);
    expect(metrics.test_to_source.resolved).toBe(2);
    expect(metrics.test_to_source.pct).toBe(100);
  });

  it("the type-only ./model.js edge is kind=type and is NOT in test_to_source", () => {
    const { edges } = build();
    const modelEdge = findEdge(edges, TEST_FILE, "./model.js");
    expect(modelEdge?.importKind).toBe("type");
    expect(modelEdge?.resolved).toBe(true);
    expect(modelEdge?.target).toBe(MODEL_TS);
    // It is an internal test import (so it IS in the test_internal denom)…
    expect(metricsTestInternalSpecs(edges)).toContain("./model.js");
    // …but excluded from the coverage gate because it carries no runtime values.
    expect(testToSourceSpecs(edges)).not.toContain("./model.js");
  });

  it("the ./setup.test.js edge lands in test_to_test, NOT test_to_source", () => {
    const { edges, metrics } = build();
    const setupEdge = findEdge(edges, TEST_FILE, "./setup.test.js");
    expect(setupEdge?.resolved).toBe(true);
    expect(setupEdge?.target).toBe(SETUP_TEST_TS);
    expect(setupEdge?.targetRole).toBe("test");
    expect(metrics.test_to_test.n).toBe(1);
    expect(metrics.test_to_test.resolved).toBe(1);
    expect(testToSourceSpecs(edges)).not.toContain("./setup.test.js");
  });

  it("test_internal counts every internal test import (runtime + type)", () => {
    const { metrics } = build();
    // ./impl.js, ./util, ./model.js, ./setup.test.js — all 4 internal, all resolve.
    expect(metrics.test_internal.n).toBe(4);
    expect(metrics.test_internal.resolved).toBe(4);
    expect(metrics.test_unresolved_internal.n).toBe(0);
  });

  it("test_file axis includes asset + external imports (health, not coverage)", () => {
    const { metrics } = build();
    // 7 imports in the test file; the 2 unresolved are ./styles.scss + node:path.
    expect(metrics.test_file.n).toBe(7);
    expect(metrics.test_file.resolved).toBe(5);
    expect(metrics.test_file.pct).toBe(71.4);
  });

  it("excludes asset and external from the internal denominator", () => {
    const { metrics, byCategory } = build();
    // all_internal = test internal(4) + service(1 source->source) = 5, all resolve.
    expect(metrics.all_internal.n).toBe(5);
    expect(metrics.all_internal.resolved).toBe(5);
    expect(metrics.all_internal.pct).toBe(100);
    // asset/node-builtin/bare-external are NOT internal.
    expect(byCategory.asset.n).toBe(1);
    expect(byCategory["node-builtin"].n).toBe(1);
    expect(byCategory["bare-external"].n).toBe(1);
  });

  it("source_to_source resolves the service->impl internal import", () => {
    const { metrics } = build();
    expect(metrics.source_to_source.n).toBe(1);
    expect(metrics.source_to_source.resolved).toBe(1);
    expect(metrics.source_to_source.pct).toBe(100);
  });

  it("wrong-terminal guard: internal imports resolve only to expected terminals", () => {
    const { edges } = build();
    const internal = edges.filter(
      (e) =>
        e.resolved &&
        (e.category === "rel-js-specifier" ||
          e.category === "rel-ts-ext" ||
          e.category === "rel-extensionless")
    );
    // Exactly the 4 resolved relative imports across test + source files:
    //   test: ./impl.js, ./util, ./model.js, ./setup.test.js ; source: service->./impl.js
    // (./impl.js resolves to IMPL_TS from BOTH test and service = 5 edges).
    expect(internal.length).toBe(5);
    const allowed = new Set([IMPL_TS, UTIL_INDEX_TS, MODEL_TS, SETUP_TEST_TS]);
    for (const e of internal) {
      expect(allowed.has(e.target as string)).toBe(true);
    }
  });
});

// Specifiers in the test_to_source gate (internal runtime test->non-test imports).
function testToSourceSpecs(edges: ImportEdge[]): string[] {
  return edges
    .filter(
      (e) =>
        e.fromRole === "test" &&
        e.importKind === "runtime" &&
        !e.external &&
        e.category !== "asset" &&
        e.category !== "node-builtin" &&
        e.category !== "bare-external" &&
        !(e.resolved && e.targetRole === "test")
    )
    .map((e) => e.specifier);
}

// Specifiers in the test_internal denominator (all internal test imports).
function metricsTestInternalSpecs(edges: ImportEdge[]): string[] {
  return edges
    .filter(
      (e) =>
        e.fromRole === "test" &&
        !e.external &&
        e.category !== "asset" &&
        e.category !== "node-builtin" &&
        e.category !== "bare-external"
    )
    .map((e) => e.specifier);
}

describe("buildImportGraph — bundler path-alias + baseUrl resolution", () => {
  it("resolveImport follows tsconfig paths and baseUrl to the real terminals", () => {
    const foo = resolveImport("@app/foo", FEATURE_TEST);
    expect(foo.resolved).toBe(true);
    expect(foo.isExternal).toBe(false);
    expect(foo.resolvedFileName).toBe(BUN_FOO);

    const util = resolveImport("util", FEATURE_TEST);
    expect(util.resolved).toBe(true);
    expect(util.isExternal).toBe(false);
    expect(util.resolvedFileName).toBe(BUN_UTIL); // baseUrl, NOT the node:util builtin
  });

  it("classifyContextFor exposes the tsconfig paths keys and baseUrl top-level names", () => {
    const ctx = classifyContextFor(FEATURE_TEST);
    expect(ctx.pathAliasKeys).toContain("@app/*");
    expect([...ctx.baseUrlTopLevel]).toEqual(expect.arrayContaining(["app", "util"]));
  });

  it("classifySpecifier buckets the alias and baseUrl specifiers via that context", () => {
    const ctx = classifyContextFor(FEATURE_TEST);
    expect(classifySpecifier("@app/foo", ctx)).toBe("path-alias");
    expect(classifySpecifier("util", ctx)).toBe("baseurl-internal");
  });
});
