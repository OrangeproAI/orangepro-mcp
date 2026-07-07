/**
 * Proof runnability classification (spec: proof-runnability-and-env-profiles, Slice R-1).
 *
 * A loop-level helper for autoProve: when the dynamic-proof oracle reports a RED baseline
 * (baseline_green === false), classify WHY into a specific, actionable reason instead of a
 * generic "needs setup (DB/env)". This mints NO proof and changes NO proof semantics — it
 * only reads the oracle's already-redacted, single-line `baseline.failureSummary` (plus the
 * target package's declared `engines.node` and the runner's Node version) and returns a
 * sanitized { category, reason }. Raw stderr / the full failureSummary is never persisted.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, posix, resolve, sep } from "node:path";

import { redactSecrets } from "./util/redact.js";

/** Specific baseline-red root causes. Only import-time ones are safe to sibling-dedup. */
export type BaselineCategory =
  | "module_not_found"
  | "tsconfig_missing"
  | "experimental_builtin"
  | "engine_mismatch"
  | "db_or_external"
  | "logic_failure"
  | "unknown";

/**
 * Categories whose failure is a deterministic property of the TARGET PACKAGE + runner Node,
 * independent of which test runs it — so a same-file sibling can reuse the result WITHOUT
 * re-running. Two qualify — `engine_mismatch` (a package-level fact: engines.node vs the runner
 * Node) and `tsconfig_missing` (the package's tsconfig extends chain; see below). `module_not_found`
 * frequently originates in the failing TEST file's OWN imports
 * (fixtures/helpers), so it is NOT a reliable target-file property and must never drop a clean
 * provable sibling. `experimental_builtin` is likewise test-originated unless the TARGET source
 * is confirmed to reference the builtin — so dedup stays off here (R-2 instead auto-injects the
 * env only on a verified target-source reference). `tsconfig_missing` IS a reliable package-level
 * property: the failure is the PACKAGE's tsconfig `extends`ing a parent outside the isolated sandbox,
 * which breaks transform for EVERY test in the package uniformly (Medplum's "25 attempts, one root
 * cause") — so it dedups safely across same-package siblings.
 */
export const IMPORT_TIME_CATEGORIES: ReadonlySet<BaselineCategory> = new Set<BaselineCategory>([
  "engine_mismatch",
  "tsconfig_missing"
]);

/**
 * Only the CONFIDENT env categories are needs_setup. A `logic_failure` is a genuine failing test
 * on the real code; an `unknown` baseline-red is an ambiguous non-proof — neither may be
 * mislabelled needs_setup (that would hide a real unproven behind a "just needs setup" excuse).
 */
export function isNeedsSetupCategory(category: BaselineCategory): boolean {
  return category !== "logic_failure" && category !== "unknown";
}

export interface BaselineClassifyInput {
  /** The oracle's redacted, single-line baseline failure summary (may be null/absent). */
  failureSummary?: string | null;
  /** The target package's declared `engines.node` range (e.g. ">=24.2.0 <25"), if any. */
  enginesNode?: string;
  /** The runner's Node version (e.g. process.version, "v26.3.0"), if known. */
  runnerNode?: string;
}

export interface BaselineClassification {
  category: BaselineCategory;
  /** Short, actionable, secret-free reason. Never the raw stderr / full failureSummary. */
  reason: string;
}

const MAX_REASON_DETAIL = 200;

function shortLine(text: string): string {
  const first = String(text).split("\n", 1)[0] ?? "";
  return first.length > MAX_REASON_DETAIL ? `${first.slice(0, MAX_REASON_DETAIL)}…` : first;
}

/**
 * Did the baseline reach an ASSERTION? An assertion-shaped first line means the test ran far
 * enough to evaluate an expectation — so the failure is a genuine logic failure on the real
 * code, NEVER an engine/env block. This wins over every env category (even when the assertion
 * message happens to contain "cannot find module"/"DatabaseSync", or the runner Node is out of
 * the declared engines range): a test that reached an assertion demonstrably RAN.
 */
function isAssertionShaped(line: string): boolean {
  return /assertionerror|jestassertionerror|\bexpect\(|\btoBe\b|\btoEqual\b|\btoMatch\b|\btoContain\b|\btoThrow\b|\btoBeInstanceOf\b|to (?:be|equal|match|contain|deep) /i.test(line);
}

/**
 * Classify a baseline-red result. Precedence: a genuine ASSERTION (logic) failure FIRST — the
 * test ran and reached an expectation, so it is never env/engine-blocked; then an out-of-range
 * runner Node (engine_mismatch), then import-time builtin/module errors, then external/DB
 * connectivity, else unknown. Only the confident env categories are needs_setup; logic_failure
 * and unknown are honest non-proofs (see isNeedsSetupCategory).
 */
export function classifyBaselineFailure(input: BaselineClassifyInput): BaselineClassification {
  const line = (input.failureSummary ?? "").trim();

  // 1. logic_failure FIRST — an assertion-shaped line means the test RAN and reached an
  //    expectation, so this is a genuine failure on the UNMODIFIED code, not env/engine.
  //    Wins over any env substring in the message AND over an out-of-range runner Node.
  if (isAssertionShaped(line)) {
    return {
      category: "logic_failure",
      reason: "The test fails on the unmodified target — a genuine test failure, not an environment problem."
    };
  }

  // 2. engine_mismatch — the runner Node is outside the declared engines.node range (either
  //    bound). Reached only for a NON-assertion failure, and only when the range parses AND the
  //    version is definitely out (an assertion failure above already proves the Node ran it).
  if (input.enginesNode && input.runnerNode) {
    const ok = satisfiesNodeRange(input.runnerNode, input.enginesNode);
    if (ok === false) {
      return {
        category: "engine_mismatch",
        reason: `Runner Node ${cleanVersion(input.runnerNode)} is outside the target package's engines.node range "${input.enginesNode}"; run on a supported Node version.`
      };
    }
  }

  // 3. experimental_builtin — an unflagged experimental Node builtin (node:sqlite/DatabaseSync).
  //    Checked before module_not_found so "Cannot find module 'node:sqlite'" lands here.
  if (/node:sqlite|databasesync|experimental[ -]sqlite|no such built-?in module/i.test(line)) {
    return {
      category: "experimental_builtin",
      reason:
        "Target imports an experimental Node builtin (node:sqlite/DatabaseSync); run on Node >=24.2 or set NODE_OPTIONS=--experimental-sqlite."
    };
  }

  // 3b. tsconfig_missing (M-4) — the package's tsconfig `extends` a parent config that isn't in the
  //     isolated sandbox (a monorepo root tsconfig), so the package fails to TRANSFORM before any
  //     test body runs. Package-level + dedupable. Catch both the esbuild warning ("Cannot find base
  //     config file") and the vite/oxc fatal ("Tsconfig not found" / "[TSCONFIG_ERROR]"), so it is
  //     recognized whichever line the oracle surfaces (Medplum grabbed the warning → fell to unknown).
  if (/cannot find base config|tsconfig not found|failed to load tsconfig|\[tsconfig_error\]/i.test(line)) {
    return {
      category: "tsconfig_missing",
      reason:
        "The package's tsconfig 'extends' a parent config outside the isolated proof sandbox (a monorepo root tsconfig), so the package can't be compiled to run the baseline."
    };
  }

  // 4. module_not_found — a local/dep import did not resolve (tool-side or a genuinely missing dep).
  if (/cannot find module|module not found|failed to resolve (?:import|entry)|cannot find package|err_module_not_found|cannot resolve|failed to load url/i.test(line)) {
    return {
      category: "module_not_found",
      reason: "A required import did not resolve; install dependencies or fix the import path (not a database problem)."
    };
  }

  // 5. db_or_external — a connection/adapter error to a service the sandbox lacks.
  if (/econnrefused|enotfound|etimedout|econnreset|connection refused|could not connect|connect(?:ion)? tim\w*|getaddrinfo|sequelize|typeorm|postgres|mysql|mongo(?:db)?|redis|prisma|database (?:connection|is not|error)|no database/i.test(line)) {
    return {
      category: "db_or_external",
      reason: "Baseline needs an external service or database that is unavailable in the proof sandbox."
    };
  }

  // 6. unknown — an ambiguous baseline-red (NOT needs_setup; an honest non-killing unproven).
  //    Surface the redacted first line so it is still actionable.
  return {
    category: "unknown",
    reason: line ? `Baseline did not pass: ${redactSecrets(shortLine(line))}` : "Baseline did not pass (no failure detail captured)."
  };
}

/** Strip a leading `v`/`=` from a version for display. */
function cleanVersion(v: string): string {
  return v.trim().replace(/^[v=]+/, "");
}

type SemTuple = [number, number, number];

/** Parse a (possibly partial/prefixed) version into [major, minor, patch]; null if unparseable. */
function parseVersion(raw: string): { tuple: SemTuple; parts: number } | null {
  const cleaned = cleanVersion(raw).split("+")[0].split("-")[0];
  const segs = cleaned.split(".");
  const nums: number[] = [];
  for (const s of segs) {
    if (s === "" || s === "x" || s === "X" || s === "*") break;
    const n = Number.parseInt(s, 10);
    if (!Number.isInteger(n) || n < 0) return null;
    nums.push(n);
  }
  if (nums.length === 0) return null;
  return { tuple: [nums[0], nums[1] ?? 0, nums[2] ?? 0], parts: Math.min(nums.length, 3) };
}

function cmp(a: SemTuple, b: SemTuple): number {
  for (let i = 0; i < 3; i += 1) {
    if (a[i] !== b[i]) return a[i] < b[i] ? -1 : 1;
  }
  return 0;
}

/**
 * Does `version` satisfy the npm-style range `range`?
 * Returns true (in range) / false (definitely out of range) / null (could not confidently
 * parse — callers must NOT treat null as a mismatch). Deliberately conservative: any token
 * it cannot parse makes the whole check return null so it never fabricates a mismatch.
 *
 * Supports the forms `engines.node` realistically uses: `||` (OR), space-separated AND,
 * `>= > <= < =`, caret `^`, tilde `~`, partial versions, and `* x`. Hyphen ranges bail to null.
 */
export function satisfiesNodeRange(version: string, range: string): boolean | null {
  const v = parseVersion(version);
  if (!v) return null;
  const groups = range.split("||");
  let sawParsableGroup = false;
  for (const group of groups) {
    const comparators = group.trim().split(/\s+/).filter(Boolean);
    if (comparators.includes("-")) return null; // hyphen range: don't guess
    if (comparators.length === 0) {
      // Empty group ("" / "*") means "any" → satisfied.
      return true;
    }
    let groupOk = true;
    let groupParsable = true;
    for (const c of comparators) {
      const r = satisfiesComparator(v.tuple, c);
      if (r === null) {
        groupParsable = false;
        break;
      }
      if (!r) {
        groupOk = false;
        break;
      }
    }
    if (!groupParsable) continue; // skip an unparseable OR-group, try the others
    sawParsableGroup = true;
    if (groupOk) return true;
  }
  // Every parsable group failed → definitely out of range; if nothing parsed → unknown.
  return sawParsableGroup ? false : null;
}

function satisfiesComparator(v: SemTuple, comparator: string): boolean | null {
  const c = comparator.trim();
  if (c === "" || c === "*" || c.toLowerCase() === "x") return true;

  if (c.startsWith("^")) {
    const p = parseVersion(c.slice(1));
    if (!p) return null;
    const [maj, min, patch] = p.tuple;
    const lower = p.tuple;
    const upper: SemTuple = maj > 0 ? [maj + 1, 0, 0] : min > 0 ? [0, min + 1, 0] : [0, 0, patch + 1];
    return cmp(v, lower) >= 0 && cmp(v, upper) < 0;
  }
  if (c.startsWith("~")) {
    const p = parseVersion(c.slice(1));
    if (!p) return null;
    const [maj, min] = p.tuple;
    const lower = p.tuple;
    const upper: SemTuple = p.parts >= 2 ? [maj, min + 1, 0] : [maj + 1, 0, 0];
    return cmp(v, lower) >= 0 && cmp(v, upper) < 0;
  }

  const m = /^(>=|<=|>|<|=)?\s*(.+)$/.exec(c);
  if (!m) return null;
  const op = m[1] ?? "";
  const p = parseVersion(m[2]);
  if (!p) return null;

  if (op === "" || op === "=") {
    // Bare full version = exact; bare partial (e.g. "24" / "24.2") = a range.
    if (p.parts >= 3) return cmp(v, p.tuple) === 0;
    const lower = p.tuple;
    const upper: SemTuple = p.parts === 1 ? [p.tuple[0] + 1, 0, 0] : [p.tuple[0], p.tuple[1] + 1, 0];
    return cmp(v, lower) >= 0 && cmp(v, upper) < 0;
  }

  // A full version: compare the exact tuple.
  if (p.parts >= 3) {
    const d = cmp(v, p.tuple);
    if (op === ">=") return d >= 0;
    if (op === "<=") return d <= 0;
    if (op === ">") return d > 0;
    if (op === "<") return d < 0;
    return null;
  }

  // A PARTIAL version with an operator MUST expand as a semver X-range, or an in-range Node is
  // fabricated out (e.g. `<=24` means `<25.0.0`, `>24.2` means `>=24.3.0`). Comparing the raw
  // partial tuple was the engine_mismatch-fabrication bug. Expansion matches node-semver:
  //   >=M[.m] → >= M.(m|0).0        <M[.m] → <  M.(m|0).0
  //   >M      → >= (M+1).0.0        >M.m   → >= M.(m+1).0
  //   <=M     → <  (M+1).0.0        <=M.m  → <  M.(m+1).0
  const [maj, min] = p.tuple;
  if (op === ">=") return cmp(v, [maj, min, 0]) >= 0;
  if (op === "<") return cmp(v, [maj, min, 0]) < 0;
  if (op === ">") return cmp(v, p.parts === 1 ? [maj + 1, 0, 0] : [maj, min + 1, 0]) >= 0;
  if (op === "<=") return cmp(v, p.parts === 1 ? [maj + 1, 0, 0] : [maj, min + 1, 0]) < 0;
  return null;
}

// ── R-2: node:sqlite / experimental Node builtin env profile ────────────────────────────

/**
 * The one env profile R-2 auto-applies: inject `--experimental-sqlite` via NODE_OPTIONS through
 * the EXISTING --test-env path (the spike's parseTestEnv allowlists exactly this flag). It only
 * makes a node:sqlite baseline RUNNABLE — it never asserts, mocks, or mints Proven.
 */
export const EXPERIMENTAL_SQLITE_TEST_ENV = "NODE_OPTIONS=--experimental-sqlite";

/** A source that references the experimental `node:sqlite` builtin (import or DatabaseSync use). */
export function referencesExperimentalSqlite(source: string): boolean {
  return /node:sqlite/.test(source) || /\bDatabaseSync\b/.test(source);
}

const REL_IMPORT_SPEC_RE = /(?:\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]*)\1/g;
const LOCAL_IMPORT_EXTS = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"];

function relativeImportSpecs(source: string): string[] {
  const specs: string[] = [];
  for (const m of source.matchAll(REL_IMPORT_SPEC_RE)) specs.push(m[2]);
  return specs;
}

/** Resolve a relative import to a source-root-relative POSIX path the reader can read, else null. */
function resolveLocalImport(fromRel: string, spec: string, reader: (rel: string) => string | null): string | null {
  const baseDir = posix.dirname(fromRel.split(sep).join("/"));
  const joined = posix.normalize(posix.join(baseDir, spec));
  for (const ext of LOCAL_IMPORT_EXTS) {
    const candidate = `${joined}${ext}`;
    if (reader(candidate) != null) return candidate;
  }
  for (const ext of LOCAL_IMPORT_EXTS.slice(1)) {
    const candidate = posix.join(joined, `index${ext}`);
    if (reader(candidate) != null) return candidate;
  }
  return null;
}

/**
 * EXACT (confident) detection: does the target file — or a same-package local import within a
 * bounded depth/file budget — reference `node:sqlite`/`DatabaseSync`? The `reader` is confined
 * to the source root, so `../other-package` specifiers resolve to null and same-package scope is
 * enforced for free. Only a direct reference in the reachable set counts (never a guess); if the
 * builtin is used only deeper than the budget, R-1 still surfaces it as `experimental_builtin`
 * needs_setup guidance rather than auto-injecting.
 */
export function targetNeedsExperimentalSqlite(
  reader: (rel: string) => string | null,
  targetFileRel: string,
  opts: { maxFiles?: number; maxDepth?: number } = {}
): boolean {
  const maxFiles = opts.maxFiles ?? 60;
  const maxDepth = opts.maxDepth ?? 2;
  const start = targetFileRel.split(sep).join("/");
  const seen = new Set<string>();
  const queue: Array<{ rel: string; depth: number }> = [{ rel: start, depth: 0 }];
  let scanned = 0;
  while (queue.length > 0 && scanned < maxFiles) {
    const { rel, depth } = queue.shift() as { rel: string; depth: number };
    if (seen.has(rel)) continue;
    seen.add(rel);
    const src = reader(rel);
    if (src == null) continue;
    scanned += 1;
    if (referencesExperimentalSqlite(src)) return true;
    if (depth >= maxDepth) continue;
    for (const spec of relativeImportSpecs(src)) {
      const resolved = resolveLocalImport(rel, spec, reader);
      if (resolved && !seen.has(resolved)) queue.push({ rel: resolved, depth: depth + 1 });
    }
  }
  return false;
}

/**
 * Nearest declared `engines.node` walking up from the target file to the source root
 * (monorepo-aware: a package's own package.json wins over the repo root). Returns undefined
 * when no package.json in range declares engines.node. Never escapes the source root.
 */
export function readEnginesNode(sourceRoot: string, targetFileRel: string): string | undefined {
  const root = resolve(sourceRoot);
  let dir = resolve(root, dirname(targetFileRel));
  for (;;) {
    if (dir !== root && !dir.startsWith(root + sep)) return undefined; // escaped the root
    const pj = join(dir, "package.json");
    if (existsSync(pj)) {
      try {
        const parsed = JSON.parse(readFileSync(pj, "utf8")) as { engines?: { node?: unknown } };
        const node = parsed?.engines?.node;
        if (typeof node === "string" && node.trim()) return node.trim();
      } catch {
        /* unreadable/garbage package.json → keep walking up */
      }
    }
    if (dir === root) return undefined;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}
