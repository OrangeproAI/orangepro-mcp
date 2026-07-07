/**
 * Resolver-derived subject imports for generated tests.
 *
 * When a generated test has NO import to reuse from a linked existing test, the
 * kit must NOT guess a module specifier from the behavior name (the old
 * `synthesizeImports` slug-guess produced `./feature-slug`, which rarely resolves).
 * Instead, derive the import from the import graph + resolver and emit it ONLY when:
 *   1. a related SOURCE file with a real exported symbol exists, and
 *   2. a relative specifier from the generated test's location is confirmed by the
 *      resolver to point back at that source file.
 * Otherwise return null — the caller marks the test a non-runnable grounded draft
 * rather than fabricate an import.
 *
 * Metadata only: reads export NAMES + resolves specifiers; never copies source text.
 */
import path from "node:path";
import { GraphNode, LocalGraph } from "../graph/ontology.js";
import { resolveImport } from "../resolve/resolver.js";
import { buildExportIndex, ExportKind } from "../resolve/exportIndex.js";

const TS_JS = /\.(ts|tsx|js|jsx|mjs|cjs|mts|cts)$/i;
const TEST_FILE = /(\.(test|spec)\.[cm]?[jt]sx?$)|(_test\.[a-z]+$)|(_spec\.[a-z]+$)|((^|\/)test_[^/]+\.[a-z]+$)/i;

export interface DerivedImport {
  /** The full import line, e.g. `import { addToCart } from "../src/cart.js";`. */
  line: string;
  /** The exported symbol imported. */
  symbol: string;
  /** Relative source file (repo path) the import resolves to. */
  source_file: string;
}

/** Drop a TS/JS extension so a relative specifier can be rebuilt with the right one. */
function stripExt(p: string): string {
  return p.replace(/\.(tsx?|jsx?|mjs|cjs|mts|cts)$/i, "");
}

/**
 * Choose a real exported symbol to import: prefer a named export whose name relates
 * to the behavior feature, else the first named (non-type) export, else a default
 * export. Returns null when the file exposes no importable runtime binding.
 */
function pickSymbol(local: Map<string, ExportKind>, feature: string): { name: string; isDefault: boolean } | null {
  const runtime = [...local].filter(([, k]) => k !== "type"); // type-only exports aren't runnable subjects
  if (runtime.length === 0) return null;
  const nonDefault = runtime.filter(([, k]) => k !== "default").map(([n]) => n);
  const hasDefault = runtime.some(([, k]) => k === "default");
  const feat = feature.toLowerCase().replace(/[^a-z0-9]/g, "");
  if (feat) {
    const match = nonDefault.find((n) => {
      const ln = n.toLowerCase();
      return ln.includes(feat) || feat.includes(ln);
    });
    if (match) return { name: match, isDefault: false };
  }
  if (nonDefault.length > 0) return { name: nonDefault[0], isDefault: false };
  if (hasDefault) return { name: "Subject", isDefault: true };
  return null;
}

function importLine(symbol: { name: string; isDefault: boolean }, specifier: string): string {
  const spec = JSON.stringify(specifier);
  return symbol.isDefault ? `import ${symbol.name} from ${spec};` : `import { ${symbol.name} } from ${spec};`;
}

/**
 * Derive a VALIDATED subject import for a generated test, or null if none can be
 * derived without guessing. TS/JS only (the resolver does not handle Python/Go
 * import systems). `candidateSourceFiles` are the behavior's related source files,
 * import-resolved first (see `relatedFilePaths`).
 */
export function deriveSubjectImport(
  graph: LocalGraph,
  behavior: GraphNode,
  candidateSourceFiles: string[],
  generatedTestRelPath: string,
  framework: string
): DerivedImport | null {
  const fw = framework.toLowerCase();
  if (fw.includes("pytest") || fw.includes("python") || fw.includes("go")) return null;

  const root = graph.workspace.root;
  const testAbs = path.join(root, generatedTestRelPath);
  const testDir = path.dirname(testAbs);
  const feature = String(behavior.properties.feature ?? behavior.title ?? "");

  for (const rel of candidateSourceFiles) {
    if (!TS_JS.test(rel) || TEST_FILE.test(rel)) continue; // source modules only
    const abs = path.join(root, rel);
    const symbol = pickSymbol(buildExportIndex(abs).local, feature);
    if (!symbol) continue;

    // Build a relative specifier from the generated test's directory to the source.
    let relSpec = path.relative(testDir, stripExt(abs)).split(path.sep).join("/");
    if (!relSpec.startsWith(".")) relSpec = "./" + relSpec;

    // Try the NodeNext `.js` extension first, then extensionless (bundler/classic).
    // The RESOLVER decides which actually points back at the source file, so we
    // never emit a specifier the repo's own config cannot resolve.
    for (const spec of [`${relSpec}.js`, relSpec]) {
      const r = resolveImport(spec, testAbs);
      if (r.resolved && r.resolvedFileName && path.resolve(r.resolvedFileName) === path.resolve(abs)) {
        return { line: importLine(symbol, spec), symbol: symbol.name, source_file: rel };
      }
    }
  }
  return null;
}
