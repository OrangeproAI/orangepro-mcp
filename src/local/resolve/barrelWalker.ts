// Barrel walker (Gate 1 / G-RESOLVE, Phase 1 PR-2).
//
// Given a starting file and the name of a binding imported FROM it, follow the
// re-export chain (`export * from` / `export { x as y } from`) to the TERMINAL
// file that locally defines the binding. Only a terminal RUNTIME definition
// reached via RUNTIME hops is COVERS-eligible (`covered === true`); every
// dead-end (ambiguous star, depth/cycle exhaustion, unresolvable hop) AND every
// type-only outcome (a type terminal, or a hop through a `export type ... from`)
// is NOT covered — a false "confirmed" is worse than "inferred"
// (gate-specs-digest.md §resolver: type-only targets are NOT terminal impl).
//
// Resolution rules (TypeScript module semantics, parse-only):
//   - Local definition          -> terminal here. covered iff the binding kind is
//                                  runtime (not "type") AND no type-only hop taken.
//   - Explicit named re-export  -> follow it; it SHADOWS star re-exports for that
//                                  name (TS: explicit exports win over `export *`).
//                                  A renamed alias (`export { x as y } from`) is
//                                  deterministic and stays COVERS-eligible.
//   - Single `export *`         -> follow it with the SAME binding name.
//   - 2+ `export *`             -> probe each; exactly one supplying terminal is
//                                  deterministic; two or more is AMBIGUOUS.
//   - `default` via `export *`  -> unresolved. TS/Node never forward a default
//                                  through a star (`import d from barrel` where
//                                  the barrel only `export *`s = "no default
//                                  export"); only `export { x as default } from`
//                                  (the named branch) forwards one.
//   - Depth > maxDepth (5)      -> depth-exceeded (downgrade).
//   - Revisited (file, binding) -> cycle (downgrade) — barrels are often cyclic.
//                                  A cycle is CONCLUSIVE for its own branch (ESM
//                                  ResolveExport treats circular star paths as
//                                  contributing nothing), so a sibling star may
//                                  still supply the binding deterministically.
//   - Total work > maxExpansions -> budget-exhausted (fail-closed; bounds a wide fan-out).
//   - Hop resolves to external/null -> unresolved (downgrade).
//   - In a 2+ star probe, a branch CUT mid-exploration (depth-exceeded or
//     budget-exhausted) or an unexpandable star POISONS the whole collapse:
//     we cannot prove the surviving terminal is unique, and a hidden second
//     supplier would make the barrel ambiguous (TS2308 / ESM "conflicting star
//     exports" = the binding is NOT delivered). Only conclusively-explored
//     branches (unresolved = binding absent; cycle; deeper-ambiguous = excluded
//     by ESM) may be dropped.
//   - A `.d.ts` terminal is types-only at runtime -> terminal but NOT covered.

import path from "node:path";
import { resolveImport } from "./resolver.js";
import { buildExportIndex, type ExportIndex, type ExportKind } from "./exportIndex.js";

export type BarrelWalkStatus =
  | "terminal"
  | "ambiguous"
  | "depth-exceeded"
  | "cycle"
  | "unresolved"
  | "budget-exhausted";

export interface BarrelWalkResult {
  status: BarrelWalkStatus;
  /** Absolute path of the defining file, set only when status === "terminal". */
  terminalFile: string | null;
  /** Binding name AT the terminal (after any `as` renames), only when terminal. */
  terminalBinding: string | null;
  /** Kind of the terminal binding (only when terminal); "type" is not impl. */
  terminalKind: ExportKind | null;
  /** Number of re-export hops taken from the start file (0 = defined in start). */
  depth: number;
  /**
   * COVERS-eligible: a terminal RUNTIME definition reached without traversing a
   * type-only re-export. A type terminal or a type-only hop is terminal-but-NOT
   * covered; every other non-terminal status is also not covered.
   */
  covered: boolean;
}

/** Resolve a re-export specifier to an INTERNAL terminal file, or null. */
export type ResolveFn = (specifier: string, containingFile: string) => string | null;
export type LoadIndexFn = (file: string) => ExportIndex;

export interface WalkBarrelOptions {
  /** Max re-export hops before downgrade. Default 5. */
  maxDepth?: number;
  /** Override resolution (default: ts.resolveModuleName, internal-only). */
  resolve?: ResolveFn;
  /** Override export-index loading (default: memoized buildExportIndex). */
  loadIndex?: LoadIndexFn;
  /**
   * Total re-export nodes visited before downgrading (fail-closed). The depth
   * bound caps a single chain's LENGTH, but a wide `export *` fan-out branches
   * combinatorially; this bounds TOTAL work so a pathological barrel graph cannot
   * blow up wall-clock. Generous default — only pathological inputs reach it.
   */
  maxExpansions?: number;
}

const DEFAULT_MAX_DEPTH = 5;
const DEFAULT_MAX_EXPANSIONS = 4000;

/** Mutable per-walk work counter backing the expansion budget. */
interface WalkBudget {
  n: number;
  max: number;
}

/** Default resolver: only INTERNAL terminals are walkable (a hop into node_modules is a dead-end). */
function defaultResolve(specifier: string, containingFile: string): string | null {
  const r = resolveImport(specifier, containingFile);
  if (!r.resolved || r.isExternal) return null;
  return r.resolvedFileName;
}

/** Kinds that denote a concrete RUNTIME implementation binding (COVERS-eligible). */
function isRuntimeKind(kind: ExportKind): boolean {
  return kind === "function" || kind === "class" || kind === "const" || kind === "default" || kind === "namespace";
}

function fail(status: BarrelWalkStatus, depth: number): BarrelWalkResult {
  return { status, terminalFile: null, terminalBinding: null, terminalKind: null, depth, covered: false };
}

function terminalKey(r: BarrelWalkResult): string {
  return `${r.terminalFile}::${r.terminalBinding}`;
}

/**
 * Follow the re-export chain from `file` for the binding `binding` to its
 * terminal defining file. See module docs for the resolution rules.
 */
export function walkBarrel(file: string, binding: string, opts: WalkBarrelOptions = {}): BarrelWalkResult {
  const maxDepth = opts.maxDepth ?? DEFAULT_MAX_DEPTH;
  const resolve = opts.resolve ?? defaultResolve;
  const loadIndex = opts.loadIndex ?? buildExportIndex;
  const budget: WalkBudget = { n: 0, max: opts.maxExpansions ?? DEFAULT_MAX_EXPANSIONS };
  return walkRec(file, binding, 0, new Set<string>(), false, maxDepth, resolve, loadIndex, budget);
}

function walkRec(
  currentFile: string,
  binding: string,
  depth: number,
  visited: Set<string>,
  typeTainted: boolean,
  maxDepth: number,
  resolve: ResolveFn,
  loadIndex: LoadIndexFn,
  budget: WalkBudget
): BarrelWalkResult {
  // Total-work budget (shared across all sibling star branches): a wide fan-out
  // can branch combinatorially within the depth bound, so cap total nodes
  // visited and downgrade fail-closed (never a false terminal) on exhaustion.
  // The status is DISTINCT from "unresolved" so the multi-star collapse can tell
  // a cut branch apart from a conclusively-absent binding (cuts must poison).
  if (++budget.n > budget.max) return fail("budget-exhausted", depth);
  if (depth > maxDepth) return fail("depth-exceeded", depth);

  // Cycle detection is along THIS path: a per-call copy lets sibling star
  // branches explore independently while still catching a loop back to a
  // (file, binding) pair already open on the current chain.
  const key = `${path.resolve(currentFile)}::${binding}`;
  if (visited.has(key)) return fail("cycle", depth);
  const pathVisited = new Set(visited);
  pathVisited.add(key);

  const index = loadIndex(currentFile);

  // 1. Defined locally -> terminal. Covered only for a RUNTIME kind reached
  //    without a type-only hop, and never in a declaration file (a `.d.ts`
  //    "export declare function" is types-only at runtime — not terminal impl).
  if (index.local.has(binding)) {
    const kind = index.local.get(binding) ?? "unknown";
    const isDeclarationFile = /\.d\.[mc]?ts$/i.test(index.file);
    return {
      status: "terminal",
      terminalFile: index.file,
      terminalBinding: binding,
      terminalKind: kind,
      depth,
      covered: !typeTainted && !isDeclarationFile && isRuntimeKind(kind)
    };
  }

  // 2. Explicit named re-exports shadow star re-exports for this name.
  const named: { specifier: string; source: string; typeOnly: boolean }[] = [];
  for (const re of index.reexports) {
    if (re.kind === "named") {
      for (const n of re.names) {
        if (n.exported === binding) named.push({ specifier: re.specifier, source: n.source, typeOnly: n.isTypeOnly });
      }
    }
  }
  if (named.length >= 2) return fail("ambiguous", depth); // duplicate explicit re-export
  if (named.length === 1) {
    const target = resolve(named[0].specifier, currentFile);
    if (!target) return fail("unresolved", depth);
    return walkRec(target, named[0].source, depth + 1, pathVisited, typeTainted || named[0].typeOnly, maxDepth, resolve, loadIndex, budget);
  }

  // A `default` cannot be supplied by `export *` (TS/Node never forward a default
  // through a star). Having exhausted explicit named re-exports above, a `default`
  // request that reaches the star section can never be satisfied — downgrade
  // instead of false-confirming a star target's OWN local default.
  if (binding === "default") return fail("unresolved", depth);

  // 3. Star re-exports are the only remaining source.
  const stars = index.reexports.filter((re): re is ReExportStarShape => re.kind === "star");
  if (stars.length === 0) return fail("unresolved", depth);
  if (stars.length === 1) {
    const target = resolve(stars[0].specifier, currentFile);
    if (!target) return fail("unresolved", depth);
    return walkRec(target, binding, depth + 1, pathVisited, typeTainted || stars[0].isTypeOnly, maxDepth, resolve, loadIndex, budget);
  }

  // 4. 2+ stars: probe each branch independently. Exactly one terminal is
  //    deterministic; two or more DISTINCT terminals is ambiguous. A branch is
  //    droppable ONLY when conclusively explored: "unresolved" (binding absent),
  //    "cycle" (ESM circular star paths contribute nothing), or "ambiguous"
  //    deeper down (ESM excludes ambiguous star exports from the namespace). A
  //    CUT branch (depth-exceeded / budget-exhausted) or an unexpandable star
  //    POISONS the collapse: a hidden second supplier would make this barrel
  //    ambiguous (TS2308), so a surviving lone terminal cannot be trusted.
  const hits: BarrelWalkResult[] = [];
  for (const star of stars) {
    const target = resolve(star.specifier, currentFile);
    if (!target) return fail("unresolved", depth); // a star we cannot expand -> cannot prove uniqueness
    const sub = walkRec(target, binding, depth + 1, new Set(pathVisited), typeTainted || star.isTypeOnly, maxDepth, resolve, loadIndex, budget);
    if (sub.status === "terminal") hits.push(sub);
    else if (sub.status === "depth-exceeded" || sub.status === "budget-exhausted") return fail(sub.status, depth);
  }
  const distinct = new Map<string, BarrelWalkResult>();
  for (const h of hits) {
    const k = terminalKey(h);
    const prev = distinct.get(k);
    // Same terminal reached via multiple stars: keep the COVERED outcome so the
    // result is independent of star declaration order (a runtime star and a
    // type-only star reaching the same def must deterministically be covered).
    if (!prev || (!prev.covered && h.covered)) distinct.set(k, h);
  }
  if (distinct.size === 1) return [...distinct.values()][0];
  if (distinct.size >= 2) return fail("ambiguous", depth);
  return fail("unresolved", depth);
}

interface ReExportStarShape {
  kind: "star";
  specifier: string;
  isTypeOnly: boolean;
}
