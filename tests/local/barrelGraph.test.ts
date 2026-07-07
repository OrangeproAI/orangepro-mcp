import { describe, it, expect, beforeEach } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  buildImportGraph,
  extractImports,
  type FileRole
} from "../../src/local/resolve/importGraph.js";
import { resetResolverCaches } from "../../src/local/resolve/resolver.js";
import { resetExportIndexCache } from "../../src/local/resolve/exportIndex.js";

const BARREL = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/barrel");
const CONSUMER = resolve(BARREL, "consumer.test.ts");

const BUN = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/resolver-bundler");
const FEATURE_TEST = resolve(BUN, "src/feature.test.ts");

beforeEach(() => {
  resetResolverCaches();
  resetExportIndexCache();
});

describe("extractImports — binding names", () => {
  it("captures named, default, and namespace import bindings", () => {
    const imports = extractImports(CONSUMER);
    const bySpecBindings = imports.map((i) => ({ spec: i.specifier, bindings: i.bindings }));
    const named = bySpecBindings.find((i) => i.spec === "./index.js" && i.bindings.length === 2);
    expect(named?.bindings).toEqual([
      { local: "saveUser", imported: "saveUser" },
      { local: "deleteUser", imported: "deleteUser" }
    ]);
    const ns = bySpecBindings.find((i) => i.bindings.some((b) => b.imported === "*"));
    expect(ns?.bindings).toEqual([{ local: "everything", imported: "*" }]);
  });
});

describe("buildImportGraph — barrel_terminal axis", () => {
  it("counts test->source barrel imports that walk to a terminal; ambiguous ones fail", () => {
    const files: { path: string; role: FileRole }[] = [{ path: CONSUMER, role: "test" }];
    const { metrics } = buildImportGraph(files, { repoRoot: BARREL });
    // 2 barrel imports with named bindings: ./index.js (both reach terminals) +
    // ./ambig/index.js (dup is ambiguous). ./more.js is NOT a barrel and the
    // namespace `* as everything` import is excluded.
    expect(metrics.barrel_terminal.n).toBe(2);
    expect(metrics.barrel_terminal.resolved).toBe(1);
    expect(metrics.barrel_terminal.pct).toBe(50);
  });
});

describe("buildImportGraph — workspace_package axis", () => {
  it("counts path-alias + baseUrl-internal imports resolving to internal targets", () => {
    const files: { path: string; role: FileRole }[] = [{ path: FEATURE_TEST, role: "test" }];
    const { metrics } = buildImportGraph(files, { repoRoot: BUN });
    // @app/foo (path-alias) + util (baseUrl-internal), both resolve to src/*.
    expect(metrics.workspace_package.n).toBe(2);
    expect(metrics.workspace_package.resolved).toBe(2);
    expect(metrics.workspace_package.pct).toBe(100);
  });

  it("is empty (pct null) when a fixture has no alias/baseUrl imports", () => {
    const files: { path: string; role: FileRole }[] = [{ path: CONSUMER, role: "test" }];
    const { metrics } = buildImportGraph(files, { repoRoot: BARREL });
    expect(metrics.workspace_package.n).toBe(0);
    expect(metrics.workspace_package.pct).toBeNull();
  });

  it("an alias that resolves INTO node_modules leaves the denominator entirely", () => {
    const VEN = resolve(dirname(fileURLToPath(import.meta.url)), "__fixtures__/resolver-vendor");
    const files: { path: string; role: FileRole }[] = [
      { path: resolve(VEN, "src/feature.test.ts"), role: "test" }
    ];
    const { metrics, edges } = buildImportGraph(files, { repoRoot: VEN });
    // Sanity: the vendor alias DID resolve, into node_modules (external).
    const vendor = edges.find((e) => e.specifier === "@vendor/ui");
    expect(vendor?.category).toBe("path-alias");
    expect(vendor?.resolved).toBe(true);
    expect(vendor?.external).toBe(true);
    // Only @app/foo counts: the vendor shim is not a workspace-resolution failure.
    expect(metrics.workspace_package.n).toBe(1);
    expect(metrics.workspace_package.resolved).toBe(1);
    expect(metrics.workspace_package.pct).toBe(100);
  });
});

describe("buildImportGraph — barrel_terminal excludes type-only terminals", () => {
  const TYPE_CONSUMER = resolve(BARREL, "type-consumer.test.ts");

  it("a runtime import of a TYPE name through a barrel is counted but not resolved", () => {
    const files: { path: string; role: FileRole }[] = [{ path: TYPE_CONSUMER, role: "test" }];
    const { metrics } = buildImportGraph(files, { repoRoot: BARREL });
    // Two barrel imports: realFn (runtime -> resolved) and Model (type -> not resolved).
    expect(metrics.barrel_terminal.n).toBe(2);
    expect(metrics.barrel_terminal.resolved).toBe(1);
    expect(metrics.barrel_terminal.pct).toBe(50);
  });
});

describe("buildImportGraph — default through a star barrel is never confirmed", () => {
  const DEFAULT_CONSUMER = resolve(BARREL, "default-consumer.test.ts");

  it("a default import through a star barrel is counted but NOT resolved (TS forwards no default)", () => {
    const files: { path: string; role: FileRole }[] = [{ path: DEFAULT_CONSUMER, role: "test" }];
    const { metrics } = buildImportGraph(files, { repoRoot: BARREL });
    expect(metrics.barrel_terminal.n).toBe(1);
    expect(metrics.barrel_terminal.resolved).toBe(0);
    expect(metrics.barrel_terminal.pct).toBe(0);
  });
});

describe("extractImports / barrel_terminal — element-level type bindings are not runtime uses", () => {
  const MIXED = resolve(BARREL, "mixed-type-consumer.test.ts");

  it("strips `import { type X }` from the binding list (only the runtime binding remains)", () => {
    const imports = extractImports(MIXED);
    const named = imports.find((i) => i.specifier === "./runtime-barrel.js");
    expect(named?.bindings).toEqual([{ local: "realFn", imported: "realFn" }]);
  });

  it("counts only the runtime binding in barrel_terminal", () => {
    const files: { path: string; role: FileRole }[] = [{ path: MIXED, role: "test" }];
    const { metrics } = buildImportGraph(files, { repoRoot: BARREL });
    expect(metrics.barrel_terminal.n).toBe(1);
    expect(metrics.barrel_terminal.resolved).toBe(1);
  });
});
