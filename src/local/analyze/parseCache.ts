import { SymbolExtraction } from "./symbols.js";
import { createRequire } from "node:module";

/**
 * Phase 5.4.2 — persistent PARSE cache.
 *
 * Caches ONLY pure, content-derived parse outputs (`extractSymbolsWithMeta`,
 * `extractTestNames`) — never a trust decision that depends on graph context
 * (resolution/confirmation/linkage live elsewhere / are recomputed).
 *
 * TRUST BOUNDARY (deliberately narrow — see Codex 5.4.2 round-3): this file is
 * TRUSTED LOCAL WORKSPACE STATE, the SAME trust level as `.orangepro/graph.json`
 * (which the kit also reads back and trusts wholesale). A process that can write
 * `parse-cache.json` can write `graph.json` directly, so defending one and not the
 * other is incoherent. We therefore do NOT claim tamper-resistance — a substring
 * "membership" check was tried and removed because it was security theater (a name
 * mentioned only in a comment passed it without being a real declaration).
 *
 * What the cache DOES guarantee:
 *   - STRICT SCHEMA on load — a malformed/garbage/old-version entry is dropped
 *     (misses, recomputes, pruned on save). Corruption never crashes or feeds
 *     off-shape data into the graph.
 *   - CONTENT-HASH key — a changed file (new hash) misses and re-parses; an
 *     unchanged file hits; PARSER_VERSION bump invalidates the whole cache.
 *   - PRUNE on save — only this-run keys persist, so a deleted file's entry
 *     cannot linger and re-enter a future graph.
 */

// Bump whenever extractSymbolsWithMeta / extractTestNames change their output.
// v2: Java/Python/Go symbol extraction moved from regex to tree-sitter (AST) — the
// cached regex symbols for those languages must not be served on a warm run.
// v3: tree-sitter now emits `trivial_accessor` (body-aware boilerplate exclusion).
// A warm v2 entry lacks it, so a Java getter would stay in the denominator forever.
// v4: TS/JS now extracts default-export subjects (`const X = …; export default X`,
// `export default connect(...)(X)`). A warm v3 entry would omit those components.
// v5: TS/JS now extracts class members (`Class.method` with member_of). A warm v4
// entry would omit them.
// v6: class-member extraction skips private/protected/#private members. A warm v5
// entry would have included those internal methods as behaviors.
// v7: class-member extraction requires a runtime body — abstract, ambient
// (`declare class`), and overload signatures no longer count. A warm v6 entry
// would still carry those declaration-only members.
// v8: a `declare class` NODE itself is no longer emitted (ambient type, no
// runtime impl). A warm v7 entry would still carry the ambient class symbol.
// v9: per-file symbol extraction cap raised from 40 to 1000 so large product
// files are no longer silently undercounted from a warm v8 truncated entry.
// v10: tree-sitter extraction now supports Ruby/Kotlin/Rust/PHP/C#/Swift/C/C++.
// Warm v9 entries for those languages had empty symbol sets.
// v11: C/C++ function names are read only from the declarator; warm v10 entries
// could include macro/namespace misparses as fake function symbols.
// v12: C/C++ requires a real function_declarator and drops keyword names, so
// warm v11 entries with C++ header keyword false positives must be invalidated.
// v13: C/C++ type nodes require an actual grammar name field; warm v12 entries
// could count anonymous enum members as class symbols.
// v14: C/C++ type nodes require a definition body and reserved keywords are
// dropped; warm v13 entries could count type references or `if` as symbols.
// v15: follow-up grammar fixes add Ruby singleton methods, C# record structs,
// Swift protocol methods, and Rust trait signatures while dropping Rust aliases.
// v16: symbol extraction now carries source line spans for runtime coverage
// report ingestion; warm v15 entries lack the ranges and cannot be mapped.
// v17: Go method symbols are receiver-qualified (Recv.M + member_of).
// v18: TS/JS extracts direct callable CommonJS exports.
// v19: chained assignments (`exports = module.exports = fn`) also expose the
// callable subject; warm v18 entries can still omit conventional CJS entries.
export const PARSER_VERSION = 19;

/** Tool package version, folded into the cache guard so UPGRADES auto-invalidate
 *  the cache — bumping PARSER_VERSION by hand is a discipline; this is a lock.
 *  (The stale-cache incident: upgraded binary served old per-file results.) */
export const TOOL_VERSION: string = (() => {
  try {
    // dist/local/analyze/ → ../../../package.json
    const req = createRequire(import.meta.url);
    return String((req("../../../package.json") as { version?: string }).version ?? "0");
  } catch {
    return "0";
  }
})();

const SYMBOL_KINDS = new Set(["function", "class", "const", "method"]);

interface ParseEntry {
  symbols?: SymbolExtraction;
  testNames?: string[];
}

export interface ParseCacheData {
  version: number;
  tool?: string;
  entries: Record<string, ParseEntry>;
}

/** Strict structural validation — persisted data is untrusted FOR SHAPE; reject anything off-shape. */
function validSymbols(v: unknown): SymbolExtraction | null {
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.truncated !== "boolean" || !Array.isArray(o.symbols)) return null;
  for (const s of o.symbols) {
    if (!s || typeof s !== "object") return null;
    const sym = s as Record<string, unknown>;
    if (typeof sym.name !== "string" || sym.name.length === 0) return null;
    if (typeof sym.symbol_kind !== "string" || !SYMBOL_KINDS.has(sym.symbol_kind)) return null;
    if (sym.start_line !== undefined && (typeof sym.start_line !== "number" || !Number.isFinite(sym.start_line))) return null;
    if (sym.end_line !== undefined && (typeof sym.end_line !== "number" || !Number.isFinite(sym.end_line))) return null;
    if (sym.callable !== undefined && typeof sym.callable !== "boolean") return null;
    if (sym.trivial_accessor !== undefined && typeof sym.trivial_accessor !== "boolean") return null;
    if (sym.member_of !== undefined && typeof sym.member_of !== "string") return null;
  }
  return o as unknown as SymbolExtraction;
}
function validTestNames(v: unknown): string[] | null {
  if (!Array.isArray(v)) return null;
  for (const x of v) if (typeof x !== "string") return null;
  return v as string[];
}

export class ParseCache {
  private entries: Map<string, ParseEntry>;
  private seen = new Set<string>();
  hits = 0;
  misses = 0;

  constructor(data?: ParseCacheData | null) {
    this.entries = new Map();
    // A version mismatch (or no data) starts empty — never trust a stale schema.
    if (!data || data.version !== PARSER_VERSION || data.tool !== TOOL_VERSION || !data.entries || typeof data.entries !== "object") return;
    for (const [key, raw] of Object.entries(data.entries)) {
      if (!raw || typeof raw !== "object") continue;
      const entry: ParseEntry = {};
      const sym = validSymbols((raw as ParseEntry).symbols);
      if (sym) entry.symbols = sym;
      const tn = validTestNames((raw as ParseEntry).testNames);
      if (tn) entry.testNames = tn;
      // Drop entries that carried nothing valid.
      if (entry.symbols || entry.testNames) this.entries.set(key, entry);
    }
  }

  /** Cached symbol extraction (keyed by content hash + language). */
  symbols(hash: string, language: string | undefined, compute: () => SymbolExtraction): SymbolExtraction {
    const key = `sym:${hash}:${language ?? ""}`;
    this.seen.add(key);
    const hit = this.entries.get(key);
    if (hit?.symbols) {
      this.hits++;
      return hit.symbols;
    }
    this.misses++;
    const value = compute();
    this.entries.set(key, { ...(hit ?? {}), symbols: value });
    return value;
  }

  /** Cached test-name extraction (keyed by content hash; language-agnostic). */
  testNames(hash: string, compute: () => string[]): string[] {
    const key = `tn:${hash}`;
    this.seen.add(key);
    const hit = this.entries.get(key);
    if (hit?.testNames) {
      this.hits++;
      return hit.testNames;
    }
    this.misses++;
    const value = compute();
    this.entries.set(key, { ...(hit ?? {}), testNames: value });
    return value;
  }

  /** hits / (hits + misses) as a percentage (1dp); 0 when nothing was looked up. */
  hitRate(): number {
    const total = this.hits + this.misses;
    return total === 0 ? 0 : Math.round((this.hits / total) * 1000) / 10;
  }

  /** Serialize for persistence — pruned to only the keys looked up THIS run (a deleted
   *  file's entry cannot linger and re-enter a future graph). */
  toData(): ParseCacheData {
    const entries: Record<string, ParseEntry> = {};
    for (const key of this.seen) {
      const e = this.entries.get(key);
      if (e) entries[key] = e;
    }
    return { version: PARSER_VERSION, tool: TOOL_VERSION, entries };
  }
}
