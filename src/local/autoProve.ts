/**
 * Auto-prove orchestration for `opro start` (PR 1 of the auto-drive-to-proven spec).
 *
 * ORCHESTRATION ONLY — this file mints no proof. After analyze, when a provider key
 * exists and the user did not opt out, it: selects the top provable TS/JS CodeSymbol
 * targets (ORS-ranked), generates a runnable test per target via the EXISTING
 * `generateTests`, writes it under `orangepro_generated/`, and runs it through the
 * UNCHANGED `opProveLoop`/dynamic-proof oracle. Proven is minted only by that oracle;
 * a static / non-killing / generation-failed / setup-failed test is an honest skip and
 * NEVER becomes Proven. A later failed attempt cannot clobber a prior Proven (the #162
 * fingerprint-scoped RTM selection guarantees this — this file does not defeat it).
 *
 * No key ⇒ writes NO files, mints NO proof, returns explicit guidance.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, posix, resolve, sep } from "node:path";

import { generateTests, readDeclaredDeps, unresolvedLocalImports } from "./generate/generator.js";
import { GENERATED_DIR, runHintsFor } from "./generate/runHints.js";
import { rankRiskGaps } from "./score/risk.js";
import { resolveProviderConfig } from "./localConfig.js";
import { buildProvider } from "./generate/providers.js";
import { resolveContained } from "./reprove/paths.js";
import { buildRtm } from "./rtm.js";
import { loadLedger } from "./ledger.js";
import { reportProgress } from "./util/progress.js";
import { loadGraph, workspacePaths } from "./workspace.js";
import { systemClock } from "./util/time.js";
import { redactSecrets } from "./util/redact.js";
import {
  classifyBaselineFailure,
  EXPERIMENTAL_SQLITE_TEST_ENV,
  IMPORT_TIME_CATEGORIES,
  isNeedsSetupCategory,
  readEnginesNode,
  targetNeedsExperimentalSqlite,
  type BaselineCategory,
  type BaselineClassification
} from "./proofRunnability.js";
import type { Clock } from "./util/time.js";
import type { FileReader } from "./types.js";
import type { GraphNode, LocalGraph } from "./graph/ontology.js";
import type { OperationDeps, ProveLoopOptions, ProveLoopResult, DynamicProofResult } from "./operations.js";

/** Real dynamic proof is profile-gated; only wired runner targets are attemptable. */
function isTsJsFile(file: string): boolean {
  return /\.[cm]?[jt]sx?$/i.test(file);
}

function isGoFile(file: string): boolean {
  return /\.go$/i.test(file);
}

function isJavaFile(file: string): boolean {
  return /\.java$/i.test(file);
}

function isPythonFile(file: string): boolean {
  return /\.py$/i.test(file);
}

function replacementForTarget(file: string): string {
  return isPythonFile(file) ? "return 0" : "return null;";
}

function codeSymbolFile(node: GraphNode): string {
  return typeof node.properties.file === "string" ? node.properties.file : node.external_id.replace(/^sym:/, "").split("#")[0];
}

function isRunnablePythonTestPath(testRel: string): boolean {
  const file = testRel.split("::", 1)[0] ?? testRel;
  return /(^|\/)(test_[^/]+|[^/]+_test)\.py$/i.test(file);
}

function isRunnableTestForTarget(node: GraphNode, testRel: string): boolean {
  const file = codeSymbolFile(node);
  if (isPythonFile(file)) return isRunnablePythonTestPath(testRel);
  return true;
}

function pytestNodeidsForFile(sourceRoot: string, testRel: string): string[] {
  if (testRel.includes("::")) return [testRel];
  if (!isRunnablePythonTestPath(testRel)) return [testRel];
  let text = "";
  try {
    text = readFileSync(resolve(sourceRoot, testRel), "utf8");
  } catch {
    return [testRel];
  }
  const out: string[] = [];
  let currentClass: string | null = null;
  let classIndent = 0;
  for (const line of text.split(/\r?\n/)) {
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    const classMatch = /^(\s*)class\s+(Test[A-Za-z0-9_]*)\b/.exec(line);
    if (classMatch) {
      currentClass = classMatch[2];
      classIndent = classMatch[1].length;
      continue;
    }
    if (currentClass && indent <= classIndent && line.trim() !== "" && !line.startsWith(" ")) currentClass = null;
    const fnMatch = /^(\s*)def\s+(test_[A-Za-z0-9_]*)\s*\(/.exec(line);
    if (!fnMatch) continue;
    const fnIndent = fnMatch[1].length;
    if (currentClass && fnIndent > classIndent) out.push(`${testRel}::${currentClass}::${fnMatch[2]}`);
    else out.push(`${testRel}::${fnMatch[2]}`);
  }
  return out.length ? out.slice(0, 25) : [testRel];
}

/**
 * SOLE trust barrier for auto-prove target selection. `opDynamicProof` has NO
 * eligibility guard — `resolveTargetSymbol` resolves ANY CodeSymbol and the prove
 * path never reads eligibility — so handing it an excluded infra symbol would mint
 * Proven against plumbing. Auto-prove must therefore refuse anything that is not an
 * entry-point-adjacent behavior surface: eligible (top-level `denominator_eligible`),
 * `behavior_surface === "entrypoint_adjacent"`, and carrying NO `denominator_reason_code`
 * (infra_behavior_surface / not_entry_point_adjacent).
 *
 * Language: TS/JS (unchanged), Go (G-INT-2), OR Java (J-INT-2). This STRICT predicate
 * keeps Go to FREE FUNCTIONS ONLY. The Go oracle can also prove receiver METHODS, but
 * a method's no-false-Proven story rests entirely on the analyzer-minted hard
 * receiver-local TESTED_BY/COVERS edge (package-unique method-name gating) — so Go
 * methods are admitted solely by `isEligibleHardExistingTarget` on the hard-edge lane,
 * never here: this predicate also feeds PR/changed-scope selection, weak MAY_*
 * expansion, and generation candidate filtering, where no hard edge backs the pick.
 * Java dynamic proof (J-1) is the INVERSE — it proves single-top-level-return METHODS,
 * so we admit Java methods; a non-J-1-shape method (void/constructor/nested/generic)
 * just classifies `unrunnable` and never mints, safe by construction. Everything
 * downstream of `closed`/the cert is language-agnostic and mints Go/Java only through
 * the unchanged G-INT-1/J-INT-1 gates.
 */
export function isEligibleProvableTarget(node: GraphNode | undefined): boolean {
  if (!node || node.kind !== "CodeSymbol") return false;
  if (node.denominator_eligible !== true) return false;
  if (node.properties.behavior_surface !== "entrypoint_adjacent") return false;
  if (node.properties.denominator_reason_code != null) return false;
  return matchesProvableLanguageShape(node);
}

/**
 * The LANGUAGE + oracle-SHAPE half of eligibility, factored out so both the strict
 * `isEligibleProvableTarget` (which layers the entry-point-adjacent SCOPE guards on top)
 * and the relaxed hard-edge existing-tests path share ONE definition of "a shape the
 * oracle can prove". CodeSymbol + a TS/JS file, a Go free function (a receiver method
 * only when the caller opts in via `allowGoMethod`), a Java method, or a Python
 * function/method.
 */
function matchesProvableLanguageShape(node: GraphNode, opts?: { allowGoMethod?: boolean }): boolean {
  if (node.kind !== "CodeSymbol") return false;
  const file = codeSymbolFile(node);
  if (isTsJsFile(file)) return true;
  // Go: free functions only, unless the caller opts into methods (`allowGoMethod`).
  // Only the hard-edge lane opts in: a method's no-false-Proven story rests on the
  // analyzer's uniqueness-gated receiver-local TESTED_BY/COVERS edge, which the strict
  // callers (changed-scope selection, weak MAY_* expansion, generation candidates)
  // do not have — admitting methods there would break the invariant that a Go method
  // only ever becomes a proof attempt via a hard receiver-local edge.
  if (isGoFile(file)) {
    if (node.properties.symbol_kind === "function") return true;
    return opts?.allowGoMethod === true && node.properties.symbol_kind === "method";
  }
  // Java: METHODS only (J-1 proves single-top-level-return methods). A non-J-1-shape
  // method classifies `unrunnable` and never mints, so admitting all Java methods is
  // safe (never a false Proven); a non-method Java symbol (a class container) is out
  // of scope. No graph return-shape signal exists to pre-filter, so we admit broadly
  // and let the Java oracle refuse non-J-1 shapes at run time.
  if (isJavaFile(file)) return node.properties.symbol_kind === "method";
  if (isPythonFile(file)) {
    const symbolKind = typeof node.properties.symbol_kind === "string" ? node.properties.symbol_kind : "";
    if (symbolKind !== "function" && symbolKind !== "method") return false;
    const member = node.external_id.split("#")[1] ?? "";
    if (/^__.*__$/.test(member)) return false;
    return true;
  }
  return false;
}

/**
 * Relaxed eligibility for the existing-tests HARD-edge path ONLY. A symbol carrying a
 * HARD `TESTED_BY`/`COVERS` proof edge (a real, analyzer-derived test) is admitted even
 * when it is `not_entry_point_adjacent` — a Formatter/Converter SPI method like
 * `PetTypeFormatter#print` is a genuine behavior the repo's own test exercises, but it
 * sits below the entry-point-adjacent denominator bar. Only the `not_entry_point_adjacent`
 * SCOPE guard is dropped, NOT a trust guard: a relaxed pick is only ever proven-or-refused
 * by the frozen oracle, never false-Proven. Guards deliberately KEPT:
 *   - `infra_behavior_surface` still excludes plumbing (getters/registry accessors) — a
 *     hard edge does not buy an infra symbol an attempt (waste, and preserves the #4 bar);
 *   - the language + oracle-shape filter (never hand a class container down).
 * This is also the ONLY caller that admits Go receiver METHODS (`allowGoMethod`): it is
 * reached solely behind a hard TESTED_BY/COVERS edge, and the analyzer mints a method
 * edge only for the uniqueness-gated receiver-local shape — the strict predicate keeps
 * Go methods out of every other selection path.
 * Used solely on the hard lane; weak MAY_* fan-out stays strict.
 */
function isEligibleHardExistingTarget(node: GraphNode | undefined): boolean {
  if (!node) return false;
  if (node.properties.denominator_reason_code === "infra_behavior_surface") return false;
  return matchesProvableLanguageShape(node, { allowGoMethod: true });
}

/** Go `_test.go` top-level test-name regex (matches `extractTestNames`'s Go pattern). */
const GO_TEST_NAME_RE = /^Test[A-Za-z0-9_]+$/;
/**
 * Edge `test_name` may also be a literal-named subtest path (`TestX/sub`, `TestX/a/b`).
 * The analyzer only records `[A-Za-z0-9_]` segments (a runtime `tc.Name` or a literal
 * needing Go's `-run` sanitization is dropped to the bare parent), so each segment is
 * `-run`-safe verbatim and this stays a strict superset of `GO_TEST_NAME_RE`.
 */
const GO_TEST_PATH_RE = /^Test[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;

/**
 * Anchor a Go test-name path into a fully-anchored `-run` pattern the oracle binds to
 * EXACTLY one test: `TestX` → `^TestX$`; `TestX/sub` → `^TestX$/^sub$` (every segment
 * anchored so no segment can prefix-match a sibling). Mirrors the spike's `targetTestName`.
 */
function anchorGoTestRun(name: string): string {
  return name.split("/").map((seg) => `^${seg}$`).join("/");
}

/**
 * G-INT-2: resolve a Go CodeSymbol target to the single anchored `^TestName$` that
 * exercises it, or null when it cannot be resolved uniquely. The Go oracle selects
 * its target test BY NAME (`go test -run ^TestX$`), so auto-drive must derive that
 * name — G-INT-1 took it as an explicit input.
 *
 * The link is the analyzer's HARD `TESTED_BY`/`COVERS` proof edge (Go sym — free fn,
 * or receiver-local method — ↔ `test:<file>_test.go`), emitted only for an eligible Go
 * symbol whose test genuinely asserts on it. PRIMARY: the edge carries
 * `properties.test_name` — the EXACT enclosing
 * `func TestXxx` where the assertion witnessed THIS target (structural metadata, never
 * proof) — which disambiguates even a `_test.go` file with many tests. FALLBACK (old
 * graphs / no edge metadata): the linked TestCase node's file-level `test_names[]`,
 * usable only when it lists exactly ONE Go test. Either way we return a name only when
 * it resolves UNIQUELY across all associated tests; zero/ambiguous ⇒ null (SKIP). A
 * wrong name never mints a false Proven — the mutant survives an unrelated test and
 * classifies unproven — but it wastes a run and the spike refuses a broad pattern anyway.
 */
export function goTestRunForTarget(nodeById: Map<string, GraphNode>, graph: LocalGraph, symId: string): string | null {
  const names = new Set<string>();
  const testIds = new Set<string>();
  for (const e of graph.edges) {
    const isTestedBy = e.from_external_id === symId && e.relationship_type === "TESTED_BY";
    const isCovers = e.to_external_id === symId && e.relationship_type === "COVERS";
    if (!isTestedBy && !isCovers) continue;
    testIds.add(isTestedBy ? e.to_external_id : e.from_external_id);
    const edgeName = e.properties?.test_name;
    if (typeof edgeName === "string" && GO_TEST_PATH_RE.test(edgeName)) names.add(edgeName);
  }
  if (names.size >= 1) return names.size === 1 ? anchorGoTestRun([...names][0]!) : null;
  // Fallback: no per-edge test_name (older graph) — a file that holds exactly one
  // (bare, top-level) test; file-level `test_names[]` never carries subtest paths.
  for (const testId of testIds) {
    const tc = nodeById.get(testId);
    if (!tc || tc.kind !== "TestCase") continue;
    const testNames = Array.isArray(tc.properties.test_names) ? tc.properties.test_names : [];
    for (const n of testNames) if (typeof n === "string" && GO_TEST_NAME_RE.test(n)) names.add(n);
  }
  return names.size === 1 ? anchorGoTestRun([...names][0]!) : null;
}

/**
 * Slice 2: the assertion source line for the edge whose `test_name` anchors to `testRun`.
 * Returned only when EXACTLY ONE such edge carries a numeric `assertion_line` (unique-else-
 * undefined, mirroring `goTestRunForTarget`'s discipline). Undefined ⇒ the spike keeps its
 * exact-name behavior. Never widens trust — a wrong line makes the oracle refuse, not prove.
 */
export function goAssertionLineForTarget(graph: LocalGraph, symId: string, testRun: string): number | undefined {
  const lines = new Set<number>();
  for (const e of graph.edges) {
    const isTestedBy = e.from_external_id === symId && e.relationship_type === "TESTED_BY";
    const isCovers = e.to_external_id === symId && e.relationship_type === "COVERS";
    if (!isTestedBy && !isCovers) continue;
    const edgeName = e.properties?.test_name;
    const line = e.properties?.assertion_line;
    if (typeof edgeName === "string" && GO_TEST_PATH_RE.test(edgeName) && anchorGoTestRun(edgeName) === testRun && typeof line === "number") {
      lines.add(line);
    }
  }
  return lines.size === 1 ? [...lines][0] : undefined;
}

/** A JUnit test method identifier (any Java identifier — JUnit does not require a Test* prefix). */
const JAVA_TEST_METHOD_RE = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/** The simple test-class name for a Java `test:<relPath>` id — the file basename without `.java`. */
function javaTestClassOf(testRelId: string): string | null {
  if (!testRelId.startsWith("test:")) return null;
  const rel = testRelId.slice("test:".length);
  if (!/\.java$/i.test(rel)) return null;
  const base = rel.split("/").pop() ?? rel;
  return base.replace(/\.java$/i, "") || null;
}

/**
 * J-INT-2: resolve a Java CodeSymbol target to the single `Class#method` JUnit test
 * that exercises it, or null when it cannot be resolved uniquely. The Java oracle
 * selects its target test with `mvn test -Dtest=Class#method`, so auto-drive must
 * derive that selector — J-INT-1 took it as an explicit input.
 *
 * The link is the analyzer's HARD `TESTED_BY`/`COVERS` proof edge (Java method sym ↔
 * `test:<...>Test.java`), emitted only for a Java symbol a JUnit test genuinely
 * asserts on. The test CLASS is the test file's simple class name (its basename, per
 * Java's one-public-class-per-file convention; the spike accepts a simple class).
 * The test METHOD is, PRIMARY: the edge's `properties.test_name` — the exact enclosing
 * `@Test` method where the assertion witnessed THIS target (structural metadata, never
 * proof) — which disambiguates a test class with many @Test methods. FALLBACK (older
 * graphs / no edge metadata): the linked TestCase node's file-level `test_names[]`,
 * usable only when it lists exactly ONE test. We return a `Class#method` only when the
 * PAIR resolves UNIQUELY across all associated tests; zero/ambiguous ⇒ null (SKIP). A
 * wrong selector never mints a false Proven — the mutant survives an unrelated test and
 * classifies unproven — but it wastes a run, so we refuse to guess.
 */
export function javaTestForTarget(nodeById: Map<string, GraphNode>, graph: LocalGraph, symId: string): string | null {
  const selectors = new Set<string>();
  // Per test id, the enclosing @Test method names named by proof edges (primary source).
  const edgeMethodsByTest = new Map<string, Set<string>>();
  const testIds = new Set<string>();
  for (const e of graph.edges) {
    const isTestedBy = e.from_external_id === symId && e.relationship_type === "TESTED_BY";
    const isCovers = e.to_external_id === symId && e.relationship_type === "COVERS";
    if (!isTestedBy && !isCovers) continue;
    const testId = isTestedBy ? e.to_external_id : e.from_external_id;
    testIds.add(testId);
    const edgeName = e.properties?.test_name;
    if (typeof edgeName === "string" && JAVA_TEST_METHOD_RE.test(edgeName)) {
      const set = edgeMethodsByTest.get(testId) ?? new Set<string>();
      set.add(edgeName);
      edgeMethodsByTest.set(testId, set);
    }
  }
  for (const testId of testIds) {
    const cls = javaTestClassOf(testId);
    if (!cls) continue;
    for (const m of edgeMethodsByTest.get(testId) ?? []) selectors.add(`${cls}#${m}`);
  }
  if (selectors.size >= 1) return selectors.size === 1 ? [...selectors][0] : null;
  // Fallback: no per-edge test_name (older graph) — a test class holding exactly one test.
  for (const testId of testIds) {
    const cls = javaTestClassOf(testId);
    if (!cls) continue;
    const tc = nodeById.get(testId);
    if (!tc || tc.kind !== "TestCase") continue;
    const testNames = Array.isArray(tc.properties.test_names) ? tc.properties.test_names : [];
    const valid = testNames.filter((n): n is string => typeof n === "string" && JAVA_TEST_METHOD_RE.test(n));
    if (valid.length === 1) selectors.add(`${cls}#${valid[0]}`);
  }
  return selectors.size === 1 ? [...selectors][0] : null;
}

const GENERATED_HEADER = "// Generated by OrangePro — do not edit";
// "Static map first, dynamically prove top 5": ONE unified dynamic-proof budget spans
// BOTH lanes (existing-tests first, then generation for the remaining eligible gaps).
// TOTAL attempts (existing + generation) are capped at this budget; `--auto-limit N`
// overrides it (clamped to MAX_AUTO_LIMIT) for deeper runs (`opro start --auto-limit 25`,
// `opro prove`, `opro prove-loop`). Static breadth (behaviors/flows/associated/risk) is
// never gated on this budget — only the dynamic verification pass is.
const DEFAULT_AUTO_LIMIT = 5;
const MAX_AUTO_LIMIT = 50;
/** Generator caps a single call at 5 (MAX_LIMIT); page candidates in windows of that. */
const GEN_WINDOW = 5;
// ponytail: cap the weak MAY_*/MAY_RELATE_TO fan-out a single symbol contributes so one hot
// file (every eligible symbol × every importing test) cannot starve the shared budget before
// a provable hard-edge symbol is tried. Small K; promote to a flag if a repo needs a wider sweep.
const EXISTING_LANE_MAX_WEAK_PER_SYMBOL = 3;

export const NO_KEY_MESSAGE =
  "No provider key; auto-prove skipped — add OPENAI_API_KEY / ANTHROPIC_API_KEY, or use the OrangePro MCP in your coding agent.";

/** How a single attempted target resolved. Only `proven` moves public Proven. */
export type AutoProveClass = "proven" | "non_killing" | "needs_setup" | "gen_failed";

export interface AutoProveAttempt {
  target_symbol: string;
  /** Workspace-relative path written under orangepro_generated/. */
  test_path: string;
  classification: AutoProveClass;
  reason?: string;
  /** Oracle status for the attempted mutant, when available. */
  mutant_status?: string;
  /**
   * R-1: fine-grained baseline-red root cause when a baseline was red
   * (module_not_found / experimental_builtin / engine_mismatch / db_or_external /
   * logic_failure / unknown). Sanitized metadata only — never raw stderr.
   */
  category?: BaselineCategory;
  /** R-1: marked from a same-file sibling's shared root cause WITHOUT re-running (dedup). */
  deduped?: boolean;
}

export function isRoastSurvivor(attempt: Pick<AutoProveAttempt, "classification" | "mutant_status">): boolean {
  return attempt.classification === "non_killing" && attempt.mutant_status === "associated_survived";
}

export interface AutoProveSkip {
  target_symbol?: string;
  title: string;
  reason: string;
}

export interface AutoProveResult {
  /** true only when a key was present and auto-prove actually ran the loop. */
  ran: boolean;
  status: "proven-run" | "ran-no-proof" | "no-targets" | "skipped-no-key" | "disabled";
  /** Human guidance for skipped/disabled/no-target runs (e.g. the no-key message). */
  reason?: string;
  attempted: number;
  proven: number;
  needs_setup: AutoProveAttempt[];
  skipped: AutoProveSkip[];
  /** Every file path written this run (workspace-relative). */
  generated_files: string[];
  /** Full per-target detail (proven + non_killing + needs_setup). */
  attempts: AutoProveAttempt[];
}

type GenerateFn = typeof generateTests;
type ProveLoopFn = (root: string, opts: ProveLoopOptions, deps: OperationDeps) => ProveLoopResult;

export interface AutoProveOptions {
  /** Unified dynamic-proof budget: total existing + generation attempts before stopping (default 5). */
  autoLimit?: number;
  /** --no-auto: restore analyze-only behavior. */
  noAuto?: boolean;
  /** Provider override (from --provider/--model), forwarded to the generator's key resolution. */
  provider?: string;
  model?: string;
  /**
   * PR mode: restrict candidates to CodeSymbols in these changed files. When present
   * and non-empty, auto-prove scopes to the diff (changed_impact), not the whole repo.
   */
  changedFiles?: string[];
  /** Try existing associated tests only; never call a model provider or write generated tests. */
  existingOnly?: boolean;
  /**
   * Opt-in generation strategy for the KEY-GATED generation lane only. Default (undefined)
   * → v2/deterministic, unchanged. "v5" routes generation through the batched two-phase v5
   * path. Trust-neutral: the generated test still flows through the UNCHANGED prove/mint
   * oracle — v5 only changes WHICH tests are drafted, never how Proven is decided.
   */
  prompt_version?: "v2" | "v5";
}

/** Injectable deps: env + clock + oracle runner (via OperationDeps), plus generate/proveLoop for testing. */
export interface AutoProveDeps extends OperationDeps {
  generate?: GenerateFn;
  proveLoop: ProveLoopFn;
}

/**
 * Resolve the contained absolute path for a generated file, REJECTING any name that
 * escapes `<sourceRoot>/orangepro_generated/`. Exported so the guardrail is unit-tested.
 */
export function containedGeneratedPath(sourceRoot: string, filename: string): string {
  const dir = resolve(sourceRoot, GENERATED_DIR);
  return resolveContained(dir, filename);
}

/** The source file a `sym:` target lives in (workspace-relative). */
function symbolFile(target: string): string {
  return target.slice("sym:".length).split("#")[0] ?? "";
}

/** Relative import specifiers (`./x`, `../x`) in import/export/require/dynamic-import positions. */
const REL_IMPORT_RE = /(\bfrom\s*|\bimport\s*|\brequire\s*\(\s*|\bimport\s*\(\s*)(['"])(\.\.?\/[^'"]*)\2/g;

/**
 * Re-point a generated test's RELATIVE imports so they resolve from
 * `orangepro_generated/`. The generator grounds imports against the SOURCE dir (the
 * model co-locates the test with the module under test, e.g. `./order.service`), but
 * autoProve writes the test to `orangepro_generated/`. Resolve each `./x` / `../x`
 * against the target source file's directory, then re-express it relative to
 * `orangepro_generated/` (POSIX, leading `./`) — e.g. `./order.service` →
 * `../src/order.service`. Only import/require positions are touched, never plain
 * string literals. TS/JS only — this rewrite serves the TS/JS generation lane;
 * Go/Java/Python proofs route through their own language spikes.
 */
function rewriteRelativeImports(body: string, targetFileRel: string, generatedDir: string): string {
  const baseDir = posix.dirname(targetFileRel.split(sep).join("/"));
  return body.replace(REL_IMPORT_RE, (_m, prefix: string, quote: string, spec: string) => {
    const abs = posix.normalize(posix.join(baseDir === "." ? "" : baseDir, spec));
    let rel = posix.relative(generatedDir, abs);
    if (!rel.startsWith(".")) rel = `./${rel}`;
    return `${prefix}${quote}${rel}${quote}`;
  });
}

function fileReaderFor(root: string): FileReader {
  const absRoot = resolve(root);
  return (relPath: string): string | null => {
    const abs = resolve(absRoot, relPath);
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) return null;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };
}

interface ClassifyContext {
  /** Absolute source root (for the nearest package.json engines lookup). */
  sourceRoot: string;
  /** Workspace-relative target file (for engines lookup + failure attribution). */
  targetFileRel: string;
  /** Runner Node version (process.version); injectable for tests. */
  runnerNode?: string;
}

interface ProofClassification {
  classification: AutoProveClass;
  reason?: string;
  category?: BaselineCategory;
}

/**
 * R-1: classify a prove-loop result. A RED baseline is classified from the oracle's
 * already-redacted `baseline.failureSummary` (+ the target's declared engines.node vs the
 * runner Node) into a SPECIFIC reason. logic_failure is a genuine failing test on the real
 * code → an honest non-proof, NEVER needs_setup. No proof is minted here.
 */
function classifyProof(result: ProveLoopResult, ctx: ClassifyContext): ProofClassification {
  if ("status" in result && result.status === "unrunnable") {
    // Setup did not run (env non-event) — nothing was minted, target needs setup.
    return { classification: "needs_setup", reason: result.reason };
  }
  const dyn = result as DynamicProofResult;
  const record = dyn.record;
  if (record.closed) return { classification: "proven" };
  const cert = record.dynamic_proof;
  if (cert && cert.baseline_green === false) {
    const { category, reason } = classifyBaselineFailure({
      failureSummary: dyn.oracle.baseline?.failureSummary,
      enginesNode: readEnginesNode(ctx.sourceRoot, ctx.targetFileRel),
      runnerNode: ctx.runnerNode ?? process.version
    });
    const classification: AutoProveClass = isNeedsSetupCategory(category) ? "needs_setup" : "non_killing";
    return { classification, reason: redactSecrets(reason), category };
  }
  return { classification: "non_killing", reason: record.reason ?? "Mutant survived; the test does not assert on the target's real behavior." };
}

function mutantStatusOf(result: ProveLoopResult): string | undefined {
  if ("status" in result && result.status === "unrunnable") return "unrunnable";
  return (result as DynamicProofResult).record.dynamic_proof?.mutant_status;
}

/**
 * R-1 sibling-dedup key: a baseline-red import-time failure is a deterministic property of
 * loading the TARGET FILE with a given runner, independent of which test runs it — so
 * same-file siblings share it. Keyed on the TARGET FILE only (every caller pins runner to
 * undefined): the sole deduped cause is engine_mismatch, a package-level fact both lanes
 * classify against the SAME process.version, so the runner must not be in the key. The old
 * {runner, target file} key split the cache across lanes (lane 1 wrote "auto <file>", the
 * generation lane read "<runner> <file>" -> never matched), silently disabling cross-lane
 * dedup. NEVER merges across different files or a different failure class.
 */
function dedupKey(runner: string | undefined, targetFileRel: string): string {
  return `${runner ?? "auto"}\u0000${targetFileRel}`;
}

/** A same-file sibling deduped WITHOUT re-running: shares the first attempt's redacted reason. */
function dedupedAttempt(targetSymbol: string, testPath: string, targetFileRel: string, blocked: BaselineClassification): AutoProveAttempt {
  return {
    target_symbol: targetSymbol,
    test_path: testPath,
    classification: "needs_setup",
    reason: `${blocked.reason} (shared root cause with a sibling in ${targetFileRel}; not re-run).`,
    category: blocked.category,
    deduped: true
  };
}

/**
 * R-2: the exact experimental-builtin env profile for a target that references node:sqlite,
 * else undefined. Auto-applied only on a confident source reference; forwarded through the
 * EXISTING test_env path (opProveLoop → oracle --test-env, spike-allowlisted). It only makes
 * the baseline RUNNABLE — never asserts, mocks, or mints Proven. Ambient NODE_OPTIONS is never
 * forwarded (this is an explicit fixed flag, not process.env).
 */
function experimentalSqliteTestEnv(reader: FileReader, targetFileRel: string): string[] | undefined {
  if (!targetNeedsExperimentalSqlite(reader, targetFileRel)) return undefined;
  // Only inject where the runner Node actually accepts the flag in NODE_OPTIONS. On Node < 22.5 the
  // flag is rejected outright ("--experimental-sqlite is not allowed in NODE_OPTIONS", exit 9), which
  // would make the baseline unrunnable for a spurious reason; there node:sqlite is unavailable anyway,
  // so we skip injection and let R-1 classify it honestly as an experimental-builtin needs_setup.
  // The oracle spawns the runner with this same Node (process.execPath), so this check is authoritative.
  if (!process.allowedNodeEnvironmentFlags.has("--experimental-sqlite")) return undefined;
  return [EXPERIMENTAL_SQLITE_TEST_ENV];
}

const zeroSummary = (status: AutoProveResult["status"], ran: boolean, reason?: string): AutoProveResult => ({
  ran,
  status,
  reason,
  attempted: 0,
  proven: 0,
  needs_setup: [],
  skipped: [],
  generated_files: [],
  attempts: []
});

function symbolFileOf(node: GraphNode): string {
  return typeof node.properties.file === "string" ? node.properties.file : node.external_id.replace(/^sym:/, "").split("#")[0];
}

/**
 * Map each ELIGIBLE CodeSymbol to the existing test files statically linked to it — the
 * repo's OWN tests. Sources are exactly the edges RTM/coverage read for the "Associated"
 * tier:
 *   - hard TESTED_BY/COVERS edges (the confirmer's sym↔TestCase links, `graph.edges`);
 *   - weak MAY_BE_TESTED_BY/MAY_COVER candidate edges (sym↔TestCase, `graph.candidate_edges`);
 *   - weak MAY_RELATE_TO candidate edges (a test file resolved-imports a source FILE) —
 *     the broadest signal, mapped to every eligible symbol in that source file.
 * The static edge only SELECTS a target+test pair for the oracle — it is never itself proof,
 * and a symbol the test does not actually exercise simply survives the mutant (honest skip).
 * AI-suggested candidate edges are excluded (a model guess is not an existing test).
 */
export function existingAssociatedTests(graph: LocalGraph, nodeById: Map<string, GraphNode>): Map<string, AssocTest[]> {
  const out = new Map<string, AssocTest[]>();
  const testFileOf = (id: string): string | null => {
    const n = nodeById.get(id);
    if (!n || n.kind !== "TestCase") return null;
    return typeof n.properties.file === "string" ? n.properties.file : id.replace(/^test:/, "");
  };
  // `hard` = TESTED_BY/COVERS (the confirmer's structural links); weak = MAY_* candidate
  // edges. Hard is recorded before weak (graph.edges scanned first), so a test already
  // linked hard is never downgraded, and a later weak dup of the same pair is a no-op —
  // the hard flag can only ever originate from a genuine TESTED_BY/COVERS edge.
  const add = (symId: string, testRel: string, hard: boolean): void => {
    // A HARD TESTED_BY/COVERS edge is a real derivable test; admit it even when the symbol
    // is not_entry_point_adjacent (relaxed shape-only guard). Weak MAY_* fan-out stays strict.
    const node = nodeById.get(symId);
    if (!(hard ? isEligibleHardExistingTarget(node) : isEligibleProvableTarget(node))) return;
    const list = out.get(symId);
    if (!list) {
      out.set(symId, [{ test: testRel, hard }]);
      return;
    }
    const existing = list.find((t) => t.test === testRel);
    if (existing) {
      if (hard) existing.hard = true;
      return;
    }
    list.push({ test: testRel, hard });
  };
  // A sym↔test edge joins one TestCase endpoint to one CodeSymbol endpoint; resolve
  // whichever side is the symbol so both edge directions are handled uniformly.
  const link = (a: string, b: string, hard: boolean): void => {
    const tb = testFileOf(b);
    if (tb && nodeById.get(a)?.kind === "CodeSymbol") return add(a, tb, hard);
    const ta = testFileOf(a);
    if (ta && nodeById.get(b)?.kind === "CodeSymbol") add(b, ta, hard);
  };

  // Eligible symbols grouped by source file, for the file-level MAY_RELATE_TO expansion.
  const eligibleByFile = new Map<string, string[]>();
  for (const n of graph.nodes) {
    if (!isEligibleProvableTarget(n)) continue;
    const f = symbolFileOf(n);
    const list = eligibleByFile.get(f);
    if (list) list.push(n.external_id);
    else eligibleByFile.set(f, [n.external_id]);
  }
  // MAY_RELATE_TO endpoints are plain workspace-relative file paths; a test file's node id
  // is `test:${relPath}`. Return the test relPath for whichever endpoint is a TestCase file.
  const testRelForFile = (relPath: string): string | null => {
    const n = nodeById.get(`test:${relPath}`);
    return n && n.kind === "TestCase" ? relPath : null;
  };

  for (const e of graph.edges) {
    if (e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS") link(e.from_external_id, e.to_external_id, true);
  }
  for (const e of graph.candidate_edges ?? []) {
    if (e.review_status === "ai_suggested") continue;
    if (e.relationship_type === "MAY_BE_TESTED_BY" || e.relationship_type === "MAY_COVER") {
      link(e.from_external_id, e.to_external_id, false);
    } else if (e.relationship_type === "MAY_RELATE_TO") {
      const fromTest = testRelForFile(e.from_external_id);
      const testRel = fromTest ?? testRelForFile(e.to_external_id);
      const sourceRel = fromTest ? e.to_external_id : e.from_external_id;
      if (testRel) for (const symId of eligibleByFile.get(sourceRel) ?? []) add(symId, testRel, false);
    }
  }
  return out;
}

/** One associated test file for a symbol, tagged by edge strength (hard TESTED_BY/COVERS vs weak MAY_*). */
export interface AssocTest {
  test: string;
  hard: boolean;
}

/** A single (symbol, test) attempt reference in the ordered existing-tests queue. */
export interface ExistingAttemptRef {
  symId: string;
  testRel: string;
  hard: boolean;
}

/**
 * Fix 3 — deterministic hard-first, weak-capped attempt order. Every hard TESTED_BY/COVERS
 * pair precedes ANY weak MAY_* pair (a provable hard-edge symbol is tried before weak fan-out
 * burns the shared budget), and each symbol contributes at most `maxWeakPerSymbol` weak pairs
 * so one hot MAY_RELATE_TO file (its every eligible symbol × every importing test) can't starve
 * the budget. Order within each tier follows the Map's insertion order (graph node/edge order),
 * so the result is deterministic.
 */
export function orderExistingAttempts(
  testsBySymbol: Map<string, AssocTest[]>,
  maxWeakPerSymbol: number = EXISTING_LANE_MAX_WEAK_PER_SYMBOL
): ExistingAttemptRef[] {
  const hard: ExistingAttemptRef[] = [];
  const weak: ExistingAttemptRef[] = [];
  for (const [symId, tests] of testsBySymbol) {
    let weakCount = 0;
    for (const t of tests) {
      if (t.hard) hard.push({ symId, testRel: t.test, hard: true });
      else if (weakCount++ < maxWeakPerSymbol) weak.push({ symId, testRel: t.test, hard: false });
    }
  }
  return [...hard, ...weak];
}

interface ExistingLaneResult {
  attempts: AutoProveAttempt[];
  needsSetup: AutoProveAttempt[];
  proven: number;
  attempted: number;
  /** Symbols the existing-tests lane already proved this run — generation skips them. */
  provenSymbols: Set<string>;
}

/**
 * PR 1.5 lane — prove the repo's OWN existing tests, NO provider key. For each eligible
 * target with an existing associated test, run the UNCHANGED `opProveLoop` with the test
 * IN ITS ORIGINAL LOCATION (never copied/relocated — that avoids the generation lane's
 * import-grounding pitfall). TS/JS uses a null-sentinel mutant; Go (G-INT-2) selects the
 * test by its derived `^TestName$` and lets the Go oracle compute its own zero-value
 * sentinel. Closes → Proven; survives / crashes-pre-assert / setup-fails / (Go)
 * unresolvable-test-name → honest skip (never Proven, and #162 best-ever selection means
 * it can never clobber a prior Proven). Consumes from the SHARED unified budget (`budget`)
 * — the generation lane gets whatever this lane leaves unspent, so TOTAL attempts
 * (existing + generation) never exceed the budget.
 */
function proveExistingAssociatedTests(
  root: string,
  graph: LocalGraph,
  sourceRoot: string,
  nodeById: Map<string, GraphNode>,
  opts: AutoProveOptions,
  proveLoop: ProveLoopFn,
  proveDeps: OperationDeps,
  alreadyProven: ReadonlySet<string>,
  importTimeBlocked: Map<string, BaselineClassification>,
  budget: number
): ExistingLaneResult {
  const attempts: AutoProveAttempt[] = [];
  const needsSetup: AutoProveAttempt[] = [];
  const provenSymbols = new Set<string>();
  let proven = 0;
  let attempted = 0;

  const changed = opts.changedFiles && opts.changedFiles.length > 0 ? new Set(opts.changedFiles) : null;
  const reader = fileReaderFor(sourceRoot); // R-2: source scan for the node:sqlite env profile
  // Fix 3: hard TESTED_BY/COVERS pairs first, weak MAY_* pairs after and capped per symbol.
  const queue = orderExistingAttempts(existingAssociatedTests(graph, nodeById));

  for (const { symId, testRel, hard } of queue) {
    if (attempted >= budget) break;
    const node = nodeById.get(symId);
    // Redundant with existingAssociatedTests' own filter, but the eligibility barrier is
    // the sole guard against handing plumbing to the guard-less prove path — assert it here too.
    // A hard-edge pick uses the relaxed shape-only guard (mirrors the add() decision above).
    if (!(hard ? isEligibleHardExistingTarget(node) : isEligibleProvableTarget(node))) continue;
    if (changed && !changed.has(symbolFileOf(node!))) continue;
    // Fix 1: already Proven for the CURRENT code (fingerprint match under #162) → skip. Re-closing
    // it would overstate newly-proven and append a redundant closed cert every run.
    if (alreadyProven.has(symId)) continue;
    // Proven earlier THIS run — one closing existing test per symbol is enough.
    if (provenSymbols.has(symId)) continue;
    const targetFileRel = symbolFileOf(node!);
    // R-1 sibling dedup: a prior same-file attempt hit a package-level env root cause
    // (engine_mismatch: runner Node outside the declared engines range). Every sibling in this
    // file fails baseline identically → mark it
    // needs_setup WITHOUT re-running (and WITHOUT consuming the attempt budget).
    const isPython = isPythonFile(targetFileRel);
    const candidateTestRels = isPython
      ? pytestNodeidsForFile(sourceRoot, testRel).filter((candidate) => isRunnableTestForTarget(node!, candidate))
      : [testRel];
    if (candidateTestRels.length === 0) continue;
    const proofTestRel = candidateTestRels[0]!;
    const blocked = importTimeBlocked.get(dedupKey(undefined, targetFileRel));
    if (blocked) {
      const attempt = dedupedAttempt(symId, proofTestRel, targetFileRel, blocked);
      attempts.push(attempt);
      needsSetup.push(attempt);
      continue;
    }
    // Go and Java targets select the test BY NAME and let their oracle derive its own
    // typed sentinel — no test_path/replacement/link_node_modules/test_env apply. Go
    // uses `go test -run ^TestX$`; Java uses `mvn test -Dtest=Class#method`. Resolve the
    // exact selector; if it can't be resolved uniquely, SKIP without spending the attempt
    // budget (a broad/wrong selector is refused/unmatched by the oracle and wastes a run).
    const isGo = isGoFile(targetFileRel);
    const isJava = isJavaFile(targetFileRel);
    let nativeTestRun: string | null = null;
    let goAssertionLine: number | undefined;
    if (isGo) {
      nativeTestRun = goTestRunForTarget(nodeById, graph, symId);
      if (!nativeTestRun) continue;
      goAssertionLine = goAssertionLineForTarget(graph, symId, nativeTestRun);
    } else if (isJava) {
      nativeTestRun = javaTestForTarget(nodeById, graph, symId);
      if (!nativeTestRun) continue;
    }
    attempted++;
    // R-2: inject NODE_OPTIONS=--experimental-sqlite via the existing test_env path when the
    // target references node:sqlite. Makes the baseline runnable only; never mints Proven.
    const testEnv = isGo || isJava || isPython ? undefined : experimentalSqliteTestEnv(reader, targetFileRel);
    const displayTest = nativeTestRun ?? proofTestRel;
    // G5: name the plan before the attempt — detected runner/selector + target —
    // so a detection miss is a visible, named thing instead of a mysterious 0.
    reportProgress(
      `proof plan: ${symId} → ${
        isGo
          ? `go test -run '${nativeTestRun}'`
          : isJava
            ? `mvn test -Dtest=${nativeTestRun}`
            : isPython
              ? `pytest ${displayTest}`
              : `js test file ${displayTest}`
      }`
    );
    let result: ProveLoopResult;
    try {
      result = proveLoop(
        root,
        nativeTestRun
          ? { target_symbol: symId, source: sourceRoot, test_run: nativeTestRun, ...(goAssertionLine !== undefined ? { go_assertion_line: goAssertionLine } : {}), run_id: `auto-prove-existing-${attempted}` }
          // link_node_modules: the isolated proof copy excludes node_modules; without linking,
          // any target/test importing a repo dependency fails baseline → needs_setup. Linking only
          // makes real tests runnable — Proven still requires the dynamic oracle's sentinel kill.
          : {
              target_symbol: symId,
              source: sourceRoot,
              test_path: proofTestRel,
              replacement: replacementForTarget(targetFileRel),
              link_node_modules: true,
              ...(testEnv ? { test_env: testEnv } : {}),
              run_id: `auto-prove-existing-${attempted}`
            },
        proveDeps
      );
    } catch (e) {
      const attempt: AutoProveAttempt = {
        target_symbol: symId,
        test_path: displayTest,
        classification: "needs_setup",
        reason: `Proof could not run: ${redactSecrets(errMsg(e))}`
      };
      attempts.push(attempt);
      needsSetup.push(attempt);
      continue;
    }
    const { classification, reason, category } = classifyProof(result, { sourceRoot, targetFileRel });
    const attempt: AutoProveAttempt = {
      target_symbol: symId,
      test_path: displayTest,
      classification,
      reason,
      category,
      mutant_status: mutantStatusOf(result)
    };
    attempts.push(attempt);
    if (classification === "proven") {
      proven++;
      provenSymbols.add(symId); // its remaining queued tests are skipped above
      continue;
    }
    if (classification === "needs_setup") {
      needsSetup.push(attempt);
      // Cache an import-time root cause so same-file siblings dedup instead of re-running.
      if (category && IMPORT_TIME_CATEGORIES.has(category)) {
        importTimeBlocked.set(dedupKey(undefined, targetFileRel), { category, reason: reason ?? "" });
      }
    }
    // non_killing → keep trying this symbol's other associated tests, if any.
  }
  return { attempts, needsSetup, proven, attempted, provenSymbols };
}

/**
 * Drive prove for the top provable TS/JS targets. Two lanes: (1) prove the repo's OWN
 * existing associated tests — NO key, runs first (PR 1.5); (2) key-gated generate → prove
 * to fill the remaining gaps (PR 1). The existing oracle is the sole proof judge for both;
 * generation writes are contained under orangepro_generated/.
 */
export async function autoProve(root: string, opts: AutoProveOptions, deps: AutoProveDeps): Promise<AutoProveResult> {
  if (opts.noAuto) return zeroSummary("disabled", false, "--no-auto: auto-prove disabled; analyze-only.");

  const clock: Clock = deps.clock ?? systemClock;
  const proveLoop = deps.proveLoop;
  const proveDeps: OperationDeps = {
    clock,
    env: deps.env,
    dynamicProofRunner: deps.dynamicProofRunner,
    coverageRunner: deps.coverageRunner,
    analyze: deps.analyze,
    aiProvider: deps.aiProvider
  };

  const graph = loadGraph(workspacePaths(root).graphPath);
  const sourceRoot = resolve(graph.workspace.root);
  const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));

  // Fix 1: symbols already Proven for the CURRENT code. `buildRtm(graph, ledger)` IS the
  // #162 fingerprint-scoped decision that sets a row's tier to "proven" (via
  // selectLedgerBySymbol), so we reuse it verbatim rather than re-deriving fingerprints.
  // Both lanes skip these so res.proven counts only NEWLY-minted proofs this run and no
  // redundant closed cert is appended. A changed file → different fingerprint → not in
  // this set → still attempted (re-prove for the new code).
  const alreadyProven = new Set(
    buildRtm(graph, loadLedger(root)).rows
      .filter((r) => r.evidence_tier === "proven")
      .map((r) => r.code_symbol)
      .filter(Boolean)
  );

  // R-1: shared sibling-dedup cache of import-time baseline failures. Spans BOTH lanes so a
  // node:sqlite-style root cause found once is never re-run across same-file siblings.
  const importTimeBlocked = new Map<string, BaselineClassification>();

  // ONE unified dynamic-proof budget for the whole pass (existing-first → then generation).
  // Default 5 ("dynamically prove top 5"); `--auto-limit N` overrides it, clamped to
  // MAX_AUTO_LIMIT. The existing lane consumes from this budget and the generation lane gets
  // only the remainder, so TOTAL attempts (existing + generation) are ≤ budget.
  const autoLimit = Math.max(1, Math.min(MAX_AUTO_LIMIT, Math.floor(opts.autoLimit ?? DEFAULT_AUTO_LIMIT)));

  // ── Lane 1: existing associated tests — NO key required, runs FIRST (PR 1.5). ──
  const ex = proveExistingAssociatedTests(root, graph, sourceRoot, nodeById, opts, proveLoop, proveDeps, alreadyProven, importTimeBlocked, autoLimit);

  if (opts.existingOnly) {
    const status: AutoProveResult["status"] = ex.proven > 0 ? "proven-run" : ex.attempted > 0 ? "ran-no-proof" : "no-targets";
    return {
      ran: ex.attempted > 0,
      status,
      reason: "existing-tests-only: generation disabled.",
      attempted: ex.attempted,
      proven: ex.proven,
      needs_setup: ex.needsSetup,
      skipped: [],
      generated_files: [],
      attempts: ex.attempts
    };
  }

  // Key gate applies ONLY to the generation lane. No provider key ⇒ generation is skipped
  // (no files, no fake proof) with explicit guidance; the existing-tests lane still counts.
  const providerConfig = resolveProviderConfig(deps.env, { provider: opts.provider, model: opts.model });
  if (!providerConfig) {
    const status: AutoProveResult["status"] = ex.proven > 0 ? "proven-run" : ex.attempted > 0 ? "ran-no-proof" : "skipped-no-key";
    return {
      ran: ex.attempted > 0,
      status,
      reason: NO_KEY_MESSAGE,
      attempted: ex.attempted,
      proven: ex.proven,
      needs_setup: ex.needsSetup,
      skipped: [],
      generated_files: [],
      attempts: ex.attempts
    };
  }

  const provider = buildProvider(providerConfig);
  const generate = deps.generate ?? generateTests;
  const reader = fileReaderFor(sourceRoot);

  // Generation gets only the budget the existing-tests lane left unspent, so existing +
  // generation attempts total ≤ autoLimit. Exhausted budget ⇒ genBudget 0 ⇒ no provider call.
  const genBudget = Math.max(0, autoLimit - ex.attempted);

  // Candidates = ORS-ranked provable CodeSymbols. rankRiskGaps ranks by OrangePro Risk
  // Score and excludes hard-confirmed symbols; we ALSO enforce the eligibility barrier
  // explicitly (isEligibleProvableTarget) at selection so an excluded infra symbol can
  // NEVER reach the guard-less prove path, and drop any symbol the existing-tests lane
  // already proved so generation fills only the remaining gaps. PR mode scopes to the
  // eligible symbols whose file is in the changed set (changed_files → symbols, NOT
  // affected_behaviors — those are Requirement/UserFlow/BusinessRule ids opDynamicProof
  // cannot prove).
  let candidates = rankRiskGaps(graph, { repoRoot: sourceRoot, limit: 500 }).filter(
    (g) => isEligibleProvableTarget(nodeById.get(g.id)) && !ex.provenSymbols.has(g.id) && !alreadyProven.has(g.id)
  );
  if (opts.changedFiles && opts.changedFiles.length > 0) {
    const changed = new Set(opts.changedFiles);
    candidates = candidates.filter((g) => changed.has(g.file));
  }

  const attempts: AutoProveAttempt[] = [];
  const needsSetup: AutoProveAttempt[] = [];
  const skipped: AutoProveSkip[] = [];
  const generatedFiles: string[] = [];
  const declaredDeps = readDeclaredDeps(sourceRoot);
  let proven = 0;
  let attempted = 0;

  for (let start = 0; start < candidates.length && attempted < genBudget; start += GEN_WINDOW) {
    const window = candidates.slice(start, start + GEN_WINDOW);
    const need = genBudget - attempted;
    const windowIds = window.map((g) => g.id);
    const gen = await generate(
      graph,
      { target_ids: windowIds, limit: Math.min(windowIds.length, need), ...(opts.prompt_version ? { prompt_version: opts.prompt_version } : {}) },
      provider,
      reader,
      clock
    );
    const tests = gen.generated_tests;
    // Global start offset so filenames stay unique across windows — runHintsFor
    // otherwise resets its index to 0 per window and same-slug targets collide.
    const hints = runHintsFor(tests, sourceRoot, start);

    for (let i = 0; i < tests.length && attempted < genBudget; i++) {
      const test = tests[i];
      const hint = hints[i];
      if (!hint.prove_run) {
        // No JS prove_run. Go and Java are dynamically provable only through their OWN
        // test in the target's package/module (the existing-tests lane): the Go oracle
        // runs `go test -run ^TestX$ ./<pkgdir>` and the Java oracle runs
        // `mvn test -Dtest=Class#method` in the target's Maven module, so a freshly
        // generated test written to orangepro_generated/ is in the wrong package/module
        // and can never be reached. Skip generated Go/Java here with an honest reason
        // (the existing-tests lane covers both).
        const genFile = hint.target_symbol_external_id ? symbolFile(hint.target_symbol_external_id) : "";
        const goGen = genFile ? isGoFile(genFile) : false;
        const javaGen = genFile ? isJavaFile(genFile) : false;
        skipped.push({
          target_symbol: hint.target_symbol_external_id,
          title: test.title,
          reason: goGen
            ? "Go dynamic proof runs the target package's own test; a generated Go test is out of that package — proven via the existing-tests lane instead."
            : javaGen
              ? "Java dynamic proof runs the target module's own test; a generated Java test is out of that module — proven via the existing-tests lane instead."
              : hint.target_symbol_external_id
                ? "Target is not TS/JS; dynamic proof supports TS/JS CodeSymbol targets only."
                : "No resolvable TS/JS code-symbol target to prove."
        });
        continue;
      }

      const { target_symbol, replacement, runner } = hint.prove_run.args;
      const targetFileRel = symbolFile(target_symbol);
      // R-1 sibling dedup (cross-lane): a same-file target already hit an import-time env root
      // cause → a fresh generated test importing the same module fails identically. Skip it
      // WITHOUT generating/writing/running or consuming the attempt budget.
      const blocked = importTimeBlocked.get(dedupKey(undefined, targetFileRel));
      if (blocked) {
        const attempt = dedupedAttempt(target_symbol, "", targetFileRel, blocked);
        attempts.push(attempt);
        needsSetup.push(attempt);
        continue;
      }
      const filename = basename(hint.prove_run.args.test_path);
      let abs: string;
      try {
        abs = containedGeneratedPath(sourceRoot, filename);
      } catch (e) {
        skipped.push({ target_symbol, title: test.title, reason: `Generated path rejected (escapes ${GENERATED_DIR}/): ${redactSecrets(errMsg(e))}` });
        continue;
      }
      const writeRel = `${GENERATED_DIR}/${filename}`;

      // The generator grounds imports at the source/suggested dir; autoProve writes
      // to orangepro_generated/. Re-point relative specifiers at the target source
      // file so they resolve from the write location (`./x` → `../src/x`).
      const body = rewriteRelativeImports(test.body, symbolFile(target_symbol), GENERATED_DIR);

      // A "non-runnable" verdict is usually just import LOCATION, which the rewrite
      // fixes. Re-validate against the ACTUAL write location: skip only if locals
      // still won't resolve (a genuine setup gap the oracle could never honestly close).
      if (test.runnable === false && unresolvedLocalImports(body, abs, sourceRoot, declaredDeps).length > 0) {
        skipped.push({
          target_symbol,
          title: test.title,
          reason: `Generator returned a non-runnable draft${test.unresolved_reason ? `: ${test.unresolved_reason}` : "."}`
        });
        continue;
      }

      if (existsSync(abs)) {
        // Guardrail: never overwrite an existing file.
        skipped.push({ target_symbol, title: test.title, reason: `Existing file ${writeRel} not overwritten.` });
        continue;
      }

      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, `${GENERATED_HEADER}\n${body}${body.endsWith("\n") ? "" : "\n"}`, "utf8");
      generatedFiles.push(writeRel);
      attempted++;

      // R-2: inject the node:sqlite env profile when the TARGET source references the builtin.
      const testEnv = experimentalSqliteTestEnv(reader, targetFileRel);
      // G5: plan line for the generated-test attempt (runner from the run hint).
      reportProgress(`proof plan: ${hint.prove_run.args.target_symbol} → ${hint.prove_run.args.runner ?? "auto"} on ${writeRel}`);
      let result: ProveLoopResult;
      try {
        result = proveLoop(
          root,
          {
            target_symbol,
            source: sourceRoot,
            test_path: writeRel,
            replacement,
            runner,
            // See lane 1: link node_modules so a generated test importing a repo dep can boot.
            link_node_modules: true,
            ...(testEnv ? { test_env: testEnv } : {}),
            run_id: `auto-prove-${start + i + 1}`
          },
          proveDeps
        );
      } catch (e) {
        const attempt: AutoProveAttempt = {
          target_symbol,
          test_path: writeRel,
          classification: "needs_setup",
          reason: `Proof could not run: ${redactSecrets(errMsg(e))}`
        };
        attempts.push(attempt);
        needsSetup.push(attempt);
        continue;
      }

      const { classification, reason, category } = classifyProof(result, { sourceRoot, targetFileRel });
      const attempt: AutoProveAttempt = {
        target_symbol,
        test_path: writeRel,
        classification,
        reason,
        category,
        mutant_status: mutantStatusOf(result)
      };
      attempts.push(attempt);
      if (classification === "proven") proven++;
      else if (classification === "needs_setup") {
        needsSetup.push(attempt);
        // Cache an import-time root cause so same-file siblings dedup instead of re-running.
        if (category && IMPORT_TIME_CATEGORIES.has(category)) {
          importTimeBlocked.set(dedupKey(undefined, targetFileRel), { category, reason: reason ?? "" });
        }
      }
      // non_killing stays in `attempts` only — an honest skip, never Proven.
    }

    // A window that produced nothing (transient generation hiccup) must NOT abandon
    // lower-ranked candidates: the outer loop already terminates at pool exhaustion
    // or when the attempt budget (autoLimit) is reached.
  }

  // Merge the existing-tests lane (ran first, no key) with the generation lane.
  const totalProven = ex.proven + proven;
  const totalAttempted = ex.attempted + attempted;
  const status: AutoProveResult["status"] =
    totalProven > 0 ? "proven-run" : totalAttempted > 0 ? "ran-no-proof" : "no-targets";
  return {
    ran: true,
    status,
    attempted: totalAttempted,
    proven: totalProven,
    needs_setup: [...ex.needsSetup, ...needsSetup],
    skipped,
    generated_files: generatedFiles,
    attempts: [...ex.attempts, ...attempts]
  };
}

function errMsg(e: unknown): string {
  const msg = e instanceof Error ? e.message : String(e);
  return msg.split("\n", 1)[0] ?? msg;
}
