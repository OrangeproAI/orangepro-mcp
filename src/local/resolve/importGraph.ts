// Import graph + per-category resolution metrics (Gate 1 / G-RESOLVE, Phase 1).
//
// Two layers, kept separate from the resolver (resolver.ts is the source of truth
// for resolution targets):
//   1. classifySpecifier — bucket each import specifier by INTENT (asset, relative,
//      path-alias, baseUrl-internal, bare-external, node-builtin), using tsconfig
//      context for the alias/baseUrl categories. Ported from the resolver spike.
//   2. buildImportGraph — extract imports per file via a `ts.createSourceFile`
//      pass (type-only vs runtime aware, with imported binding names), resolve
//      each via resolver.ts, and aggregate the per-category gate metrics.
//
// The `test_to_source` axis gates static association diagnostics
// (see private/spikes/gate-specs-digest.md §resolver B). The internal denominator
// EXCLUDES asset, node-builtin, and bare-external/external — those are not modules
// we expect to resolve inside the repo.
//
// Phase 1 PR-2 (this file): the `barrel_terminal` and `workspace_package` gate
// axes are computed here, the former by walking each test->source barrel import
// through the barrel walker (barrelWalker.ts) to a terminal defining file. The
// remaining `changed_scope` axis needs a diff (a later PR), and wiring these
// resolved terminals into the analyzer's TESTED_BY edges is Phase 2.

import ts from "typescript";
import fs from "node:fs";
import path from "node:path";
import { loadTsConfigFor, resolveImport } from "./resolver.js";
import { ResolverCache, computeResolverGate } from "./resolverCache.js";
import { buildExportIndex } from "./exportIndex.js";
import { walkBarrel } from "./barrelWalker.js";
import { isTestFile } from "../analyze/classify.js";

/** Specifier intent category. Mirrors the resolver spike's classifier. */
export type SpecifierCategory =
  | "asset"
  | "rel-js-specifier"
  | "rel-ts-ext"
  | "rel-extensionless"
  | "path-alias"
  | "baseurl-internal"
  | "bare-external"
  | "node-builtin";

export type FileRole = "test" | "source";

/** Whether an import edge carries runtime values or only types. */
export type ImportKind = "runtime" | "type";

/**
 * One imported binding: its local alias plus the name it refers to in the target
 * module. `imported` is a named import's source name, "default", or "*" (namespace).
 */
export interface ImportBinding {
  local: string;
  imported: string;
}

/** One resolved import edge from a containing file to its (maybe) target. */
export interface ImportEdge {
  from: string;
  fromRole: FileRole;
  specifier: string;
  category: SpecifierCategory;
  /** Whether the edge carries runtime values or only types (`import type`). */
  importKind: ImportKind;
  /** Imported binding names (populated for static imports; empty otherwise). */
  bindings: ImportBinding[];
  resolved: boolean;
  target: string | null;
  targetRole: FileRole | null;
  external: boolean;
}

/** A single gate axis: resolved-out-of-eligible, with the percentage. */
export interface GateAxis {
  /** Eligible denominator count for this axis. */
  n: number;
  /** How many of those resolved to a non-null target. */
  resolved: number;
  /** 100 * resolved / n, rounded to 1dp; null when n === 0. */
  pct: number | null;
}

/**
 * Per-category resolution gate axes (each resolved/eligible). Internal denominators
 * EXCLUDE asset, node-builtin, and external imports — those are not internal modules.
 *
 *  - all_internal            : every internal import, role-agnostic (health only)
 *  - test_file               : every import in a test file (health; includes assets/externals)
 *  - test_internal           : every internal import FROM a test file (the test-health denom)
 *  - test_to_test            : test->internal that RESOLVES to another test file
 *  - test_to_source          : test->internal RUNTIME imports that are NOT test->test
 *                              — gates static assertion diagnostics. Type-only and test->test are
 *                              excluded; an unresolved-internal still counts in the denom,
 *                              so a real resolution failure lowers the gate.
 *  - test_unresolved_internal: test->internal imports that did NOT resolve (diagnostic)
 *  - source_to_source        : source->internal imports (health; will be high)
 *  - barrel_terminal         : of test->source RUNTIME imports that land on a BARREL file
 *                              and carry named/default bindings, how many walk through the
 *                              re-export chain to a terminal defining file (health; barrel
 *                              stress). Namespace-only imports are excluded (cannot attribute
 *                              to a single terminal without binding-use analysis).
 *  - workspace_package       : of path-alias + baseUrl-internal imports (workspace/project-ref
 *                              style), how many resolve to an internal target (health). An alias
 *                              that RESOLVES into node_modules is vendor code, not workspace —
 *                              excluded from the denominator; unresolved aliases stay (failures).
 *
 * TODO(later PR): changed_scope needs a diff. Wiring these resolved terminals into
 * the analyzer's TESTED_BY/COVERS edges is Phase 2.
 */
export interface GateMetrics {
  all_internal: GateAxis;
  test_file: GateAxis;
  test_internal: GateAxis;
  test_to_test: GateAxis;
  test_to_source: GateAxis;
  test_unresolved_internal: GateAxis;
  source_to_source: GateAxis;
  barrel_terminal: GateAxis;
  workspace_package: GateAxis;
}

/** Raw per-category edge counts, so the report is auditable. */
export type CategoryCounts = Record<SpecifierCategory, GateAxis>;

export interface ImportGraphResult {
  edges: ImportEdge[];
  metrics: GateMetrics;
  byCategory: CategoryCounts;
}

/** tsconfig-derived context needed to classify path-alias / baseUrl-internal. */
export interface ClassifyContext {
  /** tsconfig `paths` keys (e.g. "@app/*", "mattermost-redux/*"). */
  pathAliasKeys: string[];
  /** Top-level entry names directly under tsconfig `baseUrl` (extension-stripped). */
  baseUrlTopLevel: Set<string>;
}

const EMPTY_CONTEXT: ClassifyContext = { pathAliasKeys: [], baseUrlTopLevel: new Set() };

const ASSET_RE =
  /\.(scss|sass|css|less|styl|png|jpe?g|gif|svg|webp|ico|bmp|woff2?|ttf|eot|otf|mp4|webm|mp3|wav|avif)$/i;

function isAssetSpecifier(spec: string): boolean {
  return ASSET_RE.test(spec);
}

function matchesPathAlias(spec: string, keys: string[]): boolean {
  return keys.some((k) => {
    if (k.includes("*")) {
      const base = k.slice(0, k.indexOf("*")); // TS wildcard = prefix match
      return spec.startsWith(base);
    }
    return spec === k; // exact alias: exact match only
  });
}

function isBaseUrlInternal(spec: string, ctx: ClassifyContext): boolean {
  if (ctx.baseUrlTopLevel.size === 0) return false;
  const firstSeg = spec.split("/")[0];
  return ctx.baseUrlTopLevel.has(firstSeg);
}

/**
 * Classify an import specifier by intent. `ctx` supplies the tsconfig `paths`
 * keys and `baseUrl` top-level names so alias/baseUrl-internal specifiers are
 * recognized even when (webpack-only) aliases fail TS resolution.
 */
export function classifySpecifier(spec: string, ctx: ClassifyContext = EMPTY_CONTEXT): SpecifierCategory {
  if (isAssetSpecifier(spec)) return "asset";
  if (spec.startsWith(".") || path.isAbsolute(spec)) {
    if (/\.(js|jsx|mjs|cjs)$/.test(spec)) return "rel-js-specifier"; // NodeNext .js -> .ts hazard
    if (/\.(ts|tsx|mts|cts)$/.test(spec)) return "rel-ts-ext";
    return "rel-extensionless";
  }
  if (/^node:/.test(spec)) return "node-builtin";
  if (matchesPathAlias(spec, ctx.pathAliasKeys)) return "path-alias";
  if (isBaseUrlInternal(spec, ctx)) return "baseurl-internal";
  return "bare-external";
}

/**
 * Build the classify context (path-alias keys + baseUrl top-level names) for a
 * file from its nearest tsconfig scope. Cached implicitly via loadTsConfigFor.
 */
export function classifyContextFor(file: string): ClassifyContext {
  const scope = loadTsConfigFor(file);
  const options = scope.options;
  const pathAliasKeys = Object.keys(options.paths ?? {});
  const baseUrlTopLevel = new Set<string>();
  if (options.baseUrl) {
    const baseUrlDir = path.resolve(
      scope.configPath.startsWith("<") ? process.cwd() : path.dirname(scope.configPath),
      options.baseUrl
    );
    try {
      for (const entry of fs.readdirSync(baseUrlDir, { withFileTypes: true })) {
        baseUrlTopLevel.add(entry.name.replace(/\.[mc]?[tj]sx?$/, ""));
      }
    } catch {
      /* no baseUrl dir on disk */
    }
  }
  return { pathAliasKeys, baseUrlTopLevel };
}

/** One extracted import: its module specifier, type-only-ness, and binding names. */
export interface ExtractedImport {
  specifier: string;
  kind: ImportKind;
  /** Imported binding names (populated for static `import`; empty otherwise). */
  bindings: ImportBinding[];
}

/**
 * Extract imports from a file via a lightweight `ts.createSourceFile` pass (no
 * Program / no typecheck). Unlike `ts.preProcessFile`, this distinguishes
 * `import type` / type-only re-exports from runtime imports — type-only edges
 * must NOT count toward static assertion diagnostics — and carries each static import's
 * binding names. Covers static imports/exports, dynamic `import("lit")`, and
 * `require("lit")` with a string-literal argument.
 */
export function extractImports(file: string): ExtractedImport[] {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const sourceFile = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, /*setParentNodes*/ false);
  const imports: ExtractedImport[] = [];

  const moduleText = (node: ts.Expression | undefined): string | null =>
    node && ts.isStringLiteralLike(node) ? node.text : null;

  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node)) {
      const specifier = moduleText(node.moduleSpecifier);
      if (specifier !== null) {
        imports.push({ specifier, kind: importDeclarationKind(node), bindings: importBindings(node) });
      }
    } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
      // Re-export: `export ... from "lit"`. Type-only when `export type ... from`.
      const specifier = moduleText(node.moduleSpecifier);
      if (specifier !== null) {
        imports.push({ specifier, kind: node.isTypeOnly ? "type" : "runtime", bindings: [] });
      }
    } else if (ts.isCallExpression(node)) {
      // Dynamic `import("lit")` or `require("lit")` with a string-literal arg.
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === "require";
      // TODO(low): a concatenated dynamic-import arg yields a phantom specifier; ignored.
      if (isDynamicImport || isRequire) {
        const specifier = moduleText(node.arguments[0]);
        if (specifier !== null) imports.push({ specifier, kind: "runtime", bindings: [] });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);

  return imports;
}

/**
 * Imported binding names for a static import: a default binding, a namespace
 * (`* as ns`, recorded as imported "*"), and/or named imports (carrying any
 * `as` rename's SOURCE name). Side-effect imports bind nothing.
 */
function importBindings(node: ts.ImportDeclaration): ImportBinding[] {
  const clause = node.importClause;
  if (!clause) return [];
  const out: ImportBinding[] = [];
  if (clause.name) out.push({ local: clause.name.text, imported: "default" });
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) {
    out.push({ local: named.name.text, imported: "*" });
  } else if (named && ts.isNamedImports(named)) {
    for (const el of named.elements) {
      if (el.isTypeOnly) continue; // `import { type X }`: a type binding, not a runtime use
      out.push({ local: el.name.text, imported: (el.propertyName ?? el.name).text });
    }
  }
  return out;
}

/**
 * Type-only iff the clause is `import type ...`, OR there is no default binding
 * AND no namespace import AND it has named bindings of which EVERY element is
 * itself `isTypeOnly` (i.e. `import { type A, type B } from ...`). Otherwise runtime.
 */
function importDeclarationKind(node: ts.ImportDeclaration): ImportKind {
  const clause = node.importClause;
  if (!clause) return "runtime"; // side-effect import: `import "lit"` runs code
  if (clause.isTypeOnly) return "type";
  const named = clause.namedBindings;
  const hasNamedElements = named !== undefined && ts.isNamedImports(named);
  if (clause.name === undefined && !(named && ts.isNamespaceImport(named)) && hasNamedElements) {
    const elements = (named as ts.NamedImports).elements;
    if (elements.length > 0 && elements.every((el) => el.isTypeOnly)) return "type";
  }
  return "runtime";
}

/**
 * Thin specifier-only wrapper over `extractImports`, preserving the original
 * `string[]` shape for callers that do not need the runtime/type distinction.
 */
export function extractSpecifiers(file: string): string[] {
  return extractImports(file).map((imp) => imp.specifier);
}

/** An internal-intent specifier is expected to resolve inside the repo. */
function isInternalCategory(category: SpecifierCategory): boolean {
  return (
    category === "rel-js-specifier" ||
    category === "rel-ts-ext" ||
    category === "rel-extensionless" ||
    category === "path-alias" ||
    category === "baseurl-internal"
  );
}

/** An edge counts toward the INTERNAL denominator: internal-intent AND not external. */
function isInternalEdge(edge: ImportEdge): boolean {
  return isInternalCategory(edge.category) && !edge.external;
}

function axis(edges: ImportEdge[], predicate: (e: ImportEdge) => boolean): GateAxis {
  const subset = edges.filter(predicate);
  const resolved = subset.filter((e) => e.resolved).length;
  const n = subset.length;
  return { n, resolved, pct: n ? Number(((100 * resolved) / n).toFixed(1)) : null };
}

/**
 * workspace_package axis: of path-alias + baseUrl-internal imports (the
 * workspace/project-ref style), how many resolve to an INTERNAL target. An
 * alias that RESOLVES into node_modules is conclusively a vendor shim, not
 * workspace code — it leaves the DENOMINATOR entirely (it is not a
 * workspace-resolution failure). An UNRESOLVED alias stays in the denominator:
 * it was internal-intent and genuinely failed.
 */
function workspacePackageAxis(edges: ImportEdge[]): GateAxis {
  const subset = edges.filter(
    (e) => (e.category === "path-alias" || e.category === "baseurl-internal") && !(e.resolved && e.external)
  );
  const n = subset.length;
  const resolved = subset.filter((e) => e.resolved).length;
  return { n, resolved, pct: n ? Number(((100 * resolved) / n).toFixed(1)) : null };
}

/**
 * barrel_terminal axis: among test->source RUNTIME imports that resolve to a
 * BARREL file and carry at least one named/default binding, how many walk
 * through the re-export chain so that EVERY such binding reaches a COVERS-eligible terminal
 * (runtime; type-only terminals and type-only re-export hops do NOT count). Namespace-only imports are excluded (cannot be attributed to a
 * single terminal without binding-use analysis). This is a health metric; the
 * per-link COVERS upgrade lands in Phase 2.
 */
function barrelTerminalAxis(edges: ImportEdge[]): GateAxis {
  let n = 0;
  let resolved = 0;
  for (const e of edges) {
    if (e.fromRole !== "test") continue;
    if (!isInternalEdge(e)) continue;
    if (e.importKind !== "runtime") continue;
    if (!e.resolved || !e.target) continue;
    if (e.targetRole === "test") continue;
    const namedOrDefault = e.bindings.filter((b) => b.imported !== "*");
    if (namedOrDefault.length === 0) continue; // namespace-only: cannot attribute to one terminal
    if (!buildExportIndex(e.target).isBarrel) continue; // only barrel targets are "barrel imports"
    n += 1;
    const target = e.target;
    const allCovered = namedOrDefault.every((b) => walkBarrel(target, b.imported).covered);
    if (allCovered) resolved += 1;
  }
  return { n, resolved, pct: n ? Number(((100 * resolved) / n).toFixed(1)) : null };
}

const ALL_CATEGORIES: SpecifierCategory[] = [
  "rel-js-specifier",
  "rel-ts-ext",
  "rel-extensionless",
  "path-alias",
  "baseurl-internal",
  "bare-external",
  "node-builtin",
  "asset"
];

/** Options for {@link buildImportGraph}. */
export interface BuildImportGraphOptions {
  /**
   * Repo root used to derive a repo-RELATIVE path before classifying a resolved
   * target's role. Without it, `isTestFile` runs on the basename only, which
   * avoids false positives from `tests/`/`spec/` ANCESTOR segments in the
   * absolute path misclassifying a real source target as a test.
   */
  repoRoot?: string;
  /** Persistent resolution cache (Phase 5.4.3). When provided, unchanged-shape runs reuse
   *  module-resolution results; hit-rate is exposed on the cache object. */
  resolverCache?: ResolverCache;
  /**
   * ALL walked file paths (absolute), incl. tsconfig/package.json/lockfiles and any JSON a
   * tsconfig may `extends`. The resolver gate is computed from THIS set, not just the resolved
   * test/source files — otherwise a (possibly extended) config edit, skipped from `files`,
   * would not bust the cache (Codex 5.4.3). Defaults to `files` paths when omitted.
   */
  gateFiles?: string[];
}

/**
 * Build the import graph for a set of role-tagged files: extract imports,
 * classify and resolve each, then aggregate the per-category gate metrics.
 * Returns the edges, the gate axes (`metrics`), and raw per-category counts.
 */
export function buildImportGraph(
  files: { path: string; role: FileRole }[],
  opts: BuildImportGraphOptions = {}
): ImportGraphResult {
  const { repoRoot } = opts;
  const roleByPath = new Map<string, FileRole>();
  for (const f of files) roleByPath.set(path.resolve(f.path), f.role);

  // Validate the resolution cache against the current filesystem shape + config (gate);
  // a structural/config change discards all cached resolutions (no stale survival). The
  // gate + known-target set come from the FULL walked file set (incl. tsconfig/package.json),
  // so a config edit busts the cache and a cached internal target must be a real walked file.
  const rcache = opts.resolverCache;
  const gateFiles = opts.gateFiles ?? files.map((f) => f.path);
  if (rcache) rcache.useGate(computeResolverGate(gateFiles));

  const targetRoleOf = (target: string | null): FileRole | null => {
    if (!target) return null;
    const known = roleByPath.get(path.resolve(target));
    if (known) return known;
    // Classify on a repo-relative path (or basename fallback) so `tests/`/`spec/`
    // ANCESTOR dir segments in the absolute path don't misclassify a source target.
    const rel = repoRoot ? path.relative(repoRoot, target) : path.basename(target);
    return isTestFile(rel) ? "test" : "source";
  };

  const edges: ImportEdge[] = [];
  for (const file of files) {
    const ctx = classifyContextFor(file.path);
    for (const imp of extractImports(file.path)) {
      const category = classifySpecifier(imp.specifier, ctx);
      const r = rcache
        ? rcache.resolve(path.dirname(file.path), imp.specifier, () => resolveImport(imp.specifier, file.path))
        : resolveImport(imp.specifier, file.path);
      edges.push({
        from: file.path,
        fromRole: file.role,
        specifier: imp.specifier,
        category,
        importKind: imp.kind,
        bindings: imp.bindings,
        resolved: r.resolved,
        target: r.resolvedFileName,
        targetRole: targetRoleOf(r.resolvedFileName),
        external: r.isExternal
      });
    }
  }

  const isTestInternal = (e: ImportEdge): boolean => e.fromRole === "test" && isInternalEdge(e);

  const metrics: GateMetrics = {
    all_internal: axis(edges, isInternalEdge),
    test_file: axis(edges, (e) => e.fromRole === "test"),
    // All internal imports from a test file — the test-health denominator.
    test_internal: axis(edges, isTestInternal),
    // Internal test imports that resolve to another test file (test helpers etc.).
    test_to_test: axis(edges, (e) => isTestInternal(e) && e.resolved && e.targetRole === "test"),
    // THE confirmed-coverage gate: internal RUNTIME test imports that are not
    // test->test. Type-only and test->test are excluded; an unresolved-internal
    // still counts in the denom, so a real resolution failure lowers the gate.
    test_to_source: axis(
      edges,
      (e) => isTestInternal(e) && e.importKind === "runtime" && !(e.resolved && e.targetRole === "test")
    ),
    // Diagnostic: internal test imports that failed to resolve at all.
    test_unresolved_internal: axis(edges, (e) => isTestInternal(e) && !e.resolved),
    source_to_source: axis(edges, (e) => e.fromRole === "source" && isInternalEdge(e)),
    barrel_terminal: barrelTerminalAxis(edges),
    workspace_package: workspacePackageAxis(edges)
  };

  const byCategory = {} as CategoryCounts;
  for (const cat of ALL_CATEGORIES) {
    byCategory[cat] = axis(edges, (e) => e.category === cat);
  }

  return { edges, metrics, byCategory };
}
