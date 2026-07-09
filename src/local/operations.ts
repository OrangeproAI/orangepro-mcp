import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AnalysisMeta,
  CandidateFlowMeta,
  GeneratedTest,
  LocalGraph,
  LOCAL_GRAPH_SCHEMA_VERSION,
  ManifestFileEntry,
  Manifest
} from "./graph/ontology.js";
import {
  AnalyzeFragment,
  ChangedResult,
  ChangedStatus,
  DoctorResult,
  ExplainResult,
  GapsResult,
  GenerateOptions,
  GitRunner,
  MissingEvidenceItem,
  ModelProvider,
  ScoreResult,
  StatusResult,
  UpdateResult
} from "./types.js";
import { Clock, systemClock } from "./util/time.js";
import { redactSecrets } from "./util/redact.js";
import { isPathIgnored, loadIgnore, walkFiles } from "./util/walk.js";
import {
  CONFIG_FILE,
  GRAPH_FILE,
  WORKSPACE_DIR,
  deriveWorkspaceName,
  graphExists,
  initWorkspace,
  loadConfig,
  saveConfig,
  loadGraph,
  saveGraph,
  workspaceInitialized,
  workspacePaths
} from "./workspace.js";
import { loadProviderEnv, resolveProviderConfig, ProviderOverride, ProviderName } from "./localConfig.js";
import { behaviorNodes, denominatorComposition } from "./graph/factories.js";
import { summarizeTestEvidence, GeneratedTestEvidence, EvidenceSummary } from "./graph/citations.js";
import { analyzeRepo } from "./analyze/analyzer.js";
import { ParseCache, ParseCacheData } from "./analyze/parseCache.js";
import { ResolverCache } from "./resolve/resolverCache.js";
import { manifestKindOf, roleOf } from "./analyze/classify.js";
import { enrichFromContent } from "./enrich/index.js";
import { scoreGraph } from "./score/score.js";
import { doctorGraph } from "./score/doctor.js";
import { findGaps } from "./gaps/gaps.js";
import { rankRiskGaps } from "./score/risk.js";
import { generateTests } from "./generate/generator.js";
import { autoProve, AutoProveResult, NO_KEY_MESSAGE, isEligibleProvableTarget } from "./autoProve.js";
import { AGENT_RUN_WORKFLOW, GROUNDING_CONTRACT, RunHint, runnableRunHintsFor } from "./generate/runHints.js";
import { buildProvider, DeterministicProvider } from "./generate/providers.js";
import { buildOracle, scoreArm, armMetrics, CompareDimensions, CompareMetrics } from "./generate/compareScore.js";
import { judgeComparison, buildJudgeContext } from "./generate/compareJudge.js";
import {
  renderCompareReportMarkdown,
  renderArmTestsFile,
  renderArmTestsJson,
  testsFileExt,
  testsArtifactName,
  compareTestsFramework
} from "./generate/compareReport.js";
import { buildPack } from "./pack/exporter.js";
import { packToMarkdown } from "./pack/summary.js";
import { validatePack, ValidationResult } from "./pack/validate.js";
import { buildManifest, readGitInfo } from "./freshness/manifest.js";
import { computeFreshness } from "./freshness/status.js";
import { changedImpact } from "./freshness/changed.js";
import { explainTest } from "./explain/explain.js";
import { buildVizPayload } from "./viz/payload.js";
import { renderVizHtml } from "./viz/html.js";
import { buildBehaviorReportData, dominantBlockReason, type DynamicProofReportInput } from "./viz/behaviorReportData.js";
import { renderBehaviorReport } from "./viz/behaviorReportHtml.js";
import { renderCoverageReport } from "./pack/coverageReport.js";
import { confirmedCoverageByLayer } from "./score/coverage.js";
import { prepareRuntimeCoverage, RuntimeCoveragePrepareResult, type CommandRunner } from "./analyze/coverageArtifacts.js";
import {
  appendLedgerRecord,
  canReproveLanguage,
  loadLedger,
  ledgerStats,
  proofEdgesFor,
  reproveTarget,
  resolveTargetSymbol,
  targetFingerprint,
  targetLanguage,
  type DynamicProofCertificate,
  type LedgerRecord,
  type LedgerStats
} from "./ledger.js";
import { buildRtm, renderRtmCsv, renderRtmMarkdown, type RtmFormat, type RtmResult } from "./rtm.js";
import {
  buildProofDoctor,
  distillProofAttempts,
  loadProofAttempts,
  proofAttemptsFresh,
  writeProofAttempts,
  type ProofDoctorResult
} from "./proofDoctor.js";
import { tryScopedReprove } from "./reprove/scoped.js";
import { resolveContained, toWorkspaceRel } from "./reprove/paths.js";
import { hashBuffer } from "./util/hash.js";
import { applyAiLinks, generateAiLinks, summarizeAiLinks, type AiLinkedSummary, type AiLinksResult } from "./aiGraph/links.js";
import { applyAiFlows, generateAiFlows, isValidStoredCandidateFlowMeta, revalidateCandidateFlowMeta, type AiFlowsResult } from "./flows/llmFlowDiscovery.js";
import { summarizeCorpusScope, type CorpusScopeSummary } from "./corpusScope.js";
import { reportProgress } from "./util/progress.js";

export interface AnalyzeSummary {
  graph_path: string;
  sources_count: number;
  entities_count: number;
  relationships_count: number;
  candidate_relationships_count: number;
  /** Testable behaviors (Requirement/UserFlow/BusinessRule). 0 => generate has nothing to target. */
  behavior_anchors_count: number;
  /** Scan coverage signal: files scanned, anchors inferred, and any cap that was hit. */
  analysis: AnalysisMeta;
  /** Optional local runtime coverage preparation/generation result. */
  runtime_coverage_prepare?: RuntimeCoveragePrepareResult;
  /** Weak AI-suggested candidate links in the current graph; separate from coverage/proof. */
  ai_linked: AiLinkedSummary;
  warnings: string[];
}

export interface ExportResult {
  pack_path: string;
  summary_path: string;
  validation: ValidationResult;
  graph_html_path?: string;
}

export interface GenerateSummary {
  run_id: string | null;
  model_provider: string;
  model_name: string;
  generated_tests: GeneratedTest[];
  /**
   * Validated grounding citations per test: each cited entity resolved against
   * the graph (kind, evidence strength, source_ref) so provenance is verifiable,
   * not just asserted. The keyless grounding contract — ground your test in these.
   */
  evidence: GeneratedTestEvidence[];
  /** Run-level roll-up of validated evidence (proof coverage, broken citations). */
  evidence_summary: EvidenceSummary;
  missing_evidence: MissingEvidenceItem[];
  warnings: string[];
  wrote_repo_files: false;
}

export interface GenerateComparisonArm {
  generated_tests: GeneratedTest[];
  missing_evidence: MissingEvidenceItem[];
  warnings: string[];
  /**
   * Agent run hints for the RUNNABLE tests in this arm (suggested path + run
   * command). Empty for spec-mode (JSON/XML) bodies, which are convert-not-run.
   */
  run_hints: RunHint[];
}

/** Result of `generate --compare`: prompt-only baseline vs Local KG, same model + system prompt. */
export interface GenerateComparison {
  model_provider: string;
  model_name: string;
  /** Which system prompt both arms shared. */
  system_prompt_source: "hosted_reference" | "kit_default";
  /** How the dimension scores were produced. */
  scoring_method: "llm_judge" | "heuristic";
  /** The judge's one-line rationale (llm_judge only). */
  rationale?: string;
  baseline: GenerateComparisonArm;
  grounded: GenerateComparisonArm;
  /** Side-by-side quality scores (0-100) per dimension. */
  scores: { baseline: CompareDimensions; grounded: CompareDimensions };
  /** Raw comparison matrix per arm (correct real-API, invented imports, traceability, ...). */
  matrix: { baseline: CompareMetrics; grounded: CompareMetrics };
  warnings: string[];
  wrote_repo_files: false;
}

export interface RecordRunOptions {
  target_id?: string;
  target_symbol?: string;
  source?: string;
  test_path?: string;
  agent_pass?: boolean;
  vacuous?: boolean;
  evidence_ids?: string[];
  provider?: string;
  model?: string;
  prompt_version?: string;
  run_id?: string;
}

export interface RecordRunResult {
  ledger_path: string;
  record: LedgerRecord;
}

export type DynamicProofRunner = (args: string[], opts?: { cwd?: string; scriptPath?: string }) => {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type DynamicProofReplacementMode = "return-json" | "promise-json";
export type DynamicProofTestRunner = "auto" | "vitest" | "jest" | "mocha" | "pytest";

export interface DynamicProofOptions {
  target_id?: string;
  target_symbol?: string;
  source?: string;
  /** TS/JS: required repo-relative test file. Go: unused (Go selects by test name). */
  test_path?: string;
  /** Go only: fully-anchored `^TestName$` passed to `go test -run`. */
  test_run?: string;
  /**
   * Go only (Slice 2): 1-based test-source line of the assertion that witnesses the target.
   * When set, the Go oracle binds a runtime-named subtest's mutant failure to THIS exact line
   * (a sibling subtest asserting elsewhere is refused). Omit for the exact-name behavior.
   */
  go_assertion_line?: number;
  target_path?: string;
  method?: string;
  /** TS/JS: required inert sentinel body. Go: unused (Go derives its own sentinel). */
  replacement?: string;
  replacement_mode?: DynamicProofReplacementMode;
  runner?: DynamicProofTestRunner;
  timeout_ms?: number;
  link_node_modules?: boolean;
  vitest_config?: string;
  jest_config?: string;
  test_env?: string[];
  run_id?: string;
}

export interface DynamicProofOracleSummary {
  status: string;
  proven: boolean;
  reason?: string;
  runner?: string;
  replacementMode?: string;
  test?: string;
  target?: string;
  method?: string;
  baseline?: { exitCode?: number; timedOut?: boolean; failureSummary?: string | null };
  mutant?: { exitCode?: number; timedOut?: boolean; assertionFailure?: boolean };
  medianProofMs?: number | null;
}

export interface DynamicProofResult {
  ledger_path: string;
  record: LedgerRecord;
  oracle: DynamicProofOracleSummary;
  /**
   * G2 (informational): the module root the proof sandboxed, only when it
   * differs from the analyzed source root. Display/diagnostics only — never
   * part of the certificate or the ledger record.
   */
  module_root?: string;
}

/** A trusted-local repo-prep command run in the source checkout before the oracle. */
export interface ProveLoopSetupCommand {
  command: string;
  args?: string[];
  timeout_ms?: number;
}

export interface ProveLoopOptions extends DynamicProofOptions {
  setup_commands?: ProveLoopSetupCommand[];
  setup_timeout_ms?: number;
}

export interface ProveLoopUnrunnable {
  status: "unrunnable";
  reason: string;
}

/** Setup failed → `unrunnable`; otherwise the unchanged oracle result + refreshed report path. */
export type ProveLoopResult = ProveLoopUnrunnable | (DynamicProofResult & { behavior_coverage_path?: string });

export interface RtmOptions {
  format?: RtmFormat;
  outputPath?: string;
  baseRef?: string;
  statuses?: string[];
  limit?: number;
}

export interface RtmOperationResult extends RtmResult {
  rtm_path: string;
  format: RtmFormat;
}

export interface AiLinksOptions extends ProviderOverride {
  apply?: boolean;
  all?: boolean;
  symbolsPerBehavior?: number;
  maxPromptTokens?: number;
  maxBehaviors?: number;
  progressRange?: { start: number; end: number };
}

export interface AiFlowsOptions extends ProviderOverride {
  apply?: boolean;
}

export interface StartOptions extends ProviderOverride {
  source?: string;
  baseRef?: string;
  includeMarkdown?: boolean;
  generateCoverage?: boolean;
  coverageTimeoutMs?: number;
  ai?: boolean;
  aiAll?: boolean;
  aiFlows?: boolean;
  /** Auto-prove: dynamic-proof budget — the top N viable targets (default 5).
   *  Existing associated tests run first WITHOUT a key. With a key, start also
   *  generates report-visible test drafts for the local top risk rows. */
  autoLimit?: number;
  /** --no-auto: skip auto-prove and restore analyze-only behavior. */
  noAuto?: boolean;
  /** Opt-in v5 batched generation for the auto-prove generation lane. Default (undefined) → v2/deterministic, unchanged. */
  promptVersion?: "v2" | "v5";
}

export interface StartAiResult {
  status: "applied" | "skipped" | "failed";
  reason?: string;
  generate?: AiLinksResult;
  apply?: AiLinksResult;
}

export interface StartAiFlowsResult {
  status: "applied" | "skipped" | "failed";
  reason?: string;
  generate?: AiFlowsResult;
  apply?: AiFlowsResult;
}

export interface StartResult {
  scope: CorpusScopeSummary;
  analyze: AnalyzeSummary;
  ai_links: StartAiResult;
  ai_flows: StartAiFlowsResult;
  ai_linked: AiLinkedSummary;
  graph_html_path?: string;
  behavior_coverage_path?: string;
  coverage_report_path?: string;
  rtm: RtmOperationResult;
  changed: ChangedResult;
  gaps: GapsResult;
  /** Auto-prove summary (generate→prove on start). Present on every start run. */
  auto_prove: AutoProveResult;
  next_actions: string[];
  agent_workflow: string[];
  grounding_contract: string[];
  warnings: string[];
}

export interface OperationDeps {
  clock: Clock;
  env: NodeJS.ProcessEnv;
  coverageRunner?: CommandRunner;
  dynamicProofRunner?: DynamicProofRunner;
  analyze?: typeof opAnalyze;
  aiProvider?: ModelProvider;
}

function defaultDeps(): OperationDeps {
  return { clock: systemClock, env: process.env };
}

function dynamicProofSpikePath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "scripts", "spikes", "dynamic-proof-spike.mjs");
}

/**
 * Resolve the Go MODULE root: the nearest `go.mod` ancestor of the target file,
 * searched from the target's directory up to (and including) sourceRoot. For a
 * single-module repo this is sourceRoot itself. Confined to sourceRoot so the spike
 * never sandboxes a directory outside the trusted checkout.
 * ponytail: nearest-ancestor go.mod; multi-module edge cases (nested/replace) resolve to G-INT-3.
 */
/**
 * G2 — confinement bound for module-root walk-up: the walk may pass ABOVE the
 * analyzed source path (fixing `opro start ./subpkg` inside a bigger module)
 * but never escapes the INVOCATION root the user ran opro from. If the analyzed
 * path lies outside the invocation root, keep the old sourceRoot confinement.
 * Discovery/scoping only — the proof gate is untouched, and when the chosen
 * module root differs from the analyzed path it is named in progress output
 * and on the result (module_root).
 */
function moduleRootBound(sourceRoot: string, workspaceRoot: string): string {
  const src = resolve(sourceRoot);
  const ws = resolve(workspaceRoot);
  return src === ws || src.startsWith(ws + sep) ? ws : src;
}

function goModuleRoot(sourceRoot: string, targetRel: string, workspaceRoot: string): string {
  let dir = dirname(resolve(sourceRoot, targetRel));
  const stop = moduleRootBound(sourceRoot, workspaceRoot);
  for (;;) {
    if (existsSync(join(dir, "go.mod"))) return dir;
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`No go.mod found for Go target ${targetRel} under ${stop}.`);
}

/**
 * Resolve the Java MODULE root: the nearest `pom.xml` (or `build.gradle` /
 * `build.gradle.kts`) ancestor of the target file, searched from the target's
 * directory up to (and including) sourceRoot. Mirrors goModuleRoot — for a
 * single-module project this is sourceRoot itself. Confined to sourceRoot so the
 * spike never sandboxes a directory outside the trusted checkout.
 * ponytail: nearest-ancestor build file; multi-module reactor edge cases resolve to J-INT-3.
 */
function javaModuleRoot(sourceRoot: string, targetRel: string, workspaceRoot: string): string {
  let dir = dirname(resolve(sourceRoot, targetRel));
  const stop = moduleRootBound(sourceRoot, workspaceRoot);
  for (;;) {
    if (existsSync(join(dir, "pom.xml")) || existsSync(join(dir, "build.gradle")) || existsSync(join(dir, "build.gradle.kts"))) {
      return dir;
    }
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(`No pom.xml or build.gradle found for Java target ${targetRel} under ${stop}.`);
}

/** Route to the per-language spike. TS/JS keeps the original path; native profiles use their own mechanisms. */
function dynamicProofSpikePathFor(language: string): string {
  if (language === "go" || language === "java" || language === "python") {
    const here = dirname(fileURLToPath(import.meta.url));
    const script =
      language === "go"
        ? "go-dynamic-proof-spike.mjs"
        : language === "java"
          ? "java-dynamic-proof-spike.mjs"
          : "python-dynamic-proof-spike.mjs";
    return resolve(here, "..", "..", "scripts", "spikes", script);
  }
  return dynamicProofSpikePath();
}

function defaultDynamicProofRunner(args: string[], opts: { cwd?: string; scriptPath?: string } = {}): ReturnType<DynamicProofRunner> {
  const script = opts.scriptPath ?? dynamicProofSpikePath();
  if (!existsSync(script)) {
    throw new Error(
      `Dynamic proof spike runner not found at ${script}. Run this command from an OrangePro source checkout with scripts/spikes available.`
    );
  }
  const child = spawnSync(process.execPath, [script, ...args], {
    cwd: opts.cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  if (child.error) throw child.error;
  return {
    stdout: child.stdout ?? "",
    stderr: child.stderr ?? "",
    exitCode: child.status ?? 1
  };
}

function parseDynamicProofJson(stdout: string, stderr: string): DynamicProofOracleSummary {
  try {
    return JSON.parse(stdout) as DynamicProofOracleSummary;
  } catch (err) {
    const detail = redactSecrets((stderr || stdout).slice(0, 2000));
    throw new Error(`Dynamic proof runner did not return JSON.${detail ? ` stderr/stdout: ${detail}` : ""}`);
  }
}

/** The Go spike's own JSON shape (scripts/spikes/go-dynamic-proof-spike.mjs). */
export interface GoDynamicProofJson {
  status: string;
  proven: boolean;
  reason?: string;
  testRun?: string;
  target?: string;
  func?: string;
  baseline?: { exitCode?: number; timedOut?: boolean; failureSummary?: string | null };
  mutant?:
    | { exitCode?: number; timedOut?: boolean; trustedAssertion?: boolean; failureSummary?: string | null }
    | { skipped: true; reason?: string | null };
  medianProofMs?: number | null;
}

/** The label recorded as the cert `sentinel` for a Go proof (Go derives a zero-value return). */
const GO_SENTINEL_LABEL = "go-zero-return";

/**
 * Map the Go spike's JSON onto the SAME language-agnostic DynamicProofOracleSummary the
 * unchanged `dynamicProofSucceeded` and cert block read. This is the ONE trust-adjacent
 * seam, so mapping is STRICT: `assertionFailure` is true ONLY when the Go spike genuinely
 * returned `mutant.trustedAssertion === true`. A skipped/refused mutation, a survived
 * mutation, or any absent field maps to `assertionFailure = false` — never a false Proven.
 */
function mapGoOracle(go: GoDynamicProofJson): DynamicProofOracleSummary {
  const mutant = go.mutant;
  // A refused/skipped mutation co-occurs with status "unrunnable"; it must never close.
  const skipped = Boolean(mutant && "skipped" in mutant && mutant.skipped === true);
  const runMutant = !skipped && mutant ? (mutant as { exitCode?: number; timedOut?: boolean; trustedAssertion?: boolean }) : undefined;
  return {
    status: go.status,
    proven: go.proven === true,
    reason: go.reason,
    runner: "go",
    replacementMode: GO_SENTINEL_LABEL,
    test: go.testRun,
    target: go.target,
    method: go.func,
    baseline: go.baseline
      ? { exitCode: go.baseline.exitCode, timedOut: go.baseline.timedOut, failureSummary: go.baseline.failureSummary ?? null }
      : undefined,
    // STRICT: trustedAssertion must be exactly true AND the mutant must carry a NUMERIC non-zero
    // exit code. A missing/undefined/zero exitCode ⇒ assertionFailure=false ⇒ non-close, so the
    // shared gate (which asserts `exitCode !== 0`, where `undefined !== 0` is truthy) can never
    // false-close on an absent exit code. skipped/absent/false ⇒ false ⇒ non-close.
    mutant: runMutant
      ? {
          exitCode: runMutant.exitCode,
          timedOut: runMutant.timedOut,
          assertionFailure:
            runMutant.trustedAssertion === true &&
            typeof runMutant.exitCode === "number" &&
            runMutant.exitCode !== 0
        }
      : { assertionFailure: false },
    medianProofMs: go.medianProofMs
  };
}

/** Test-only handle on the Go→oracle mapper (the one trust-adjacent seam). */
export function __mapGoOracleForTest(go: GoDynamicProofJson): DynamicProofOracleSummary {
  return mapGoOracle(go);
}

/** The Java spike's own JSON shape (scripts/spikes/java-dynamic-proof-spike.mjs). */
export interface JavaDynamicProofJson {
  status: string;
  proven: boolean;
  reason?: string;
  mode?: string;
  testClass?: string;
  testMethod?: string;
  target?: string;
  method?: string;
  baseline?: { exitCode?: number; timedOut?: boolean; compileFailed?: boolean; targetTestPassed?: boolean; failureSummary?: string | null };
  mutant?:
    | { exitCode?: number; timedOut?: boolean; compileFailed?: boolean; targetTestFailed?: boolean; isAssertion?: boolean; failureType?: string | null; failureSummary?: string | null }
    | { skipped: true; reason?: string | null };
  medianProofMs?: number | null;
}

/** The label recorded as the cert `sentinel` for a Java proof (Java derives a typed sentinel from the return type). */
const JAVA_SENTINEL_LABEL = "java-typed-sentinel";

/**
 * Map the Java spike's JSON onto the SAME language-agnostic DynamicProofOracleSummary the
 * unchanged `dynamicProofSucceeded` and cert block read. This is the ONE trust-adjacent
 * seam, so mapping is STRICT: `assertionFailure` is true ONLY when the Java spike genuinely
 * signalled a trusted JUnit assertion failure — the mutant ran (not skipped), the SAME
 * target test FAILED, AND surefire classified it as a trusted assertion (`isAssertion`).
 * A skipped/refused mutation, a survived (associated_survived) mutation, a compile failure,
 * a non-assertion error, or any absent field maps to `assertionFailure = false` — never a
 * false Proven. The spike itself already gates `status: "proven"` on all of this; the mapper
 * re-derives the assertion signal independently so the cert's `mutant_failed_assertion` never
 * trusts the spike's verdict alone.
 */
function mapJavaOracle(java: JavaDynamicProofJson): DynamicProofOracleSummary {
  const mutant = java.mutant;
  // A refused/skipped mutation co-occurs with status "unrunnable"; it must never close.
  const skipped = Boolean(mutant && "skipped" in mutant && mutant.skipped === true);
  const runMutant = !skipped && mutant
    ? (mutant as { exitCode?: number; timedOut?: boolean; targetTestFailed?: boolean; isAssertion?: boolean })
    : undefined;
  return {
    status: java.status,
    proven: java.proven === true,
    reason: java.reason,
    runner: "junit",
    replacementMode: JAVA_SENTINEL_LABEL,
    test: java.testClass && java.testMethod ? `${java.testClass}#${java.testMethod}` : java.testMethod,
    target: java.target,
    method: java.method,
    baseline: java.baseline
      ? { exitCode: java.baseline.exitCode, timedOut: java.baseline.timedOut, failureSummary: java.baseline.failureSummary ?? null }
      : undefined,
    // STRICT: the mutant must have RUN, FAILED the same target test, the failure must be a trusted
    // JUnit assertion, AND the mutant must carry a NUMERIC non-zero exit code. A missing/undefined/
    // zero exitCode ⇒ assertionFailure=false ⇒ non-close, so the shared gate (which asserts
    // `exitCode !== 0`, where `undefined !== 0` is truthy) can never false-close on an absent exit
    // code. skipped/survived/compile-fail/non-assertion/absent ⇒ false ⇒ non-close.
    mutant: runMutant
      ? {
          exitCode: runMutant.exitCode,
          timedOut: runMutant.timedOut,
          assertionFailure:
            runMutant.targetTestFailed === true &&
            runMutant.isAssertion === true &&
            typeof runMutant.exitCode === "number" &&
            runMutant.exitCode !== 0
        }
      : { assertionFailure: false },
    medianProofMs: java.medianProofMs
  };
}

/** Test-only handle on the Java→oracle mapper (the one trust-adjacent seam). */
export function __mapJavaOracleForTest(java: JavaDynamicProofJson): DynamicProofOracleSummary {
  return mapJavaOracle(java);
}

function dynamicProofSucceeded(oracle: DynamicProofOracleSummary): boolean {
  return (
    oracle.status === "proven" &&
    oracle.proven === true &&
    oracle.baseline?.exitCode === 0 &&
    oracle.baseline?.timedOut !== true &&
    oracle.mutant?.exitCode !== 0 &&
    oracle.mutant?.assertionFailure === true &&
    oracle.mutant?.timedOut !== true
  );
}

function symbolTargetParts(symExtId: string): { file: string; method: string; memberQualifier?: string } {
  const match = /^sym:(.+)#([^#]+)$/.exec(symExtId);
  if (!match) {
    throw new Error(`Cannot derive dynamic proof target from symbol id: ${symExtId}`);
  }
  const [, file, symbolName] = match;
  const segments = symbolName.split(".").filter(Boolean);
  const method = segments.pop();
  if (!file || !method) {
    throw new Error(`Cannot derive dynamic proof target from symbol id: ${symExtId}`);
  }
  // The owner qualifier of a member id (TS `Class.method`, Go `Recv.M`). The Go
  // lane passes it as --recv so the mutator matches the exact receiver.
  return { file, method, ...(segments.length ? { memberQualifier: segments.join(".") } : {}) };
}

function assertProofTargetMatchesSymbol(opts: DynamicProofOptions, symbolTarget: { file: string; method: string }): void {
  if (opts.target_path !== undefined && opts.target_path !== "") {
    const provided = opts.target_path.split(/[\\/]+/).join("/");
    if (provided !== symbolTarget.file) {
      throw new Error(
        `prove target mismatch: --target-file ${provided} does not match resolved symbol file ${symbolTarget.file}. Dynamic proof certificates must mutate the credited symbol.`
      );
    }
  }
  if (opts.method !== undefined && opts.method !== "" && opts.method !== symbolTarget.method) {
    throw new Error(
      `prove target mismatch: --method ${opts.method} does not match resolved symbol member ${symbolTarget.method}. Dynamic proof certificates must mutate the credited symbol.`
    );
  }
}

function assertProofSourceMatchesGraph(sourceRoot: string, graph: LocalGraph): void {
  const graphRoot = resolve(graph.workspace.root);
  if (sourceRoot !== graphRoot) {
    throw new Error(
      `prove source mismatch: --source ${sourceRoot} does not match the analyzed graph root ${graphRoot}. Run OrangePro analyze/prove against the same checkout before minting public Proven.`
    );
  }
}

/**
 * Refuse to prove against a target file that changed since analyze: the cert's
 * target_fingerprint is derived from the analyzed graph manifest hash, so proving
 * against different current bytes would credit a proof of the CURRENT source to a
 * STALE graph revision and RTM would show Proven for code the graph never indexed.
 * No manifest entry → the fingerprint is undefined and RTM never counts it.
 */
function assertTargetFileFresh(sourceRoot: string, targetRel: string, graph: LocalGraph): void {
  const analyzedHash = graph.manifest.files[targetRel]?.hash;
  if (analyzedHash === undefined) return;
  const targetAbs = resolveContained(sourceRoot, targetRel);
  if (existsSync(targetAbs) && hashBuffer(readFileSync(targetAbs)) !== analyzedHash) {
    throw new Error(
      `prove: target file ${targetRel} changed since analyze; rerun \`opro analyze\` before proving so the proof binds to the current code.`
    );
  }
}

/** Parse a positive-int env override; undefined falls back to the analyzer default. */
function positiveIntEnv(raw: string | undefined): number | undefined {
  if (!raw) return undefined;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** Read the configurable inferred-flow cap (ORANGEPRO_MAX_FLOWS) from the env. */
function maxFlowsFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  return positiveIntEnv(env.ORANGEPRO_MAX_FLOWS);
}

/** Read the configurable file-scan cap (ORANGEPRO_MAX_FILES) from the env. */
function maxFilesFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  return positiveIntEnv(env.ORANGEPRO_MAX_FILES);
}

/** Read the configurable symbol-extraction cap (ORANGEPRO_MAX_SYMBOLS) from the env. */
function maxSymbolsFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  return positiveIntEnv(env.ORANGEPRO_MAX_SYMBOLS);
}

/** Read the configurable per-file-scan wall-clock budget (ORANGEPRO_MAX_ANALYZE_MS) from the env. */
function maxAnalyzeMsFromEnv(env: NodeJS.ProcessEnv): number | undefined {
  return positiveIntEnv(env.ORANGEPRO_MAX_ANALYZE_MS);
}

/** Path of the persistent parse cache (next to the workspace graph). */
function parseCachePath(graphPath: string): string {
  return join(dirname(graphPath), "parse-cache.json");
}

/** Load the persistent parse cache; a missing/garbage/old-version file starts empty (never trusted). */
function loadParseCache(graphPath: string): ParseCache {
  try {
    const raw = readFileSync(parseCachePath(graphPath), "utf8");
    return new ParseCache(JSON.parse(raw) as ParseCacheData);
  } catch {
    return new ParseCache(null);
  }
}

/** Path of the persistent resolver cache (next to the workspace graph). */
function resolverCachePath(graphPath: string): string {
  return join(dirname(graphPath), "resolver-cache.json");
}

/** Load the persistent resolver cache; a missing/garbage file starts empty (the gate re-validates). */
function loadResolverCache(graphPath: string): ResolverCache {
  try {
    const raw = readFileSync(resolverCachePath(graphPath), "utf8");
    return new ResolverCache(JSON.parse(raw));
  } catch {
    return new ResolverCache(null);
  }
}

// ── helpers ──────────────────────────────────────────────────────────

/** Write atomically (temp + rename) so a concurrent poller never reads a half file. */
function writeFileAtomic(path: string, data: string): void {
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, data, "utf8");
  renameSync(tmp, path);
}

function gitRunner(root: string) {
  return (args: string[]): string | null => {
    try {
      return execFileSync("git", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString();
    } catch {
      return null;
    }
  };
}

/** Injection-safe `gh` runner (array args, never a shell string); null on failure. */
function ghRunner(root: string) {
  return (args: string[]): string | null => {
    try {
      return execFileSync("gh", args, { cwd: root, stdio: ["ignore", "pipe", "ignore"] }).toString();
    } catch {
      return null;
    }
  };
}

function fileReaderFor(root: string) {
  const absRoot = resolve(root);
  return (relPath: string): string | null => {
    const abs = resolve(absRoot, relPath);
    // Guard against traversal AND sibling-prefix escapes (e.g. /root vs /root-evil).
    if (abs !== absRoot && !abs.startsWith(absRoot + sep)) return null;
    try {
      return readFileSync(abs, "utf8");
    } catch {
      return null;
    }
  };
}

/** Lightweight content-hash scan (no node building) for freshness checks. */
function scanFileEntries(root: string): Record<string, ManifestFileEntry> {
  const ignore = loadIgnore(root);
  const files = walkFiles(root, ignore);
  const entries: Record<string, ManifestFileEntry> = {};
  for (const f of files) {
    entries[f.relPath] = { hash: f.hash, size: f.size, kind: manifestKindOf(f.relPath) };
  }
  return entries;
}

function dedupeNodesByExternalId(nodes: LocalGraph["nodes"]): LocalGraph["nodes"] {
  const seen = new Map<string, LocalGraph["nodes"][number]>();
  for (const n of nodes) {
    const prev = seen.get(n.external_id);
    if (!prev || n.confidence > prev.confidence) seen.set(n.external_id, n);
  }
  return [...seen.values()];
}

function dedupeById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Map<string, T>();
  for (const it of items) if (!seen.has(it.id)) seen.set(it.id, it);
  return [...seen.values()];
}

/** Drop edges whose endpoints are not present — enforces "no dangling edges". */
function pruneDanglingEdges<E extends { from_external_id: string; to_external_id: string }>(
  nodes: LocalGraph["nodes"],
  edges: E[]
): E[] {
  const ids = new Set(nodes.map((n) => n.external_id));
  return edges.filter((e) => ids.has(e.from_external_id) && ids.has(e.to_external_id));
}

/** Discover optional enricher inputs (templates/docs) without LLM. */
function collectEnricherFragments(root: string, extraPaths: string[], includeMarkdown: boolean) {
  const fragments: ReturnType<typeof enrichFromContent>[] = [];
  const reader = fileReaderFor(root);
  const seen = new Set<string>();

  const tryFile = (relPath: string) => {
    if (seen.has(relPath)) return;
    seen.add(relPath);
    const content = reader(relPath);
    if (!content) return;
    const frag = enrichFromContent(relPath, content);
    if (frag) fragments.push(frag);
  };

  for (const p of extraPaths) tryFile(p);

  const ignore = loadIgnore(root);
  for (const f of walkFiles(root, ignore)) {
    const lower = f.relPath.toLowerCase();
    if (lower.endsWith(".csv")) tryFile(f.relPath);
    else if (
      includeMarkdown &&
      /\.(md|mdx|markdown)$/.test(lower) &&
      /(requirement|template|acceptance|stories|prd|spec|intake)/.test(lower)
    ) {
      tryFile(f.relPath);
    }
  }
  return fragments.filter(Boolean) as NonNullable<ReturnType<typeof enrichFromContent>>[];
}

function buildGraphFromFragments(
  workspaceRoot: string,
  scanRoot: string,
  analyzeFragment: AnalyzeFragment,
  enrichFragments: NonNullable<ReturnType<typeof enrichFromContent>>[],
  now: string
): LocalGraph {
  const paths = workspacePaths(workspaceRoot);
  const config = loadConfig(paths);
  const repoSource = analyzeFragment.sources[0];

  const nodes = dedupeNodesByExternalId([
    ...analyzeFragment.nodes,
    ...enrichFragments.flatMap((f) => f.nodes)
  ]);
  const edges = dedupeById([...analyzeFragment.edges, ...enrichFragments.flatMap((f) => f.edges)]);
  const candidate_edges = dedupeById([
    ...analyzeFragment.candidate_edges,
    ...enrichFragments.flatMap((f) => f.candidate_edges)
  ]);
  const sources = [...analyzeFragment.sources, ...enrichFragments.flatMap((f) => f.sources)];

  const manifest: Manifest = buildManifest(analyzeFragment.file_entries, readGitInfo(gitRunner(scanRoot)), now);
  const prunedEdges = pruneDanglingEdges(nodes, edges);

  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: {
      name: config.workspace_name || deriveWorkspaceName(scanRoot),
      root: resolve(scanRoot),
      root_hash: repoSource?.content_hash ?? "sha256:",
      source_upload_policy: "metadata_only"
    },
    created_at: now,
    updated_at: now,
    sources,
    nodes,
    edges: prunedEdges,
    candidate_edges: pruneDanglingEdges(nodes, candidate_edges),
    generation_runs: [],
    generated_tests: [],
    manifest,
    // Composition AND confirmed-by-layer are computed over the MERGED node set
    // (analyzer + enrichers) and the pruned edges, so template/markdown
    // requirements land in the denominator and the confirmed metric agrees with it.
    analysis: {
      ...analyzeFragment.analysis,
      denominator: denominatorComposition({ nodes }),
      confirmed_by_layer: confirmedCoverageByLayer({ nodes, edges: prunedEdges })
    }
  };
}

// ── operations ───────────────────────────────────────────────────────

export function opInit(root: string, deps: OperationDeps = defaultDeps()): { graph_path: string; config_path: string } {
  const { paths } = initWorkspace(root, deps.clock());
  return { graph_path: paths.graphPath, config_path: paths.configPath };
}

export interface AnalyzeOptions {
  /** Source path to scan. Defaults to the workspace root. May differ so the
   *  workspace (.orangepro) never has to be written into the analyzed checkout. */
  source?: string;
  paths?: string[];
  includeMarkdown?: boolean;
  /** Opt-in: run local coverage tooling before analyze so runtime coverage can be ingested. */
  generateCoverage?: boolean;
  /** Per-command timeout for local coverage generation. */
  coverageTimeoutMs?: number;
  /** Internal: opStart owns its own progress percentages and suppresses nested analyze percentages. */
  suppressProgress?: boolean;
}

export interface RuntimeCoverageOptions {
  /** Source path to inspect/generate coverage for. Defaults to the workspace root. */
  source?: string;
  /** Run local test tooling to create coverage artifacts. Detection-only by default. */
  generate?: boolean;
  /** Per-command timeout for generation, in milliseconds. */
  timeoutMs?: number;
}

/**
 * Carry an applied AI candidate-flow lane across a re-analysis. The stored lane
 * is untrusted input: a missing/corrupt old graph or a malformed/invariant-
 * violating lane is dropped (never throws), and re-validation touches ONLY
 * analysis.candidate_flows — never edges, tiers, or the denominator.
 */
function preserveCandidateFlows(graphPath: string, graph: LocalGraph): LocalGraph {
  let previous: CandidateFlowMeta | undefined;
  try {
    if (existsSync(graphPath)) previous = loadGraph(graphPath).analysis?.candidate_flows;
  } catch {
    return graph;
  }
  if (!previous || !isValidStoredCandidateFlowMeta(previous)) return graph;
  try {
    return {
      ...graph,
      analysis: { ...(graph.analysis as AnalysisMeta), candidate_flows: revalidateCandidateFlowMeta(previous, graph) }
    };
  } catch {
    return graph;
  }
}

export function opAnalyze(root: string, opts: AnalyzeOptions = {}, deps: OperationDeps = defaultDeps()): AnalyzeSummary {
  const now = deps.clock();
  const paths = workspacePaths(root);
  const scanRoot = opts.source ? resolve(opts.source) : resolve(root);
  // Fail loudly on a typo'd path instead of silently producing an empty graph.
  if (!existsSync(scanRoot)) {
    throw new Error(`Path not found: ${scanRoot}. Pass an existing directory to analyze (e.g. \`opro analyze .\`).`);
  }
  if (!statSync(scanRoot).isDirectory()) {
    throw new Error(`Not a directory: ${scanRoot}. Pass a directory to analyze (e.g. \`opro analyze .\`).`);
  }
  if (!opts.suppressProgress) reportProgress(`analyze: source ${scanRoot}`, { current: 1, total: 4 });
  const runtimeCoveragePrepare = opts.generateCoverage
    ? (!opts.suppressProgress && reportProgress("coverage: generating local runtime coverage before graph build", { current: 2, total: 4 }),
      prepareRuntimeCoverage(scanRoot, { generate: true, timeoutMs: opts.coverageTimeoutMs, runner: deps.coverageRunner }))
    : undefined;

  if (!workspaceInitialized(root)) initWorkspace(root, now);

  if (!opts.suppressProgress) {
    reportProgress("analyze: parsing source and building deterministic graph", {
      current: opts.generateCoverage ? 3 : 2,
      total: opts.generateCoverage ? 4 : 3
    });
  }
  const parseCache = loadParseCache(paths.graphPath);
  const resolverCache = loadResolverCache(paths.graphPath);
  const analyzeFragment = analyzeRepo(scanRoot, {
    readContent: true,
    maxInferredFlows: maxFlowsFromEnv(deps.env),
    maxFiles: maxFilesFromEnv(deps.env),
    maxSymbols: maxSymbolsFromEnv(deps.env),
    maxAnalyzeMs: maxAnalyzeMsFromEnv(deps.env),
    parseCache,
    resolverCache
  });
  // Persist the (pruned-to-this-run) parse cache so the next analyze reuses unchanged files.
  // Best-effort: a cache write failure must never fail analyze.
  try {
    writeFileAtomic(parseCachePath(paths.graphPath), JSON.stringify(parseCache.toData()));
  } catch {
    /* ignore */
  }
  try {
    writeFileAtomic(resolverCachePath(paths.graphPath), JSON.stringify(resolverCache.toData()));
  } catch {
    /* ignore */
  }
  const extraPaths = (opts.paths ?? []).filter((p) => existsSync(resolve(scanRoot, p)) && /\.(csv|md|mdx|markdown|txt)$/i.test(p));
  const enrichFragments = collectEnricherFragments(scanRoot, extraPaths, opts.includeMarkdown ?? true);

  const builtGraph = buildGraphFromFragments(root, scanRoot, analyzeFragment, enrichFragments, now);
  // Applied AI candidate flows must SURVIVE re-analysis, but the stored lane is
  // untrusted (any process can rewrite graph.json) — preserve+re-validate it
  // without ever letting a malformed lane fail analyze.
  const graph = preserveCandidateFlows(paths.graphPath, builtGraph);
  if (!opts.suppressProgress) {
    reportProgress("analyze: writing graph.json", { current: opts.generateCoverage ? 4 : 3, total: opts.generateCoverage ? 4 : 3 });
  }
  saveGraph(paths.graphPath, graph);

  const coverageWarnings =
    runtimeCoveragePrepare?.generated
      .filter((g) => !g.ok)
      .map((g) => `coverage generation failed for ${g.language} module ${g.module_dir}: ${g.reason ?? "unknown failure"}`) ?? [];
  const coverageSuccess =
    runtimeCoveragePrepare?.generated
      .filter((g) => g.ok && g.artifact_path)
      .map((g) => `coverage artifact generated for ${g.language} module ${g.module_dir}: ${g.artifact_path}`) ?? [];
  const warnings = [...coverageSuccess, ...coverageWarnings, ...(runtimeCoveragePrepare?.warnings ?? []), ...analyzeFragment.warnings, ...enrichFragments.flatMap((f) => f.warnings)];
  return {
    graph_path: paths.graphPath,
    sources_count: graph.sources.length,
    entities_count: graph.nodes.length,
    relationships_count: graph.edges.length,
    candidate_relationships_count: graph.candidate_edges.length,
    behavior_anchors_count: behaviorNodes(graph).length,
    analysis: graph.analysis ?? analyzeFragment.analysis,
    ...(runtimeCoveragePrepare ? { runtime_coverage_prepare: runtimeCoveragePrepare } : {}),
    ai_linked: summarizeAiLinks(graph),
    warnings
  };
}

export function opRuntimeCoverage(root: string, opts: RuntimeCoverageOptions = {}): RuntimeCoveragePrepareResult {
  const scanRoot = opts.source ? resolve(opts.source) : resolve(root);
  if (!existsSync(scanRoot)) {
    throw new Error(`Path not found: ${scanRoot}. Pass an existing directory to coverage (e.g. \`opro coverage .\`).`);
  }
  if (!statSync(scanRoot).isDirectory()) {
    throw new Error(`Not a directory: ${scanRoot}. Pass a directory to coverage (e.g. \`opro coverage .\`).`);
  }
  return prepareRuntimeCoverage(scanRoot, { generate: opts.generate, timeoutMs: opts.timeoutMs });
}

/** Persist the default provider/model chosen via `opro setup`. Keys are never stored. */
export function opSetModelDefault(
  root: string,
  sel: { provider: ProviderName; model: string },
  deps: OperationDeps = defaultDeps()
): void {
  if (!workspaceInitialized(root)) initWorkspace(root, deps.clock());
  const paths = workspacePaths(root);
  saveConfig(paths, { ...loadConfig(paths), model_default: sel });
}

/** Read the saved default provider/model, if `opro setup` was run. */
export function getModelDefault(root: string): { provider: ProviderName; model: string } | null {
  if (!workspaceInitialized(root)) return null;
  return loadConfig(workspacePaths(root)).model_default ?? null;
}

function startProviderOverride(root: string, opts: ProviderOverride): ProviderOverride {
  if (opts.provider || opts.model) return { provider: opts.provider, model: opts.model };
  const saved = getModelDefault(root);
  return saved ? { provider: saved.provider, model: saved.model } : {};
}

/**
 * Resolve the behaviors a diff touches, so `generate --base <ref>` targets only the
 * changed code (PR-scoped generation) instead of the global top gap. Never throws or
 * fabricates: returns structured guidance when there is no usable diff (not a git
 * repo / missing base ref / no changes), or when the diff touches no tracked behavior.
 */
export function resolveDiffTargets(
  root: string,
  baseRef: string | undefined
): { status: ChangedStatus; base_ref: string; target_ids: string[]; guidance?: string } {
  const ch = opChanged(root, baseRef);
  if (ch.status !== "ok") {
    return { status: ch.status, base_ref: ch.base_ref, target_ids: [], guidance: ch.guidance };
  }
  return {
    status: "ok",
    base_ref: ch.base_ref,
    target_ids: ch.affected_behaviors,
    guidance: ch.affected_behaviors.length
      ? undefined
      : `The diff vs ${ch.base_ref} touched no tracked behaviors. Generate without --base, or add requirements/tests for the changed area.`
  };
}

export interface PrCheckoutResult {
  status: "ok" | "gh_missing" | "checkout_failed" | "invalid_pr" | "needs_confirmation" | "dirty_tree";
  pr: number;
  /** The PR's base branch made locally diffable (e.g. "origin/main"), when resolved. */
  base_ref?: string;
  guidance?: string;
}

/**
 * One-command PR support for `generate --pr <n>`: check out the PR via `gh` and
 * resolve its base branch so the diff is scoped to the PR's changes. Side-effecting
 * (switches the working tree via `gh pr checkout` + `git fetch`) and CLI-only.
 *
 * The mutation is gated: it refuses on a dirty working tree (`dirty_tree`) and
 * does NOTHING unless `opts.confirmed` is true — without confirmation it returns
 * `needs_confirmation` and performs no `gh`/`git` write. The non-mutating default
 * is `--base <ref>` (read-only `git diff`); `--pr` is the opt-in escape hatch.
 *
 * Never throws; returns structured guidance for every refusal. Runners are
 * injectable for tests.
 */
export function resolvePrCheckout(
  root: string,
  prNumber: number,
  opts: { gh?: GitRunner; git?: GitRunner; confirmed?: boolean } = {}
): PrCheckoutResult {
  const gh = opts.gh ?? ghRunner(root);
  const git = opts.git ?? gitRunner(root);
  if (!Number.isInteger(prNumber) || prNumber <= 0) {
    return { status: "invalid_pr", pr: prNumber, guidance: "Pass a positive PR number, e.g. `opro generate --pr 123`." };
  }
  if (gh(["--version"]) === null) {
    return {
      status: "gh_missing",
      pr: prNumber,
      guidance:
        "GitHub CLI `gh` was not found. Install it (https://cli.github.com) and run `gh auth login`, or check out the PR yourself and pass --base <ref>."
    };
  }
  // Refuse on a dirty working tree BEFORE any mutation: `gh pr checkout` would
  // either fail or strand uncommitted work. A null porcelain result means git
  // could not report status (not a repo / git error); the checkout below will
  // surface that as checkout_failed rather than us guessing "dirty".
  const porcelain = git(["status", "--porcelain"]);
  if (porcelain !== null && porcelain.trim() !== "") {
    return {
      status: "dirty_tree",
      pr: prNumber,
      guidance:
        `Working tree has uncommitted changes — \`opro generate --pr ${prNumber}\` would run \`gh pr checkout\` and switch branches, ` +
        "risking your work. Commit/stash first, or check out the PR yourself and use the non-mutating `--base <ref>`."
    };
  }
  // No mutation without explicit confirmation. Non-TTY / --json / MCP callers
  // never auto-confirm, so they get this and stop; a TTY user confirms (or
  // passes --yes/--force) before we touch the working tree.
  if (!opts.confirmed) {
    return {
      status: "needs_confirmation",
      pr: prNumber,
      guidance:
        `\`--pr ${prNumber}\` mutates your working tree: it runs \`gh pr checkout ${prNumber}\` (switches branch) and \`git fetch\`. ` +
        "Re-run with --yes (or --force) to confirm, or use the non-mutating default `--base <ref>` to diff without checking out."
    };
  }
  if (gh(["pr", "checkout", String(prNumber)]) === null) {
    return {
      status: "checkout_failed",
      pr: prNumber,
      guidance:
        `Could not check out PR #${prNumber}. Confirm gh is authenticated (gh auth status), this is the correct GitHub repo, ` +
        `the working tree is clean, and #${prNumber} is an open PR.`
    };
  }
  // Resolve the PR's base branch and make it locally diffable.
  const baseName = gh(["pr", "view", String(prNumber), "--json", "baseRefName", "-q", ".baseRefName"])?.trim();
  let base_ref: string | undefined;
  if (baseName) {
    git(["fetch", "origin", baseName]); // best-effort; the base may already be local
    const remoteRef = `origin/${baseName}`;
    if (git(["rev-parse", "--verify", "--quiet", `${remoteRef}^{commit}`]) !== null) base_ref = remoteRef;
    else if (git(["rev-parse", "--verify", "--quiet", `${baseName}^{commit}`]) !== null) base_ref = baseName;
    else base_ref = remoteRef; // resolveDiffContext will surface a missing-ref guidance if unresolved
  }
  return { status: "ok", pr: prNumber, base_ref };
}

export function opStatus(root: string, deps: OperationDeps = defaultDeps()): StatusResult {
  const paths = workspacePaths(root);
  const initialized = workspaceInitialized(root);
  if (!initialized || !graphExists(root)) {
    return {
      workspace_initialized: initialized,
      graph_path: paths.graphPath,
      last_analyzed_at: null,
      local_only: true,
      sources: {},
      quality_score: null,
      can_generate_tests: false,
      freshness: "missing",
      changed_files: 0,
      analysis: null,
      privacy: { graph_storage: "local", upload_enabled: false, source_snippets_in_pack: false }
    };
  }

  const graph = loadGraph(paths.graphPath);
  const current = scanFileEntries(graph.workspace.root);
  const fresh = computeFreshness(graph, current);
  const score = scoreGraph(graph);

  const sources: Record<string, number> = {};
  for (const s of graph.sources) sources[s.source_system] = (sources[s.source_system] ?? 0) + 1;

  return {
    workspace_initialized: true,
    graph_path: paths.graphPath,
    last_analyzed_at: graph.updated_at,
    local_only: true,
    sources,
    quality_score: score.overall,
    can_generate_tests: score.overall >= 1 && graph.nodes.length > 0,
    freshness: fresh.state,
    changed_files: fresh.changed_files.length,
    analysis: graph.analysis ?? null,
    privacy: { graph_storage: "local", upload_enabled: false, source_snippets_in_pack: false }
  };
}

export function opScore(root: string): ScoreResult {
  return scoreGraph(loadGraph(workspacePaths(root).graphPath));
}

export function opDoctor(root: string): DoctorResult {
  const graph = loadGraph(workspacePaths(root).graphPath);
  return doctorGraph(graph, scoreGraph(graph));
}

/**
 * G1 — proof-focused doctor: why are top targets not Dynamically Proven?
 * Read-only: consumes the canonical RTM judgment (buildRtm) plus the last run's
 * redacted proof-attempts sidecar. Mints nothing, mutates no ledger, writes no
 * files — under staleness or ambiguity it fails closed to "re-run".
 */
export function opProofDoctor(root: string): ProofDoctorResult {
  const graph = loadGraph(workspacePaths(root).graphPath);
  const rtm = buildRtm(graph, loadLedger(root));
  return buildProofDoctor(graph, rtm, loadProofAttempts(root));
}

export function opGaps(root: string, opts: { limit?: number; min_priority?: string } = {}): GapsResult {
  const graph = loadGraph(workspacePaths(root).graphPath);
  const gaps = findGaps(graph, opts);
  const topRiskGaps = rankRiskGaps(graph, { limit: opts.limit ?? 10, repoRoot: root }).map((gap) => ({
    external_id: gap.id,
    title: gap.title,
    file: gap.file,
    risk_score: gap.risk_score,
    incoming_refs: gap.incoming_refs,
    git_churn: gap.git_churn,
    entry_point: gap.entry_point,
    reasons: gap.reasons,
    probability: gap.probability,
    impact: gap.impact,
    detection_difficulty: gap.detection_difficulty,
    fan_out: gap.fan_out,
    route_weight: gap.route_weight,
    data_sensitivity: gap.data_sensitivity,
    flow_position: gap.flow_position,
    complexity_proxy: gap.complexity_proxy,
    is_new_code: gap.is_new_code,
    integration_signal: gap.integration_signal
  }));
  return {
    ...gaps,
    top_risk_gaps: topRiskGaps,
    risk_model: {
      formula: "OrangePro Risk Score = Probability(1-10) × Impact(1-10) × DetectionDifficulty(1|5|10); P = normalize(git_churn*0.35 + fan_out*0.30 + new_code*15 + complexity*0.20); I = normalize(fan_in*0.30 + route_weight*0.30 + flow_position*0.20 + data_sensitivity*0.20); D = {proven:1, associated:5, none:10}",
      note: "Risk ranking is prioritization only. It does not change Proven, Runtime-covered, Associated signal, No integration signal, or coverage percentages."
    }
  };
}

export function opRecordRun(root: string, opts: RecordRunOptions, deps: OperationDeps = defaultDeps()): RecordRunResult {
  const paths = workspacePaths(root);
  const preGraph = loadGraph(paths.graphPath);
  const targetInput = opts.target_symbol ?? opts.target_id;
  const target = targetInput ? resolveTargetSymbol(preGraph, targetInput) : null;
  if (!target) {
    throw new Error("record requires --target-symbol sym:<file>#<Symbol>, or a target id that resolves to exactly one CodeSymbol.");
  }
  const language = targetLanguage(target);
  const preEdges = proofEdgesFor(preGraph, target);
  const sourceRoot = resolve(opts.source ?? root);
  const testRel = opts.test_path ? toWorkspaceRel(sourceRoot, resolveContained(sourceRoot, opts.test_path)) : undefined;
  let status: LedgerRecord["status"] = "unproven";
  let closed = false;
  let newEdges: string[] = [];
  let reason = "";
  let reproveMode: LedgerRecord["reprove_mode"];
  let reproveReason: string | undefined;

  if (!canReproveLanguage(language)) {
    status = "generated_unverifiable";
    reason = `OrangePro cannot dynamically verify ${language} targets yet; recorded separately from kept-rate.`;
  } else if (preEdges.length > 0) {
    status = "unproven";
    reason = "Target already had a static hard edge before this run; record_run is static diagnostics only and public Proven requires orangepro_prove.";
  } else {
    const scoped = tryScopedReprove({
      root: opts.source ?? root,
      graph: preGraph,
      targetSymbol: target,
      preEdges,
      testPath: opts.test_path,
      now: deps.clock()
    });
    let reproved: { closed: boolean; newEdges: string[] };
    if (scoped && scoped.newEdges.length > 0) {
      saveGraph(paths.graphPath, scoped.graph);
      reproved = { closed: true, newEdges: scoped.newEdges };
      reproveMode = "scoped";
      reproveReason = scoped.reason;
    } else {
      (deps.analyze ?? opAnalyze)(root, { source: opts.source ?? root }, deps);
      const postGraph = loadGraph(paths.graphPath);
      reproved = reproveTarget(preEdges, postGraph, target);
      reproveMode = "full";
      reproveReason = opts.test_path
        ? "Scoped confirmer did not produce a hard edge; full re-analysis decided the outcome."
        : "No explicit test path was provided; full re-analysis decided the outcome.";
    }
    newEdges = testRel ? reproved.newEdges.filter((edge) => edge.startsWith(`test:${testRel}->`)) : reproved.newEdges;
    const staticAssociated = newEdges.length > 0;
    closed = false;
    status = "unproven";
    if (testRel && reproved.closed && newEdges.length === 0) {
      reproveReason = `A hard COVERS edge for the target exists, but none came from the provided test (${testRel}); not credited to this attempt.`;
    }
    reason = staticAssociated
      ? reproveMode === "scoped"
        ? "Static COVERS edge found by scoped deterministic confirmation; public Proven still requires a dynamic targeted-proof certificate."
        : "Static COVERS edge found after re-analysis; public Proven still requires a dynamic targeted-proof certificate."
      : opts.vacuous
        ? "No new hard edge; attempt marked vacuous."
        : "No new hard COVERS edge found after re-analysis.";
  }

  return appendLedgerRecord(root, {
    run_id: opts.run_id,
    target_id: opts.target_id,
    target_symbol: target,
    pre_edges: preEdges,
    new_edges: newEdges,
    closed,
    vacuous: opts.vacuous === true,
    agent_pass: opts.agent_pass,
    evidence_ids: opts.evidence_ids ?? [],
    provider: opts.provider,
    model: opts.model,
    prompt_version: opts.prompt_version,
    language,
    status,
    reprove_mode: reproveMode,
    reprove_reason: reproveReason,
    reason,
    ts: deps.clock()
  });
}

/**
 * G2 — Python sandbox NARROWING: the nearest pyproject.toml/setup.py/setup.cfg
 * ancestor of the target, confined to sourceRoot, used only when the test also
 * lives inside it. Falls back to sourceRoot (today's behavior) otherwise —
 * this only ever shrinks the copied sandbox, never widens or breaks it.
 */
function pythonModuleRoot(sourceRoot: string, targetRel: string, testRel: string): string {
  const stop = resolve(sourceRoot);
  let dir = dirname(resolve(sourceRoot, targetRel));
  let found: string | null = null;
  for (;;) {
    if (existsSync(join(dir, "pyproject.toml")) || existsSync(join(dir, "setup.py")) || existsSync(join(dir, "setup.cfg"))) {
      found = dir;
      break;
    }
    if (dir === stop) break;
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  if (!found || found === stop) return stop;
  const testAbs = resolve(sourceRoot, testRel);
  return testAbs === found || testAbs.startsWith(found + sep) ? found : stop;
}

export function opDynamicProof(root: string, opts: DynamicProofOptions, deps: OperationDeps = defaultDeps()): DynamicProofResult {
  const paths = workspacePaths(root);
  const graph = loadGraph(paths.graphPath);
  const targetInput = opts.target_symbol ?? opts.target_id;
  const target = targetInput ? resolveTargetSymbol(graph, targetInput) : null;
  if (!target) {
    throw new Error("prove requires --target-symbol sym:<file>#<Symbol>, or a target id that resolves to exactly one CodeSymbol.");
  }
  const language = targetLanguage(target);
  if (language !== "typescript" && language !== "go" && language !== "java" && language !== "python") {
    throw new Error(`prove currently supports JavaScript/TypeScript, Go, Java, and Python targets only; found ${language}.`);
  }
  const sourceRoot = resolve(opts.source ?? root);
  assertProofSourceMatchesGraph(sourceRoot, graph);
  const symbolTarget = symbolTargetParts(target);
  const providedTargetRel = opts.target_path ? toWorkspaceRel(sourceRoot, resolveContained(sourceRoot, opts.target_path)) : undefined;
  assertProofTargetMatchesSymbol({ ...opts, target_path: providedTargetRel }, symbolTarget);
  const targetRel = symbolTarget.file;
  const method = symbolTarget.method;
  assertTargetFileFresh(sourceRoot, targetRel, graph);

  // Per-language routing produces the spike args + a mapped oracle in the SAME
  // DynamicProofOracleSummary shape. Everything from `closed` onward (the trust gate,
  // the cert, appendLedgerRecord, the return summary) is language-agnostic and unchanged.
  let oracle: DynamicProofOracleSummary;
  let proofModuleRoot: string | undefined;
  let testRel: string;
  let replacementMode: string;
  let runner: string;
  if (language === "go") {
    // Go selects the target test by NAME (`go test -run ^TestX$`), derives its own
    // zero-value sentinel, and always uses `go test`. No --replacement/--runner/
    // --vitest-config/--jest-config/--test-env/--link-node-modules apply.
    if (!opts.test_run) throw new Error("prove requires --test-run '^TestName$' for Go targets.");
    if (!/^\^.+\$$/.test(opts.test_run)) {
      throw new Error("prove --test-run must be a fully-anchored test name, e.g. '^TestName$'.");
    }
    const goRoot = goModuleRoot(sourceRoot, targetRel, root);
    if (goRoot !== resolve(sourceRoot)) {
      proofModuleRoot = goRoot;
      reportProgress(`proof scope: Go module root ${goRoot} (above the analyzed path)`);
    }
    const args = [
      "--root",
      goRoot,
      "--target",
      relative(goRoot, resolve(sourceRoot, targetRel)).split(sep).join("/"),
      "--func",
      method,
      "--test-run",
      opts.test_run,
      "--json"
    ];
    if (opts.timeout_ms !== undefined) args.push("--timeout-ms", String(opts.timeout_ms));
    // Slice 2: bind a runtime-named subtest's mutant failure to the exact assertion line.
    if (opts.go_assertion_line !== undefined) args.push("--go-assertion-line", String(opts.go_assertion_line));
    // Receiver-qualified method target (`sym:file.go#Recv.M`) → the mutator must
    // match the exact receiver, never a same-named decl on another type.
    if (symbolTarget.memberQualifier) args.push("--recv", symbolTarget.memberQualifier);
    const run = (deps.dynamicProofRunner ?? defaultDynamicProofRunner)(args, {
      cwd: goRoot,
      scriptPath: dynamicProofSpikePathFor("go")
    });
    oracle = mapGoOracle(parseDynamicProofJson(run.stdout, run.stderr) as unknown as GoDynamicProofJson);
    testRel = opts.test_run;
    replacementMode = GO_SENTINEL_LABEL;
    runner = "go";
  } else if (language === "java") {
    // Java selects the target test by class#method (`mvn test -Dtest=Class#method`),
    // derives its own type-compatible sentinel from the return type, and always uses
    // Surefire. The single `test_run` field carries `Class#method` (FQCN or simple
    // class both accepted by the spike). No --replacement/--runner/--vitest-config/
    // --jest-config/--test-env/--link-node-modules apply.
    if (!opts.test_run) throw new Error("prove requires --test-run 'TestClass#testMethod' for Java targets.");
    const hash = opts.test_run.lastIndexOf("#");
    if (hash <= 0 || hash === opts.test_run.length - 1) {
      throw new Error("prove --test-run must be 'TestClass#testMethod' for Java targets, e.g. 'CalculatorTest#addsTwoNumbers'.");
    }
    const testClass = opts.test_run.slice(0, hash);
    const testMethod = opts.test_run.slice(hash + 1);
    const javaRoot = javaModuleRoot(sourceRoot, targetRel, root);
    if (javaRoot !== resolve(sourceRoot)) {
      proofModuleRoot = javaRoot;
      reportProgress(`proof scope: Java module root ${javaRoot} (above the analyzed path)`);
    }
    const args = [
      "--root",
      javaRoot,
      "--test-class",
      testClass,
      "--test-method",
      testMethod,
      "--target",
      relative(javaRoot, resolve(sourceRoot, targetRel)).split(sep).join("/"),
      "--method",
      method,
      "--json"
    ];
    if (opts.timeout_ms !== undefined) args.push("--timeout-ms", String(opts.timeout_ms));
    const run = (deps.dynamicProofRunner ?? defaultDynamicProofRunner)(args, {
      cwd: javaRoot,
      scriptPath: dynamicProofSpikePathFor("java")
    });
    oracle = mapJavaOracle(parseDynamicProofJson(run.stdout, run.stderr) as unknown as JavaDynamicProofJson);
    testRel = opts.test_run;
    replacementMode = JAVA_SENTINEL_LABEL;
    runner = "junit";
  } else if (language === "python") {
    if (!opts.test_path) throw new Error("prove requires --test <path>.");
    if (opts.replacement === undefined) throw new Error("prove requires --replacement <sentinel>.");
    testRel = toWorkspaceRel(sourceRoot, resolveContained(sourceRoot, opts.test_path));
    replacementMode = opts.replacement_mode ?? "return-json";
    runner = opts.runner ?? "auto";
    if (replacementMode !== "return-json") {
      throw new Error("prove --replacement-mode promise-json is not supported for Python targets.");
    }
    if (runner !== "auto" && runner !== "pytest") {
      throw new Error("prove Python targets require --runner auto or --runner pytest.");
    }
    if ((opts.test_env?.length ?? 0) > 0) {
      throw new Error("prove --test-env is not supported for Python targets yet.");
    }
    // G2: narrow the copied sandbox to the owning Python project when both the
    // target and the test live inside it (bounded copy — no full-repo OOM).
    const pyRoot = pythonModuleRoot(sourceRoot, targetRel, testRel);
    if (pyRoot !== resolve(sourceRoot)) {
      proofModuleRoot = pyRoot;
      reportProgress(`proof scope: Python project root ${pyRoot} (narrowed from the analyzed path)`);
    }
    const args = [
      "--root",
      pyRoot,
      "--test",
      relative(pyRoot, resolve(sourceRoot, testRel)).split(sep).join("/"),
      "--target",
      relative(pyRoot, resolve(sourceRoot, targetRel)).split(sep).join("/"),
      "--func",
      method,
      "--mode",
      "sentinel",
      "--json"
    ];
    if (opts.timeout_ms !== undefined) args.push("--timeout-ms", String(opts.timeout_ms));
    const run = (deps.dynamicProofRunner ?? defaultDynamicProofRunner)(args, {
      cwd: pyRoot,
      scriptPath: dynamicProofSpikePathFor("python")
    });
    oracle = parseDynamicProofJson(run.stdout, run.stderr);
  } else {
    if (!opts.test_path) throw new Error("prove requires --test <path>.");
    if (opts.replacement === undefined) throw new Error("prove requires --replacement <sentinel>.");
    testRel = toWorkspaceRel(sourceRoot, resolveContained(sourceRoot, opts.test_path));
    replacementMode = opts.replacement_mode ?? "return-json";
    runner = opts.runner ?? "auto";
    if (replacementMode !== "return-json" && replacementMode !== "promise-json") {
      throw new Error("prove --replacement-mode must be one of: return-json, promise-json.");
    }
    if (runner === "pytest") {
      throw new Error("prove --runner pytest requires a Python target.");
    }
    if (runner !== "auto" && runner !== "vitest" && runner !== "jest" && runner !== "mocha") {
      throw new Error("prove --runner must be one of: auto, vitest, jest, mocha.");
    }
    const args = [
      "--root",
      sourceRoot,
      "--test",
      testRel,
      "--target",
      targetRel,
      "--method",
      method,
      "--replacement",
      opts.replacement,
      "--replacement-mode",
      replacementMode,
      "--runner",
      runner,
      "--json"
    ];
    if (opts.timeout_ms !== undefined) args.push("--timeout-ms", String(opts.timeout_ms));
    if (opts.link_node_modules) args.push("--link-node-modules");
    if (opts.vitest_config) args.push("--vitest-config", toWorkspaceRel(sourceRoot, resolveContained(sourceRoot, opts.vitest_config)));
    if (opts.jest_config) args.push("--jest-config", toWorkspaceRel(sourceRoot, resolveContained(sourceRoot, opts.jest_config)));
    for (const entry of opts.test_env ?? []) args.push("--test-env", entry);

    const run = (deps.dynamicProofRunner ?? defaultDynamicProofRunner)(args, { cwd: sourceRoot });
    oracle = parseDynamicProofJson(run.stdout, run.stderr);
  }
  const closed = dynamicProofSucceeded(oracle);
  const baselineGreen = oracle.baseline?.exitCode === 0 && oracle.baseline?.timedOut !== true;
  const mutantFailedAssertion = oracle.mutant?.assertionFailure === true && oracle.mutant?.timedOut !== true;
  const dynamicProof: DynamicProofCertificate = {
    proof_kind: "dynamic_targeted",
    baseline_green: baselineGreen,
    mutant_failed_assertion: mutantFailedAssertion,
    // Derived from the targeted mutation kill: if the credited subject is mocked/replaced,
    // mutating its real body cannot cause the same test to fail at an assertion.
    target_not_mocked: closed,
    sentinel: oracle.replacementMode ?? replacementMode,
    runner: oracle.runner ?? runner,
    test_path: oracle.test ?? testRel,
    mutant_status: oracle.status
  };
  const result = appendLedgerRecord(root, {
    run_id: opts.run_id,
    target_id: opts.target_id,
    target_symbol: target,
    pre_edges: proofEdgesFor(graph, target),
    new_edges: [],
    closed,
    evidence_ids: [],
    language,
    dynamic_proof: dynamicProof,
    target_fingerprint: targetFingerprint(graph, target),
    status: closed ? "reproven" : "unproven",
    reason: oracle.reason ?? (closed ? "Dynamic targeted proof closed." : "Dynamic targeted proof did not close."),
    ts: deps.clock()
  });
  return {
    ...result,
    ...(proofModuleRoot ? { module_root: proofModuleRoot } : {}),
    oracle: {
      status: oracle.status,
      proven: oracle.proven,
      reason: oracle.reason,
      runner: oracle.runner,
      replacementMode: oracle.replacementMode,
      test: oracle.test,
      target: oracle.target,
      method: oracle.method,
      baseline: oracle.baseline
        ? {
            exitCode: oracle.baseline.exitCode,
            timedOut: oracle.baseline.timedOut,
            // Surface the oracle's already-redacted, single-line baseline failure summary so
            // autoProve can classify WHY a baseline was red (R-1). Transient return-only field:
            // it is NOT written to the ledger cert (the record carries only the dynamic_proof
            // certificate), so raw stderr never lands in the ledger or the report.
            failureSummary: oracle.baseline.failureSummary ?? null
          }
        : undefined,
      mutant: oracle.mutant
        ? { exitCode: oracle.mutant.exitCode, timedOut: oracle.mutant.timedOut, assertionFailure: oracle.mutant.assertionFailure }
        : undefined,
      medianProofMs: oracle.medianProofMs
    }
  };
}

const SETUP_DEFAULT_TIMEOUT_MS = 30_000;

/** Validate a prove-loop setup command shape (ported from the spike cost-runner). */
function validateSetupCommand(command: ProveLoopSetupCommand, index: number): { command: string; args: string[]; timeout_ms?: number } {
  if (!command || typeof command !== "object") {
    throw new Error(`prove-loop setup command ${index} must be an object`);
  }
  if (typeof command.command !== "string" || command.command.trim() === "") {
    throw new Error(`prove-loop setup command ${index} missing command`);
  }
  if (command.args !== undefined && (!Array.isArray(command.args) || command.args.some((a) => typeof a !== "string"))) {
    throw new Error(`prove-loop setup command ${index} has invalid args`);
  }
  if (command.timeout_ms !== undefined && (!Number.isInteger(command.timeout_ms) || command.timeout_ms <= 0)) {
    throw new Error(`prove-loop setup command ${index} has invalid timeout_ms (must be a positive integer)`);
  }
  return { command: command.command, args: command.args ?? [], timeout_ms: command.timeout_ms };
}

/**
 * Run setup_commands in the source checkout before the oracle makes its isolated
 * baseline/mutant copies. Trusted-local prep only (same posture as test_env). The
 * first non-zero exit or timeout stops the run; the reason redacts secret-looking output.
 */
function runProveLoopSetup(
  sourceRoot: string,
  commands: ReturnType<typeof validateSetupCommand>[],
  defaultTimeoutMs: number | undefined
): { ok: true } | { ok: false; reason: string } {
  for (const command of commands) {
    const timeoutMs = command.timeout_ms ?? defaultTimeoutMs ?? SETUP_DEFAULT_TIMEOUT_MS;
    const result = spawnSync(command.command, command.args, {
      cwd: sourceRoot,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: timeoutMs,
      // A successful `npm ci` / `npm run build` (the main use case) easily exceeds the
      // 1 MiB default, which would SIGTERM the child and be misread as a failure.
      maxBuffer: 64 * 1024 * 1024
    });
    const label = redactSecrets([command.command, ...command.args].join(" "));
    if (result.error) {
      // Spawn-level failure (status is null): ENOENT (bad command), ENOBUFS (output
      // over maxBuffer), ETIMEDOUT, etc. Surface the real code so it is not fabricated
      // as "(exit 1)".
      const err = result.error as NodeJS.ErrnoException;
      const code = err.code ?? "spawn error";
      const detail = redactSecrets(err.message ?? "").split("\n", 1)[0] ?? "";
      return { ok: false, reason: `setup command failed: ${label} (${code}${detail ? `: ${detail}` : ""})` };
    }
    const exitCode = result.status ?? 1;
    if (exitCode !== 0) {
      const detail = redactSecrets((result.stderr || result.stdout || "").trim().split("\n", 1)[0] ?? "");
      return { ok: false, reason: `setup command failed: ${label} (exit ${exitCode})${detail ? `: ${detail}` : ""}` };
    }
  }
  return { ok: true };
}

/**
 * Product wrapper around opDynamicProof: run trusted-local setup in the source
 * checkout, then call the UNCHANGED oracle, then best-effort refresh the report.
 * Setup lives entirely here so the proof primitive stays a small single-shot.
 * A setup failure returns `unrunnable` WITHOUT touching the ledger (setup-didn't-run
 * is an environmental non-event); the oracle is not called and no cert is minted.
 */
export function opProveLoop(root: string, opts: ProveLoopOptions, deps: OperationDeps = defaultDeps()): ProveLoopResult {
  // Resolve the credited symbol up front and apply the SAME TS-only guard opDynamicProof
  // enforces — both BEFORE running setup — so a bad/non-TS target fails fast like `opro
  // prove` and never runs setup or mints a divergent record the primitive would reject.
  const graph = loadGraph(workspacePaths(root).graphPath);
  const targetInput = opts.target_symbol ?? opts.target_id;
  const target = targetInput ? resolveTargetSymbol(graph, targetInput) : null;
  if (!target) {
    throw new Error("prove requires --target-symbol sym:<file>#<Symbol>, or a target id that resolves to exactly one CodeSymbol.");
  }
  const language = targetLanguage(target);
  if (language !== "typescript" && language !== "go" && language !== "java" && language !== "python") {
    throw new Error(`prove currently supports JavaScript/TypeScript, Go, Java, and Python targets only; found ${language}.`);
  }

  const setupCommands = (opts.setup_commands ?? []).map((command, index) => validateSetupCommand(command, index));
  const sourceRoot = resolve(opts.source ?? root);
  const setup = runProveLoopSetup(sourceRoot, setupCommands, opts.setup_timeout_ms);
  if (!setup.ok) {
    // Setup did not run: an environmental non-event, not a proof attempt of record.
    // Append NOTHING — a setup flake (e.g. `npm ci` network blip) must never write a
    // newer ledger record that, via RTM latest-wins, clobbers a prior closed cert for
    // this symbol. The oracle is NOT called.
    return { status: "unrunnable", reason: setup.reason };
  }

  // Setup passed (or none) → call opDynamicProof VERBATIM. It copies the now-prepared
  // source, derives the mutation target from the credited symbol, mints the cert.
  const proof = opDynamicProof(
    root,
    {
      target_symbol: opts.target_symbol,
      target_id: opts.target_id,
      source: opts.source,
      test_path: opts.test_path,
      test_run: opts.test_run,
      go_assertion_line: opts.go_assertion_line,
      target_path: opts.target_path,
      method: opts.method,
      replacement: opts.replacement,
      replacement_mode: opts.replacement_mode,
      runner: opts.runner,
      timeout_ms: opts.timeout_ms,
      link_node_modules: opts.link_node_modules,
      vitest_config: opts.vitest_config,
      jest_config: opts.jest_config,
      test_env: opts.test_env,
      run_id: opts.run_id
    },
    deps
  );

  // Best-effort report refresh (exactly like ai-flows --apply): a render failure
  // must never fail a completed proof — the ledger/cert is already written.
  let behaviorCoveragePath: string | undefined;
  try {
    behaviorCoveragePath = opBehaviorCoverageHtml(root, `${WORKSPACE_DIR}/behavior-coverage.html`).behavior_coverage_path;
  } catch {
    // ponytail: swallow — refresh is advisory; DynamicProofResult carries no warnings channel.
  }
  return { ...proof, ...(behaviorCoveragePath ? { behavior_coverage_path: behaviorCoveragePath } : {}) };
}

export function opStats(root: string): LedgerStats {
  return ledgerStats(root);
}

export function opRtm(root: string, opts: RtmOptions = {}): RtmOperationResult {
  const graph = loadGraph(workspacePaths(root).graphPath);
  let targetIds: string[] | undefined;
  let changedFiles: string[] | undefined;
  let scope: RtmResult["scope"] | undefined;
  if (opts.baseRef) {
    const diff = opChanged(root, opts.baseRef);
    targetIds = diff.affected_behaviors;
    changedFiles = diff.status === "ok" ? diff.changed_files : [];
    scope = {
      base_ref: diff.base_ref,
      status: diff.status,
      ...(diff.guidance ? { guidance: diff.guidance } : {}),
      target_ids: diff.affected_behaviors,
      changed_files: changedFiles
    };
  }
  const format = opts.format ?? "md";
  const result = buildRtm(graph, loadLedger(root), { targetIds, changedFiles, statuses: opts.statuses, limit: opts.limit, scope });
  const ext = format === "json" ? "json" : format === "csv" ? "csv" : "md";
  const absRoot = resolve(root);
  // --out resolves like the sibling commands (export/graph-html/coverage-report):
  // relative to the workspace root, absolute paths honored as-is, no confinement.
  const rtmPath = opts.outputPath ? resolve(absRoot, opts.outputPath) : join(workspacePaths(root).dir, `rtm.${ext}`);
  mkdirSync(dirname(rtmPath), { recursive: true });
  const content = format === "json" ? JSON.stringify(result, null, 2) + "\n" : format === "csv" ? renderRtmCsv(result) : renderRtmMarkdown(result);
  writeFileAtomic(rtmPath, content);
  return { ...result, rtm_path: rtmPath, format };
}

export async function opAiLinks(
  root: string,
  opts: AiLinksOptions = {},
  deps: OperationDeps = defaultDeps()
): Promise<AiLinksResult> {
  const paths = workspacePaths(root);
  const graph = loadGraph(paths.graphPath);
  if (opts.apply) {
    const { result, graph: next } = applyAiLinks(root, graph);
    saveGraph(paths.graphPath, { ...next, updated_at: deps.clock() });
    return result;
  }

  const providerEnv = loadProviderEnv([root], deps.env);
  const cfg = opts.provider === "deterministic" ? null : resolveProviderConfig(providerEnv, opts);
  const provider = deps.aiProvider ?? (cfg ? buildProvider(cfg) : null);
  if (!provider) {
    throw new Error("No model provider configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_BASE_URL before running ai-links.");
  }
  return generateAiLinks(
    root,
    graph,
    provider,
    {
      all: opts.all,
      symbolsPerBehavior: opts.symbolsPerBehavior ?? positiveIntEnv(providerEnv.ORANGEPRO_AI_LINK_SYMBOLS_PER_BEHAVIOR),
      maxPromptTokens: opts.maxPromptTokens ?? positiveIntEnv(providerEnv.ORANGEPRO_AI_LINK_MAX_PROMPT_TOKENS),
      maxBehaviors: opts.maxBehaviors ?? positiveIntEnv(providerEnv.ORANGEPRO_AI_LINK_MAX_BEHAVIORS),
      progressRange: opts.progressRange
    },
    deps.clock
  );
}

/**
 * LLM candidate flow discovery (Slice 4). Mirrors opAiLinks: BYOK provider,
 * two-phase generate (stage artifact) / apply (store analysis.candidate_flows).
 * Explicit opt-in only — NEVER auto-run by opStart. Candidate flows are a
 * "verify these" worklist, never evidence.
 */
export async function opAiFlows(
  root: string,
  opts: AiFlowsOptions = {},
  deps: OperationDeps = defaultDeps()
): Promise<AiFlowsResult> {
  const paths = workspacePaths(root);
  const graph = loadGraph(paths.graphPath);
  if (opts.apply) {
    const { result, graph: next } = applyAiFlows(root, graph);
    saveGraph(paths.graphPath, { ...next, updated_at: deps.clock() });
    // Re-render the behavior report so applied candidate flows are visible.
    // Best-effort: a render failure must never fail apply (graph is saved).
    const warnings = [...result.warnings];
    let behaviorCoveragePath: string | undefined;
    try {
      behaviorCoveragePath = opBehaviorCoverageHtml(root, `${WORKSPACE_DIR}/behavior-coverage.html`).behavior_coverage_path;
    } catch (error) {
      warnings.push(`behavior coverage view not written: ${error instanceof Error ? error.message : String(error)}`);
    }
    return { ...result, warnings, ...(behaviorCoveragePath ? { behavior_coverage_path: behaviorCoveragePath } : {}) };
  }

  const providerEnv = loadProviderEnv([root], deps.env);
  const cfg = opts.provider === "deterministic" ? null : resolveProviderConfig(providerEnv, opts);
  const provider = deps.aiProvider ?? (cfg ? buildProvider(cfg) : null);
  if (!provider) {
    throw new Error("No model provider configured. Set OPENAI_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_BASE_URL before running ai-flows.");
  }
  return generateAiFlows(root, graph, provider, deps.clock);
}

/**
 * Dependency-manager lockfiles / installed-dep dirs — a diff of ONLY these maps to no behaviors.
 * Language-agnostic (monorepos exist in every ecosystem), not JS-only: JS/TS, Rust, Go, Python,
 * Ruby, PHP, Gradle.
 */
const INSTALL_ARTIFACT_BASENAMES = new Set([
  "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", // JS/TS
  "cargo.lock",                                                                 // Rust
  "go.sum",                                                                     // Go
  "poetry.lock", "pipfile.lock",                                                // Python
  "gemfile.lock",                                                               // Ruby
  "composer.lock",                                                              // PHP
  "gradle.lockfile"                                                             // Gradle
]);
export function isInstallArtifact(rel: string): boolean {
  const p = rel.split(/[\\/]+/).join("/");
  // installed-dep dirs
  if (/(?:^|\/)(?:node_modules|vendor\/bundle|\.venv)(?:\/|$)/.test(p)) return true;
  return INSTALL_ARTIFACT_BASENAMES.has((p.split("/").pop() ?? "").toLowerCase());
}

/**
 * Auto-prove scope for `opStart`. Explicit `--base` (PR/diff mode) stays scoped to the diff verbatim.
 * DEFAULT `opro start` must NOT let an install-artifact-only diff (e.g. a `package-lock.json` bump)
 * scope auto-prove to zero behaviors and skip the keyless existing-tests-first lane: ignore install
 * artifacts, and scope to the diff ONLY when it maps to >=1 eligible provable CodeSymbol target —
 * otherwise return undefined so autoProve runs the GLOBAL top-5 existing-tests-first pass.
 */
export function autoProveChangedScope(
  graph: LocalGraph,
  changed: ChangedResult,
  baseRef: string | undefined
): string[] | undefined {
  if (changed.status !== "ok") return undefined;
  if (baseRef) return changed.changed_files; // explicit PR/diff mode: unchanged, stay scoped
  const meaningful = changed.changed_files.filter((f) => !isInstallArtifact(f));
  if (meaningful.length === 0) return undefined; // only install artifacts → global top-5
  const changedSet = new Set(meaningful);
  const hasEligibleTarget = graph.nodes.some((n) => {
    if (n.kind !== "CodeSymbol" || !isEligibleProvableTarget(n)) return false;
    const ref = n.provenance?.source_ref;
    const file = typeof n.properties.file === "string" ? n.properties.file : undefined;
    return (ref != null && changedSet.has(ref)) || changedSet.has(n.external_id) || (file != null && changedSet.has(file));
  });
  return hasEligibleTarget ? meaningful : undefined; // no eligible provable target in scope → global top-5
}

export async function opStart(
  root: string,
  opts: StartOptions = {},
  deps: OperationDeps = defaultDeps()
): Promise<StartResult> {
  const providerOpts = startProviderOverride(root, opts);
  const scanRoot = opts.source ? resolve(opts.source) : resolve(root);
  const providerEnv = loadProviderEnv([root, scanRoot], deps.env);
  const providerDeps = { ...deps, env: providerEnv };
  const scope = summarizeCorpusScope(scanRoot);
  reportProgress(`start: preflight found ${scope.files.toLocaleString()} source/doc file(s)`, { current: 1, total: 8 });
  reportProgress("start: running deterministic analysis", { current: 2, total: 8 });
  const analyze = (deps.analyze ?? opAnalyze)(
    root,
    {
      source: opts.source ?? root,
      includeMarkdown: opts.includeMarkdown,
      generateCoverage: opts.generateCoverage,
      coverageTimeoutMs: opts.coverageTimeoutMs,
      suppressProgress: true
    },
    deps
  );
  const warnings = [...analyze.warnings];
  reportProgress("start: deterministic graph is ready", { current: 4, total: 8 });

  const providerConfigured = deps.aiProvider !== undefined || resolveProviderConfig(providerEnv, providerOpts) !== null;
  let aiLinks: StartAiResult = { status: "skipped", reason: "AI candidate links disabled for this run." };
  if (opts.ai !== false) {
    if (!providerConfigured) {
      reportProgress("ai: skipped — no local provider key/base URL found", { current: 5, total: 8 });
      aiLinks = {
        status: "skipped",
        reason: "No model provider configured; set OPENAI_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_BASE_URL to auto-apply weak AI grounding."
      };
    } else {
      try {
        reportProgress("ai: generating weak candidate links from the coverage-aware graph", { current: 5, total: 8 });
        const generated = await opAiLinks(root, { ...providerOpts, all: opts.aiAll, progressRange: { start: 63, end: 75 } }, providerDeps);
        reportProgress("ai: applying weak candidate links", { current: 6, total: 8 });
        const applied = await opAiLinks(root, { apply: true }, providerDeps);
        aiLinks = { status: "applied", generate: generated, apply: applied };
        warnings.push(...generated.warnings, ...applied.warnings);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        aiLinks = { status: "failed", reason };
        warnings.push(`AI candidate links skipped: ${reason}`);
      }
    }
  }

  let aiFlows: StartAiFlowsResult = { status: "skipped", reason: "AI candidate flows disabled for this run." };
  if (opts.ai !== false && opts.aiFlows !== false) {
    if (!providerConfigured) {
      aiFlows = {
        status: "skipped",
        reason: "No model provider configured; set OPENAI_API_KEY, ANTHROPIC_API_KEY, or OLLAMA_BASE_URL to auto-apply AI candidate flows."
      };
    } else {
      try {
        reportProgress("ai-flows: generating candidate behavior-flow worklist", { current: 6, total: 8 });
        const generated = await opAiFlows(root, providerOpts, providerDeps);
        reportProgress("ai-flows: applying candidate behavior-flow worklist", { current: 6, total: 8 });
        const applied = await opAiFlows(root, { apply: true }, providerDeps);
        aiFlows = { status: "applied", generate: generated, apply: applied };
        warnings.push(...generated.warnings, ...applied.warnings);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        aiFlows = { status: "failed", reason };
        warnings.push(`AI candidate flows skipped: ${reason}`);
      }
    }
  }

  // PR scope is computed once here so auto-prove can scope to the diff and the later
  // summary can reuse it.
  const changed = opChanged(root, opts.baseRef);

  // Auto-prove (PR 1): key-gated generate→prove for the top provable TS/JS targets.
  // Runs BEFORE the report/RTM writes below so they reflect any freshly-minted Proven.
  // Proof is minted only by opProveLoop's UNCHANGED oracle; no key ⇒ no files, no proof.
  reportProgress("auto-prove: driving generate → prove on the top provable targets", { current: 6, total: 8 });
  let autoProveResult: AutoProveResult;
  try {
    autoProveResult = await autoProve(
      root,
      {
        autoLimit: opts.autoLimit,
        noAuto: opts.noAuto,
        provider: providerOpts.provider,
        model: providerOpts.model,
        prompt_version: opts.promptVersion,
        changedFiles: autoProveChangedScope(loadGraph(workspacePaths(root).graphPath), changed, opts.baseRef)
      },
      { ...providerDeps, proveLoop: opProveLoop }
    );
    for (const skip of autoProveResult.skipped) warnings.push(`auto-prove skipped ${skip.target_symbol ?? skip.title}: ${skip.reason}`);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    autoProveResult = {
      ran: false,
      status: "no-targets",
      reason: `auto-prove failed but deterministic artifacts are ready: ${reason}`,
      attempted: 0,
      proven: 0,
      needs_setup: [],
      skipped: [],
      generated_files: [],
      attempts: []
    };
    warnings.push(`auto-prove skipped: ${reason}`);
  }

  if (!opts.noAuto && providerConfigured && opts.ai !== false) {
    try {
      const graphForGeneration = loadGraph(workspacePaths(root).graphPath);
      const generatedTargets = new Set(
        (graphForGeneration.generated_tests ?? []).map((t) => t.target_symbol_external_id).filter((id): id is string => Boolean(id))
      );
      const targetIds = rankRiskGaps(graphForGeneration, { repoRoot: root, limit: START_GENERATE_RISK_LIMIT })
        .map((gap) => gap.id)
        .filter((id) => !generatedTargets.has(id));
      if (targetIds.length) {
        reportProgress(`generate: drafting tests for top ${targetIds.length} risk target(s)`, { current: 6, total: 8 });
        let accepted = 0;
        for (let i = 0; i < targetIds.length; i += START_GENERATE_BATCH_LIMIT) {
          const batch = targetIds.slice(i, i + START_GENERATE_BATCH_LIMIT);
          const generated = await opGenerate(
            root,
            {
              ...providerOpts,
              target_ids: batch,
              limit: batch.length,
              prompt_version: opts.promptVersion ?? "v5"
            },
            providerDeps
          );
          accepted += generated.generated_tests.length;
          warnings.push(...generated.warnings.map((w) => `generate: ${w}`));
        }
        if (accepted === 0) warnings.push("generate: provider returned no accepted tests for the top risk targets.");
      }
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      warnings.push(`generate skipped: ${reason}`);
    }
  }

  // G1: persist the distilled, already-redacted attempt classifications so
  // `opro doctor --proof` and standalone report regens can explain blockers
  // after this process exits. Sidecar only — never read by the oracle, RTM,
  // or ledger paths; a write failure must never fail start.
  try {
    writeProofAttempts(
      root,
      distillProofAttempts(autoProveResult, {
        generatedAt: deps.clock(),
        graph: loadGraph(workspacePaths(root).graphPath)
      })
    );
  } catch (error) {
    warnings.push(`proof-attempts sidecar not written: ${error instanceof Error ? error.message : String(error)}`);
  }

  let coverageReport: string | undefined;
  try {
    reportProgress("artifacts: writing coverage report", { current: 6, total: 8 });
    coverageReport = opCoverageReport(root, `${WORKSPACE_DIR}/COVERAGE_REPORT.md`).coverage_report_path;
  } catch (error) {
    warnings.push(`coverage report not written: ${error instanceof Error ? error.message : String(error)}`);
  }

  let coverageHtml: string | undefined;
  try {
    reportProgress("artifacts: writing behavior coverage view", { current: 7, total: 8 });
    // Forward THIS-RUN dynamic-proof outcome so the report can name the dominant setup/runnability
    // block reason when 0 behaviors closed (metadata only; mints nothing, changes no tier count).
    const dynForReport: DynamicProofReportInput = {
      attempted: autoProveResult.attempted,
      proven: autoProveResult.proven,
      needsSetup: autoProveResult.needs_setup.map((a) => ({ category: a.category, reason: a.reason }))
    };
    coverageHtml = opBehaviorCoverageHtml(root, `${WORKSPACE_DIR}/behavior-coverage.html`, dynForReport).behavior_coverage_path;
  } catch (error) {
    warnings.push(`behavior coverage view not written: ${error instanceof Error ? error.message : String(error)}`);
  }

  reportProgress("artifacts: writing RTM", { current: 8, total: 8 });
  const rtm = opRtm(root, { format: "md", baseRef: opts.baseRef, limit: START_RTM_LIMIT });
  const finalGraph = loadGraph(workspacePaths(root).graphPath);
  const aiLinked = summarizeAiLinks(finalGraph);
  const finalAnalyze: AnalyzeSummary = {
    ...analyze,
    analysis: finalGraph.analysis ?? analyze.analysis,
    candidate_relationships_count: finalGraph.candidate_edges.length,
    ai_linked: aiLinked
  };
  reportProgress("artifacts: selecting gap targets", { current: 8, total: 8 });
  const gaps = opGaps(root, { limit: 10 });

  const nextActions: string[] = [];
  if (coverageHtml) nextActions.push(`Open ${coverageHtml} for the behavior report (codebase, behaviors, composed flows, priority risks).`);
  // Auto-prove summary: "auto-proved M of N attempted" + needs_setup/skipped reasons + files.
  if (autoProveResult.status === "skipped-no-key") {
    nextActions.push(autoProveResult.reason ?? NO_KEY_MESSAGE);
  } else if (autoProveResult.status === "disabled") {
    nextActions.push("Dynamic proof was not attempted (--no-auto); run without it to auto-mint Dynamically Proven from generated tests. Static mapping and Associated signals are unaffected.");
  } else if (autoProveResult.ran) {
    nextActions.push(`Dynamic proof: attempted the top ${autoProveResult.attempted} target(s); ${autoProveResult.proven} dynamically proven. Static breadth (behaviors, flows, Associated signals) is mapped regardless.`);
    if (autoProveResult.proven === 0) {
      const dom = dominantBlockReason(autoProveResult.needs_setup);
      if (dom) nextActions.push(`Dynamic proof closed 0: blocked because ${dom.label} (${dom.count}/${dom.total}). This is a sandbox setup gap, not a static-test failure; Static Associated signals are still shown.`);
    }
    for (const file of autoProveResult.generated_files) nextActions.push(`Auto-prove wrote generated test: ${file}`);
    for (const attempt of autoProveResult.needs_setup) nextActions.push(`Auto-prove needs setup for ${attempt.target_symbol} (${attempt.test_path}): ${attempt.reason ?? "baseline/setup did not run"}.`);
    // Fix 2: the existing-tests lane ran without a key but minted 0 Proven (all survived) —
    // still surface the add-a-key guidance, since a key would unlock the generation lane.
    // (`reason` carries NO_KEY_MESSAGE only on the no-key path; skipped-no-key is handled above.)
    if (autoProveResult.proven === 0 && autoProveResult.reason === NO_KEY_MESSAGE) nextActions.push(autoProveResult.reason);
  }
  if (rtm.summary.total > 0 && rtm.summary.proven === 0) {
    nextActions.push(
      "Dynamically Proven is 0 because no dynamic proof has closed yet; this is expected after analyze-only. In a coding agent, generate a test for the top gap and follow the returned prove_run/prove_loop handoff to mint Dynamically Proven through the dynamic oracle."
    );
  }
  nextActions.push(
    rtm.rows.length < rtm.summary.total
      ? `Share ${rtm.rtm_path} as the capped deterministic traceability matrix (${rtm.rows.length}/${rtm.summary.total} rows).`
      : `Share ${rtm.rtm_path} as the deterministic traceability matrix.`
  );
  if (rtm.rows.length < rtm.summary.total) nextActions.push("For full machine-readable RTM, run `opro rtm --format json --out .orangepro/rtm-full.json`; avoid opening full Markdown on very large repos.");
  if (changed.status === "ok" && changed.affected_behaviors.length > 0) {
    nextActions.push(`In your coding agent, call orangepro_generate_tests with base_ref=${changed.base_ref}; write runnable tests, then follow each returned handoff: call orangepro_prove with returned prove_run args when present for public Proven, otherwise record_run is static diagnostics only.`);
  } else if (gaps.gaps.length > 0) {
    nextActions.push(`In your coding agent, call orangepro_generate_tests for ${gaps.gaps[0].external_id}; write runnable tests, then follow each returned handoff: call orangepro_prove with returned prove_run args when present for public Proven, otherwise record_run is static diagnostics only.`);
  } else {
    nextActions.push("No deterministic gap target was found; inspect the RTM and graph before generating tests.");
  }
  if (aiLinks.status === "skipped") nextActions.push(aiLinks.reason ?? "AI grounding was skipped.");
  if (aiLinks.status === "failed") nextActions.push(`AI grounding failed but deterministic artifacts are ready: ${aiLinks.reason}`);
  if (aiFlows.status === "applied") nextActions.push("Review the AI-suggested flows section in the behavior report; these are candidate chains to verify, not evidence.");
  if (aiFlows.status === "failed") nextActions.push(`AI candidate flows failed but deterministic artifacts are ready: ${aiFlows.reason}`);

  return {
    scope,
    analyze: finalAnalyze,
    ai_links: aiLinks,
    ai_flows: aiFlows,
    ai_linked: aiLinked,
    behavior_coverage_path: coverageHtml,
    coverage_report_path: coverageReport,
    rtm,
    changed,
    gaps,
    auto_prove: autoProveResult,
    next_actions: nextActions,
    agent_workflow: AGENT_RUN_WORKFLOW,
    grounding_contract: GROUNDING_CONTRACT,
    warnings
  };
}

const NO_PROVIDER_MESSAGE =
  'No model provider configured. Set OPENAI_API_KEY (or OLLAMA_BASE_URL / ANTHROPIC_API_KEY) in your shell environment or a .env.provider.local file to generate with your own model, or pass provider="deterministic" (or set ORANGEPRO_ALLOW_DETERMINISTIC=1) to use the offline deterministic stand-in. No tests were generated.';
const START_RTM_LIMIT = 500;
const START_GENERATE_RISK_LIMIT = 20;
const START_GENERATE_BATCH_LIMIT = 5;

const EMPTY_EVIDENCE_SUMMARY: EvidenceSummary = {
  tests: 0,
  tests_with_proof: 0,
  tests_without_validated_evidence: 0,
  invalid_citations: 0
};

/**
 * Resolve the generation provider per the BYOK contract. Returns null when no
 * provider/key is configured and the deterministic stand-in was not opted into,
 * so callers can surface NO_PROVIDER_MESSAGE instead of silently degrading.
 */
function resolveGenerationProvider(env: NodeJS.ProcessEnv, opts: ProviderOverride): ModelProvider | null {
  if (opts.provider === "deterministic") return new DeterministicProvider();
  const cfg = resolveProviderConfig(env, { provider: opts.provider, model: opts.model });
  if (cfg) return buildProvider(cfg);
  if (/^(1|true|yes)$/i.test(String(env.ORANGEPRO_ALLOW_DETERMINISTIC ?? ""))) return new DeterministicProvider();
  return null;
}

export async function opGenerate(
  root: string,
  opts: GenerateOptions & ProviderOverride = {},
  deps: OperationDeps = defaultDeps()
): Promise<GenerateSummary> {
  const paths = workspacePaths(root);
  const graph = loadGraph(paths.graphPath);

  // BYOK contract: real customer generation uses their own key/local model.
  // Load provider credentials from the workspace's .env.provider.local/.env.local/.env
  // (never persisted) the same way ai-links/ai-flows/start do, so `opro generate`
  // picks up a key file without exporting it into the shell. The offline
  // deterministic stand-in is opt-in only; otherwise return setup guidance
  // instead of silently degrading.
  const providerEnv = loadProviderEnv([root], deps.env);
  const provider = deps.aiProvider ?? resolveGenerationProvider(providerEnv, opts);
  if (!provider) {
    return {
      run_id: null,
      model_provider: "none",
      model_name: "none",
      generated_tests: [],
      evidence: [],
      evidence_summary: EMPTY_EVIDENCE_SUMMARY,
      missing_evidence: [],
      warnings: [NO_PROVIDER_MESSAGE],
      wrote_repo_files: false
    };
  }
  const reader = fileReaderFor(graph.workspace.root);

  const result = await generateTests(
    graph,
    { target_ids: opts.target_ids, framework: opts.framework, limit: opts.limit, input_mode: opts.input_mode, prompt_version: opts.prompt_version },
    provider,
    reader,
    deps.clock
  );

  if (result.run && result.generated_tests.length) {
    const next: LocalGraph = {
      ...graph,
      generation_runs: [...graph.generation_runs, result.run],
      generated_tests: [...graph.generated_tests, ...result.generated_tests],
      updated_at: deps.clock()
    };
    saveGraph(paths.graphPath, next);
    // Keep the behavior report in sync with the freshly persisted generated
    // tests — analyze/start would REBUILD the graph and drop them, so this is
    // the only command that can surface them. Display-only refresh; a render
    // failure must never fail generate.
    try {
      opBehaviorCoverageHtml(root, `${WORKSPACE_DIR}/behavior-coverage.html`);
    } catch {
      /* best-effort report refresh */
    }
  }

  // Validate each test's grounding citations against the graph the tests cite.
  // This is the keyless grounding contract: provenance must be verifiable, and a
  // test that cites nothing resolvable is surfaced loudly, not returned as success.
  const { per_test, summary } = summarizeTestEvidence(graph, result.generated_tests);
  const warnings = [...result.warnings];
  if (summary.tests_without_validated_evidence > 0) {
    warnings.push(
      `${summary.tests_without_validated_evidence} generated test(s) cite no evidence that resolves to the local graph — provenance unverified.`
    );
  }

  return {
    run_id: result.run?.run_id ?? null,
    model_provider: provider.providerName,
    model_name: provider.modelName,
    generated_tests: result.generated_tests,
    evidence: per_test,
    evidence_summary: summary,
    missing_evidence: result.missing_evidence,
    warnings,
    wrote_repo_files: false
  };
}

/**
 * Run BOTH arms — prompt-only baseline vs Local KG (graph-grounded) — with the
 * SAME model and the SAME (kit default) system prompt via the single-call path, so
 * both arms emit runnable framework code (the only difference is KG injection).
 * Score them across four dimensions and return the side-by-side comparison.
 * Non-persisting testing view: it does not write generation runs into the graph.
 */
export async function opCompare(
  root: string,
  opts: GenerateOptions & ProviderOverride = {},
  deps: OperationDeps = defaultDeps()
): Promise<GenerateComparison> {
  const graph = loadGraph(workspacePaths(root).graphPath);
  const provider = resolveGenerationProvider(deps.env, opts);
  const ZERO: CompareDimensions = { completeness: 0, context_awareness: 0, accuracy: 0, domain_specificity: 0 };
  const ZERO_METRICS: CompareMetrics = {
    tests: 0,
    concrete_assertions_avg: 0,
    traceability_refs: 0,
    weak_evidence_disclosed: 0,
    smoke_only: 0
  };
  const emptyArm = (): GenerateComparisonArm => ({ generated_tests: [], missing_evidence: [], warnings: [], run_hints: [] });
  if (!provider) {
    return {
      model_provider: "none",
      model_name: "none",
      system_prompt_source: "kit_default",
      scoring_method: "heuristic",
      baseline: emptyArm(),
      grounded: emptyArm(),
      scores: { baseline: ZERO, grounded: ZERO },
      matrix: { baseline: ZERO_METRICS, grounded: ZERO_METRICS },
      warnings: [NO_PROVIDER_MESSAGE],
      wrote_repo_files: false
    };
  }
  const reader = fileReaderFor(graph.workspace.root);
  // Both arms use the SAME single-call generation with the SAME (kit) system
  // prompt; the ONLY difference is whether Local KG evidence is injected
  // (graph_grounded) vs not (raw_prompt). Both arms emit RUNNABLE framework code,
  // so a tester can run AND compare the actual scripts side by side.
  const shared = { target_ids: opts.target_ids, framework: opts.framework, limit: opts.limit };
  const baseline = await generateTests(graph, { ...shared, input_mode: "raw_prompt" }, provider, reader, deps.clock);
  const grounded = await generateTests(graph, { ...shared, input_mode: "graph_grounded", prompt_version: opts.prompt_version }, provider, reader, deps.clock);


  // Score holistically — the arms produce different test cases, so never per-test.
  // Use the LLM judge when a real model is configured; fall back to the deterministic
  // heuristic offline so the comparison still runs with no key.
  const oracle = buildOracle(graph);
  const haveTests = baseline.generated_tests.length > 0 || grounded.generated_tests.length > 0;
  const judged =
    provider.providerName !== "deterministic" && haveTests
      ? await judgeComparison(
          provider,
          buildJudgeContext(graph, grounded.generated_tests),
          baseline.generated_tests.map((t) => t.body).join("\n\n"),
          grounded.generated_tests.map((t) => t.body).join("\n\n")
        )
      : null;
  let scores: { baseline: CompareDimensions; grounded: CompareDimensions };
  let scoring_method: "llm_judge" | "heuristic";
  let rationale: string | undefined;
  if (judged) {
    scores = { baseline: judged.baseline, grounded: judged.grounded };
    scoring_method = "llm_judge";
    rationale = judged.rationale;
  } else {
    scores = {
      baseline: scoreArm(baseline.generated_tests, oracle),
      grounded: scoreArm(grounded.generated_tests, oracle)
    };
    scoring_method = "heuristic";
  }

  const matrix = {
    baseline: armMetrics(baseline.generated_tests, oracle),
    grounded: armMetrics(grounded.generated_tests, oracle)
  };

  return {
    model_provider: provider.providerName,
    model_name: provider.modelName,
    system_prompt_source: "kit_default",
    scoring_method,
    ...(rationale ? { rationale } : {}),
    baseline: {
      generated_tests: baseline.generated_tests,
      missing_evidence: baseline.missing_evidence,
      warnings: baseline.warnings,
      run_hints: runnableRunHintsFor(baseline.generated_tests, graph.workspace.root)
    },
    grounded: {
      generated_tests: grounded.generated_tests,
      missing_evidence: grounded.missing_evidence,
      warnings: grounded.warnings,
      run_hints: runnableRunHintsFor(grounded.generated_tests, graph.workspace.root)
    },
    scores,
    matrix,
    // Both arms share the same target-selection warnings (e.g. "no behavior
    // anchors"), so dedupe instead of emitting each one twice.
    warnings: [...new Set([...baseline.warnings, ...grounded.warnings])],
    wrote_repo_files: false
  };
}

/**
 * Write a fresh A/B comparison report (Markdown + JSON) into the workspace's
 * .orangepro/ dir. Overwritten on every run. Local testing artifact only — not the
 * evidence pack, never uploaded.
 */
export function writeCompareReport(
  root: string,
  cmp: GenerateComparison,
  deps: OperationDeps = defaultDeps()
): {
  report_path: string;
  report_json_path: string;
  local_kg_tests_path: string;
  baseline_tests_path: string;
  local_kg_json_path: string;
  baseline_json_path: string;
} {
  const dir = dirname(workspacePaths(root).graphPath);
  const now = deps.clock();
  // Per-arm extensions: an arm whose bodies carry JSX gets .tsx (JSX in .ts is a TS error).
  const fw = compareTestsFramework(cmp);
  const groundedExt = testsFileExt(fw, cmp.grounded.generated_tests.map((t) => t.body));
  const baselineExt = testsFileExt(fw, cmp.baseline.generated_tests.map((t) => t.body));
  const names = {
    localKgTests: testsArtifactName("compare-tests.local-kg", groundedExt),
    baselineTests: testsArtifactName("compare-tests.baseline", baselineExt),
    localKgJson: "compare-tests.local-kg.json",
    baselineJson: "compare-tests.baseline.json"
  };
  const report_path = join(dir, "compare-report.md");
  const report_json_path = join(dir, "compare-report.json");
  const local_kg_tests_path = join(dir, names.localKgTests);
  const baseline_tests_path = join(dir, names.baselineTests);
  const local_kg_json_path = join(dir, names.localKgJson);
  const baseline_json_path = join(dir, names.baselineJson);
  // Per-arm test files are the durable artifacts (run + compare each arm); the
  // Markdown report is a slim pointer + scores. Atomic writes so a background
  // poller reading these never sees a half-written file.
  writeFileAtomic(local_kg_tests_path, renderArmTestsFile(cmp, "grounded", now));
  writeFileAtomic(baseline_tests_path, renderArmTestsFile(cmp, "baseline", now));
  writeFileAtomic(local_kg_json_path, renderArmTestsJson(cmp, "grounded", now));
  writeFileAtomic(baseline_json_path, renderArmTestsJson(cmp, "baseline", now));
  writeFileAtomic(report_path, renderCompareReportMarkdown(cmp, now, names));
  writeFileAtomic(report_json_path, JSON.stringify(cmp, null, 2));
  return {
    report_path,
    report_json_path,
    local_kg_tests_path,
    baseline_tests_path,
    local_kg_json_path,
    baseline_json_path
  };
}

export function opExplain(root: string, testId: string): ExplainResult {
  return explainTest(loadGraph(workspacePaths(root).graphPath), testId);
}

export function opExport(
  root: string,
  outputPath: string,
  opts: { include_generated_bodies?: boolean; graph_html?: boolean } = {},
  deps: OperationDeps = defaultDeps()
): ExportResult {
  const graph = loadGraph(workspacePaths(root).graphPath);
  const score = scoreGraph(graph);
  const pack = buildPack(graph, score, { include_generated_bodies: opts.include_generated_bodies ?? false }, deps.clock);
  const validation = validatePack(pack);

  const packPath = resolve(root, outputPath);
  writeFileSync(packPath, JSON.stringify(pack, null, 2) + "\n", "utf8");

  const summaryPath = packPath.replace(/\.json$/i, "") + ".md";
  writeFileSync(summaryPath, packToMarkdown(pack, graph.analysis), "utf8");

  const result: ExportResult = { pack_path: packPath, summary_path: summaryPath, validation };
  if (opts.graph_html) {
    const htmlPath = packPath.replace(/\.json$/i, "") + ".html";
    writeFileSync(htmlPath, renderVizHtml(buildVizPayload(graph, score, loadLedger(root))), "utf8");
    result.graph_html_path = htmlPath;
  }
  return result;
}

/** Write the self-contained offline evidence-graph explorer (metadata only). */
export function opGraphHtml(root: string, outputPath = "orangepro-graph.html"): { graph_html_path: string } {
  const graph = loadGraph(workspacePaths(root).graphPath);
  const html = renderVizHtml(buildVizPayload(graph, scoreGraph(graph), loadLedger(root)));
  const htmlPath = resolve(root, outputPath);
  writeFileSync(htmlPath, html, "utf8");
  return { graph_html_path: htmlPath };
}

/** Write the self-contained offline behavior-coverage view (deterministic, metadata only). */
export function opBehaviorCoverageHtml(
  root: string,
  outputPath = "orangepro-behavior-coverage.html",
  dynamicProof?: DynamicProofReportInput
): { behavior_coverage_path: string } {
  const graph = loadGraph(workspacePaths(root).graphPath);
  // Standalone regens have no this-run outcome: fall back to the persisted
  // proof-attempts sidecar ONLY when it anchors to the current graph+commit
  // (stale evidence is dropped — fail closed; display copy only, no tier math).
  const dyn = dynamicProof ?? sidecarDynamicProof(root, graph);
  const html = renderBehaviorReport(buildBehaviorReportData(graph, loadLedger(root), { repoRoot: root, dynamicProof: dyn }));
  const htmlPath = resolve(root, outputPath);
  writeFileSync(htmlPath, html, "utf8");
  return { behavior_coverage_path: htmlPath };
}

/** Fresh-only sidecar view for report regens; unreadable or stale ⇒ undefined. */
function sidecarDynamicProof(root: string, graph: LocalGraph): DynamicProofReportInput | undefined {
  try {
    const attempts = loadProofAttempts(root);
    if (!attempts || !proofAttemptsFresh(attempts, graph)) return undefined;
    return {
      attempted: attempts.attempted,
      proven: attempts.proven,
      needsSetup: attempts.attempts
        .filter((a) => a.classification === "needs_setup")
        .map((a) => ({ category: a.category, reason: a.reason }))
    };
  } catch {
    return undefined;
  }
}

/** Phase 5.2 — write the human-readable COVERAGE_REPORT.md (3-file contract). */
export function opCoverageReport(root: string, outputPath = "COVERAGE_REPORT.md"): { coverage_report_path: string } {
  const graph = loadGraph(workspacePaths(root).graphPath);
  const reportPath = resolve(root, outputPath);
  writeFileSync(reportPath, renderCoverageReport(graph, loadLedger(root)), "utf8");
  return { coverage_report_path: reportPath };
}

export function opUpdate(
  root: string,
  opts: { force_full_rebuild?: boolean } = {},
  deps: OperationDeps = defaultDeps()
): UpdateResult {
  const paths = workspacePaths(root);
  if (!graphExists(root)) {
    opAnalyze(root, {}, deps);
    return { status: "rebuilt", changed_files: 0, updated_entities: 0, stale_generated_tests: 0, warnings: ["No graph existed; performed full analyze."] };
  }

  const old = loadGraph(paths.graphPath);
  const scanRoot = old.workspace.root;
  const current = scanFileEntries(scanRoot);
  const fresh = computeFreshness(old, current);

  if (opts.force_full_rebuild) {
    const summary = opAnalyze(root, { source: scanRoot }, deps);
    return { status: "rebuilt", changed_files: fresh.changed_files.length, updated_entities: summary.entities_count, stale_generated_tests: 0, warnings: summary.warnings };
  }

  if (fresh.changed_files.length === 0) {
    return { status: "fresh", changed_files: 0, updated_entities: 0, stale_generated_tests: 0, warnings: [] };
  }

  const next = incrementalMerge(
    scanRoot,
    old,
    fresh.changed_files,
    deps.clock(),
    maxFlowsFromEnv(deps.env),
    maxFilesFromEnv(deps.env),
    maxSymbolsFromEnv(deps.env)
  );
  saveGraph(paths.graphPath, next.graph);
  return {
    status: "updated",
    changed_files: fresh.changed_files.length,
    updated_entities: next.updated_entities,
    stale_generated_tests: next.stale_generated_tests,
    warnings: next.warnings
  };
}

function incrementalMerge(
  root: string,
  old: LocalGraph,
  changedFiles: string[],
  now: string,
  maxInferredFlows?: number,
  maxFiles?: number,
  maxSymbols?: number
): { graph: LocalGraph; updated_entities: number; stale_generated_tests: number; warnings: string[] } {
  const changed = new Set(changedFiles);
  // maxSymbols MUST match the analyze run: a lower cap here would drop live
  // exports beyond it from the fresh scan and mark them stale, silently
  // shrinking the denominator on every `opro update`.
  const freshFragment = analyzeRepo(root, { readContent: true, maxInferredFlows, maxFiles, maxSymbols });
  const enrichFragments = collectEnricherFragments(root, [], true);
  const repoScopeId = freshFragment.sources[0]?.source_scope_id;

  // Preserve enricher/manual nodes (non-analyzer); fully refresh analyzer nodes from fresh scan.
  const preservedNodes = old.nodes.filter((n) => n.provenance.source_scope_id !== repoScopeId);
  const freshExt = new Set(freshFragment.nodes.map((n) => n.external_id));
  const removedAnalyzer = old.nodes
    .filter((n) => n.provenance.source_scope_id === repoScopeId && !freshExt.has(n.external_id))
    .map((n) => ({ ...n, stale: true }));

  const nodes = dedupeNodesByExternalId([
    ...freshFragment.nodes,
    ...enrichFragments.flatMap((f) => f.nodes),
    ...preservedNodes,
    ...removedAnalyzer
  ]);

  const preservedEdges = old.edges.filter((e) => e.provenance.source_scope_id !== repoScopeId);
  const edges = dedupeById([...freshFragment.edges, ...enrichFragments.flatMap((f) => f.edges), ...preservedEdges]);
  const candidate_edges = dedupeById([
    ...freshFragment.candidate_edges,
    ...enrichFragments.flatMap((f) => f.candidate_edges),
    ...old.candidate_edges.filter((e) => e.provenance?.source_scope_id !== repoScopeId)
  ]);

  // Mark generated tests stale when their grounding touches a changed file.
  let staleCount = 0;
  const generated_tests = old.generated_tests.map((t) => {
    const touches = [...t.grounding.entity_ids, ...t.grounding.source_refs].some((ref) => changed.has(ref));
    if (touches && !t.stale) {
      staleCount++;
      return { ...t, stale: true };
    }
    return t;
  });

  const manifest = buildManifest(freshFragment.file_entries, readGitInfo(gitRunner(root)), now);
  const updatedEntities = freshFragment.nodes.filter((n) => {
    const ref = n.provenance.source_ref;
    return (ref && changed.has(ref)) || changed.has(n.external_id) || (typeof n.properties.file === "string" && changed.has(n.properties.file));
  }).length;

  const prunedEdges = pruneDanglingEdges(nodes, edges);
  const graph: LocalGraph = {
    ...old,
    updated_at: now,
    sources: [...freshFragment.sources, ...enrichFragments.flatMap((f) => f.sources)],
    nodes,
    edges: prunedEdges,
    candidate_edges: pruneDanglingEdges(nodes, candidate_edges),
    generated_tests,
    manifest,
    analysis: {
      ...freshFragment.analysis,
      denominator: denominatorComposition({ nodes }),
      confirmed_by_layer: confirmedCoverageByLayer({ nodes, edges: prunedEdges })
    }
  };
  return { graph, updated_entities: updatedEntities, stale_generated_tests: staleCount, warnings: freshFragment.warnings };
}

const NO_DIFF_GUIDANCE =
  "No changed files found. Run this on a feature branch, pass base_ref, or use the test-gaps tool for baseline opportunities (CLI: opro gaps; MCP: orangepro_find_test_gaps).";

const NO_CODE_CHANGES_GUIDANCE =
  "The diff vs the base ref only touched docs (.md/.txt/etc) — there is no code change to generate tests for. Generate without --base for baseline coverage, or use the test-gaps tool (CLI: opro gaps; MCP: orangepro_find_test_gaps).";

export interface DiffContext {
  status: ChangedStatus;
  base_ref: string;
  changed_files: string[];
  guidance?: string;
}

/**
 * Diff/PR tool-mode contract. Every tool that needs a real change set resolves
 * its diff context here. It NEVER throws and NEVER fabricates impact: when the
 * workspace is not a git repo, the base ref is missing, or there is no diff, it
 * returns a structured guidance status instead. Baseline tools must NOT call it.
 *
 * `base_ref` defaults to `main`. The diff runs from `git merge-base <base> HEAD`
 * to the working tree: the branch's own commits AND uncommitted edits, never
 * upstream churn on the base (falls back to the base tip when no merge-base
 * exists). This diff resolver is read-only: it does not write repo files or upload source.
 */
export function resolveDiffContext(graph: LocalGraph, baseRefInput?: string): DiffContext {
  const scanRoot = graph.workspace.root;
  const git = gitRunner(scanRoot);
  const explicitBase = (baseRefInput && baseRefInput.trim()) || "";
  let base_ref = explicitBase || "main";

  const insideWorkTree = git(["rev-parse", "--is-inside-work-tree"]);
  if (!insideWorkTree || insideWorkTree.trim() !== "true") {
    return {
      status: "not_a_git_repo",
      base_ref,
      changed_files: [],
      guidance:
        "Workspace is not a git repository, so there is no diff to analyze. Use the test-gaps tool for baseline opportunities on the current checkout (CLI: opro gaps; MCP: orangepro_find_test_gaps)."
    };
  }

  // No explicit base (e.g. bare diff / `--changed`): autodetect the default branch
  // so it works on master-default repos too, not just "main".
  if (!explicitBase) {
    for (const cand of ["main", "master"]) {
      if (git(["rev-parse", "--verify", "--quiet", `${cand}^{commit}`])) {
        base_ref = cand;
        break;
      }
    }
  }

  // Peel to a commit (^{commit}) so branches, tags, remotes, and shas all validate
  // uniformly (and annotated tags resolve to their commit). Injection-safe: git
  // args are passed as an array to execFileSync, never a shell string.
  const verified = git(["rev-parse", "--verify", "--quiet", `${base_ref}^{commit}`]);
  if (!verified) {
    return {
      status: "missing_base_ref",
      base_ref,
      changed_files: [],
      guidance: `Base ref '${base_ref}' was not found locally. Pass an existing local ref — a branch (try "master" if this repo does not use "main"), a tag, a commit sha, or a fetched remote like "origin/main" — or use the test-gaps tool for baseline opportunities (CLI: opro gaps; MCP: orangepro_find_test_gaps).`
    };
  }

  // Diff from the MERGE-BASE of base and HEAD to the working tree: the branch's
  // own changes (plus uncommitted edits), never upstream churn. Diffing the base
  // TIP directly counted every file changed ON the base since the branch point as
  // "changed" — on an active repo that flooded --pr targeting with upstream-
  // modified test files (Mattermost dogfood: 513 files / 243 tests reported for a
  // PR whose real diff was 5). Falls back to the base tip when merge-base is
  // unavailable (shallow clone, unrelated histories) — degraded, never fabricated.
  const mergeBase = git(["merge-base", base_ref, "HEAD"])?.trim();
  const diff = git(["diff", "--name-only", mergeBase || base_ref]) ?? "";
  const rules = loadIgnore(scanRoot);
  const allChanged = diff
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean)
    .filter((f) => !isPathIgnored(f, rules));

  if (allChanged.length === 0) {
    return { status: "no_diff", base_ref, changed_files: [], guidance: NO_DIFF_GUIDANCE };
  }

  // PR-scoped generation targets REAL code changes only: a docs-only diff
  // (README/.md/.txt/etc) has nothing to test. Drop role 'doc'; keep
  // code/test/config/other so the change set (and the area mapping) is not
  // inflated by documentation edits.
  const changed_files = allChanged.filter((f) => roleOf(f) !== "doc");
  if (changed_files.length === 0) {
    return { status: "no_code_changes", base_ref, changed_files: [], guidance: NO_CODE_CHANGES_GUIDANCE };
  }
  return { status: "ok", base_ref, changed_files };
}

export function opChanged(root: string, baseRef?: string): ChangedResult {
  const graph = loadGraph(workspacePaths(root).graphPath);
  const ctx = resolveDiffContext(graph, baseRef);
  if (ctx.status !== "ok") {
    return {
      status: ctx.status,
      base_ref: ctx.base_ref,
      changed_files: [],
      affected_behaviors: [],
      link_kinds: {},
      affected_tests: [],
      recommended_actions: [],
      guidance: ctx.guidance
    };
  }
  return changedImpact(graph, ctx.changed_files, ctx.base_ref);
}

export { redactSecrets };
