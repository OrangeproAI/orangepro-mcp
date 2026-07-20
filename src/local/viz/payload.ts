import type { BehaviorFlow, LocalBucket, LocalGraph } from "../graph/ontology.js";
import { behaviorNodes, isDenominatorEligible } from "../graph/factories.js";
import { structurallyUnconfirmable, type DeferReason } from "../graph/confirmable.js";
import { ScoreResult } from "../types.js";
import { languageOf } from "../analyze/classify.js";
import { LEDGER_SCHEMA_VERSION, type Ledger } from "../ledger.js";
import { buildRtm, type RtmRow } from "../rtm.js";

/**
 * Privacy-safe view model for the offline evidence-graph explorer.
 *
 * IMPORTANT: this payload embeds METADATA ONLY — ids, labels, kinds, evidence
 * strength/confidence, edge kinds, and provenance refs. It NEVER embeds raw
 * source code, generated test bodies, prompts, or node `properties` (which can
 * carry test names/deps). Everything here is already a trust artifact.
 */
export interface VizNode {
  id: string;
  label: string;
  kind: string;
  strength: string;
  confidence: number;
  ref?: string;
  /** Behavior-only: has acceptance criteria. */
  ac?: boolean;
  /** Behavior-only: test evidence state. */
  evidence?: "covered" | "weak" | "none";
}

export interface VizEdge {
  from: string;
  to: string;
  kind: string;
  weak: boolean;
  strength?: string;
  confidence?: number;
}

/**
 * Four-state coverage for a behavior, honest about the real graph shape:
 * - `confirmed`: a legacy static hard edge exists for a UserFlow diagnostic.
 * - `not_structurally_confirmable`: no hard edge, but the behavior's tests are all
 *   e2e/api — a layer the static resolver cannot confirm. NOT a gap, NOT confirmed;
 *   excluded from the confirmed-% denominator (Phase 4.5).
 * - `inferred`: only a WEAK candidate edge (MAY_BE_TESTED_BY / MAY_COVER) exists.
 *   This is the common case — UserFlows are inferred FROM test describe-names, so
 *   each one is weakly linked to its test, just not CONFIRMED.
 * - `none`: no coverage edge at all.
 */
export type FlowCoverage = "confirmed" | "not_structurally_confirmable" | "inferred" | "none";

export interface GapTestLink {
  from: string;
  to: string;
  status: "confirmed" | "possible";
  label: "Static test link" | "Possible test link";
  confidence: number;
  last_verified?: number;
}

export interface GapSymbolProofLink {
  from: string;
  to: string;
  symbol_label: string;
  test_label: string;
  area: string;
  confidence: number;
  last_verified?: number;
}

/** A single UserFlow row for the gap-first views (Flows table + connectivity graph). */
export interface GapFlow {
  id: string;
  title: string;
  area: string;
  coverage: FlowCoverage;
  /** Back-compat: true iff coverage === "confirmed" (a hard coverage edge exists). */
  has_test: boolean;
  /** Why this flow is not_structurally_confirmable (layer_e2e / layer_api), when applicable. */
  defer_reason?: DeferReason;
  /** TestCase external_ids weakly linked via MAY_BE_TESTED_BY / MAY_COVER (capped at 2). */
  test_ids: string[];
  /** Directed, plain-language behavior -> test links for graph.html. */
  test_links: GapTestLink[];
  confidence: number;
  behaviors: string[];
}

/** Per-area denominator rollup for the Gap Heatmap cards. */
export interface GapArea {
  area: string;
  total: number;
  /** Eligible CodeSymbols proven by dynamic targeted-proof ledger records. */
  confirmed: number;
  /** Eligible CodeSymbols executed by an ingested runtime coverage artifact, not proof. */
  runtime_covered: number;
  /** Eligible CodeSymbols with a weak/candidate test association, not proof. */
  inferred: number;
  /** Kept for back-compat with older HTML payloads; CodeSymbol heatmap rows do not use live-test deferral. */
  not_structurally_confirmable: number;
  /** Eligible CodeSymbols with no test signal. */
  none: number;
  /** dynamic Proven / total. */
  confirmed_pct: number;
  sample_gaps: Array<{ title: string; file?: string; status: "associated" | "candidate" | "none" }>;
}

/** A TestCase sample for the connectivity graph's "connected" cluster. */
export interface GapTestcase {
  id: string;
  title: string;
  test_names: string[];
  test_layer: string;
}

/** A distinct area surfaced as a service hub in the connectivity graph. */
export interface GapService {
  id: string;
  title: string;
  area: string;
}

/** Denominator-backed code-symbol coverage by language. */
export interface GapLanguageTier {
  language: string;
  total: number;
  proven: number;
  runtime_covered: number;
  associated: number;
  unlinked: number;
  proven_pct: number;
  runtime_pct: number;
  associated_pct: number;
}

export interface CodeBehaviorRow {
  id: string;
  title: string;
  file?: string;
  area: string;
  language: string;
  evidence: "proven" | "runtime" | "associated" | "candidate" | "none";
}

export interface StaticFlowHopRow {
  from: string;
  to: string;
  strength: "hard" | "framework-derived";
  resolution?: string;
}

export interface StaticFlowRow {
  id: string;
  entry_id: string;
  entry_title: string;
  entry_kind: "Endpoint" | "Behavior";
  terminal: string;
  depth: number;
  tier: "hard: reachable" | "framework-derived: reachable";
  truncated: boolean;
  hops: StaticFlowHopRow[];
}

/**
 * Gap-first view model consumed by the v4 coverage-gap explorer. The renderer
 * turns this into the `DATA` object the embedded logic destructures as
 * `{ workspace, stats, area_summary, all_userflows, testcases_sample, services }`.
 *
 * Unlike the metadata-only top-level payload, this view intentionally includes
 * real test describe-names (example_behaviors / test_names) — it is a LOCAL
 * artifact written to `.orangepro/graph.html` and never uploaded.
 */
export interface VizGap {
  workspace: string;
  stats: {
    userflows: number;
    testcases: number;
    confirmed: number;
    inferred: number;
    not_structurally_confirmable: number;
    none: number;
    /** confirmed + inferred + none — the denominator confirmed_pct is computed over (excludes nsc). */
    confirmable_total: number;
    /** FLOW-view coverage (UserFlow describe-names). Gap-explorer stat ONLY — NOT the headline. */
    confirmed_pct: number;
    /** Alias of confirmed_pct, kept for back-compat. */
    coverage_pct: number;
    /**
     * HEADLINE coverage: confirmed over the DENOMINATOR behaviors (CodeSymbols +
     * Requirements), matching COVERAGE_REPORT.md. The hero ring/% is driven by this,
     * NOT the UserFlow flow-view above (Phase 5.1 / carry-over #3).
     */
    behavior_confirmed: number;
    behavior_total: number;
    behavior_confirmed_pct: number;
  };
  area_summary: GapArea[];
  /** Per-language denominator coverage; proof and weak association are never blended. */
  language_tiers: GapLanguageTier[];
  /** Denominator-backed code behaviors for the searchable gap table. */
  code_behaviors: CodeBehaviorRow[];
  /** Static CALLS-chain reachability flows. Reachable only — not execution/proof/user-flow evidence. */
  static_flows: {
    total: number;
    hard_reachable: number;
    framework_derived_reachable: number;
    truncated: number;
    items: StaticFlowRow[];
  };
  all_userflows: GapFlow[];
  /** Hard CodeSymbol -> TestCase proof links surfaced separately from UserFlow hints. */
  symbol_test_links: GapSymbolProofLink[];
  testcases_sample: GapTestcase[];
  services: GapService[];
  /**
   * Set when a wall-clock budget stopped the scan: the rendered headline must show a
   * partial-scan banner so the coverage % is never read as a complete/fresh number.
   */
  partial_scan?: { files_not_analyzed: number; budget_ms: number };
  /** Set when static confirmation was limited because the full scan exceeded the confirmer budget. */
  proof_limited?: {
    skipped_files_budget: number;
    scoped_by_risk?: {
      candidate_pairs: number;
      involved_files: number;
      risk_symbols: number;
      risk_symbol_limit: number;
      file_budget: number;
    };
  };
}

export interface VizPayload {
  meta: {
    workspace: string;
    created_at: string;
    source_upload_policy: string;
    score: { overall: number; band: string; breakdown: Record<string, number>; missing_evidence: string[] };
    analysis: LocalGraph["analysis"] | null;
    counts: {
      nodes: number;
      edges: number;
      candidates: number;
      nodesByKind: Array<{ kind: string; count: number }>;
      edgesByKind: Array<{ kind: string; count: number }>;
      strength: Record<string, number>;
    };
    frameworks: string[];
    sources: Array<{ system: string; name: string }>;
    generated: {
      count: number;
      byBucket: Array<{ bucket: string; count: number }>;
      items: Array<{ title: string; entity_ids: string[]; bucket?: string }>;
    };
    gaps: number;
  };
  nodes: VizNode[];
  edges: VizEdge[];
  /** Node kinds shown in the summarized default view. */
  defaultKinds: string[];
  /** Gap-first view model for the coverage-gap explorer (heatmap / connectivity / flows). */
  gap: VizGap;
}

// What counts as a behavior comes ONLY from the canonical helpers
// (factories.behaviorNodes over ontology.BEHAVIOR_KINDS) — a duplicated local
// kind set lived here once and could silently drift from score's definition.
const DEFAULT_KINDS = [
  "TenantStub",
  "Requirement",
  "UserFlow",
  "BusinessRule",
  "AcceptanceCriterion",
  "Service",
  "Endpoint",
  "Incident",
  "Framework",
  "Package"
];

function tally(items: string[]): Array<{ kind: string; count: number }> {
  const m = new Map<string, number>();
  for (const k of items) m.set(k, (m.get(k) ?? 0) + 1);
  return [...m.entries()].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count);
}

function behaviorEvidence(graph: LocalGraph, externalId: string): "covered" | "weak" | "none" {
  const hard = graph.edges.some(
    (e) =>
      (e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS") &&
      (e.from_external_id === externalId || e.to_external_id === externalId)
  );
  if (hard) return "covered";
  const weak = graph.candidate_edges.some(
    (e) =>
      (e.relationship_type === "MAY_BE_TESTED_BY" || e.relationship_type === "MAY_COVER") &&
      (e.from_external_id === externalId || e.to_external_id === externalId)
  );
  return weak ? "weak" : "none";
}

/** First path segment of a provenance ref / source path (the "area"). */
function areaOf(sourceRefOrPath: string | undefined): string {
  if (!sourceRefOrPath) return "core";
  const cleaned = sourceRefOrPath.replace(/^[./]+/, "").split(/[#?]/)[0];
  const first = cleaned.split(/[\\/]/).filter(Boolean)[0];
  return first || "core";
}

function cleanPathParts(sourceRefOrPath: string | undefined): string[] {
  if (!sourceRefOrPath) return [];
  return sourceRefOrPath.replace(/^[./]+/, "").split(/[#?]/)[0].split(/[\\/]/).filter(Boolean);
}

function parentDir(parts: string[]): string {
  return parts.length > 1 ? parts[parts.length - 2] : parts[0] || "core";
}

function codeAreaOf(sourceRefOrPath: string | undefined): string {
  const parts = cleanPathParts(sourceRefOrPath);
  if (parts.length === 0) return "core";
  const language = languageOf(sourceRefOrPath ?? "");

  if (language === "java" || language === "kotlin") {
    const srcIdx = parts.findIndex((p, i) => p === "src" && (parts[i + 1] === "main" || parts[i + 1] === "test"));
    if (srcIdx >= 0 && parts[srcIdx + 2] && ["java", "kotlin"].includes(parts[srcIdx + 2])) return parentDir(parts.slice(srcIdx + 3));
    return parentDir(parts);
  }

  if (language === "python") {
    if (["src", "app"].includes(parts[0]) && parts.length > 2) return parts.slice(1, 3).join("/");
    return parts.length > 2 ? parts.slice(0, 2).join("/") : parentDir(parts);
  }

  if (language === "go") {
    return parts.length > 2 ? parts.slice(0, 2).join("/") : parentDir(parts);
  }

  if (language === "typescript" || language === "javascript") {
    return parts.length > 2 ? parts.slice(0, 2).join("/") : parentDir(parts);
  }

  return parts.length > 2 ? parts.slice(0, 2).join("/") : parentDir(parts);
}

/**
 * 4-state coverage for a UserFlow (precedence: confirmed > nsc > inferred > none):
 *   confirmed = hard TESTED_BY/COVERS edge; not_structurally_confirmable = no hard
 *   edge but all tests are e2e/api; inferred = weak candidate edge; none = neither.
 */
function flowCoverage(graph: LocalGraph, externalId: string, nsc: Map<string, DeferReason>): FlowCoverage {
  const ev = behaviorEvidence(graph, externalId);
  if (ev === "covered") return "confirmed";
  if (nsc.has(externalId)) return "not_structurally_confirmable";
  if (ev === "weak") return "inferred";
  return "none";
}

/** TestCase external_ids weakly linked to this flow via MAY_BE_TESTED_BY / MAY_COVER (capped). */
function flowTestIds(graph: LocalGraph, externalId: string): string[] {
  return flowTestLinks(graph, externalId)
    .filter((l) => l.status === "possible")
    .map((l) => l.to)
    .slice(0, 2);
}

function flowTestLinks(graph: LocalGraph, externalId: string): GapTestLink[] {
  const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
  const links = new Map<string, GapTestLink>();
  for (const e of graph.candidate_edges) {
    if (e.relationship_type !== "MAY_BE_TESTED_BY" && e.relationship_type !== "MAY_COVER") continue;
    let other: string | undefined;
    if (e.from_external_id === externalId) other = e.to_external_id;
    else if (e.to_external_id === externalId) other = e.from_external_id;
    if (!other || links.has(other)) continue;
    const node = nodeById.get(other);
    if (node?.kind === "TestCase") {
      links.set(other, {
        from: externalId,
        to: other,
        status: "possible",
        label: "Possible test link",
        confidence: e.confidence
      });
    }
  }
  for (const e of graph.edges) {
    if (e.relationship_type !== "TESTED_BY" && e.relationship_type !== "COVERS") continue;
    let testId: string | undefined;
    if (e.from_external_id === externalId) testId = e.to_external_id;
    else if (e.to_external_id === externalId) testId = e.from_external_id;
    if (!testId || nodeById.get(testId)?.kind !== "TestCase") continue;
    links.set(testId, {
      from: externalId,
      to: testId,
      status: "confirmed",
      label: "Static test link",
      confidence: e.confidence ?? 1,
      ...(typeof e.last_verified === "number" ? { last_verified: e.last_verified } : {})
    });
  }
  return [...links.values()].sort((a, b) => (a.status === b.status ? a.to.localeCompare(b.to) : a.status === "confirmed" ? -1 : 1));
}

function nodeFileRef(n: LocalGraph["nodes"][number]): string | undefined {
  if (typeof n.properties.file === "string") return n.properties.file;
  if (typeof n.provenance?.source_ref === "string") return n.provenance.source_ref;
  return n.external_id.replace(/^sym:/, "").split("#")[0];
}

function symbolProofLinks(graph: LocalGraph): GapSymbolProofLink[] {
  const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
  const links = new Map<string, GapSymbolProofLink>();
  for (const e of graph.edges) {
    if (e.relationship_type !== "TESTED_BY" && e.relationship_type !== "COVERS") continue;
    const from = nodeById.get(e.from_external_id);
    const to = nodeById.get(e.to_external_id);
    let symbol = from?.kind === "CodeSymbol" ? from : to?.kind === "CodeSymbol" ? to : undefined;
    let test = from?.kind === "TestCase" ? from : to?.kind === "TestCase" ? to : undefined;
    if (!symbol || !test || symbol.denominator_eligible === false) continue;
    const key = `${symbol.external_id}|${test.external_id}`;
    links.set(key, {
      from: symbol.external_id,
      to: test.external_id,
      symbol_label: symbol.title || symbol.external_id,
      test_label: test.title || test.external_id,
      area: areaOf(nodeFileRef(symbol)),
      confidence: e.confidence ?? 1,
      ...(typeof e.last_verified === "number" ? { last_verified: e.last_verified } : {})
    });
  }
  return [...links.values()].sort((a, b) => a.area.localeCompare(b.area) || a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
}

function behaviorHasAc(graph: LocalGraph, externalId: string): boolean {
  if (graph.edges.some((e) => e.relationship_type === "HAS_ACCEPTANCE_CRITERION" && e.from_external_id === externalId)) {
    return true;
  }
  const node = graph.nodes.find((n) => n.external_id === externalId);
  const inline = node?.properties.acceptance_criteria;
  return Array.isArray(inline) ? inline.length > 0 : Boolean(inline);
}

function languageLabel(language: string): string {
  const labels: Record<string, string> = {
    typescript: "TypeScript/JavaScript",
    javascript: "TypeScript/JavaScript",
    python: "Python",
    go: "Go",
    java: "Java",
    ruby: "Ruby",
    kotlin: "Kotlin",
    rust: "Rust",
    php: "PHP",
    csharp: "C#",
    swift: "Swift",
    c: "C",
    cpp: "C++"
  };
  return labels[language] ?? language;
}

function emptyLedger(): Ledger {
  return { schema_version: LEDGER_SCHEMA_VERSION, records: [] };
}

function publicRowsById(graph: LocalGraph, ledger: Ledger | undefined): Map<string, RtmRow> {
  return new Map(buildRtm(graph, ledger ?? emptyLedger()).rows.map((row) => [row.behavior_id, row]));
}

function eligibleCodeSymbols(graph: LocalGraph): LocalGraph["nodes"] {
  return graph.nodes.filter((n) => n.kind === "CodeSymbol" && isDenominatorEligible(n));
}

function languageTiers(graph: LocalGraph, ledger?: Ledger): GapLanguageTier[] {
  const publicRows = publicRowsById(graph, ledger);
  const rows = new Map<string, GapLanguageTier>();
  for (const n of eligibleCodeSymbols(graph)) {
    const file = nodeFileRef(n) ?? "";
    const publicRow = publicRows.get(n.external_id);
    const language = languageLabel(languageOf(file));
    let row = rows.get(language);
    if (!row) {
      row = { language, total: 0, proven: 0, runtime_covered: 0, associated: 0, unlinked: 0, proven_pct: 0, runtime_pct: 0, associated_pct: 0 };
      rows.set(language, row);
    }
    row.total++;
    if (publicRow?.evidence_tier === "proven") row.proven++;
    else if (publicRow?.evidence_tier === "runtime") row.runtime_covered++;
    else if (publicRow?.evidence_tier === "associated") row.associated++;
    else row.unlinked++;
  }

  return [...rows.values()]
    .map((r) => ({
      ...r,
      proven_pct: r.total > 0 ? (r.proven / r.total) * 100 : 0,
      runtime_pct: r.total > 0 ? (r.runtime_covered / r.total) * 100 : 0,
      associated_pct: r.total > 0 ? (r.associated / r.total) * 100 : 0
    }))
    .sort((a, b) => b.total - a.total || a.language.localeCompare(b.language));
}

function codeAreaSummary(graph: LocalGraph, ledger?: Ledger): GapArea[] {
  const publicRows = publicRowsById(graph, ledger);
  const areaMap = new Map<
    string,
    { total: number; confirmed: number; runtime_covered: number; inferred: number; none: number; noLinkSamples: GapArea["sample_gaps"]; associatedSamples: GapArea["sample_gaps"] }
  >();

  for (const n of eligibleCodeSymbols(graph)) {
    const file = nodeFileRef(n) ?? "";
    const publicRow = publicRows.get(n.external_id);
    const area = codeAreaOf(file);
    let a = areaMap.get(area);
    if (!a) {
      a = { total: 0, confirmed: 0, runtime_covered: 0, inferred: 0, none: 0, noLinkSamples: [], associatedSamples: [] };
      areaMap.set(area, a);
    }
    a.total++;
    if (publicRow?.evidence_tier === "proven") {
      a.confirmed++;
    } else if (publicRow?.evidence_tier === "runtime") {
      a.runtime_covered++;
    } else {
      if (publicRow?.evidence_tier === "associated") {
        a.inferred++;
        a.associatedSamples.push({ title: n.title || n.external_id, file, status: "associated" });
      } else if (publicRow?.evidence_tier === "candidate") {
        // Lexical/Jaccard candidate: a lead, not evidence — surfaced distinctly,
        // never folded into the associated (test-linked) column.
        a.inferred++;
        a.associatedSamples.push({ title: n.title || n.external_id, file, status: "candidate" });
      } else {
        a.none++;
        a.noLinkSamples.push({ title: n.title || n.external_id, file, status: "none" });
      }
    }
  }

  return [...areaMap.entries()]
    .map(([area, a]) => ({
      area,
      total: a.total,
      confirmed: a.confirmed,
      runtime_covered: a.runtime_covered,
      inferred: a.inferred,
      not_structurally_confirmable: 0,
      none: a.none,
      confirmed_pct: a.total > 0 ? (a.confirmed / a.total) * 100 : 0,
      sample_gaps: [...a.noLinkSamples, ...a.associatedSamples].slice(0, 6)
    }))
    .sort((x, y) => y.total - x.total || x.area.localeCompare(y.area));
}

function codeBehaviorRows(graph: LocalGraph, ledger?: Ledger): CodeBehaviorRow[] {
  const publicRows = publicRowsById(graph, ledger);
  return eligibleCodeSymbols(graph)
    .map((n) => {
      const file = nodeFileRef(n) ?? "";
      const tier = publicRows.get(n.external_id)?.evidence_tier;
      const evidence: CodeBehaviorRow["evidence"] = tier === "proven"
        ? "proven"
        : tier === "runtime"
          ? "runtime"
          : tier === "associated"
            ? "associated"
            : tier === "candidate"
              ? "candidate"
              : "none";
      return {
        id: n.external_id,
        title: n.title || n.external_id,
        file,
        area: codeAreaOf(file),
        language: languageLabel(languageOf(file)),
        evidence
      };
    })
    .sort((a, b) => {
      const rank = (x: CodeBehaviorRow) => (x.evidence === "none" ? 0 : x.evidence === "candidate" ? 1 : x.evidence === "associated" ? 2 : x.evidence === "runtime" ? 3 : 4);
      return rank(a) - rank(b) || a.area.localeCompare(b.area) || a.file.localeCompare(b.file) || a.title.localeCompare(b.title);
    });
}

function staticFlowRows(graph: LocalGraph): VizGap["static_flows"] {
  const flows = graph.analysis?.flows?.flows ?? [];
  const items: StaticFlowRow[] = flows.slice(0, 100).map((flow: BehaviorFlow) => ({
    id: flow.id,
    entry_id: flow.entry_point.external_id,
    entry_title: flow.entry_point.title || flow.entry_point.external_id,
    entry_kind: flow.entry_point.kind,
    terminal: flow.terminal,
    depth: flow.depth,
    tier: flow.flow_tier,
    truncated: flow.truncated === true,
    hops: flow.hops.map((h) => ({
      from: h.from,
      to: h.to,
      strength: h.evidence_strength,
      ...(h.resolution ? { resolution: h.resolution } : {})
    }))
  }));
  return {
    total: graph.analysis?.flows?.total_flows ?? flows.length,
    hard_reachable: graph.analysis?.flows?.by_tier["hard: reachable"] ?? flows.filter((f) => f.flow_tier === "hard: reachable").length,
    framework_derived_reachable:
      graph.analysis?.flows?.by_tier["framework-derived: reachable"] ?? flows.filter((f) => f.flow_tier === "framework-derived: reachable").length,
    truncated: graph.analysis?.flows?.truncated_flows ?? flows.filter((f) => f.truncated === true).length,
    items
  };
}

/** Build the gap-first view model (heatmap / connectivity / flows). */
function buildGap(graph: LocalGraph, ledger?: Ledger): VizGap {
  const nsc = structurallyUnconfirmable(graph);
  const publicRtm = buildRtm(graph, ledger ?? emptyLedger());
  const flows: GapFlow[] = graph.nodes
    .filter((n) => n.kind === "UserFlow")
    .map((n) => {
      const ref = n.provenance?.source_ref;
      const propArea = typeof n.properties.area === "string" ? (n.properties.area as string) : undefined;
      const area = ref ? areaOf(ref) : propArea || "core";
      const behaviors = Array.isArray(n.properties.example_behaviors)
        ? (n.properties.example_behaviors as unknown[]).filter((b): b is string => typeof b === "string").slice(0, 3)
        : [];
      const coverage = flowCoverage(graph, n.external_id, nsc);
      const test_links = flowTestLinks(graph, n.external_id);
      return {
        id: n.external_id,
        title: n.title || n.external_id,
        area,
        coverage,
        has_test: coverage === "confirmed",
        ...(coverage === "not_structurally_confirmable" ? { defer_reason: nsc.get(n.external_id) } : {}),
        test_ids: flowTestIds(graph, n.external_id),
        test_links,
        confidence: n.confidence,
        behaviors
      };
    });

  const userflows = flows.length;
  const confirmed = flows.filter((f) => f.coverage === "confirmed").length;
  const inferred = flows.filter((f) => f.coverage === "inferred").length;
  const notStructurallyConfirmable = flows.filter((f) => f.coverage === "not_structurally_confirmable").length;
  const none = flows.filter((f) => f.coverage === "none").length;
  // confirmed_pct EXCLUDES nsc: e2e/api behaviors never dilute the structural %.
  const confirmableTotal = confirmed + inferred + none;
  const confirmed_pct = confirmableTotal > 0 ? (confirmed / confirmableTotal) * 100 : 0;

  const area_summary = codeAreaSummary(graph, ledger);

  const testCaseNodes = graph.nodes.filter((n) => n.kind === "TestCase");
  const testcases_sample: GapTestcase[] = testCaseNodes.slice(0, 60).map((n) => ({
    id: n.external_id,
    title: n.title || n.external_id,
    test_names: Array.isArray(n.properties.test_names)
      ? (n.properties.test_names as unknown[]).filter((t): t is string => typeof t === "string").slice(0, 3)
      : [],
    test_layer: typeof n.properties.test_layer === "string" ? (n.properties.test_layer as string) : "unknown"
  }));

  const symbol_test_links = symbolProofLinks(graph);
  const services: GapService[] = [...new Set([...flows.map((f) => f.area), ...symbol_test_links.map((l) => l.area)])].map((name) => ({
    id: `area:${name}`,
    title: name,
    area: name
  }));

  // Headline Proven is computed over the public denominator behaviors from the
  // same RTM gate as COVERAGE_REPORT.md: dynamic targeted proof only.

  return {
    workspace: graph.workspace.name,
    stats: {
      userflows,
      testcases: testCaseNodes.length,
      confirmed,
      inferred,
      not_structurally_confirmable: notStructurallyConfirmable,
      none,
      confirmable_total: confirmableTotal,
      confirmed_pct,
      coverage_pct: confirmed_pct,
      behavior_confirmed: publicRtm.summary.proven,
      behavior_total: publicRtm.summary.total,
      behavior_confirmed_pct: publicRtm.summary.coverage_pct
    },
    area_summary,
    language_tiers: languageTiers(graph, ledger),
    code_behaviors: codeBehaviorRows(graph, ledger),
    static_flows: staticFlowRows(graph),
    all_userflows: flows,
    symbol_test_links,
    testcases_sample,
    services,
    ...(graph.analysis?.not_analyzed_due_to_budget
      ? {
          partial_scan: {
            files_not_analyzed: graph.analysis.not_analyzed_due_to_budget.files_not_analyzed,
            budget_ms: graph.analysis.not_analyzed_due_to_budget.budget_ms
          }
        }
      : {}),
    ...(graph.analysis?.confirmed_coverage && graph.analysis.confirmed_coverage.skipped_files_budget > 0
      ? {
          proof_limited: {
            skipped_files_budget: graph.analysis.confirmed_coverage.skipped_files_budget,
            ...(graph.analysis.confirmed_coverage.scoped_by_risk ? { scoped_by_risk: graph.analysis.confirmed_coverage.scoped_by_risk } : {})
          }
        }
      : {})
  };
}

export function buildVizPayload(graph: LocalGraph, score: ScoreResult, ledger?: Ledger): VizPayload {
  const behaviors = behaviorNodes(graph);
  const behaviorMeta = new Map<string, { ac: boolean; evidence: "covered" | "weak" | "none" }>();
  let gaps = 0;
  for (const b of behaviors) {
    const ac = behaviorHasAc(graph, b.external_id);
    const evidence = behaviorEvidence(graph, b.external_id);
    behaviorMeta.set(b.external_id, { ac, evidence });
    if (!ac || evidence !== "covered") gaps++;
  }

  const nodes: VizNode[] = graph.nodes.map((n) => {
    const node: VizNode = {
      id: n.external_id,
      label: (n.title || n.external_id).slice(0, 80),
      kind: n.kind,
      strength: n.evidence_strength,
      confidence: n.confidence,
      ref: n.provenance?.source_ref
    };
    const bm = behaviorMeta.get(n.external_id);
    if (bm) {
      node.ac = bm.ac;
      node.evidence = bm.evidence;
    }
    return node;
  });

  const edges: VizEdge[] = [
    ...graph.edges.map((e) => ({
      from: e.from_external_id,
      to: e.to_external_id,
      kind: e.relationship_type,
      weak: e.evidence_strength === "framework-derived",
      strength: e.evidence_strength
    })),
    ...graph.candidate_edges.map((e) => ({
      from: e.from_external_id,
      to: e.to_external_id,
      kind: e.relationship_type,
      weak: true,
      confidence: e.confidence
    }))
  ];

  const strength: Record<string, number> = {};
  for (const n of graph.nodes) strength[n.evidence_strength] = (strength[n.evidence_strength] ?? 0) + 1;

  const frameworks = graph.nodes.filter((n) => n.kind === "Framework").map((n) => n.title || n.external_id);
  const sources = graph.sources.map((s) => ({ system: s.source_system, name: s.display_name }));
  const generatedItems = graph.generated_tests.map((t) => ({
    title: t.title,
    entity_ids: t.grounding.entity_ids,
    bucket: t.bucket
  }));
  const generatedByBucket = tally(
    graph.generated_tests.map((t) => t.bucket).filter((b): b is LocalBucket => b !== undefined)
  ).map((x) => ({ bucket: x.kind, count: x.count }));

  return {
    meta: {
      workspace: graph.workspace.name,
      created_at: graph.updated_at,
      source_upload_policy: graph.workspace.source_upload_policy,
      score: {
        overall: score.overall,
        band: score.band,
        breakdown: score.breakdown as unknown as Record<string, number>,
        missing_evidence: score.missing_evidence
      },
      analysis: graph.analysis ?? null,
      counts: {
        nodes: graph.nodes.length,
        edges: graph.edges.length,
        candidates: graph.candidate_edges.length,
        nodesByKind: tally(graph.nodes.map((n) => n.kind)),
        edgesByKind: tally([...graph.edges, ...graph.candidate_edges].map((e) => e.relationship_type)),
        strength
      },
      frameworks,
      sources,
      generated: { count: graph.generated_tests.length, byBucket: generatedByBucket, items: generatedItems },
      gaps
    },
    nodes,
    edges,
    defaultKinds: DEFAULT_KINDS,
    gap: buildGap(graph, ledger)
  };
}
