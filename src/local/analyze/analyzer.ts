import { readFileSync } from "node:fs";
import path from "node:path";
import { CandidateEdge, GraphEdge, GraphNode, LocalGraph, LOCAL_GRAPH_SCHEMA_VERSION, ManifestFileEntry, Provenance, SourceScope } from "../graph/ontology.js";
import { makeCandidateEdge, makeEdge, makeNode, makeProofEdges, makeTestCaseNode } from "../graph/factories.js";
import { hashString } from "../util/hash.js";
import { slugify } from "../util/ids.js";
import { loadIgnore, walkFilesWithMeta } from "../util/walk.js";
import { AnalyzeFragment } from "../types.js";
import { buildImportGraph, type GateMetrics } from "../resolve/importGraph.js";
import { walkBarrel } from "../resolve/barrelWalker.js";
import { resetResolverCaches } from "../resolve/resolver.js";
import { resetExportIndexCache } from "../resolve/exportIndex.js";
import {
  baseName,
  extOf,
  GENERATED_CODE_REASON,
  isGeneratedCode,
  isNonProductPath,
  NON_PRODUCT_REASON,
  isTestSupportPath,
  languageOf,
  manifestKindOf,
  roleOf
} from "./classify.js";
import { classifyTestLayer } from "./testLayer.js";
import { detectFromPackageJson, detectFrameworksFromManifest, detectManifestPackage, frameworkFromConfig } from "./frameworks.js";
import { extractSymbolsWithMeta, extractTestNames, MAX_SYMBOLS_PER_FILE, type SymbolExtraction } from "./symbols.js";
import { extractTreeSitterStructure, extractTreeSitterSymbols, treeSitterReady, treeSitterStatus, type TreeSitterStructure } from "./treeSitter/engine.js";
import { isTreeSitterLanguage } from "./treeSitter/languages.js";
import { conventionSibling, isConventionLanguage } from "./linkage/conventions.js";
import { isBoilerplateSymbol, BOILERPLATE_REASON } from "./boilerplate.js";
import {
  extractCalls,
  extractMedusaGeneratedServices,
  MEDUSA_GENERATED_METHOD_BASES,
  MEDUSA_INTERNAL_SERVICE_TYPE,
  medusaGeneratedMethodName,
  type MedusaGeneratedMethodBase,
  type MedusaGeneratedService,
  type RawCall
} from "./callGraph.js";
import { buildStructuralClusters } from "./clustering.js";
import { applyRuntimeCoverage } from "./coverage.js";
import { ParseCache } from "./parseCache.js";
import { rankRiskGaps } from "../score/risk.js";
import { extractBehaviorContracts, type BehaviorContract } from "./behaviorContracts.js";
import { enumerateFlows } from "../flows/flowWalker.js";

/**
 * Symbol extraction router. Non-TS languages use the language-agnostic tree-sitter
 * AST when their grammar has been preloaded; TS/JS stay on the TypeScript compiler
 * path. The regex extractors in symbols.ts remain only as a fallback for the rare
 * case where a tree-sitter grammar failed to preload — they are never the primary
 * path.
 */
function extractFileSymbols(content: string, language: string): SymbolExtraction {
  if (isTreeSitterLanguage(language) && treeSitterReady(language)) {
    return extractTreeSitterSymbols(content, language);
  }
  return extractSymbolsWithMeta(content, language);
}

/**
 * The extractor backend used for `language` RIGHT NOW — part of the parse-cache key
 * so a regex-fallback result (computed before a grammar was preloaded) can never be
 * served once tree-sitter becomes ready: the key flips `rx` -> `ts`, forcing a fresh
 * AST extraction instead of persisting a shallow denominator.
 */
function extractionBackend(language: string): string {
  if (!isTreeSitterLanguage(language)) return "tsc"; // TS/JS compiler path (or unextracted)
  return treeSitterReady(language) ? "ts" : "rx"; // tree-sitter AST vs regex fallback
}
import { ResolverCache } from "../resolve/resolverCache.js";
import { runConfirmer, type ConfirmCandidate } from "./confirm.js";

const DETECTOR = "repo_analyzer";
// Global ceiling on extracted code symbols. A SINGLE counter shared across the walk,
// so a low value lets whichever language is walked first (e.g. a Go `server/`) eat the
// whole budget and STARVE later dirs (the React/TS `webapp/` extracted 0 symbols on
// Mattermost). Set high enough that a large multi-language monorepo extracts every
// language's behavior surface; the per-file cap (symbols.ts MAX_SYMBOLS_PER_FILE) and
// the file-scan cap still bound the work. Override with ORANGEPRO_MAX_SYMBOLS.
const MAX_TOTAL_SYMBOLS = 50000;
const MAX_INFERRED_SERVICES = 30;
const DEFAULT_CONFIRM_RISK_SYMBOLS = 500;
/**
 * High default ceiling on inferred behavior anchors — a pathological-run guard,
 * not a tuning knob. Scan-all is the default; ORANGEPRO_MAX_FLOWS lowers it only
 * to bound an accidental huge run.
 */
const DEFAULT_MAX_INFERRED_FLOWS = 50_000;

const BEHAVIOR_SURFACE_PATH_RE =
  /(^|\/)(api|apis|routes?|router|controllers?|handlers?|jobs?|workers?|queues?|processors?|resolvers?|commands?|cmd|webhooks?|listeners?|subscribers?|consumers?)(\/|$)/i;
const BEHAVIOR_SERVICE_PATH_RE = /(^|\/)(services?|svc)(\/|$)|(^|\/)[^/]*service\.[^.\/]+$/i;
const BEHAVIOR_SURFACE_FILE_RE =
  /(^|\/)[^/]*(api|controller|service|handler|resolver|processor|job|worker|queue|consumer|subscriber|listener|command|gateway|route|router)\.[^.\/]+$/i;
const BEHAVIOR_SURFACE_NAME_RE =
  /(^|[.#])(__init__|handle|handler|route|controller|service|resolver|processor|job|worker|queue|consumer|subscriber|listener|command|gateway|execute|process|consume|dispatch|schedule|upload|download|sync|checkout|charge|refund|capture|authorize|login|logout|register|find|search|list|create|update|delete|remove|archive|enable|disable|validate|get|add|sub|sum|total|save|load|render|run|main|root|child|mul|about|behavior)([A-Z0-9_]|$)/i;
const CLIENT_FACTORY_NAME_RE = /(^|[.#])get[A-Z0-9_].*Client$/;
const BEHAVIOR_OWNER_RE =
  /(Service|Controller|Resolver|Handler|Processor|Job|Worker|Queue|Consumer|Subscriber|Listener|Command|Gateway|Route|Router)$/;
const UTILITY_DIRECTORY_EXCLUDE_RE =
  /\/(utils?|helpers?|tools?|loaders?|dml|dal|orchestration|codemods?|oas|models?|migrations?|migration-scripts?|instrumentation|medusa-telemetry|medusa-test-utils|eslint-plugin)\//i;
const FRAMEWORK_INTERNAL_PATH_EXCLUDE_RE =
  /\/(http\/(?:routes-loader|routes-finder|routes-sorter|middlewares\/bodyparser)|medusa-app-loader|remote-query\/query)(?:\/|$)/i;
const CLI_PACKAGE_PATH_EXCLUDE_RE = /\/(?:cli\/[^/]+\/src\/(?:commands|core|reporter)|packages\/[^/]+\/src\/commands)\//i;
const BACKEND_RUNTIME_PATH_EXCLUDE_RE =
  /\/(?:packages\/core\/framework\/src|packages\/modules\/(?:workflow-engine-[^/]+|link-modules)\/src)(?:\/|$)/i;
const UI_PRODUCT_PATH_EXCLUDE_RE =
  /\/(?:packages\/admin\/(?:dashboard|admin-bundler|admin-vite-plugin)\/src|packages\/design-system\/(?:toolbox|icons)\/src|www\/(?:apps|packages)\/[^/]+\/(?:app|src|providers|components|lib))(?:\/|$)/i;
const SDK_CLIENT_PATH_EXCLUDE_RE = /\/(?:packages\/core\/js-sdk\/src|packages\/[^/]+\/(?:sdk|client)\/src)(?:\/|$)/i;
const PLUGIN_ADMIN_PATH_EXCLUDE_RE = /\/(?:plugins\/[^/]+\/src\/admin|admin\/routes)\//i;
const INFRA_METHOD_SUFFIX_RE =
  /^get[A-Z0-9_].*(Identifier|RegistrationKey|Config|Registry|Options|Settings|Path|Directory|TmpDir|Program|PackageManager|Command|Expression|Recommendation|CircularReferences|PivotTableName|PropertyName|PropertyKey|UnderlyingType|ComputedColumnRegistry|EntityOverrideRegistry|InverseRegistry|RelativeDate|SelectsAndRelations|SetDifference|ResolvedPlugins|Token|Scope|Module|Column|Pivot|Ttl|Timeout|Interval|Size|Limit|Offset|Prefix|Suffix|Pattern|Handler|Resource)$/;
const BUILD_BOOTSTRAP_PREFIX_RE =
  /^(load|build|compile)(Modules?|Routes?|Routers?|Plugins?|Config|Schema|Program|Package|Project|Files?|Commands?|Migrations?|Definitions?|Manifest|Artifacts?)([A-Z0-9_]|$)/;
// NOTE: the broad `.*Provider.*Service` clause was removed — it over-excluded FUNCTIONAL provider
// services (PaymentProviderService, TaxProviderService, FulfillmentProviderService,
// NotificationProviderService, AuthProviderService) that own real behaviors (capturePayment,
// getTaxLines, createFulfillment, ...). Genuine infra providers (CacheProviderService) are already
// caught by the `(Cache|...).*Service` clause. Add explicit infra prefixes here if a new infra
// provider is missed — never a `.*Provider.*` catch-all.
// QueryBuilder anchored at ^ matches QueryBuilder*Service (a query-builder is infra by definition,
// so ALL its methods — buildQuery/buildResponse/compileExpression/buildWhere/... — are plumbing) but
// NOT functional OrderBuilderService/QuoteService (they don't start with "QueryBuilder"). This is the
// owner-level fix for the buildQuery leak — strictly narrower than a forbidden `.*Builder.*Service`.
const INFRA_SERVICE_NAME_RE =
  /^(?:(InMemory|Redis|Pg|Mongo|Mikro|TypeOrm|Knex).*Service|(Cache|Caching|EventBus|JobScheduler|RemoteQuery|Index|Search|QueryBuilder).*Service)$/;
const FRAMEWORK_HOOK_METHOD_RE = /^__(joinerConfig|hooks|definition)$/;

function handlerSymbolCandidates(contract: BehaviorContract): string[] {
  if (!contract.handler) return [];
  if (contract.controller) {
    return [`${contract.controller}.${contract.handler}`];
  }
  return [contract.handler];
}

function behaviorSurfaceExclusionReason(relPath: string, name: string, memberOf?: string): string | null {
  const path = `/${relPath.replace(/\\/g, "/")}`;
  const owner = memberOf || (name.includes(".") ? name.slice(0, name.indexOf(".")) : "");
  const methodName = name.includes(".") ? name.slice(name.lastIndexOf(".") + 1) : name;
  if (UTILITY_DIRECTORY_EXCLUDE_RE.test(path)) {
    return "Utility/model/tooling path — infrastructure plumbing, excluded from the behavior denominator.";
  }
  if (FRAMEWORK_INTERNAL_PATH_EXCLUDE_RE.test(path)) {
    return "Framework-internal route/query plumbing — excluded from the behavior denominator.";
  }
  if (CLI_PACKAGE_PATH_EXCLUDE_RE.test(path)) {
    return "CLI developer tooling path — excluded from the behavior denominator.";
  }
  if (BACKEND_RUNTIME_PATH_EXCLUDE_RE.test(path)) {
    return "Framework/runtime/link plumbing path — excluded from backend behavior denominator.";
  }
  if (UI_PRODUCT_PATH_EXCLUDE_RE.test(path)) {
    return "UI/docs/design-system path — excluded from backend behavior denominator.";
  }
  if (SDK_CLIENT_PATH_EXCLUDE_RE.test(path)) {
    return "SDK/client package path — excluded from backend behavior denominator.";
  }
  if (PLUGIN_ADMIN_PATH_EXCLUDE_RE.test(path)) {
    return "Plugin admin UI path — excluded from backend behavior denominator.";
  }
  if (FRAMEWORK_HOOK_METHOD_RE.test(methodName)) {
    return "Framework lifecycle hook — excluded from the behavior denominator.";
  }
  if (owner && INFRA_SERVICE_NAME_RE.test(owner)) {
    return `Method of infrastructure service ${owner} — excluded from the behavior denominator.`;
  }
  if (INFRA_METHOD_SUFFIX_RE.test(methodName)) {
    return "Infrastructure accessor/registry method — excluded from the behavior denominator.";
  }
  if (BUILD_BOOTSTRAP_PREFIX_RE.test(methodName)) {
    return "Framework/build bootstrap method — excluded from the behavior denominator.";
  }
  return null;
}

function behaviorSurfaceReason(relPath: string, name: string, memberOf?: string): string | null {
  const exclusionReason = behaviorSurfaceExclusionReason(relPath, name, memberOf);
  if (exclusionReason) return null;
  const owner = memberOf || (name.includes(".") ? name.slice(0, name.indexOf(".")) : "");
  const servicePath = BEHAVIOR_SERVICE_PATH_RE.test(relPath);
  if (BEHAVIOR_SURFACE_PATH_RE.test(relPath) || (BEHAVIOR_SURFACE_FILE_RE.test(relPath) && !servicePath)) {
    return "API/service/route/job-adjacent source path — countable behavior surface.";
  }
  if (owner && BEHAVIOR_OWNER_RE.test(owner)) {
    return `Method of ${owner} — service/API/job-adjacent behavior surface.`;
  }
  if (CLIENT_FACTORY_NAME_RE.test(name)) return null;
  if (servicePath && BEHAVIOR_SURFACE_NAME_RE.test(name)) {
    return "Service-adjacent behavior-like function — countable behavior surface.";
  }
  if (BEHAVIOR_SURFACE_NAME_RE.test(name)) {
    return "Handler/service/job-like symbol name — countable behavior surface.";
  }
  return null;
}

const FLOW_LINK_STOPWORDS = new Set([
  "test",
  "tests",
  "spec",
  "should",
  "works",
  "found",
  "from",
  "names",
  "behavior",
  "behaviors",
  "service",
  "controller",
  "handler",
  "route",
  "api",
  "src",
  "app"
]);

function textTokens(text: string): Set<string> {
  const spaced = text
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .filter((t) => t.length >= 3 && !FLOW_LINK_STOPWORDS.has(t));
  return new Set(spaced);
}

function tokenJaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const t of a) if (b.has(t)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

interface RiskScopedConfirmInput {
  candidates: ConfirmCandidate[];
  nodes: GraphNode[];
  edges: GraphEdge[];
  candidate_edges: CandidateEdge[];
  root: string;
  confirmBudget: number;
  riskSymbolLimit: number;
  eligibleSymbolsByFile: Map<string, string[]>;
}

function selectRiskScopedConfirmCandidates(input: RiskScopedConfirmInput): { candidates: ConfirmCandidate[]; riskSymbols: number; involvedFiles: number } {
  const graph: LocalGraph = {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: path.basename(input.root), root: input.root, root_hash: hashString(input.root), source_upload_policy: "metadata_only" },
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
    sources: [],
    nodes: input.nodes,
    edges: input.edges,
    candidate_edges: input.candidate_edges,
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: new Date(0).toISOString(), git: null, files: {} }
  };
  const ranked = rankRiskGaps(graph, { limit: input.riskSymbolLimit, repoRoot: input.root });
  const scoreBySymbol = new Map(ranked.map((gap, index) => [gap.id, { score: gap.risk_score, rank: index }]));
  const fileScore = new Map<string, { score: number; rank: number; symbols: number }>();
  for (const [file, names] of input.eligibleSymbolsByFile) {
    for (const name of names) {
      const risk = scoreBySymbol.get(`sym:${file}#${name}`);
      if (!risk) continue;
      const existing = fileScore.get(file);
      if (!existing || risk.score > existing.score || (risk.score === existing.score && risk.rank < existing.rank)) {
        fileScore.set(file, { ...risk, symbols: 1 });
      } else if (existing) {
        existing.symbols++;
      }
    }
  }
  const rankedCandidates = input.candidates
    .filter((candidate) => fileScore.has(candidate.implRel))
    .sort((a, b) => {
      const ar = fileScore.get(a.implRel);
      const br = fileScore.get(b.implRel);
      return (
        (br?.score ?? 0) - (ar?.score ?? 0) ||
        (ar?.rank ?? Number.MAX_SAFE_INTEGER) - (br?.rank ?? Number.MAX_SAFE_INTEGER) ||
        a.implRel.localeCompare(b.implRel) ||
        a.testRel.localeCompare(b.testRel)
      );
    });
  const selected: ConfirmCandidate[] = [];
  const involved = new Set<string>();
  for (const candidate of rankedCandidates) {
    const next = new Set(involved);
    next.add(candidate.testAbs);
    next.add(candidate.implAbs);
    if (next.size > input.confirmBudget) continue;
    selected.push(candidate);
    involved.clear();
    for (const file of next) involved.add(file);
  }
  const selectedFiles = new Set(selected.map((candidate) => candidate.implRel));
  let riskSymbols = 0;
  for (const file of selectedFiles) riskSymbols += fileScore.get(file)?.symbols ?? 0;
  return { candidates: selected, riskSymbols, involvedFiles: involved.size };
}

export interface AnalyzeOptions {
  /** Files whose content the analyzer may read for cheap symbol/framework metadata. */
  readContent?: boolean;
  /** Cap on inferred behavior anchors. Defaults to DEFAULT_MAX_INFERRED_FLOWS; lower to bound a run. */
  maxInferredFlows?: number;
  /** Cap on files scanned. Defaults to walk.ts DEFAULT_MAX_FILES; lower to bound a run. */
  maxFiles?: number;
  /** Cap on total extracted code symbols (the denominator's code surface). Defaults to MAX_TOTAL_SYMBOLS; raise on big monorepos. */
  maxSymbols?: number;
  /** Wall-clock budget (ms) for the per-file scan. When exceeded the scan stops and records
   *  not_analyzed_due_to_budget (a DISCLOSED partial — never silent). undefined = no budget. */
  maxAnalyzeMs?: number;
  /** Injectable monotonic clock (ms) for deterministic budget tests. Defaults to Date.now. */
  now?: () => number;
  /** Persistent parse cache (content-hash keyed). When provided, unchanged files reuse their
   *  parse outputs instead of re-running extraction. Hit-rate is recorded in analysis.parse_cache. */
  parseCache?: ParseCache;
  /** Persistent module-resolution cache (Phase 5.4.3). Reuses resolveModuleName results when
   *  the filesystem shape + config are unchanged. Hit-rate recorded in analysis.resolver_cache. */
  resolverCache?: ResolverCache;
}

/**
 * Build an OrangePro-shaped graph fragment from a local checkout/path.
 *
 * Fully deterministic and static — no LLM. Stores metadata only (paths, names,
 * hashes): file content is read in-process but never persisted.
 *
 * Node/property conventions (consumed by score, gaps, generation, pack):
 *  - File        properties: { language, role, test_layer? }
 *  - ConfigFile  properties: { role }
 *  - TestCase    external_id `test:<relPath>`; properties: { framework?, test_layer, file, test_names[] }
 *  - CodeSymbol  external_id `sym:<relPath>#<name>`; properties: { symbol_kind, file, start_line?, end_line? }
 *  - Framework   external_id `framework:<name>`; properties: { category, test_layer? }
 *  - Package     external_id `package:<name>`; properties: { ecosystem, dependencies[] }
 *  - Service     external_id `service:<area>` (inferred, weak); properties: { area, inferred_from }
 *  - UserFlow    external_id `flow:<slug>`  (inferred, weak); properties: { area, inferred_from, example_behaviors[] }
 */
export function analyzeRepo(root: string, opts: AnalyzeOptions = {}): AnalyzeFragment {
  // A long-lived process (MCP server) must never resolve with a stale tsconfig
  // or export surface: reset both resolve-layer caches at the start of every run.
  resetResolverCaches();
  resetExportIndexCache();
  const readContent = opts.readContent !== false;
  const maxFlows = Math.max(1, opts.maxInferredFlows ?? DEFAULT_MAX_INFERRED_FLOWS);
  const maxSymbols = Math.max(1, opts.maxSymbols ?? MAX_TOTAL_SYMBOLS);
  const ignore = loadIgnore(root);
  const { files, truncated: filesCapHit, max_files: maxFiles } = walkFilesWithMeta(root, ignore, { maxFiles: opts.maxFiles });
  const warnings: string[] = [];
  // Wall-clock budget for the per-file scan (DISCLOSED partial when hit; never silent).
  const now = opts.now ?? (() => Date.now());
  const scanStartMs = now();
  const budgetMs = opts.maxAnalyzeMs != null && opts.maxAnalyzeMs > 0 ? opts.maxAnalyzeMs : null;
  let filesProcessed = 0;
  let budgetStopped = false;

  const nodes: GraphNode[] = [];
  const edges: GraphEdge[] = [];
  const candidate_edges: CandidateEdge[] = [];
  const file_entries: Record<string, ManifestFileEntry> = {};

  const repoName = baseName(root) || "workspace";
  const repoScopeId = `repo:${slugify(repoName)}`;
  const combinedHash = hashString(files.map((f) => f.hash).sort().join("|"));
  const source: SourceScope = {
    source_scope_id: repoScopeId,
    source_system: "repo",
    source_type: "local_checkout",
    display_name: repoName,
    content_hash: combinedHash,
    metadata: { file_count: files.length, root_name: repoName }
  };

  const prov = (ref: string, quote_hash?: string): Provenance => ({
    source_scope_id: repoScopeId,
    source_ref: ref,
    quote_hash,
    detector: DETECTOR
  });

  // Root anchor.
  nodes.push(
    makeNode({
      kind: "TenantStub",
      external_id: "tenant:local",
      title: repoName,
      properties: { local_only: true },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: prov(repoScopeId)
    })
  );

  const frameworkIds = new Set<string>();
  const packageIds = new Set<string>();
  const serviceIds = new Set<string>();
  const flowIds = new Set<string>();
  let symbolCount = 0;
  let symbolCapHit = false;
  let symbolFilesTruncated = 0;
  let excludedBoilerplate = 0;
  // Phase 4 confirmer inputs: denominator-eligible exported symbol names per code
  // file, and every CodeSymbol external_id that made it into the graph (so a
  // confirmed-but-capped symbol downgrades instead of COVERS-ing the file).
  const eligibleSymbolsByFile = new Map<string, string[]>();
  // Proof-edge eligibility for non-TS languages. A hard TESTED_BY/COVERS proof edge is REAL
  // derivable evidence (a test the repo already runs), independent of the entry-point-adjacent
  // DENOMINATOR bar. It admits behavior-callable symbols that are `eligible` OR merely
  // `not_entry_point_adjacent` (e.g. a Formatter/Converter SPI method like PetTypeFormatter#print)
  // but still EXCLUDES infra plumbing (behaviorSurfaceExcluded) and boilerplate/generated. Used
  // only by the Go/Java/Python proof-target resolvers; `eligibleSymbolsByFile` (the denominator)
  // is unchanged, so this never widens the denominator.
  const proofEligibleSymbolsByFile = new Map<string, string[]>();
  const codeSymbolIds = new Set<string>();
  let testFiles = 0;
  let flowsTruncated = 0;
  let sawPythonTest = false;
  let pytestRef = "";
  // For linking each test file to its likely source sibling by basename stem.
  const codeFilesByStem = new Map<string, Array<{ relPath: string; dir: string }>>();
  // All scanned source-file relPaths — drives precise per-language convention
  // linkage (predict-and-verify a sibling path actually exists in scope).
  const codeFileSet = new Set<string>();
  const generatedCodeFiles = new Set<string>();
  const behaviorContractsByFramework = new Map<string, number>();
  const behaviorContractsByKind = new Map<string, number>();
  const behaviorContractsByFile = new Map<string, BehaviorContract[]>();
  let behaviorContractsTotal = 0;
  let behaviorContractsHandlerEdges = 0;
  const testFileStems: Array<{ relPath: string; stem: string; dir: string }> = [];
  // TS/JS test+code files fed to the import-graph resolver (Gate 1).
  const resolveFiles: Array<{ abs: string; rel: string; role: "test" | "source" }> = [];
  // Emitted CodeSymbol names per file — the call graph resolves callers/callees
  // ONLY to symbols that actually became nodes (the "known symbol" invariant).
  const symbolsByFile = new Map<string, Set<string>>();
  // Raw (caller, callee) call pairs per TS/JS code file, resolved after the
  // import graph is built (cross-file calls need its bindings + targets).
  const rawCallsByFile = new Map<string, RawCall[]>();
  const medusaGeneratedServicesByFile = new Map<string, MedusaGeneratedService[]>();
  // Raw imports/calls for tree-sitter languages. Edges are emitted only after
  // every CodeSymbol exists, so endpoints are known and ambiguity can underlink.
  const nonTsStructureByFile = new Map<string, { language: string; structure: TreeSitterStructure }>();
  const goTestStructureByFile = new Map<string, TreeSitterStructure>();
  const javaTestStructureByFile = new Map<string, TreeSitterStructure>();
  const pythonTestStructureByFile = new Map<string, TreeSitterStructure>();
  const goModulesByDir = new Map<string, string>();

  /** Human-readable feature name from a test/module file (drops test suffixes). */
  const featureName = (relPath: string): string => {
    const cleaned = baseName(relPath)
      .replace(/\.(test|spec)\.[a-z0-9]+$/i, "")
      .replace(/^test_/, "")
      .replace(/_test$/, "")
      .replace(/\.[a-z0-9]+$/i, "");
    const human = cleaned.replace(/[-_.]+/g, " ").trim();
    return human || "behaviors";
  };

  /** Bare module name (lowercased) used to match a test file to its source sibling. */
  const moduleStem = (relPath: string): string => {
    let s = baseName(relPath).replace(/\.[a-z0-9]+$/i, ""); // drop extension
    s = s.replace(/\.(test|spec)$/i, ""); // card.test -> card
    s = s.replace(/^test[_.]/i, ""); // test_card -> card
    s = s.replace(/[_.](test|spec)$/i, ""); // card_test -> card
    return s.toLowerCase();
  };
  const dirOf = (relPath: string): string => {
    const i = relPath.lastIndexOf("/");
    return i >= 0 ? relPath.slice(0, i) : "";
  };

  const readSafe = (absPath: string): string | null => {
    if (!readContent) return null;
    try {
      return readFileSync(absPath, "utf8");
    } catch {
      return null;
    }
  };
  const isNonProductFile = (relPath: string): boolean => isNonProductPath(relPath) || generatedCodeFiles.has(relPath);

  const addFramework = (name: string, category: "test" | "build" | "runtime", test_layer: string | undefined, ref: string): void => {
    const external_id = `framework:${name}`;
    if (!frameworkIds.has(external_id)) {
      frameworkIds.add(external_id);
      nodes.push(
        makeNode({
          kind: "Framework",
          external_id,
          title: name,
          properties: { category, ...(test_layer ? { test_layer } : {}) },
          evidence_strength: "hard",
          review_status: "auto_detected",
          confidence: 1,
          provenance: prov(ref)
        })
      );
    }
  };

  const topArea = (relPath: string): string => {
    const parts = relPath.split("/").filter(Boolean);
    const skip = new Set(["src", "app", "lib", "packages", "tests", "test", "e2e", "__tests__", "spec"]);
    for (const part of parts.slice(0, parts.length - 1)) {
      if (!skip.has(part.toLowerCase())) return part;
    }
    return parts.length > 1 ? parts[0] : "core";
  };

  // Per-directory evidence tally, to suggest non-evidence dirs for .orangeproignore.
  const dirTally = new Map<string, { other: number; useful: number }>();

  for (const file of files) {
    // Budget gate: stop the per-file scan once the wall-clock budget is exhausted. The
    // remaining files are recorded as not_analyzed_due_to_budget (disclosed partial).
    if (budgetMs != null && now() - scanStartMs >= budgetMs) {
      budgetStopped = true;
      break;
    }
    filesProcessed++;
    const role = roleOf(file.relPath);
    const dirKey = dirOf(file.relPath) || "(root)";
    const dt = dirTally.get(dirKey) ?? { other: 0, useful: 0 };
    if (role === "other") dt.other++;
    else dt.useful++;
    dirTally.set(dirKey, dt);
    file_entries[file.relPath] = { hash: file.hash, size: file.size, kind: manifestKindOf(file.relPath) };
    const base = baseName(file.relPath);

    // conftest.py is a strong pytest signal even though it is not a test file.
    if (base === "conftest.py") {
      sawPythonTest = true;
      pytestRef = pytestRef || file.relPath;
    }

    if (role === "config") {
      nodes.push(
        makeNode({
          kind: "ConfigFile",
          external_id: file.relPath,
          title: base,
          properties: { role: "config" },
          evidence_strength: "hard",
          review_status: "auto_detected",
          confidence: 1,
          provenance: prov(file.relPath),
          content_hash: file.hash
        })
      );

      const fwFromConfig = frameworkFromConfig(file.relPath);
      if (fwFromConfig) {
        addFramework(fwFromConfig.name, fwFromConfig.category, fwFromConfig.test_layer, file.relPath);
        edges.push(
          makeEdge({
            from_external_id: `framework:${fwFromConfig.name}`,
            to_external_id: file.relPath,
            relationship_type: "CONFIGURED_BY",
            evidence_strength: "hard",
            review_status: "auto_detected",
            provenance: prov(file.relPath)
          })
        );
      }

      const content = readSafe(file.absPath);
      if (content && base === "package.json") {
        const { pkg, frameworks } = detectFromPackageJson(file.relPath, content);
        if (pkg && !packageIds.has(`package:${pkg.name}`)) {
          packageIds.add(`package:${pkg.name}`);
          nodes.push(
            makeNode({
              kind: "Package",
              external_id: `package:${pkg.name}`,
              title: pkg.name,
              properties: { ecosystem: pkg.ecosystem, dependencies: pkg.dependencies },
              evidence_strength: "hard",
              review_status: "auto_detected",
              confidence: 1,
              provenance: prov(file.relPath)
            })
          );
        }
        for (const fw of frameworks) addFramework(fw.name, fw.category, fw.test_layer, file.relPath);
      } else if (content) {
        if (base === "go.mod") {
          const m = content.match(/^\s*module\s+(\S+)/m);
          if (m) goModulesByDir.set(dirOf(file.relPath), m[1]);
        }
        const pkg = detectManifestPackage(file.relPath, content);
        if (pkg && !packageIds.has(`package:${pkg.name}`)) {
          packageIds.add(`package:${pkg.name}`);
          nodes.push(
            makeNode({
              kind: "Package",
              external_id: `package:${pkg.name}`,
              title: pkg.name,
              properties: { ecosystem: pkg.ecosystem, dependencies: pkg.dependencies },
              evidence_strength: "hard",
              review_status: "auto_detected",
              confidence: 1,
              provenance: prov(file.relPath)
            })
          );
        }
        for (const fw of detectFrameworksFromManifest(file.relPath, content)) {
          addFramework(fw.name, fw.category, fw.test_layer, file.relPath);
          if (fw.name === "pytest") pytestRef = pytestRef || file.relPath;
        }
      }
      continue;
    }

    // Container File node for code/test/doc roles.
    const language = languageOf(file.relPath);
    nodes.push(
      makeNode({
        kind: "File",
        external_id: file.relPath,
        title: base,
        properties: { language, role },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: prov(file.relPath),
        content_hash: file.hash
      })
    );

    if ((role === "test" || role === "code") && (language === "typescript" || language === "javascript")) {
      resolveFiles.push({ abs: file.absPath, rel: file.relPath, role: role === "test" ? "test" : "source" });
    }

    if (role === "test") {
      testFiles++;
      testFileStems.push({ relPath: file.relPath, stem: moduleStem(file.relPath), dir: dirOf(file.relPath) });
      if (extOf(file.relPath) === "py") {
        sawPythonTest = true;
        pytestRef = pytestRef || file.relPath;
      }
      const content = readSafe(file.absPath);
      const { layer, confidence: layerConfidence, signals: layerSignals } = classifyTestLayer(file.relPath, content);
      const testNames = content
        ? opts.parseCache
          ? opts.parseCache.testNames(file.hash, () => extractTestNames(content))
          : extractTestNames(content)
        : [];
      const testExternalId = `test:${file.relPath}`;
      nodes.push(
        makeTestCaseNode({
          testRel: file.relPath,
          title: base,
          testLayer: layer,
          layerConfidence,
          layerSignals,
          testNames,
          provenance: prov(file.relPath, content ? hashString(testNames.join("\n")) : undefined),
          contentHash: file.hash
        })
      );
      edges.push(
        makeEdge({
          from_external_id: testExternalId,
          to_external_id: file.relPath,
          relationship_type: "DEFINED_IN",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: prov(file.relPath)
        })
      );

      if (language === "go" && content && treeSitterReady("go")) {
        goTestStructureByFile.set(file.relPath, extractTreeSitterStructure(content, "go"));
      }
      if (language === "java" && content && treeSitterReady("java")) {
        javaTestStructureByFile.set(file.relPath, extractTreeSitterStructure(content, "java"));
      }
      if (language === "python" && content && treeSitterReady("python")) {
        pythonTestStructureByFile.set(file.relPath, extractTreeSitterStructure(content, "python"));
      }

      // Inferred behavior anchor (weak) grounded in real test names.
      if (testNames.length > 0) {
        const area = topArea(file.relPath);
        const flowId = `flow:${slugify(area + "-" + base)}`;
        if (!flowIds.has(flowId)) {
          if (flowIds.size >= maxFlows) {
            flowsTruncated++;
          } else {
            flowIds.add(flowId);
            const feature = featureName(file.relPath);
            const title = `${feature.charAt(0).toUpperCase()}${feature.slice(1)} (found from test names)`;
            nodes.push(
              makeNode({
                kind: "UserFlow",
                external_id: flowId,
                title,
                properties: { area, feature, inferred_from: "test_describe", example_behaviors: testNames.slice(0, 6), priority: "unknown" },
                evidence_strength: "weak",
                review_status: "inferred",
                confidence: 0.35,
                provenance: prov(file.relPath, hashString(testNames.join("\n"))),
                behavior_source: "test_inferred",
                denominator_eligible: false,
                denominator_reason: "Inferred from test names — a test cannot witness its own requirement."
              })
            );
            candidate_edges.push(
              makeCandidateEdge({
                from_external_id: flowId,
                to_external_id: testExternalId,
                relationship_type: "MAY_BE_TESTED_BY",
                evidence_strength: "weak",
                reason: "Behavior anchor inferred from test names in this file",
                confidence: 0.35,
                provenance: prov(file.relPath)
              })
            );
          }
        }
      }
    } else if (role === "code") {
      const stem = moduleStem(file.relPath);
      const entry = { relPath: file.relPath, dir: dirOf(file.relPath) };
      const list = codeFilesByStem.get(stem);
      if (list) list.push(entry);
      else codeFilesByStem.set(stem, [entry]);
      codeFileSet.add(file.relPath);

      const area = topArea(file.relPath);
      const serviceId = `service:${slugify(area)}`;
      if (!serviceIds.has(serviceId) && serviceIds.size < MAX_INFERRED_SERVICES && area !== "core") {
        serviceIds.add(serviceId);
        nodes.push(
          makeNode({
            kind: "Service",
            external_id: serviceId,
            title: area,
            properties: { area, inferred_from: "directory" },
            evidence_strength: "weak",
            review_status: "inferred",
            confidence: 0.3,
            provenance: prov(file.relPath)
          })
        );
      }

      const content = readSafe(file.absPath);
      const isGenerated = content ? isGeneratedCode(content) : false;
      if (isGenerated) generatedCodeFiles.add(file.relPath);
      if (content && (language === "typescript" || language === "javascript") && !isGenerated && !isNonProductPath(file.relPath)) {
        for (const contract of extractBehaviorContracts(content, file.relPath)) {
          if (behaviorSurfaceExclusionReason(file.relPath, contract.handler ?? contract.title)) continue;
          behaviorContractsTotal++;
          behaviorContractsByFramework.set(contract.framework, (behaviorContractsByFramework.get(contract.framework) ?? 0) + 1);
          behaviorContractsByKind.set(contract.kind, (behaviorContractsByKind.get(contract.kind) ?? 0) + 1);
          const contractsForFile = behaviorContractsByFile.get(file.relPath);
          if (contractsForFile) contractsForFile.push(contract);
          else behaviorContractsByFile.set(file.relPath, [contract]);
          nodes.push(
            makeNode({
              kind: "Endpoint",
              external_id: contract.id,
              title: contract.title,
              properties: {
                contract_kind: contract.kind,
                framework: contract.framework,
                method: contract.method,
                path: contract.path,
                file: contract.file,
                source: contract.source,
                ...(contract.handler ? { handler: contract.handler } : {}),
                ...(contract.controller ? { controller: contract.controller } : {})
              },
              evidence_strength: "hard",
              review_status: "auto_detected",
              confidence: 1,
              provenance: prov(file.relPath),
              behavior_source: "contract_entrypoint",
              denominator_eligible: false,
              denominator_reason: "Framework entrypoint contract discovered; tracked separately from the legacy CodeSymbol denominator in v1."
            })
          );
          edges.push(
            makeEdge({
              from_external_id: contract.id,
              to_external_id: file.relPath,
              relationship_type: "DEFINED_IN",
              evidence_strength: "hard",
              review_status: "auto_detected",
              provenance: prov(file.relPath)
            })
          );
        }
      }
      if (content && symbolCount >= maxSymbols && !symbolCapHit) {
        // The global cap can land exactly on a file boundary — the flag must
        // still flip, or every later file is skipped with zero disclosure.
        symbolCapHit = true;
        warnings.push(`Symbol extraction cap (${maxSymbols}) reached; some code symbols omitted. Raise ORANGEPRO_MAX_SYMBOLS to include them.`);
      }
      if (content && symbolCount < maxSymbols) {
        const extraction = opts.parseCache
          ? opts.parseCache.symbols(file.hash, `${language}#${extractionBackend(language)}`, () => extractFileSymbols(content, language))
          : extractFileSymbols(content, language);
        if (extraction.truncated) symbolFilesTruncated++;
        for (const sym of extraction.symbols) {
          if (symbolCount >= maxSymbols) {
            symbolCapHit = true;
            warnings.push(`Symbol extraction cap (${maxSymbols}) reached; some code symbols omitted. Raise ORANGEPRO_MAX_SYMBOLS to include them.`);
            break;
          }
          const symId = `sym:${file.relPath}#${sym.name}`;
          // Gate 3 eligibility: an export counts as a code-derived behavior only
          // when it is provably callable behavior surface — fn/class/method, or
          // a const the AST proved is a function. `.d.ts` declares types, not
          // behavior. (evidence is "hard" here by construction; role is "code"
          // because this whole branch is the code-file path.)
          const isDts = /\.d\.[cm]?ts$/.test(file.relPath);
          // Symbols in CI/test-infra paths are kept as nodes but excluded from the
          // behavior denominator (path-based; takes precedence over accessor rules).
          const isInfra = isNonProductPath(file.relPath);
          const isGeneratedSymbol = generatedCodeFiles.has(file.relPath);
          const callableKind =
            sym.symbol_kind === "function" || sym.symbol_kind === "class" || sym.symbol_kind === "method";
          const nonTsClassBehavior = sym.symbol_kind === "class" && language !== "typescript" && language !== "javascript";
          const behaviorCallableKind = sym.symbol_kind === "function" || sym.symbol_kind === "method" || sym.callable === true || nonTsClassBehavior;
          // Trivial accessors (Java getId/toString, Python __repr__) are real
          // symbols but carry no testable behavior — kept in the graph, dropped
          // from the denominator with disclosure so coverage is not under-claimed.
          const isBoilerplate =
            !isDts && !isInfra && !isGeneratedSymbol && callableKind && isBoilerplateSymbol(sym.name, language, sym.symbol_kind, sym.trivial_accessor);
          const callableBehaviorCandidate = !isDts && !isInfra && !isGeneratedSymbol && !isBoilerplate && behaviorCallableKind;
          const surfaceExclusionReason = callableBehaviorCandidate
            ? behaviorSurfaceExclusionReason(file.relPath, sym.name, sym.member_of)
            : null;
          const surfaceReason = nonTsClassBehavior
            ? "Non-TS class/constructor behavior surface — countable for language proof."
            : callableBehaviorCandidate && !surfaceExclusionReason
              ? behaviorSurfaceReason(file.relPath, sym.name, sym.member_of)
              : null;
          const eligible = callableBehaviorCandidate && surfaceReason !== null;
          const behaviorSurfaceExcluded = callableBehaviorCandidate && surfaceExclusionReason !== null;
          const notEntryPointAdjacent = callableBehaviorCandidate && !eligible && !behaviorSurfaceExcluded;
          if (isBoilerplate) excludedBoilerplate++;
          nodes.push(
            makeNode({
              kind: "CodeSymbol",
              external_id: symId,
              title: sym.name,
              properties: {
                symbol_kind: sym.symbol_kind,
                file: file.relPath,
                ...(sym.start_line ? { start_line: sym.start_line } : {}),
                ...(sym.end_line ? { end_line: sym.end_line } : {}),
                ...(sym.member_of ? { member_of: sym.member_of } : {}),
                ...(sym.callable !== undefined ? { callable_const: sym.callable } : {}),
                ...(surfaceReason ? { behavior_surface: "entrypoint_adjacent" } : {}),
                ...(behaviorSurfaceExcluded ? { denominator_reason_code: "infra_behavior_surface" } : {}),
                ...(notEntryPointAdjacent ? { denominator_reason_code: "not_entry_point_adjacent" } : {})
              },
              evidence_strength: "hard",
              review_status: "auto_detected",
              confidence: 1,
              provenance: prov(file.relPath),
              behavior_source: "code_export",
              denominator_eligible: eligible,
              denominator_reason: isDts
                ? "Type declaration (.d.ts/.d.mts/.d.cts) — no runtime behavior to test."
                : isInfra
                  ? NON_PRODUCT_REASON
                  : isGeneratedSymbol
                  ? GENERATED_CODE_REASON
                  : isBoilerplate
                  ? BOILERPLATE_REASON
                  : eligible && surfaceReason
                    ? surfaceReason
                    : behaviorSurfaceExcluded && surfaceExclusionReason
                      ? surfaceExclusionReason
                    : callableBehaviorCandidate
                      ? "Callable export is not API/service/route/job-adjacent — kept for grounding, excluded from the behavior denominator."
                      : sym.symbol_kind === "class"
                        ? "Exported class container — kept for grounding; methods/functions carry behavior in v1."
                        : "Exported const (not provably callable) — excluded from the denominator in v1."
            })
          );
          edges.push(
            makeEdge({
              from_external_id: symId,
              to_external_id: file.relPath,
              relationship_type: "DEFINED_IN",
              evidence_strength: "hard",
              review_status: "auto_detected",
              provenance: prov(file.relPath)
            })
          );
          codeSymbolIds.add(symId);
          const fileSyms = symbolsByFile.get(file.relPath);
          if (fileSyms) fileSyms.add(sym.name);
          else symbolsByFile.set(file.relPath, new Set([sym.name]));
          if (eligible) {
            const list = eligibleSymbolsByFile.get(file.relPath);
            if (list) list.push(sym.name);
            else eligibleSymbolsByFile.set(file.relPath, [sym.name]);
          }
          // Proof-edge eligibility: eligible OR not_entry_point_adjacent, but never infra
          // (behaviorSurfaceExcluded). Denominator-neutral — only the non-TS proof resolvers read it.
          if (eligible || notEntryPointAdjacent) {
            const list = proofEligibleSymbolsByFile.get(file.relPath);
            if (list) list.push(sym.name);
            else proofEligibleSymbolsByFile.set(file.relPath, [sym.name]);
          }
          symbolCount++;
        }
        const contractsForFile = behaviorContractsByFile.get(file.relPath) ?? [];
        const fileSymbols = symbolsByFile.get(file.relPath) ?? new Set<string>();
        for (const contract of contractsForFile) {
          const handlerName = handlerSymbolCandidates(contract).find((candidate) => fileSymbols.has(candidate));
          if (!handlerName) continue;
          const handlerId = `sym:${file.relPath}#${handlerName}`;
          if (!codeSymbolIds.has(handlerId)) continue;
          edges.push(
            makeEdge({
              from_external_id: contract.id,
              to_external_id: handlerId,
              relationship_type: "IMPLEMENTED_IN",
              evidence_strength: "hard",
              review_status: "auto_detected",
              provenance: prov(file.relPath)
            })
          );
          behaviorContractsHandlerEdges++;
        }
        // Call graph (TS/JS only): capture raw (caller, callee) pairs now while
        // the content is in hand; resolution to CodeSymbols runs after the import
        // graph is built (cross-file calls reuse its bindings + targets).
        // Skip non-product paths (test infra + .github CI) so the call graph
        // consumes only product behavior — same predicate that excludes those
        // symbols from the denominator.
        if ((language === "typescript" || language === "javascript") && !isNonProductFile(file.relPath)) {
          const tsx = /\.(tsx|jsx)$/.test(file.relPath);
          const calls = extractCalls(content, tsx);
          if (calls.length > 0) rawCallsByFile.set(file.relPath, calls);
          const generatedServices = extractMedusaGeneratedServices(content, tsx);
          if (generatedServices.length > 0) medusaGeneratedServicesByFile.set(file.relPath, generatedServices);
        } else if (isTreeSitterLanguage(language) && treeSitterReady(language) && !isNonProductFile(file.relPath)) {
          const structure = extractTreeSitterStructure(content, language);
          nonTsStructureByFile.set(file.relPath, { language, structure });
        }
      }
    }
  }

  const medusaGeneratedByClass = new Map<string, { rel: string; service: MedusaGeneratedService }>();
  const medusaServiceByRegistration = new Map<string, Array<{ rel: string; service: MedusaGeneratedService; modelKey: string }>>();
  const lowerCaseFirst = (value: string): string => (value ? `${value[0].toLowerCase()}${value.slice(1)}` : value);
  for (const [rel, services] of medusaGeneratedServicesByFile) {
    for (const service of services) {
      const classId = `sym:${rel}#${service.className}`;
      if (!codeSymbolIds.has(classId)) continue;
      medusaGeneratedByClass.set(`${rel}#${service.className}`, { rel, service });
      for (const modelKey of service.modelKeys) {
        const registration = `${lowerCaseFirst(modelKey)}Service`;
        const existing = medusaServiceByRegistration.get(registration);
        const item = { rel, service, modelKey };
        if (existing) existing.push(item);
        else medusaServiceByRegistration.set(registration, [item]);
      }
      for (const modelKey of service.modelKeys) {
        for (const method of MEDUSA_GENERATED_METHOD_BASES) {
          const methodName = medusaGeneratedMethodName(modelKey, method);
          const symbolName = `${service.className}.${methodName}`;
          const symId = `sym:${rel}#${symbolName}`;
          if (codeSymbolIds.has(symId)) continue;
          codeSymbolIds.add(symId);
          nodes.push(
            makeNode({
              kind: "CodeSymbol",
              external_id: symId,
              title: symbolName,
              properties: {
                symbol_kind: "GeneratedMethod",
                file: rel,
                member_of: service.className,
                method_base: method,
                model_key: modelKey,
                origin: "framework-derived",
                synthesized: true,
                framework: "medusa"
              },
              evidence_strength: "framework-derived",
              review_status: "auto_detected",
              confidence: 1,
              provenance: prov(rel),
              behavior_source: "code_export",
              denominator_eligible: false,
              denominator_reason: "Framework-derived Medusa service method — synthesized runtime method, excluded from the behavior denominator."
            })
          );
        }
      }
    }
  }

  // ---- Import graph (parse-only ts.resolveModuleName) — Gate 1 integration ----
  // (1) hard File->IMPORTS->File edges: a resolved internal import is a
  //     structural fact, not a guess;
  // (2) resolved test->source MAY_RELATE_TO candidates: the PRIMARY test<->source
  //     linkage, replacing the basename-stem guess. Still candidate (never proof):
  //     a resolved import proves the test file LOADS the module, not that it
  //     exercises + asserts a binding — that upgrade is the Phase-4 confirmer.
  //     Targets that are tests or test-support (mocks/fixtures/helpers) are
  //     excluded: exercising a helper is not coverage of production behavior.
  // (3) the per-axis resolver gate metrics, persisted with raw counts.
  // Tests with at least one RESOLVED internal runtime non-test import: the
  // resolver understood these files, so the stem fallback is suppressed even
  // when every target was support-filtered — a test that imports only helpers
  // must not get stem-linked to a module it never imports.
  const importResolvedTests = new Set<string>();
  let resolverMetrics: GateMetrics | undefined;
  if (readContent && resolveFiles.length > 0) {
    const relByAbs = new Map(resolveFiles.map((f) => [path.resolve(f.abs), f.rel]));
    const importGraph = buildImportGraph(
      resolveFiles.map((f) => ({ path: f.abs, role: f.role })),
      {
        repoRoot: root,
        resolverCache: opts.resolverCache,
        // Full walked set (incl. tsconfig/package.json/lockfiles + any extended JSON) drives
        // the resolver gate — a config edit anywhere must bust the cache (Codex 5.4.3).
        gateFiles: files.map((f) => path.resolve(root, f.relPath))
      }
    );
    resolverMetrics = importGraph.metrics;
    // Two independent dedups: a (type-only) import must still emit the IMPORTS
    // edge, while the SAME module pair reached later by a runtime import must
    // still produce the test->source linkage.
    const seenImports = new Set<string>();
    const seenTestLinks = new Set<string>();
    // Per-file import bindings (local name → {imported, target file+abs}).
    // Runtime bindings resolve direct calls; type bindings resolve injected-field
    // type annotations. Namespace imports (`* as ns`) are kept separately for
    // import-scoped `ns.method()` MAY_CALL resolution.
    const importBindingsByFile = new Map<string, Map<string, { imported: string; targetRel: string; targetAbs: string }>>();
    const typeBindingsByFile = new Map<string, Map<string, { imported: string; targetRel: string; targetAbs: string }>>();
    const namespaceBindingsByFile = new Map<string, Map<string, { targetRel: string; targetAbs: string }>>();
    for (const e of importGraph.edges) {
      if (!e.resolved || e.external || !e.target) continue;
      const fromRel = relByAbs.get(path.resolve(e.from));
      const targetRel = relByAbs.get(path.resolve(e.target));
      // Skip targets outside the scanned set (ignored/generated files): no node to link.
      if (!fromRel || !targetRel || fromRel === targetRel) continue;
      const targetAbs = path.resolve(e.target);
      for (const b of e.bindings) {
        if (e.importKind === "runtime") {
          if (b.imported === "*") {
            let ns = namespaceBindingsByFile.get(fromRel);
            if (!ns) namespaceBindingsByFile.set(fromRel, (ns = new Map()));
            if (!ns.has(b.local)) ns.set(b.local, { targetRel, targetAbs });
            continue;
          }
          let m = importBindingsByFile.get(fromRel);
          if (!m) importBindingsByFile.set(fromRel, (m = new Map()));
          if (!m.has(b.local)) m.set(b.local, { imported: b.imported, targetRel, targetAbs });
          continue;
        }
        if (b.imported === "*") continue;
        let tm = typeBindingsByFile.get(fromRel);
        if (!tm) typeBindingsByFile.set(fromRel, (tm = new Map()));
        if (!tm.has(b.local)) tm.set(b.local, { imported: b.imported, targetRel, targetAbs });
      }
      const pairKey = `${fromRel}|${targetRel}`;
      if (!seenImports.has(pairKey)) {
        seenImports.add(pairKey);
        edges.push(
          makeEdge({
            from_external_id: fromRel,
            to_external_id: targetRel,
            relationship_type: "IMPORTS",
            evidence_strength: "hard",
            review_status: "auto_detected",
            provenance: prov(fromRel)
          })
        );
      }
      if (e.fromRole === "test" && e.importKind === "runtime" && e.targetRole !== "test") {
        importResolvedTests.add(fromRel);
        if (!isTestSupportPath(targetRel) && !isNonProductFile(targetRel) && !seenTestLinks.has(pairKey)) {
          seenTestLinks.add(pairKey);
          candidate_edges.push(
            makeCandidateEdge({
              from_external_id: fromRel,
              to_external_id: targetRel,
              relationship_type: "MAY_RELATE_TO",
              evidence_strength: "candidate",
              reason: `Test resolved-imports this module ("${e.specifier}")`,
              confidence: 0.75,
              provenance: prov(fromRel)
            })
          );
        }
      }
    }
    const tts = importGraph.metrics.test_to_source;
    if (tts.n > 0 && tts.resolved / tts.n < 0.8) {
      warnings.push(
        `Static confirmation is not defensible for this scope (test->source resolution ${tts.pct}% < 80%); structural test<->source linkage is reported per-link only.`
      );
    }

    // ---- Call graph (Layer 1): symbol→symbol CALLS + MAY_CALL edges ----
    // STRUCTURAL CONTEXT ONLY — never coverage evidence, never fed to the
    // confirmer/denominator. Every endpoint is a KNOWN emitted CodeSymbol.
    //   hard CALLS (exact, no guessing):
    //     - free `bar()`      → same-file symbol, else an import-resolved binding
    //                            whose target file actually defines that name;
    //     - `this.bar()`      → a member of the caller's own class, same file;
    //     - `C.bar()` static  → a member of the same-file class `C`.
    //   candidate MAY_CALL (heuristic hint, tiered confidence, ambiguity → none):
    //     - 0.65 `obj.method()` → the ONLY emitted `*.method` member in the repo;
    //     - 0.55 `ns.method()`  → an export reachable from the namespace-imported module;
    //     - 0.45 `foo()`        → a barrel terminal traced by the resolver/export index.
    const seenCalls = new Set<string>();
    const seenFrameworkDerivedCalls = new Set<string>();
    const seenMay = new Set<string>();
    const emitCall = (callerId: string, calleeId: string, fromRel: string, callVia: string, resolution: string): void => {
      if (callerId === calleeId) return; // skip self-recursion edges
      const key = `${callerId}|${calleeId}`;
      if (seenCalls.has(key)) return;
      seenCalls.add(key);
      edges.push(
        makeEdge({
          from_external_id: callerId,
          to_external_id: calleeId,
          relationship_type: "CALLS",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: prov(fromRel),
          properties: {
            call_via: callVia,
            resolution
          }
        })
      );
    };
    const emitFrameworkDerivedCall = (
      callerId: string,
      calleeId: string,
      fromRel: string,
      resolution: string,
      modelKey: string,
      methodBase: string
    ): void => {
      if (callerId === calleeId || !codeSymbolIds.has(callerId) || !codeSymbolIds.has(calleeId)) return;
      const key = `${callerId}|${calleeId}`;
      if (seenCalls.has(key) || seenFrameworkDerivedCalls.has(key)) return;
      seenFrameworkDerivedCalls.add(key);
      edges.push(
        makeEdge({
          from_external_id: callerId,
          to_external_id: calleeId,
          relationship_type: "CALLS",
          evidence_strength: "framework-derived",
          review_status: "auto_detected",
          provenance: prov(fromRel),
          properties: {
            call_via: "framework-derived",
            origin: "medusa-generated-service",
            resolution,
            model_key: modelKey,
            method_base: methodBase
          }
        })
      );
    };
    // Heuristic edges are accumulated, then emitted AFTER all exact CALLS so an
    // exact pair always wins (a pair that is both stays hard, never duplicated).
    const mayCandidates: Array<{ callerId: string; calleeId: string; fromRel: string; confidence: number; reason: string }> = [];
    const queueMay = (callerId: string, calleeId: string, fromRel: string, confidence: number, reason: string): void => {
      if (callerId === calleeId) return;
      mayCandidates.push({ callerId, calleeId, fromRel, confidence, reason });
    };

    // Global index of emitted PRODUCT member methods by unqualified name — drives
    // the 0.65 unique-member tier (exactly one candidate, else no edge).
    const membersByMethod = new Map<string, string[]>();
    for (const n of nodes) {
      if (n.kind !== "CodeSymbol" || typeof n.properties.member_of !== "string") continue;
      const f = n.properties.file;
        if (typeof f === "string" && isNonProductFile(f)) continue; // infra/generated targets excluded
      const title = n.title ?? "";
      const dot = title.indexOf(".");
      if (dot < 0) continue;
      const method = title.slice(dot + 1);
      const list = membersByMethod.get(method);
      if (list) list.push(n.external_id);
      else membersByMethod.set(method, [n.external_id]);
    }
    // Resolve `name` exported from a (possibly barrel) module to an emitted,
    // non-infra terminal symbol id, or null. Direct local definition first,
    // else a deterministic resolver-backed barrel walk.
    const resolveModuleExport = (targetRel: string, targetAbs: string, name: string): string | null => {
    if (symbolsByFile.get(targetRel)?.has(name) && !isNonProductFile(targetRel)) return `sym:${targetRel}#${name}`;
      const w = walkBarrel(targetAbs, name);
      if (w.status !== "terminal" || !w.covered || !w.terminalFile || !w.terminalBinding) return null;
      const termRel = relByAbs.get(path.resolve(w.terminalFile));
    if (!termRel || isNonProductFile(termRel)) return null;
      return symbolsByFile.get(termRel)?.has(w.terminalBinding) ? `sym:${termRel}#${w.terminalBinding}` : null;
    };
    const resolveInjectedMember = (typeBinding: { imported: string; targetRel: string; targetAbs: string }, callee: string): { id: string; resolution: string } | null => {
      if (typeBinding.imported === "default" || typeBinding.imported === "*") return null;
      if (symbolsByFile.get(typeBinding.targetRel)?.has(typeBinding.imported) && !isNonProductFile(typeBinding.targetRel)) {
        const member = `${typeBinding.imported}.${callee}`;
        return symbolsByFile.get(typeBinding.targetRel)?.has(member) ? { id: `sym:${typeBinding.targetRel}#${member}`, resolution: "injected_import" } : null;
      }
      const w = walkBarrel(typeBinding.targetAbs, typeBinding.imported);
      if (w.status !== "terminal" || !w.covered || !w.terminalFile || !w.terminalBinding) return null;
      const termRel = relByAbs.get(path.resolve(w.terminalFile));
      if (!termRel || isNonProductFile(termRel)) return null;
      const member = `${w.terminalBinding}.${callee}`;
      return symbolsByFile.get(termRel)?.has(w.terminalBinding) && symbolsByFile.get(termRel)?.has(member) ? { id: `sym:${termRel}#${member}`, resolution: "injected_barrel" } : null;
    };

    for (const [rel, calls] of rawCallsByFile) {
      const localSyms = symbolsByFile.get(rel);
      if (!localSyms) continue; // file emitted no symbols → no caller can exist
      const imports = importBindingsByFile.get(rel);
      const typeImports = typeBindingsByFile.get(rel);
      const namespaces = namespaceBindingsByFile.get(rel);
      for (const c of calls) {
        if (!localSyms.has(c.caller)) continue; // caller must be an emitted symbol
        const callerId = `sym:${rel}#${c.caller}`;
        if (c.via === "free") {
          if (localSyms.has(c.callee)) {
            emitCall(callerId, `sym:${rel}#${c.callee}`, rel, "free", "same_file"); // same-file
          } else {
            const b = imports?.get(c.callee);
            if (!b) continue;
          if (symbolsByFile.get(b.targetRel)?.has(b.imported) && !isNonProductFile(b.targetRel)) {
              emitCall(callerId, `sym:${b.targetRel}#${b.imported}`, rel, "free", "import"); // exact: target defines it
            } else {
              // 0.45 — resolver-backed barrel terminal recovery.
              const w = walkBarrel(b.targetAbs, b.imported);
              if (w.status === "terminal" && w.covered && w.terminalFile && w.terminalBinding) {
                const termRel = relByAbs.get(path.resolve(w.terminalFile));
          if (termRel && !isNonProductFile(termRel) && symbolsByFile.get(termRel)?.has(w.terminalBinding)) {
                  queueMay(callerId, `sym:${termRel}#${w.terminalBinding}`, rel, 0.45, `Resolver-backed barrel MAY_CALL: call matched a terminal export through a barrel.`);
                }
              }
            }
          }
        } else if (c.via === "this") {
          const cls = c.caller.includes(".") ? c.caller.slice(0, c.caller.indexOf(".")) : "";
          if (cls) {
            const member = `${cls}.${c.callee}`;
            if (localSyms.has(member)) emitCall(callerId, `sym:${rel}#${member}`, rel, "this", "same_file");
          }
        } else if (c.via === "static" && c.qualifier) {
          const member = `${c.qualifier}.${c.callee}`;
          if (localSyms.has(c.qualifier) && localSyms.has(member)) {
            emitCall(callerId, `sym:${rel}#${member}`, rel, "static", "same_file"); // exact: same-file class member
          } else {
            const ns = namespaces?.get(c.qualifier);
            const qImport = imports?.get(c.qualifier);
            if (ns) {
              // 0.55 — import-scoped: ns.method() → an export of the imported module.
              const calleeId = resolveModuleExport(ns.targetRel, ns.targetAbs, c.callee);
              if (calleeId) queueMay(callerId, calleeId, rel, 0.55, `Import-scoped MAY_CALL: ns.method() matched an export reachable from the imported module.`);
            } else if (qImport) {
              // 0.65 — IMPORT-ANCHORED unique member: the qualifier is imported, and
              // the only emitted `*.method` member is DEFINED IN that imported module.
              // Anchoring to the import kills generic-name noise (a local `x.get()`
              // has no import binding for `x`, so it never reaches here).
              const cands = membersByMethod.get(c.callee);
              if (cands && cands.length === 1 && cands[0].slice(4, cands[0].indexOf("#")) === qImport.targetRel) {
                queueMay(callerId, cands[0], rel, 0.65, `Imported-binding member match: the qualifier is imported from the module defining the only *.method symbol.`);
              }
            }
            // A non-imported (local/param) qualifier is NOT anchored — no edge.
          }
        } else if (c.via === "injected" && c.injectedType) {
          const typeBinding = typeImports?.get(c.injectedType) ?? imports?.get(c.injectedType);
          if (typeBinding) {
            const targetMember = resolveInjectedMember(typeBinding, c.callee);
            if (targetMember) emitCall(callerId, targetMember.id, rel, "injected", targetMember.resolution);
            else {
              const direct = medusaGeneratedByClass.get(`${typeBinding.targetRel}#${typeBinding.imported}`);
              if (direct) {
                if (direct.service.methods.includes(c.callee)) {
                  const targetId = `sym:${direct.rel}#${direct.service.className}.${c.callee}`;
                  const match = direct.service.modelKeys.flatMap((modelKey) =>
                    MEDUSA_GENERATED_METHOD_BASES.map((base) => ({ modelKey, base, methodName: medusaGeneratedMethodName(modelKey, base) }))
                  ).find(({ methodName }) => methodName === c.callee);
                  if (match && codeSymbolIds.has(targetId)) {
                    emitFrameworkDerivedCall(callerId, targetId, rel, "medusa_concrete_generated_class", match.modelKey, match.base);
                  }
                } else if (MEDUSA_GENERATED_METHOD_BASES.includes(c.callee as MedusaGeneratedMethodBase)) {
                  const matches = direct.service.modelKeys
                    .map((modelKey) => ({
                      modelKey,
                      methodName: medusaGeneratedMethodName(modelKey, c.callee as MedusaGeneratedMethodBase)
                    }))
                    .filter(({ methodName }) => codeSymbolIds.has(`sym:${direct.rel}#${direct.service.className}.${methodName}`));
                  if (matches.length === 1) {
                    emitFrameworkDerivedCall(
                      callerId,
                      `sym:${direct.rel}#${direct.service.className}.${matches[0].methodName}`,
                      rel,
                      "medusa_concrete_generated_class",
                      matches[0].modelKey,
                      c.callee
                    );
                  }
                }
              }
            }
            continue;
          }
          const member = `${c.injectedType}.${c.callee}`;
          if (localSyms.has(c.injectedType) && localSyms.has(member)) {
            emitCall(callerId, `sym:${rel}#${member}`, rel, "injected", "same_file_type");
          } else if (c.injectedType === MEDUSA_INTERNAL_SERVICE_TYPE && MEDUSA_GENERATED_METHOD_BASES.includes(c.callee as MedusaGeneratedMethodBase) && c.qualifier) {
            const registration = c.qualifier.endsWith("_") ? c.qualifier.slice(0, -1) : c.qualifier;
            const matches = medusaServiceByRegistration.get(registration) ?? [];
            if (matches.length === 1) {
              const match = matches[0];
              const methodName = medusaGeneratedMethodName(match.modelKey, c.callee as MedusaGeneratedMethodBase);
              const targetId = `sym:${match.rel}#${match.service.className}.${methodName}`;
              if (codeSymbolIds.has(targetId)) {
                emitFrameworkDerivedCall(callerId, targetId, rel, "medusa_unique_registration", match.modelKey, c.callee);
              }
            }
          }
        }
      }
    }
    // Emit MAY_CALL — skip any pair already a hard CALLS, dedup among themselves.
    for (const m of mayCandidates) {
      const key = `${m.callerId}|${m.calleeId}`;
      if (seenCalls.has(key) || seenMay.has(key)) continue;
      seenMay.add(key);
      candidate_edges.push(
        makeCandidateEdge({
          from_external_id: m.callerId,
          to_external_id: m.calleeId,
          relationship_type: "MAY_CALL",
          evidence_strength: "weak",
          reason: m.reason,
          confidence: m.confidence,
          provenance: prov(m.fromRel)
        })
      );
    }
  }

  // ---- Non-TS structural imports/calls (Layer 1) ----
  // Tree-sitter languages do not feed the TS resolver/confirmer. These edges are
  // structural context only, emitted only when both endpoints are known and the
  // language convention resolves without ambiguity. Ambiguous modules underlink.
  let goProofConfirmedPairs = 0;
  let goProofAttempted = 0;
  let javaProofConfirmedPairs = 0;
  let javaProofAttempted = 0;
  let pythonProofConfirmedPairs = 0;
  let pythonProofAttempted = 0;
  if (nonTsStructureByFile.size > 0) {
    const nodeByExternalId = new Map(nodes.map((n) => [n.external_id, n]));
    const codeFilesByLanguage = new Map<string, Set<string>>();
    const javaClassByFqn = new Map<string, string>();
    const javaClassFilesByFqn = new Map<string, Set<string>>();
    const kotlinSymbolByFqn = new Map<string, Set<string>>();
    const phpClassByFqn = new Map<string, string>();
    const csharpFilesByNamespace = new Map<string, Set<string>>();
    const csharpClassByFqn = new Map<string, Set<string>>();
    const csharpUsingNamespacesByFile = new Map<string, Set<string>>();
    const rustModuleToFiles = new Map<string, Set<string>>();
    const pythonModuleToFiles = new Map<string, Set<string>>();
    const goFilesByDir = new Map<string, string[]>();
    const addMulti = <T>(map: Map<string, Set<T>>, key: string, value: T): void => {
      let set = map.get(key);
      if (!set) map.set(key, (set = new Set()));
      set.add(value);
    };
    const rustSourceRoots = files
      .filter((f) => /\.rs$/i.test(f.relPath) && (baseName(f.relPath) === "main.rs" || baseName(f.relPath) === "lib.rs"))
      .map((f) => dirOf(f.relPath))
      .sort((a, b) => b.length - a.length);
    const rustSourceRootFor = (rel: string): string | undefined => rustSourceRoots.find((r) => (r ? rel.startsWith(`${r}/`) : true));
    const rustModulePath = (sourceRoot: string, rel: string): string | null => {
      const moduleRel = sourceRoot ? rel.slice(sourceRoot.length + 1) : rel;
      const withoutExt = moduleRel.replace(/\.rs$/i, "");
      if (withoutExt === "lib" || withoutExt === "main") return "crate";
      if (withoutExt.endsWith("/mod")) {
        const parent = withoutExt.slice(0, -"/mod".length);
        return parent ? `crate.${parent.split("/").join(".")}` : "crate";
      }
      if (withoutExt) return `crate.${withoutExt.split("/").join(".")}`;
      return null;
    };
    const rustMapKey = (sourceRoot: string, modulePath: string): string => `${sourceRoot}\0${modulePath}`;
    const uniqueRustModuleTarget = (fromRel: string, modulePath: string): string | null => {
      const sourceRoot = rustSourceRootFor(fromRel);
      return sourceRoot === undefined ? null : uniqueMapTarget(rustModuleToFiles, rustMapKey(sourceRoot, modulePath));
    };
    for (const [rel, { language, structure }] of nonTsStructureByFile) {
      let byLang = codeFilesByLanguage.get(language);
      if (!byLang) codeFilesByLanguage.set(language, (byLang = new Set()));
      byLang.add(rel);
      if (language === "go") {
        const d = dirOf(rel);
        const list = goFilesByDir.get(d);
        if (list) list.push(rel);
        else goFilesByDir.set(d, [rel]);
      }
      if (language === "java" && structure.packageName) {
        for (const name of symbolsByFile.get(rel) ?? []) {
          const node = nodeByExternalId.get(`sym:${rel}#${name}`);
          if (node?.properties.symbol_kind === "class") {
            javaClassByFqn.set(`${structure.packageName}.${name}`, rel);
            addMulti(javaClassFilesByFqn, `${structure.packageName}.${name}`, rel);
          }
        }
      }
      if (language === "kotlin" && structure.packageName) {
        for (const name of structure.topLevelSymbols ?? []) {
          if (!symbolsByFile.get(rel)?.has(name)) continue;
          addMulti(kotlinSymbolByFqn, `${structure.packageName}.${name}`, rel);
        }
      }
      if (language === "php" && structure.moduleName) {
        for (const name of symbolsByFile.get(rel) ?? []) {
          const node = nodeByExternalId.get(`sym:${rel}#${name}`);
          if (node?.properties.symbol_kind === "class") phpClassByFqn.set(`${structure.moduleName}\\${name}`, rel);
        }
      }
      if (language === "csharp" && structure.moduleName) {
        addMulti(csharpFilesByNamespace, structure.moduleName, rel);
        for (const name of symbolsByFile.get(rel) ?? []) {
          const node = nodeByExternalId.get(`sym:${rel}#${name}`);
          if (node?.properties.symbol_kind === "class") addMulti(csharpClassByFqn, `${structure.moduleName}.${name}`, rel);
        }
      }
      if (language === "rust") {
        const sourceRoot = rustSourceRootFor(rel);
        const modulePath = sourceRoot === undefined ? null : rustModulePath(sourceRoot, rel);
        if (sourceRoot !== undefined && modulePath) addMulti(rustModuleToFiles, rustMapKey(sourceRoot, modulePath), rel);
      }
      if (language === "python") {
        const withoutExt = rel.replace(/\.py$/i, "");
        const parts = withoutExt.endsWith("/__init__") ? withoutExt.slice(0, -"/__init__".length).split("/") : withoutExt.split("/");
        for (let i = 0; i < parts.length; i++) {
          const mod = parts.slice(i).join(".");
          if (!mod) continue;
          let set = pythonModuleToFiles.get(mod);
          if (!set) pythonModuleToFiles.set(mod, (set = new Set()));
          set.add(rel);
        }
      }
    }

    type NonTsImportBinding = { targetRel?: string; targetDir?: string; imported?: string; kind: "module" | "named" };
    const importBindingsByFile = new Map<string, Map<string, NonTsImportBinding>>();
    const seenImports = new Set(edges.filter((e) => e.relationship_type === "IMPORTS").map((e) => `${e.from_external_id}|${e.to_external_id}`));
    const seenCalls = new Set(edges.filter((e) => e.relationship_type === "CALLS").map((e) => `${e.from_external_id}|${e.to_external_id}`));

    const emitImport = (fromRel: string, targetRel: string): void => {
      if (fromRel === targetRel || !codeFileSet.has(targetRel) || isNonProductFile(targetRel)) return;
      const key = `${fromRel}|${targetRel}`;
      if (seenImports.has(key)) return;
      seenImports.add(key);
      edges.push(
        makeEdge({
          from_external_id: fromRel,
          to_external_id: targetRel,
          relationship_type: "IMPORTS",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: prov(fromRel)
        })
      );
    };
    const emitCall = (callerId: string, calleeId: string, fromRel: string): void => {
      if (callerId === calleeId || !codeSymbolIds.has(callerId) || !codeSymbolIds.has(calleeId)) return;
      const key = `${callerId}|${calleeId}`;
      if (seenCalls.has(key)) return;
      seenCalls.add(key);
      edges.push(
        makeEdge({
          from_external_id: callerId,
          to_external_id: calleeId,
          relationship_type: "CALLS",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: prov(fromRel),
          properties: {
            call_via: "language_convention",
            resolution: "tree_sitter_exact"
          }
        })
      );
    };
    const addImportBinding = (
      fromRel: string,
      local: string,
      target: { targetRel?: string; targetDir?: string },
      imported: string | undefined,
      kind: "module" | "named"
    ): void => {
      let map = importBindingsByFile.get(fromRel);
      if (!map) importBindingsByFile.set(fromRel, (map = new Map()));
      if (!map.has(local)) map.set(local, { ...target, imported, kind });
    };
    const uniquePythonModule = (mod: string): string | null => {
      const set = pythonModuleToFiles.get(mod);
      return set?.size === 1 ? [...set][0] : null;
    };
    const resolveRelativePython = (fromRel: string, mod: string): string | null => {
      const m = mod.match(/^(\.+)(.*)$/);
      if (!m) return null;
      const up = m[1].length - 1;
      const tail = m[2].replace(/^\./, "").split(".").filter(Boolean);
      const base = dirOf(fromRel).split("/").filter(Boolean);
      if (up > base.length) return null;
      const parts = base.slice(0, base.length - up).concat(tail);
      const file = `${parts.join("/")}.py`;
      const init = `${parts.join("/")}/__init__.py`;
      if (codeFileSet.has(file)) return file;
      if (codeFileSet.has(init)) return init;
      return null;
    };
    const resolvePythonImport = (fromRel: string, mod: string): string | null => (mod.startsWith(".") ? resolveRelativePython(fromRel, mod) : uniquePythonModule(mod));
    const resolveRelativeModule = (fromRel: string, mod: string, exts: string[]): string | null => {
      const raw = mod.replace(/^\.\//, "");
      const base = path.posix.normalize(path.posix.join(dirOf(fromRel), raw));
      if (base.startsWith("../")) return null;
      for (const ext of exts) {
        const file = base.endsWith(ext) ? base : `${base}${ext}`;
        if (codeFileSet.has(file) && !isNonProductFile(file)) return file;
      }
      for (const ext of exts) {
        const file = `${base}/index${ext}`;
        if (codeFileSet.has(file) && !isNonProductFile(file)) return file;
      }
      return null;
    };
    const uniqueMapTarget = (map: Map<string, Set<string>>, key: string): string | null => {
      const matches = [...(map.get(key) ?? [])].filter((f) => !isNonProductFile(f));
      return matches.length === 1 ? matches[0] : null;
    };
    const symbolKind = (rel: string, name: string): unknown => nodeByExternalId.get(`sym:${rel}#${name}`)?.properties.symbol_kind;
    const guardedMemberTarget = (targetRel: string | undefined, className: string, methodName: string): string | null => {
      if (!targetRel || !symbolsByFile.get(targetRel)?.has(methodName)) return null;
      const classes = [...(symbolsByFile.get(targetRel) ?? [])].filter((name) => symbolKind(targetRel, name) === "class");
      if (classes.length !== 1 || classes[0] !== className) return null;
      return symbolKind(targetRel, methodName) === "method" ? targetRel : null;
    };
    const guardedCsharpMemberTarget = (fromRel: string, className: string, methodName: string): string | null => {
      const ownNamespace = nonTsStructureByFile.get(fromRel)?.structure.moduleName;
      const namespaces = new Set([...(ownNamespace ? [ownNamespace] : []), ...(csharpUsingNamespacesByFile.get(fromRel) ?? [])]);
      const matches = [...namespaces]
        .map((ns) => guardedMemberTarget(uniqueMapTarget(csharpClassByFqn, `${ns}.${className}`) ?? undefined, className, methodName))
        .filter((v): v is string => Boolean(v));
      return [...new Set(matches)].length === 1 ? matches[0] : null;
    };
    const resolveRustImport = (fromRel: string, mod: string): string | null => {
      if (mod.startsWith("./")) return resolveRelativeModule(fromRel, mod, [".rs"]);
      const target = uniqueRustModuleTarget(fromRel, mod);
      if (target) return target;
      const parts = mod.split(".").filter(Boolean);
      if (parts.length > 1) return uniqueRustModuleTarget(fromRel, parts.slice(0, -1).join("."));
      return null;
    };
    const goModuleForDir = (dir: string): { dir: string; module: string } | null => {
      for (;;) {
        const module = goModulesByDir.get(dir);
        if (module) return { dir, module };
        if (!dir) return null;
        dir = dirOf(dir);
      }
    };
    const goModuleForFile = (rel: string): { dir: string; module: string } | null => goModuleForDir(dirOf(rel));
    const resolveGoImportDir = (fromRel: string, mod: string): string | null => {
      const owner = goModuleForFile(fromRel);
      if (!owner || !mod.startsWith(`${owner.module}/`)) return null;
      const moduleRel = mod.slice(owner.module.length + 1);
      const dir = path.posix.normalize(owner.dir ? path.posix.join(owner.dir, moduleRel) : moduleRel);
      if (dir.startsWith("../") || (owner.dir && dir !== owner.dir && !dir.startsWith(`${owner.dir}/`))) return null;
      if (goModuleForDir(dir)?.module !== owner.module) return null;
      const filesInPackage = (goFilesByDir.get(dir) ?? []).filter((f) => !isNonProductFile(f));
      return filesInPackage.length > 0 ? dir : null;
    };
    const uniqueGoPackageSymbol = (dir: string, name: string): string | null => {
      const matches = (goFilesByDir.get(dir) ?? []).filter((f) => !isNonProductFile(f) && symbolsByFile.get(f)?.has(name));
      return matches.length === 1 ? matches[0] : null;
    };
    const eligibleGoSymbol = (targetRel: string | null, name: string): string | null => {
      if (!targetRel || !(proofEligibleSymbolsByFile.get(targetRel) ?? []).includes(name)) return null;
      const symId = `sym:${targetRel}#${name}`;
      return codeSymbolIds.has(symId) ? symId : null;
    };
    const eligiblePythonSymbol = (targetRel: string | null, name: string): string | null => {
      if (!targetRel || !(proofEligibleSymbolsByFile.get(targetRel) ?? []).includes(name)) return null;
      const symId = `sym:${targetRel}#${name}`;
      return codeSymbolIds.has(symId) ? symId : null;
    };
    const uniqueJavaClass = (packageName: string | undefined, className: string): string | null => {
      return packageName ? uniqueMapTarget(javaClassFilesByFqn, `${packageName}.${className}`) : null;
    };
    const javaClassDeclaresMethod = (targetRel: string, className: string, methodName: string): boolean => {
      return Boolean(nonTsStructureByFile.get(targetRel)?.structure.javaClasses?.some((c) => c.name === className && c.methods.includes(methodName)));
    };
    const eligibleJavaSymbol = (targetRel: string | null, name: string, expectedKind: "class" | "method"): string | null => {
      if (!targetRel || !(proofEligibleSymbolsByFile.get(targetRel) ?? []).includes(name)) return null;
      if (symbolKind(targetRel, name) !== expectedKind) return null;
      const symId = `sym:${targetRel}#${name}`;
      return codeSymbolIds.has(symId) ? symId : null;
    };
    const resolveGoProofTarget = (testRel: string, structure: TreeSitterStructure, qualifier: string | undefined, callee: string, shadowed: Set<string>): string | null => {
      if (!qualifier) {
        if (shadowed.has(callee) || structure.packageName?.endsWith("_test")) return null;
        return eligibleGoSymbol(uniqueGoPackageSymbol(dirOf(testRel), callee), callee);
      }
      const rootQualifier = qualifier.split(".")[0];
      if (shadowed.has(rootQualifier)) return null;
      const binding = structure.imports.find((i) => i.local === rootQualifier && i.kind === "module");
      const targetDir = binding ? resolveGoImportDir(testRel, binding.module) : null;
      return targetDir ? eligibleGoSymbol(uniqueGoPackageSymbol(targetDir, callee), callee) : null;
    };
    const resolveJavaProofTarget = (structure: TreeSitterStructure, proof: NonNullable<TreeSitterStructure["javaProofCalls"]>[number]): string | null => {
      if (new Set(proof.shadowed).has(proof.className)) return null;
      const targetRel = uniqueJavaClass(structure.packageName, proof.className);
      if (proof.target_kind === "constructor") return eligibleJavaSymbol(targetRel, proof.className, "class");
      if (!targetRel || !javaClassDeclaresMethod(targetRel, proof.className, proof.callee)) return null;
      return eligibleJavaSymbol(targetRel, proof.callee, "method");
    };
    const pythonQualifierRoot = (qualifier: string): string => /^([A-Za-z_]\w*)/.exec(qualifier.split(".")[0] ?? qualifier)?.[1] ?? qualifier;
    const pythonProofImportBinding = (
      testRel: string,
      structure: TreeSitterStructure,
      local: string
    ): { targetRel?: string; imported?: string; kind: "module" | "named" } | null | undefined => {
      const matches = structure.imports.filter((i) => i.local === local);
      if (matches.length === 0) return undefined;
      if (matches.length > 1) return null;
      const binding = matches[0];
      if (!binding) return null;
      const targetRel = resolvePythonImport(testRel, binding.module) ?? undefined;
      return { targetRel, imported: binding.imported, kind: binding.kind };
    };
    const resolvePythonProofTarget = (testRel: string, structure: TreeSitterStructure, qualifier: string | undefined, callee: string, shadowed: Set<string>): string | null => {
      const conv = conventionSibling(testRel, "python", codeFileSet);
      const conventionTargetRel = conv?.relPath && !isNonProductFile(conv.relPath) ? conv.relPath : null;
      const hasWildcardImport = structure.imports.some((i) => i.imported === "*");
      if (!qualifier) {
        if (shadowed.has(callee)) return null;
        const binding = pythonProofImportBinding(testRel, structure, callee);
        if (binding === null) return null;
        if (binding) {
          if (binding.kind !== "named" || !binding.targetRel || isNonProductFile(binding.targetRel) || binding.imported !== callee) return null;
          return eligiblePythonSymbol(binding.targetRel, callee);
        }
        if (!conventionTargetRel) return null;
        if (hasWildcardImport) return null;
        return eligiblePythonSymbol(conventionTargetRel, callee);
      }
      const rootQualifier = pythonQualifierRoot(qualifier);
      if (shadowed.has(rootQualifier)) return null;
      const binding = pythonProofImportBinding(testRel, structure, rootQualifier);
      if (binding === null) return null;
      if (binding?.kind === "module") {
        return binding.targetRel && !isNonProductFile(binding.targetRel) ? eligiblePythonSymbol(binding.targetRel, callee) : null;
      }
      const classTargetRel = binding?.kind === "named" ? binding.targetRel : conventionTargetRel;
      if (binding?.kind === "named" && (!classTargetRel || isNonProductFile(classTargetRel) || binding.imported !== rootQualifier)) return null;
      if (!classTargetRel || symbolKind(classTargetRel, rootQualifier) !== "class") return null;
      return eligiblePythonSymbol(classTargetRel, callee);
    };

    for (const [rel, { language, structure }] of nonTsStructureByFile) {
      for (const i of structure.imports) {
        let targetRel: string | null = null;
        let targetDir: string | null = null;
        if (language === "java") targetRel = javaClassByFqn.get(i.module) ?? null;
        else if (language === "python") targetRel = resolvePythonImport(rel, i.module);
        else if (language === "go") {
          targetDir = resolveGoImportDir(rel, i.module);
          const filesInPackage = targetDir ? (goFilesByDir.get(targetDir) ?? []).filter((f) => !isNonProductFile(f)) : [];
          targetRel = filesInPackage.length === 1 ? filesInPackage[0] : null;
        } else if (language === "ruby") targetRel = i.module.startsWith("./") ? resolveRelativeModule(rel, i.module, [".rb"]) : null;
        else if (language === "kotlin") targetRel = uniqueMapTarget(kotlinSymbolByFqn, i.module);
        else if (language === "rust") targetRel = resolveRustImport(rel, i.module);
        else if (language === "php") targetRel = phpClassByFqn.get(i.module) ?? null;
        else if (language === "csharp") {
          addMulti(csharpUsingNamespacesByFile, rel, i.module);
          targetRel = uniqueMapTarget(csharpFilesByNamespace, i.module);
        }
        else if (language === "c" || language === "cpp") targetRel = resolveRelativeModule(rel, i.module, [".h", ".hpp", ".hh", ".hxx", ".c", ".cc", ".cpp", ".cxx"]);
        if (!targetRel && !targetDir) continue;
        if (targetRel) emitImport(rel, targetRel);
        addImportBinding(rel, i.local, { ...(targetRel ? { targetRel } : {}), ...(targetDir ? { targetDir } : {}) }, i.imported, i.kind);
      }
    }
    for (const [rel, { language, structure }] of nonTsStructureByFile) {
      const localSyms = symbolsByFile.get(rel);
      if (!localSyms) continue;
      const imports = importBindingsByFile.get(rel);
      const sameFileKotlinTopLevelFunctions =
        language === "kotlin"
          ? new Set(
              (structure.topLevelSymbols ?? []).filter(
                (name) => nodeByExternalId.get(`sym:${rel}#${name}`)?.properties.symbol_kind === "function"
              )
            )
          : undefined;
      for (const c of structure.calls) {
        if (!localSyms.has(c.caller)) continue;
        const callerId = `sym:${rel}#${c.caller}`;
        const shadowed = new Set(c.shadowed);
        if (c.via === "free") {
          if (shadowed.has(c.callee)) continue;
          if (sameFileKotlinTopLevelFunctions?.has(c.callee)) {
            emitCall(callerId, `sym:${rel}#${c.callee}`, rel);
            continue;
          }
          if (language === "python" && localSyms.has(c.callee)) continue;
          const b = imports?.get(c.callee);
          if (language === "php" && b?.targetRel && b.imported && symbolKind(b.targetRel, b.imported) !== "function") continue;
          if (b?.kind === "named" && b.imported && b.targetRel && symbolsByFile.get(b.targetRel)?.has(b.imported)) {
            emitCall(callerId, `sym:${b.targetRel}#${b.imported}`, rel);
          }
        } else if (c.qualifier) {
          const rootQualifier = c.qualifier.split(".")[0];
          if (shadowed.has(rootQualifier)) continue;
          const b = imports?.get(rootQualifier);
          if (language === "go" && b?.kind === "module" && b.targetDir) {
            const targetRel = uniqueGoPackageSymbol(b.targetDir, c.callee);
            if (targetRel) emitCall(callerId, `sym:${targetRel}#${c.callee}`, rel);
          } else if (language === "rust") {
            const targetRel = uniqueRustModuleTarget(rel, c.qualifier) ?? (b?.kind === "module" ? b.targetRel : undefined);
            if (targetRel && symbolsByFile.get(targetRel)?.has(c.callee)) emitCall(callerId, `sym:${targetRel}#${c.callee}`, rel);
          } else if (language === "php" && b?.kind === "named") {
            const targetRel = guardedMemberTarget(b.targetRel, rootQualifier, c.callee);
            if (targetRel) emitCall(callerId, `sym:${targetRel}#${c.callee}`, rel);
          } else if (language === "csharp") {
            const targetRel = guardedCsharpMemberTarget(rel, rootQualifier, c.callee);
            if (targetRel) emitCall(callerId, `sym:${targetRel}#${c.callee}`, rel);
          } else if (b?.kind === "module" && b.targetRel && symbolsByFile.get(b.targetRel)?.has(c.callee)) {
            emitCall(callerId, `sym:${b.targetRel}#${c.callee}`, rel);
          } else if (language === "java" && b?.kind === "named" && b.targetRel && symbolsByFile.get(b.targetRel)?.has(c.callee)) {
            emitCall(callerId, `sym:${b.targetRel}#${c.callee}`, rel);
          }
        }
      }
    }
    const seenGoProof = new Set<string>();
    const proofVerifiedAt = scanStartMs;
    for (const [testRel, structure] of goTestStructureByFile) {
      const testExternalId = `test:${testRel}`;
      for (const proof of structure.goProofCalls ?? []) {
        goProofAttempted++;
        const symId = resolveGoProofTarget(testRel, structure, proof.qualifier, proof.callee, new Set(proof.shadowed));
        if (!symId) continue;
        const edgeKey = `${testExternalId}|${symId}`;
        if (seenGoProof.has(edgeKey)) continue;
        seenGoProof.add(edgeKey);
        goProofConfirmedPairs++;
        // `test_name` = the enclosing `func TestXxx` (or its literal-named subtest path,
        // `TestXxx/sub`) where the assertion witnessed the target. STRUCTURAL METADATA ONLY
        // (never proof) — it lets Go auto-drive pick the exact `go test -run` for THIS target
        // even when the file has many tests, where the file-level `test_names[]` cannot
        // disambiguate. Only `[A-Za-z0-9_]` path segments are accepted (defensive; the
        // extractor already drops runtime/unsafe subtest names to the bare parent).
        // `assertion_line` (Slice 2) = the 1-based test-source line of the assertion that
        // witnessed the target. STRUCTURAL METADATA ONLY — it lets the Go oracle bind a
        // runtime-named subtest's mutant failure to THIS exact assertion (a sibling subtest
        // asserting at a different line is refused). Emitted only alongside a valid test_name.
        const goEdgeProps = /^Test[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/.test(proof.testName)
          ? { test_name: proof.testName, ...(typeof proof.assertionLine === "number" ? { assertion_line: proof.assertionLine } : {}) }
          : undefined;
        edges.push(
          makeEdge({
            from_external_id: symId,
            to_external_id: testExternalId,
            relationship_type: "TESTED_BY",
            evidence_strength: "hard",
            review_status: "auto_detected",
            provenance: prov(testRel, hashString(`${symId}:${proof.assertion}`)),
            last_verified: proofVerifiedAt,
            ...(goEdgeProps ? { properties: goEdgeProps } : {})
          })
        );
        edges.push(
          makeEdge({
            from_external_id: testExternalId,
            to_external_id: symId,
            relationship_type: "COVERS",
            evidence_strength: "hard",
            review_status: "auto_detected",
            provenance: prov(testRel, hashString(`${symId}:${proof.assertion}`)),
            last_verified: proofVerifiedAt,
            ...(goEdgeProps ? { properties: goEdgeProps } : {})
          })
        );
      }
    }
    const seenJavaProof = new Set<string>();
    for (const [testRel, structure] of javaTestStructureByFile) {
      const testExternalId = `test:${testRel}`;
      for (const proof of structure.javaProofCalls ?? []) {
        javaProofAttempted++;
        const symId = resolveJavaProofTarget(structure, proof);
        if (!symId) continue;
        const edgeKey = `${testExternalId}|${symId}`;
        if (seenJavaProof.has(edgeKey)) continue;
        seenJavaProof.add(edgeKey);
        javaProofConfirmedPairs++;
        // `test_name` = the enclosing `@Test` method where the assertion witnessed the
        // target. STRUCTURAL METADATA ONLY (never proof) — it lets Java auto-drive pick
        // the exact `mvn test -Dtest=Class#method` for THIS target even when the test
        // class has many @Test methods, where the file-level `test_names[]` cannot
        // disambiguate. Only a plain Java identifier is recorded (defensive; the
        // extractor already yields one). Provenance hash is unchanged.
        const javaEdgeProps = /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(proof.testName) ? { test_name: proof.testName } : undefined;
        edges.push(
          ...makeProofEdges({
            testRel,
            symId,
            provenance: prov(testRel, hashString(`${symId}:${proof.assertion}:${proof.className}.${proof.callee}`)),
            lastVerified: proofVerifiedAt,
            ...(javaEdgeProps ? { properties: javaEdgeProps } : {})
          })
        );
      }
    }
    const seenPythonProof = new Set<string>();
    for (const [testRel, structure] of pythonTestStructureByFile) {
      const testExternalId = `test:${testRel}`;
      for (const proof of structure.pythonProofCalls ?? []) {
        pythonProofAttempted++;
        const symId = resolvePythonProofTarget(testRel, structure, proof.qualifier, proof.callee, new Set(proof.shadowed));
        if (!symId) continue;
        const edgeKey = `${testExternalId}|${symId}`;
        if (seenPythonProof.has(edgeKey)) continue;
        seenPythonProof.add(edgeKey);
        pythonProofConfirmedPairs++;
        const pythonEdgeProps = /^(?:Test[A-Za-z0-9_]*::)?test_[A-Za-z0-9_]+$/.test(proof.testName)
          ? { test_name: proof.testName }
          : undefined;
        edges.push(
          ...makeProofEdges({
            testRel,
            symId,
            provenance: prov(testRel, hashString(`${symId}:${proof.assertion}`)),
            lastVerified: proofVerifiedAt,
            ...(pythonEdgeProps ? { properties: pythonEdgeProps } : {})
          })
        );
      }
    }
  }

  // ---- Static assertion candidates (Phase 4 / Gate 2): TypeChecker-derived hard edges ----
  // Upgrade resolver-derived test->source candidates to HARD TESTED_BY/COVERS
  // ONLY where the 5-conjunct confirmer proves a runtime, asserted use of a real
  // exported binding. These edges are static candidate evidence for association
  // and diagnostics only; public Proven is minted solely from dynamic targeted
  // proof records in the metadata-only ledger. Stem-derived links are NEVER
  // confirmation inputs. (v1 narrow scope: a candidate whose target is a re-export
  // barrel — which holds no LOCAL behavior symbols — is not confirmed here;
  // barrel-routed confirmation is a documented follow-up. Under-confirming is the
  // desired failure mode.)
  let confirmedCoverage: { confirmed_pairs: number; attempted: number; capped_downgrades: number; skipped_files_budget: number } | undefined;
  if (readContent && eligibleSymbolsByFile.size > 0) {
    const absByRel = new Map(resolveFiles.map((f) => [f.rel, f.abs]));
    const candidates: ConfirmCandidate[] = [];
    const seenPair = new Set<string>();
    for (const e of candidate_edges) {
      // resolver-derived MAY_RELATE_TO only (evidence_strength "candidate"); the
      // weak stem fallback has not been emitted yet, and would be excluded anyway.
      if (e.relationship_type !== "MAY_RELATE_TO" || e.evidence_strength !== "candidate") continue;
      const testRel = e.from_external_id;
      const implRel = e.to_external_id;
      if (!eligibleSymbolsByFile.has(implRel)) continue;
      const testAbs = absByRel.get(testRel);
      const implAbs = absByRel.get(implRel);
      if (!testAbs || !implAbs) continue;
      const key = `${testRel}|${implRel}`;
      if (seenPair.has(key)) continue;
      seenPair.add(key);
      candidates.push({ testRel, testAbs, implRel, implAbs });
    }
    const confirmBudget = Math.max(1, Number(process.env.ORANGEPRO_MAX_CONFIRM_FILES) || 1500);
    const riskSymbolLimit = Math.max(1, Number(process.env.ORANGEPRO_CONFIRM_RISK_SYMBOLS) || DEFAULT_CONFIRM_RISK_SYMBOLS);
    const involved = new Set<string>();
    for (const c of candidates) {
      involved.add(c.testAbs);
      involved.add(c.implAbs);
    }
    if (candidates.length === 0) {
      confirmedCoverage = { confirmed_pairs: 0, attempted: 0, capped_downgrades: 0, skipped_files_budget: 0 };
    } else try {
      const scoped = involved.size > confirmBudget
        ? selectRiskScopedConfirmCandidates({
            candidates,
            nodes,
            edges,
            candidate_edges,
            root,
            confirmBudget,
            riskSymbolLimit,
            eligibleSymbolsByFile
          })
        : { candidates, riskSymbols: 0, involvedFiles: involved.size };
      if (involved.size > confirmBudget && scoped.candidates.length === 0) {
        confirmedCoverage = { confirmed_pairs: 0, attempted: 0, capped_downgrades: 0, skipped_files_budget: involved.size };
        warnings.push(
          `Static confirmation skipped: ${involved.size} files exceed the confirmer budget (${confirmBudget}), and no high-risk subset fit. Use \`--base <ref>\` for PR-scoped confirmation, or raise ORANGEPRO_MAX_CONFIRM_FILES.`
        );
      } else {
        const result = runConfirmer({ candidates: scoped.candidates, symbolsByImpl: eligibleSymbolsByFile, existingSymIds: codeSymbolIds, anchorFile: root });
        const proofVerifiedAt = scanStartMs;
        const seenEdge = new Set<string>();
        let confirmedPairs = 0;
        for (const c of result.confirmations) {
          const edgeKey = `test:${c.testRel}|${c.symId}`;
          if (seenEdge.has(edgeKey)) continue;
          seenEdge.add(edgeKey);
          confirmedPairs++;
          edges.push(
            ...makeProofEdges({
              testRel: c.testRel,
              symId: c.symId,
              provenance: prov(c.testRel, hashString(c.symId)),
              lastVerified: proofVerifiedAt
            })
          );
        }
        confirmedCoverage = {
          confirmed_pairs: confirmedPairs,
          attempted: result.attempted,
          capped_downgrades: result.capped_downgrades,
          skipped_files_budget: involved.size > confirmBudget ? involved.size : 0,
          ...(involved.size > confirmBudget
            ? {
                scoped_by_risk: {
                  candidate_pairs: scoped.candidates.length,
                  involved_files: scoped.involvedFiles,
                  risk_symbols: scoped.riskSymbols,
                  risk_symbol_limit: riskSymbolLimit,
                  file_budget: confirmBudget
                }
              }
            : {})
        };
        if (involved.size > confirmBudget) {
          warnings.push(
            `Static confirmation scoped: ${involved.size} files exceed the confirmer budget (${confirmBudget}); ran ${scoped.candidates.length} candidate pair(s) from the top ${scoped.riskSymbols} risk-ranked symbol(s). Public Proven still requires dynamic targeted proof.`
          );
        }
      }
    } catch (err) {
      // The confirmer is best-effort: an exotic tsconfig (composite/references)
      // or a TS compiler-API edge must NEVER crash analyze. Degrade to
      // candidate-only coverage with a disclosure.
      const msg = err instanceof Error ? err.message : String(err);
      confirmedCoverage = { confirmed_pairs: 0, attempted: 0, capped_downgrades: 0, skipped_files_budget: 0 };
      warnings.push(
        `Static confirmation skipped: the structural confirmer could not run on this project (${msg.slice(0, 160)}). Coverage is reported from candidate links only.`
      );
    }
  }
  const nonTsHardProofAttempted = goProofAttempted + javaProofAttempted + pythonProofAttempted;
  if (nonTsHardProofAttempted > 0) {
    confirmedCoverage = {
      confirmed_pairs: (confirmedCoverage?.confirmed_pairs ?? 0) + goProofConfirmedPairs + javaProofConfirmedPairs + pythonProofConfirmedPairs,
      attempted: (confirmedCoverage?.attempted ?? 0) + nonTsHardProofAttempted,
      capped_downgrades: confirmedCoverage?.capped_downgrades ?? 0,
      skipped_files_budget: confirmedCoverage?.skipped_files_budget ?? 0
    };
  }

  // Link remaining test files to a source sibling — SECONDARY, for files the
  // resolver cannot link (non-TS/JS languages, no resolvable imports). A naming/
  // path convention, so candidate/weak (never-proof); skipped entirely for any
  // test file the import graph already linked.
  //
  // (a) PER-LANGUAGE CONVENTION (Go `_test.go`, JVM `FooTest`↔`Foo` src/test→
  //     src/main mirror, Python `test_x.py`↔`x.py` tests/ mirror): predict the
  //     exact sibling path and verify it was scanned. High precision, so it wins
  //     over the coarse global stem match. (b) GLOBAL STEM fallback otherwise.
  for (const t of testFileStems) {
    if (importResolvedTests.has(t.relPath)) continue;

    const language = languageOf(t.relPath);
    const conv = conventionSibling(t.relPath, language, codeFileSet);
    if (conv && !isTestSupportPath(conv.relPath) && !isNonProductFile(conv.relPath)) {
      candidate_edges.push(
        makeCandidateEdge({
          from_external_id: t.relPath,
          to_external_id: conv.relPath,
          relationship_type: "MAY_RELATE_TO",
          evidence_strength: "weak",
          reason: conv.reason,
          confidence: conv.confidence,
          provenance: prov(t.relPath)
        })
      );
      continue;
    }
    // For a language with a strong test convention, a non-matching file is a
    // test-tree helper/shadow, not a behavior test (e.g. src/test/.../Owner.java
    // with no Test suffix). Under-link rather than resurrect the coarse global
    // stem matcher's cross-file false links. The stem fallback below stays for
    // TS/JS (resolver-missed) and unsupported languages only.
    if (isConventionLanguage(language)) continue;

    const candidates = codeFilesByStem.get(t.stem);
    if (!candidates || candidates.length === 0) continue;
    const sameDir = candidates.filter((c) => c.dir === t.dir);
    let target: { relPath: string; dir: string } | undefined;
    let confidence = 0;
    if (sameDir.length === 1) {
      target = sameDir[0];
      confidence = 0.6;
    } else if (sameDir.length === 0 && candidates.length === 1) {
      target = candidates[0];
      confidence = 0.4;
    } else {
      continue; // ambiguous (0 or >1 plausible sources) — do not guess
    }
    if (isTestSupportPath(target.relPath) || isNonProductFile(target.relPath)) continue; // helper/generated file named like the behavior is not coverage
    candidate_edges.push(
      makeCandidateEdge({
        from_external_id: t.relPath,
        to_external_id: target.relPath,
        relationship_type: "MAY_RELATE_TO",
        evidence_strength: "weak",
        reason: `Test and source share the basename stem "${t.stem}"`,
        confidence,
        provenance: prov(t.relPath)
      })
    );
  }

  // Ensure a pytest framework node when Python tests/conftest exist but no
  // explicit pytest config/dep was found (Python repos that rely on defaults).
  if (sawPythonTest && !frameworkIds.has("framework:pytest")) {
    addFramework("pytest", "test", "unit", pytestRef || repoScopeId);
  }

  // Semantic association pass: test names are useful "Associated" evidence when
  // file-stem/import heuristics miss cross-file behavior tests. This is still
  // weak candidate evidence only: it never mints hard COVERS/TESTED_BY proof.
  const existingSemanticTestLinks = new Set(
    candidate_edges
      .filter((e) => e.relationship_type === "MAY_BE_TESTED_BY" || e.relationship_type === "MAY_COVER")
      .map((e) => `${e.from_external_id}|${e.to_external_id}`)
  );
  const semanticTargets = nodes.filter((n) => n.kind === "UserFlow" || (n.kind === "CodeSymbol" && n.denominator_eligible === true));
  const testNodes = nodes.filter((n) => n.kind === "TestCase");
  if (semanticTargets.length > 0 && testNodes.length > 0) {
    const testTokensById = new Map<string, Set<string>>();
    const testsByToken = new Map<string, Set<GraphNode>>();
    for (const t of testNodes) {
      const names = Array.isArray(t.properties.test_names) ? t.properties.test_names.map(String).join(" ") : "";
      const tokens = textTokens(`${t.title ?? ""} ${names} ${t.properties.file ?? ""}`);
      testTokensById.set(t.external_id, tokens);
      for (const token of tokens) {
        const bucket = testsByToken.get(token);
        if (bucket) bucket.add(t);
        else testsByToken.set(token, new Set([t]));
      }
    }
    for (const target of semanticTargets) {
      const examples = Array.isArray(target.properties.example_behaviors) ? target.properties.example_behaviors.map(String).join(" ") : "";
      const targetTokens = textTokens(
        `${target.title ?? ""} ${examples} ${target.properties.feature ?? ""} ${target.properties.area ?? ""} ${target.properties.file ?? ""}`
      );
      const candidateTests = new Set<GraphNode>();
      for (const token of targetTokens) for (const test of testsByToken.get(token) ?? []) candidateTests.add(test);
      const matches = [...candidateTests]
        .map((test) => ({ test, score: tokenJaccard(targetTokens, testTokensById.get(test.external_id) ?? new Set()) }))
        .filter((m) => m.score >= 0.28)
        .sort((a, b) => b.score - a.score || a.test.external_id.localeCompare(b.test.external_id))
        .slice(0, 3);
      for (const { test, score } of matches) {
        const key = `${target.external_id}|${test.external_id}`;
        if (existingSemanticTestLinks.has(key)) continue;
        existingSemanticTestLinks.add(key);
        candidate_edges.push(
          makeCandidateEdge({
            from_external_id: target.external_id,
            to_external_id: test.external_id,
            relationship_type: "MAY_BE_TESTED_BY",
            evidence_strength: "weak",
            reason: "Token overlap between behavior name/title and test names; associated only, never proof.",
            confidence: Math.round(score * 100) / 100,
            provenance: prov(target.provenance.source_ref ?? repoScopeId)
          })
        );
      }
    }
  }

  if (files.length === 0) {
    warnings.push("No analyzable files found. Check the path and .orangeproignore rules.");
  }
  if (flowsTruncated > 0) {
    warnings.push(
      `Inferred-behavior cap (${maxFlows}) reached; ${flowsTruncated} test file(s) were not turned into behavior anchors. Lower ORANGEPRO_MAX_FLOWS only to bound a run; the default scans all.`
    );
  }
  if (symbolFilesTruncated > 0) {
    warnings.push(
      `${symbolFilesTruncated} file(s) exceeded the per-file symbol cap (${MAX_SYMBOLS_PER_FILE} exports); exports beyond the cap are NOT in the coverage denominator.`
    );
  }
  if (filesCapHit) {
    warnings.push(
      `File-scan cap (${maxFiles}) reached; some files were not scanned. Raise ORANGEPRO_MAX_FILES to include them.`
    );
  }
  const filesNotAnalyzed = files.length - filesProcessed;
  const elapsedMs = now() - scanStartMs;
  if (budgetStopped) {
    warnings.push(
      `Analyze budget (${budgetMs}ms) reached after ${filesProcessed}/${files.length} files; ${filesNotAnalyzed} file(s) were NOT analyzed. Coverage is over a PARTIAL scan (a floor, not a complete headline). Raise ORANGEPRO_MAX_ANALYZE_MS, or scope with --base.`
    );
  }

  // tree-sitter downgrade disclosure: a configured grammar that FAILED to load (vs
  // simply never preloaded) means extraction silently fell back to the shallow regex
  // path for that language — surface it instead of serving a quietly-undercounted
  // denominator (Codex PR-1 HIGH). Only warns for languages actually present.
  const tsStatus = treeSitterStatus();
  let treeSitterDowngraded: string[] = [];
  if (tsStatus.failed.length > 0) {
    const codeLangs = new Set<string>();
    for (const n of nodes) {
      if (n.kind === "File" && n.properties.role === "code" && typeof n.properties.language === "string") {
        codeLangs.add(n.properties.language);
      }
    }
    treeSitterDowngraded = tsStatus.failed.filter((l) => codeLangs.has(l));
    if (treeSitterDowngraded.length > 0) {
      warnings.push(
        `tree-sitter grammar(s) failed to load for ${treeSitterDowngraded.join(", ")} — symbol extraction fell back to a SHALLOW regex path, so the coverage denominator for ${treeSitterDowngraded.join("/")} is undercounted. Reinstall the package (grammars ship with it) for accurate extraction.`
      );
    }
  }

  // Directories with no graph evidence at all (only non-code/test/config/doc files)
  // and a meaningful file count — the safest things to add to .orangeproignore to
  // speed up and de-noise analysis. Suggest-only; never auto-excluded.
  const NOISE_DIR_MIN = 25;
  const exclude_suggestions = [...dirTally.entries()]
    .filter(([dir, c]) => dir !== "(root)" && c.useful === 0 && c.other >= NOISE_DIR_MIN)
    .sort((a, b) => b[1].other - a[1].other)
    .slice(0, 10)
    .map(([path, c]) => ({ path, files: c.other, reason: `${c.other} files, none with code/test/config/doc evidence` }));

  const runtimeCoverage = applyRuntimeCoverage(root, files, nodes, goModulesByDir);
  const structuralClusters = buildStructuralClusters(nodes, edges, candidate_edges);
  const flows = enumerateFlows({ nodes, edges, candidate_edges, workspaceRoot: root });

  const analysis = {
    test_files: testFiles,
    inferred_flows: flowIds.size,
    flows_truncated: flowsTruncated,
    max_inferred_flows: maxFlows,
    symbol_cap_hit: symbolCapHit,
    symbol_files_truncated: symbolFilesTruncated,
    excluded_boilerplate: excludedBoilerplate,
    files_scanned: filesProcessed,
    files_cap_hit: filesCapHit,
    max_files: maxFiles,
    ...(budgetStopped
      ? { not_analyzed_due_to_budget: { files_not_analyzed: filesNotAnalyzed, elapsed_ms: elapsedMs, budget_ms: budgetMs as number } }
      : {}),
    ...(opts.parseCache
      ? { parse_cache: { hits: opts.parseCache.hits, misses: opts.parseCache.misses, hit_rate: opts.parseCache.hitRate() } }
      : {}),
    ...(opts.resolverCache
      ? { resolver_cache: { hits: opts.resolverCache.hits, misses: opts.resolverCache.misses, hit_rate: opts.resolverCache.hitRate() } }
      : {}),
    exclude_suggestions,
    ...(behaviorContractsTotal
      ? {
          behavior_contracts: {
            total: behaviorContractsTotal,
            by_framework: Object.fromEntries([...behaviorContractsByFramework.entries()].sort(([a], [b]) => a.localeCompare(b))),
            by_kind: Object.fromEntries([...behaviorContractsByKind.entries()].sort(([a], [b]) => a.localeCompare(b))),
            handler_edges: behaviorContractsHandlerEdges
          }
        }
      : {}),
    flows,
    structural_clusters: structuralClusters,
    ...(tsStatus.loaded.length || tsStatus.failed.length
      ? { tree_sitter: { loaded: tsStatus.loaded, failed: tsStatus.failed, downgraded: treeSitterDowngraded } }
      : {}),
    ...(confirmedCoverage ? { confirmed_coverage: confirmedCoverage } : {}),
    ...(runtimeCoverage ? { runtime_coverage: runtimeCoverage } : {}),
    ...(resolverMetrics
      ? {
          resolver_metrics: resolverMetrics,
          resolver_gate: {
            axis: "test_to_source" as const,
            threshold_pct: 80,
            pct: resolverMetrics.test_to_source.pct,
            // Raw-count ratio (display pct rounds, e.g. 79.96 -> 80.0) AND a
            // complete scan: a files-cap-truncated OR budget-stopped run measured
            // an unknown fraction of the repo, so it can never be declared defensible.
            defensible:
              !filesCapHit &&
              !budgetStopped &&
              resolverMetrics.test_to_source.n > 0 &&
              resolverMetrics.test_to_source.resolved / resolverMetrics.test_to_source.n >= 0.8
          }
        }
      : {})
  };

  return { nodes, edges, candidate_edges, sources: [source], warnings, file_entries, analysis };
}
