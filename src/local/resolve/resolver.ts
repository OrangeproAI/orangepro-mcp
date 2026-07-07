// TypeScript import resolver (Gate 1 / G-RESOLVE, Phase 1 PR-1).
//
// Source of truth for "what does this import point to." Uses the TypeScript
// compiler API (`ts.resolveModuleName`) — the same resolver the rewrite adopts
// for "confirmed" coverage. This module is SEPARATE from any parser: the parser
// extracts specifiers (see importGraph.ts), this module turns a specifier +
// containing file into a resolved terminal file.
//
// Productionized from private/spikes/resolver/resolve-spike.mjs (spiked GREEN:
// test->source resolution ~100% on this NodeNext repo and the Mattermost bundler
// repo). It honors each file's NEAREST tsconfig so NodeNext (.js->.ts rewrite)
// and bundler (paths/baseUrl) repos each resolve under their own options.

import ts from "typescript";
import fs from "node:fs";
import path from "node:path";

/** Result of resolving a single import specifier from a containing file. */
export interface ResolvedImport {
  /** Absolute path of the terminal file the specifier resolves to, or null. */
  resolvedFileName: string | null;
  /** True when TypeScript classifies the target as a node_modules/external lib. */
  isExternal: boolean;
  /** Convenience flag: a non-null resolvedFileName was found. */
  resolved: boolean;
}

/** A parsed tsconfig scope: its compiler options + a shared resolution cache. */
export interface TsConfigScope {
  /** Absolute path of the tsconfig used (or a synthetic key for the fallback). */
  configPath: string;
  options: ts.CompilerOptions;
  /** ONE cache per scope, reused across every resolveModuleName call in it. */
  moduleResolutionCache: ts.ModuleResolutionCache;
}

/** Sane NodeNext defaults when no tsconfig is found walking up from a file. */
const FALLBACK_OPTIONS: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext,
  moduleResolution: ts.ModuleResolutionKind.NodeNext,
  target: ts.ScriptTarget.ES2022,
  esModuleInterop: true,
  allowJs: true
};

const FALLBACK_KEY = "<nodenext-fallback>";

// Cache by `configPath + ":" + mtimeMs` (or the fallback key). Walking up the dir
// tree repeatedly is cheap, but parsing a tsconfig + building a resolution cache is
// not — so each distinct scope is parsed exactly once per (path, mtime) pair. Keying
// on mtime means an edited tsconfig busts its own cache entry, so a long-lived MCP
// process never resolves with a stale tsconfig after edits.
const scopeCache = new Map<string, TsConfigScope>();
// Memoize the nearest-tsconfig lookup per containing directory.
const nearestConfigByDir = new Map<string, string | null>();

/** Cache key for a tsconfig path: path + its current mtime (0 if unreadable). */
function scopeCacheKey(configPath: string): string {
  let mtimeMs = 0;
  try {
    mtimeMs = fs.statSync(configPath).mtimeMs;
  } catch {
    /* unreadable tsconfig — key on mtime 0 */
  }
  return `${configPath}:${mtimeMs}`;
}

function makeScope(configPath: string, options: ts.CompilerOptions): TsConfigScope {
  const moduleResolutionCache = ts.createModuleResolutionCache(
    path.dirname(configPath === FALLBACK_KEY ? process.cwd() : configPath),
    (x) => x,
    options
  );
  return { configPath, options, moduleResolutionCache };
}

function fallbackScope(): TsConfigScope {
  const existing = scopeCache.get(FALLBACK_KEY);
  if (existing) return existing;
  const scope = makeScope(FALLBACK_KEY, FALLBACK_OPTIONS);
  scopeCache.set(FALLBACK_KEY, scope);
  return scope;
}

/** Walk up from `dir` to find the nearest tsconfig.json. Memoized per dir. */
function findNearestTsConfig(dir: string): string | null {
  const memo = nearestConfigByDir.get(dir);
  if (memo !== undefined) return memo;
  const found = ts.findConfigFile(dir, ts.sys.fileExists, "tsconfig.json") ?? null;
  nearestConfigByDir.set(dir, found);
  return found;
}

/** Parse a tsconfig into compiler options, building+caching its scope. */
function loadScopeForConfig(configPath: string): TsConfigScope {
  // Key on (path, mtime) so an edited tsconfig busts the cache (stale-scope fix).
  const key = scopeCacheKey(configPath);
  const cached = scopeCache.get(key);
  if (cached) return cached;

  const read = ts.readConfigFile(configPath, ts.sys.readFile);
  if (read.error) {
    // Unparseable tsconfig — fall back rather than throw; resolution still works
    // for plain relative/NodeNext imports under defaults.
    return fallbackScope();
  }
  const parsed = ts.parseJsonConfigFileContent(read.config, ts.sys, path.dirname(configPath));
  const scope = makeScope(configPath, parsed.options);
  scopeCache.set(key, scope);
  return scope;
}

/**
 * Find the nearest tsconfig.json walking up from `file`'s directory, parse it,
 * and return its scope (options + a shared module-resolution cache). The scope is
 * cached by resolved tsconfig path. Falls back to NodeNext defaults when none is
 * found.
 */
export function loadTsConfigFor(file: string): TsConfigScope {
  const dir = path.dirname(path.resolve(file));
  const configPath = findNearestTsConfig(dir);
  if (!configPath) return fallbackScope();
  return loadScopeForConfig(configPath);
}

/**
 * Resolve a single import `specifier` as seen from `containingFile`, using
 * `ts.resolveModuleName` under the containing file's nearest-tsconfig options.
 * `isExternal` comes from TypeScript's own `isExternalLibraryImport` flag.
 */
export function resolveImport(specifier: string, containingFile: string): ResolvedImport {
  const scope = loadTsConfigFor(containingFile);
  const result = ts.resolveModuleName(
    specifier,
    containingFile,
    scope.options,
    ts.sys,
    scope.moduleResolutionCache
  );
  const mod = result.resolvedModule;
  if (!mod) {
    return { resolvedFileName: null, isExternal: false, resolved: false };
  }
  return {
    resolvedFileName: mod.resolvedFileName,
    isExternal: !!mod.isExternalLibraryImport,
    resolved: true
  };
}

/**
 * Clear the process-level scope/config caches. Call at the START of each analyze
 * run so a long-lived MCP process re-reads tsconfigs (and re-walks for new ones)
 * from a clean slate, in addition to the per-entry mtime invalidation above.
 */
export function resetResolverCaches(): void {
  scopeCache.clear();
  nearestConfigByDir.clear();
}
