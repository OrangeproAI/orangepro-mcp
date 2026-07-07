// Per-file export index (Gate 1 / G-RESOLVE, Phase 1 PR-2).
//
// For one file, list (a) the bindings it EXPORTS whose terminal definition is
// the file itself, and (b) its re-export directives (`export ... from`). The
// barrel walker (barrelWalker.ts) consumes this to follow re-export chains to a
// terminal defining file.
//
// PARSE-ONLY: a single `ts.createSourceFile` pass, NO `Program`/`TypeChecker`.
// The confirmed-safety spike proved this parse-only path is false-confirm-safe
// (see private/spikes/confirmed). A re-export of an IMPORTED binding
// (`import { x } from "./m"; export { x }`) is synthesized into a named
// re-export so the walker follows it to the real definition rather than stopping
// at the re-exporting file. Type-only-ness is tracked per re-exported name and
// per local binding (kind "type") so the walker never treats a type as a
// COVERS-eligible runtime terminal (gate-specs-digest.md §resolver: type-only
// targets are NOT terminal impl).

import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

/** Kind of an exported binding. The "type" kind is NOT terminal impl. */
export type ExportKind =
  | "function"
  | "class"
  | "const"
  | "type"
  | "default"
  | "namespace"
  | "unknown";

/** `export * from "./m"` (optionally type-only). */
export interface ReExportStar {
  kind: "star";
  specifier: string;
  isTypeOnly: boolean;
}

/** `export { a, b as c } from "./m"` — or a synthesized re-export of an imported binding. */
export interface ReExportNamed {
  kind: "named";
  specifier: string;
  /** Statement-level `export type { ... } from`. */
  isTypeOnly: boolean;
  /**
   * Each: `source` = name in the TARGET module; `exported` = name exposed here;
   * `isTypeOnly` = effective (statement OR element-level `export { type x }`).
   */
  names: { source: string; exported: string; isTypeOnly: boolean }[];
}

export type ReExport = ReExportStar | ReExportNamed;

/** The export surface of a single file. */
export interface ExportIndex {
  /** Absolute path of the indexed file. */
  file: string;
  /** Exported bindings DEFINED in this file (name exposed here -> kind). */
  local: Map<string, ExportKind>;
  /** `export ... from` directives (plus synthesized re-exports of imported bindings). */
  reexports: ReExport[];
  /** True when the file has any re-export directive (i.e. it is a barrel). */
  isBarrel: boolean;
}

/** A locally bound import: `local` name in this file <- `source` name in `specifier`. */
interface LocalImport {
  specifier: string;
  /** name in the target module: a named import's source, "default", or "*". */
  source: string;
  /** `import type {x}` / `import {type x}`: a re-export of this binding is type-only. */
  typeOnly: boolean;
}

const EMPTY_INDEX = (file: string): ExportIndex => ({
  file,
  local: new Map(),
  reexports: [],
  isBarrel: false
});

// Cache by `absPath + ":" + mtimeMs` so an edited file busts its own entry; a
// long-lived MCP process never serves a stale index after edits. Mirrors the
// resolver's scope cache.
const indexCache = new Map<string, ExportIndex>();

function cacheKey(file: string): string {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(file).mtimeMs;
  } catch {
    /* unreadable file — key on mtime 0 */
  }
  return `${path.resolve(file)}:${mtimeMs}`;
}

/**
 * Build (and memoize) the export index for `file`. Returns an empty index for
 * an unreadable file rather than throwing.
 */
export function buildExportIndex(file: string): ExportIndex {
  const key = cacheKey(file);
  const cached = indexCache.get(key);
  if (cached) return cached;
  const index = computeExportIndex(file);
  indexCache.set(key, index);
  return index;
}

/** Clear the process-level export-index cache. Call at the START of an analyze run. */
export function resetExportIndexCache(): void {
  indexCache.clear();
}

function modifierFlags(node: ts.Node): ts.ModifierFlags {
  return ts.canHaveModifiers(node) ? ts.getCombinedModifierFlags(node as ts.Declaration) : ts.ModifierFlags.None;
}

/** Collect identifier names from a binding name (identifier or destructuring pattern). */
function bindingNames(name: ts.BindingName, out: string[]): void {
  if (ts.isIdentifier(name)) {
    out.push(name.text);
    return;
  }
  for (const el of name.elements) {
    if (ts.isBindingElement(el)) bindingNames(el.name, out);
  }
}

function moduleText(node: ts.Expression | undefined): string | null {
  return node && ts.isStringLiteralLike(node) ? node.text : null;
}

/**
 * Kind for a `namespace N { ... }`: "namespace" (runtime object) only when it is
 * INSTANTIATED. TS erases a namespace whose body holds only interfaces, type
 * aliases, and uninstantiated nested namespaces — and any ambient (`declare`)
 * namespace — so those must be kind "type" (never COVERS-eligible).
 */
function namespaceKind(node: ts.ModuleDeclaration): ExportKind {
  if (modifierFlags(node) & ts.ModifierFlags.Ambient) return "type"; // `declare namespace` is erased
  return isInstantiatedNamespace(node) ? "namespace" : "type";
}

function isInstantiatedNamespace(node: ts.ModuleDeclaration): boolean {
  const body = node.body;
  if (!body) return false;
  if (ts.isModuleDeclaration(body)) return isInstantiatedNamespace(body); // `namespace A.B { ... }`
  if (!ts.isModuleBlock(body)) return false;
  return body.statements.some((s) => {
    if (ts.isInterfaceDeclaration(s) || ts.isTypeAliasDeclaration(s)) return false;
    if (ts.isModuleDeclaration(s)) return isInstantiatedNamespace(s);
    return true; // any value declaration or executable statement instantiates
  });
}

function computeExportIndex(file: string): ExportIndex {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return EMPTY_INDEX(path.resolve(file));
  }
  const abs = path.resolve(file);
  const sourceFile = ts.createSourceFile(abs, text, ts.ScriptTarget.Latest, /*setParentNodes*/ false);

  // Pass 1: top-level declarations (name -> kind, whether exported or not) and
  // import bindings — both needed to resolve `export { x }` (no `from`).
  const declared = new Map<string, ExportKind>();
  const localImports = new Map<string, LocalImport>();
  for (const stmt of sourceFile.statements) {
    collectDeclarations(stmt, declared);
    collectImports(stmt, localImports);
  }

  // Pass 2: exports + re-exports.
  const local = new Map<string, ExportKind>();
  const reexports: ReExport[] = [];
  for (const stmt of sourceFile.statements) {
    collectExports(stmt, declared, localImports, local, reexports);
  }

  return { file: abs, local, reexports, isBarrel: reexports.length > 0 };
}

function collectDeclarations(node: ts.Statement, declared: Map<string, ExportKind>): void {
  // An ambient declaration (`declare function` etc., or anything in a .d.ts) is
  // erased at emit — its binding is types-only for coverage purposes.
  const ambient = (modifierFlags(node) & ts.ModifierFlags.Ambient) !== 0;
  const runtime = (kind: ExportKind): ExportKind => (ambient ? "type" : kind);
  if (ts.isFunctionDeclaration(node) && node.name) declared.set(node.name.text, runtime("function"));
  else if (ts.isClassDeclaration(node) && node.name) declared.set(node.name.text, runtime("class"));
  else if (ts.isEnumDeclaration(node)) declared.set(node.name.text, runtime("const"));
  else if (ts.isInterfaceDeclaration(node)) declared.set(node.name.text, "type");
  else if (ts.isTypeAliasDeclaration(node)) declared.set(node.name.text, "type");
  else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) declared.set(node.name.text, namespaceKind(node));
  else if (ts.isVariableStatement(node)) {
    for (const decl of node.declarationList.declarations) {
      const names: string[] = [];
      bindingNames(decl.name, names);
      for (const n of names) declared.set(n, runtime("const"));
    }
  }
}

function collectImports(node: ts.Statement, localImports: Map<string, LocalImport>): void {
  if (!ts.isImportDeclaration(node)) return;
  const specifier = moduleText(node.moduleSpecifier);
  if (specifier === null) return;
  const clause = node.importClause;
  if (!clause) return; // side-effect import binds nothing
  const clauseTypeOnly = clause.isTypeOnly; // `import type ...`
  if (clause.name) localImports.set(clause.name.text, { specifier, source: "default", typeOnly: clauseTypeOnly });
  const named = clause.namedBindings;
  if (named && ts.isNamespaceImport(named)) {
    localImports.set(named.name.text, { specifier, source: "*", typeOnly: clauseTypeOnly });
  } else if (named && ts.isNamedImports(named)) {
    for (const el of named.elements) {
      localImports.set(el.name.text, {
        specifier,
        source: (el.propertyName ?? el.name).text,
        typeOnly: clauseTypeOnly || el.isTypeOnly // `import { type x }`
      });
    }
  }
}

function collectExports(
  node: ts.Statement,
  declared: Map<string, ExportKind>,
  localImports: Map<string, LocalImport>,
  local: Map<string, ExportKind>,
  reexports: ReExport[]
): void {
  const flags = modifierFlags(node);
  const isExported = (flags & ts.ModifierFlags.Export) !== 0;
  const isDefault = (flags & ts.ModifierFlags.Default) !== 0;

  // `export default function/class ...` exposes the binding as "default".
  if (isExported && isDefault) {
    local.set("default", "default");
    return;
  }

  if (isExported) {
    // `export declare ...` is ambient: erased at emit, so types-only for coverage.
    const ambient = (flags & ts.ModifierFlags.Ambient) !== 0;
    const runtime = (kind: ExportKind): ExportKind => (ambient ? "type" : kind);
    if (ts.isFunctionDeclaration(node) && node.name) local.set(node.name.text, runtime("function"));
    else if (ts.isClassDeclaration(node) && node.name) local.set(node.name.text, runtime("class"));
    else if (ts.isEnumDeclaration(node)) local.set(node.name.text, runtime("const"));
    else if (ts.isInterfaceDeclaration(node)) local.set(node.name.text, "type");
    else if (ts.isTypeAliasDeclaration(node)) local.set(node.name.text, "type");
    else if (ts.isModuleDeclaration(node) && ts.isIdentifier(node.name)) local.set(node.name.text, namespaceKind(node));
    else if (ts.isVariableStatement(node)) {
      for (const decl of node.declarationList.declarations) {
        const names: string[] = [];
        bindingNames(decl.name, names);
        for (const n of names) local.set(n, runtime("const"));
      }
    }
    return;
  }

  // `export default <expr>` (ExportAssignment, not `export =`).
  if (ts.isExportAssignment(node) && !node.isExportEquals) {
    local.set("default", "default");
    return;
  }
  // `export = expr` (CommonJS) is intentionally NOT indexed (rare in modern TS-ESM).

  if (!ts.isExportDeclaration(node)) return;

  // `export * [as ns] from "./m"` / `export { ... } from "./m"`.
  if (node.moduleSpecifier) {
    const specifier = moduleText(node.moduleSpecifier);
    if (specifier === null) return;
    const isTypeOnly = node.isTypeOnly;
    const clause = node.exportClause;
    if (!clause) {
      reexports.push({ kind: "star", specifier, isTypeOnly });
    } else if (ts.isNamespaceExport(clause)) {
      // `export * as ns from "./m"` binds the namespace object HERE.
      local.set(clause.name.text, isTypeOnly ? "type" : "namespace");
    } else {
      const names = clause.elements.map((el) => ({
        source: (el.propertyName ?? el.name).text,
        exported: el.name.text,
        isTypeOnly: isTypeOnly || el.isTypeOnly
      }));
      reexports.push({ kind: "named", specifier, isTypeOnly, names });
    }
    return;
  }

  // `export { a, b as c }` (no `from`): re-export of an imported binding (follow
  // it) OR a local/ambient binding (terminal here).
  if (node.exportClause && ts.isNamedExports(node.exportClause)) {
    for (const el of node.exportClause.elements) {
      const exported = el.name.text;
      const localName = (el.propertyName ?? el.name).text;
      const elementTypeOnly = node.isTypeOnly || el.isTypeOnly;
      const imported = localImports.get(localName);
      if (imported) {
        // A re-export of an imported binding is type-only if the EXPORT marks it
        // type-only OR the original IMPORT was type-only (`import type {x}; export {x}`
        // re-exports a type, never a runtime value — must not become COVERS-eligible).
        reexports.push({
          kind: "named",
          specifier: imported.specifier,
          isTypeOnly: node.isTypeOnly || imported.typeOnly,
          names: [{ source: imported.source, exported, isTypeOnly: elementTypeOnly || imported.typeOnly }]
        });
      } else {
        local.set(exported, elementTypeOnly ? "type" : declared.get(localName) ?? "unknown");
      }
    }
  }
}
