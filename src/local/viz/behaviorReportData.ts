import { createHash } from "node:crypto";
import path from "node:path";
import type { BehaviorFlow, GraphNode, LocalGraph } from "../graph/ontology.js";
import type { Ledger } from "../ledger.js";
import { buildRtm, type RtmRow } from "../rtm.js";
import { inspectRiskInputHealth, isEntryPoint, rankRiskGaps, type RiskGap } from "../score/risk.js";
import { ORANGEPRO_VERSION } from "../version.js";
import { PROOF_BLOCKER_GUIDE } from "../proofDoctor.js";

export interface BehaviorReportData {
  repo: string;
  scanned: string;
  framework: string;
  analysisKind: "static" | "static+dynamic";
  provenance: {
    source: string;
    gitRoot: string | null;
    commit: string | null;
    history: "full" | "shallow" | "partial" | "unavailable";
    churn: "available" | "unavailable";
    churnWindow: string;
    toolVersion: string;
    inputFingerprint: string;
    reason?: string;
  };
  /**
   * Tier counts. `proven`/`associated`/`none` are the classification (unchanged).
   * `reachableUntested`/`noSignal` are a DISPLAY-ONLY split of the `none` bucket
   * (reachableUntested + noSignal === none): a none-tier behavior whose symbol
   * appears in a static flow is "Reachable Untested"; the rest are "No Signal".
   */
  summary: {
    /** Stable deterministic denominator; excludes display-union proof rows. */
    total: number;
    /** All current dynamic proofs, including valid proofs outside the denominator. */
    proven: number;
    /** Proof rows displayed in the report but excluded from `total`. */
    provenOutsideDenominator?: number;
    associated: number;
    candidate: number;
    none: number;
    reachableUntested: number;
    noSignal: number;
  };
  proofGuidance: { state: "proven" | "attempted" | "not_started"; title: string; body: string; action: string };
  pipeline: Array<{ key: string; label: string; pr: string; on: "1" | "partial" | "0" }>;
  scan: {
    services: Array<[name: string, behaviorCount: number]>;
    serviceTotal: number;
    tests: { total: number; integration: number; unit: number };
    excluded: { count: string; text: string };
  };
  behaviorGroups: Array<{ key: string; count: number }>;
  behaviors: Array<{ sig: string; group: string; file: string; tier: "proven" | "assoc" | "candidate" | "none"; reachable: boolean; desc: string }>;
  flows: BehaviorReportFlow[];
  /**
   * AI-suggested candidate flows — a clearly-labeled "verify these" worklist.
   * Rendered ONLY in the AI-suggested subsection with neutral colors; never
   * merged into `flows`, flow counts, the pipeline strip, or tier cards.
   */
  candidateFlows: BehaviorReportCandidateFlows | null;
  risks: Array<{
    rank: number;
    verb: string;
    path: string;
    context?: string;
    desc: string;
    tags: Array<[label: string, kind: "risk" | "info" | "entry"]>;
    todo: string;
    /**
     * v6 gap-card extensions (display-only). Concern categories that apply to
     * this flow and categories for which a generated draft is attached. Drafts
     * are planning artifacts, never coverage or proof.
     */
    applicableCategories: string[];
    generatedCategories: string[];
    generatedTests: Array<{ name: string; concern?: string; technique?: string; bucket?: string; assertion?: string; code: string; runnable?: boolean }>;
  }>;
  /** Verbatim "why 0 dynamic proof" explainer — populated ONLY when summary.proven === 0. Display copy; changes no classification. */
  zeroProofExplainer: { title: string; body: string[] } | null;
  /** Total generated tests recorded in the graph (honest count; 0 hides the CTA band). */
  /** Cap disclosure: what the view shows vs what was computed. Display-only. */
  mapModel: SystemMapModel;
  /** Delta vs the previous run's snapshot (null on first run / unreadable baseline). Display-only. */
  delta?: ReportDelta | null;
  viewMeta: {
    risks: { shown: number; scored: number };
    flows: { shown: number; prunedByCaps: number };
  };
  generatedTotal: number;
  /** How many of those are rendered inline in risk cards (0 until linkage is wired). */
  shownCount: number;
}

export interface BehaviorReportFlow {
  title: string;
  trigger: { verb: string; path: string } | null;
  /** Root symbol is a true entry point per the graph (route/main/CLI). */
  root_entry?: boolean;
  risk: "critical" | "high" | "medium" | null;
  proof: "proven" | "none";
  services: number;
  flow_tier: "hard: reachable" | "framework-derived: reachable";
  why: string;
  steps: Array<{
    sig: string;
    tier: "hard" | "framework-derived";
    edge: "hard" | "framework-derived" | null;
    desc: string;
  }>;
}

export interface BehaviorReportCandidateFlows {
  /** First-class rejection accounting headline: "model proposed N → accepted M". */
  proposed: number;
  accepted: number;
  model: string;
  prompt_version: string;
  flows: Array<{
    title: string;
    confidence: number;
    rationale: string;
    steps: Array<{ sig: string; desc: string; hop: "matches_known_edge" | "unverified" | null }>;
  }>;
}

/**
 * Distilled THIS-RUN dynamic-proof outcome, forwarded from autoProve so the report can name
 * the dominant setup/runnability block reason when 0 behaviors closed. Metadata only — it
 * mints nothing and never changes tier counts (summary.proven still comes from the RTM/oracle).
 */
export interface DynamicProofReportInput {
  /** Targets the dynamic pass actually ran this run (existing + generation). */
  attempted: number;
  /** Newly Dynamically Proven this run (informational; the KPI uses the RTM count). */
  proven: number;
  /** needs_setup attempts with their R-1 category + short redacted reason (for dominant-block naming). */
  needsSetup: Array<{ category?: string; reason?: string }>;
}

export interface BehaviorReportDataOptions {
  repoRoot?: string;
  riskLimit?: number;
  /** THIS-RUN dynamic-proof outcome (omit for standalone report regen → ledger-only guidance). */
  dynamicProof?: DynamicProofReportInput;
}

/** Short human phrase per R-1 needs_setup category, for the "blocked because: …" panel copy. */
const BLOCK_CATEGORY_LABEL: Record<string, string> = {
  module_not_found: "a missing module or dependency in the sandbox",
  tsconfig_missing: "a monorepo tsconfig the sandbox can't resolve (a parent config the package extends)",
  experimental_builtin: "an experimental Node builtin that needs a runtime flag",
  engine_mismatch: "the runner Node being outside the declared engines range",
  db_or_external: "a database or external service the sandbox lacks"
};

/**
 * Group this run's needs_setup attempts by R-1 category and name the most common one. NOT a new
 * classifier — it only tallies the category/reason autoProve already returned. Attempts with no
 * category (unrunnable setup) fall into a generic "setup/runnability" bucket.
 */
export function dominantBlockReason(
  needsSetup: ReadonlyArray<{ category?: string; reason?: string }>
): { label: string; count: number; total: number; category: string } | null {
  if (needsSetup.length === 0) return null;
  const counts = new Map<string, number>();
  for (const a of needsSetup) {
    const key = a.category && BLOCK_CATEGORY_LABEL[a.category] ? a.category : "runnability";
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  let topKey = "runnability";
  let top = 0;
  for (const [k, c] of counts) {
    if (c > top) {
      top = c;
      topKey = k;
    }
  }
  return { label: BLOCK_CATEGORY_LABEL[topKey] ?? "setup/runnability of the test in the sandbox", count: top, total: needsSetup.length, category: topKey };
}

/**
 * G1: category-specific smallest next step for the dominant blocker (display
 * copy only; the guide lives in proofDoctor so doctor/CLI/report share one
 * source). Unknown/uncategorized falls back to the generic handoff action.
 */
function nextStepFor(dom: { category: string } | null): string | null {
  if (!dom) return null;
  const key = dom.category === "runnability" ? "setup_failed" : dom.category;
  const guide = (PROOF_BLOCKER_GUIDE as Record<string, { next_step: string }>)[key];
  return guide ? `Next: ${guide.next_step}` : null;
}

function nodeFile(node: GraphNode | undefined): string {
  if (!node) return "";
  if (typeof node.properties.file === "string") return node.properties.file;
  return node.provenance.source_ref ?? "";
}

function groupOf(file: string): string {
  const parts = file.split("/").filter(Boolean);
  if (parts[0] === "packages" && parts[1]) return parts[1];
  return parts[0] ?? "core";
}

function symbolDisplay(id: string, nodesById: Map<string, GraphNode>): string {
  const node = nodesById.get(id);
  return node?.title || id.replace(/^sym:/, "").split("#").pop() || id;
}

function nodeDescription(id: string, nodesById: Map<string, GraphNode>): string {
  const node = nodesById.get(id);
  const candidate =
    node?.properties.behavior_description ??
    node?.properties.description ??
    node?.properties.summary ??
    node?.properties.intent ??
    node?.title;
  return typeof candidate === "string" && candidate.trim() ? candidate.trim() : symbolDisplay(id, nodesById);
}

function serviceName(sig: string): string {
  const base = sig.split(".")[0] || sig;
  return base.replace(/^.*#/, "");
}

function endpointTrigger(node: GraphNode | undefined): { verb: string; path: string } | null {
  if (!node || node.kind !== "Endpoint") return null;
  const method = typeof node.properties.method === "string" ? node.properties.method : "";
  const routePath = typeof node.properties.path === "string" ? node.properties.path : "";
  if (!method && !routePath) return null;
  return { verb: method || "CALL", path: routePath || "/" };
}

/**
 * Every symbol external_id that appears in a static flow (entry points + hop
 * endpoints). Display-only: used to split the untested `none` bucket into
 * "Reachable Untested" (symbol is in a flow) vs "No Signal". Reads existing
 * flow data; mints nothing and touches no tier classification.
 */
function flowSymbolIds(graph: LocalGraph): Set<string> {
  const ids = new Set<string>();
  for (const flow of graph.analysis?.flows?.flows ?? []) {
    ids.add(flow.entry_point.external_id);
    for (const hop of flow.hops) {
      ids.add(hop.from);
      ids.add(hop.to);
    }
  }
  return ids;
}

function isNoneTier(tier: RtmRow["evidence_tier"]): boolean {
  return tier !== "proven" && tier !== "associated" && tier !== "runtime" && tier !== "candidate";
}

function summaryFromRows(rows: RtmRow[], flowIds: Set<string>): BehaviorReportData["summary"] {
  // buildRtm intentionally unions valid proof rows that fall outside the static
  // denominator. They remain visible and count as Dynamically Proven, but must
  // never increase the "Methods found" denominator.
  const denominatorRows = rows.filter((r) => r.off_denominator !== true);
  const proven = rows.filter((r) => r.evidence_tier === "proven").length;
  const provenOutsideDenominator = rows.filter((r) => r.off_denominator === true && r.evidence_tier === "proven").length;
  const associated = denominatorRows.filter((r) => r.evidence_tier === "associated" || r.evidence_tier === "runtime").length;
  const candidate = denominatorRows.filter((r) => r.evidence_tier === "candidate").length;
  const noneRows = denominatorRows.filter((r) => isNoneTier(r.evidence_tier));
  // DISPLAY-ONLY split of `none`: a none-tier symbol that shows up in a static flow is "Reachable Untested".
  const reachableUntested = noneRows.filter((r) => flowIds.has(r.behavior_id)).length;
  return {
    total: denominatorRows.length,
    proven,
    ...(provenOutsideDenominator > 0 ? { provenOutsideDenominator } : {}),
    associated,
    candidate,
    none: noneRows.length,
    reachableUntested,
    noSignal: noneRows.length - reachableUntested
  };
}

/** Verbatim 0-dynamic-proof explainer copy. Rendered only when summary.proven === 0. */
const ZERO_PROOF_EXPLAINER = {
  title: "Why dynamic proof is 0",
  body: [
    "OrangePro mapped behaviors, flows, and static test links without running your app. Dynamic proof requires executing tests in a sandbox and checking whether a test fails when the target behavior is mutated.",
    "The statically linked behaviors have test evidence, but they are not verified yet. Treat them as likely covered, not proven.",
    "OrangePro tries to dynamically prove the top 5 highest-risk behaviors by default. If setup is missing, the report shows the reason, such as missing dependencies, database setup, environment variables, or unsupported test runner configuration."
  ]
} as const;

function pipeline(graph: LocalGraph, ledger: Ledger, summary: BehaviorReportData["summary"]): BehaviorReportData["pipeline"] {
  const endpointCount = graph.nodes.filter((n) => n.kind === "Endpoint").length;
  const implementedIn = graph.edges.filter((e) => e.relationship_type === "IMPLEMENTED_IN").length;
  const calls = graph.edges.filter((e) => e.relationship_type === "CALLS");
  const injectedCalls = calls.filter((e) => e.properties?.call_via === "injected");
  const frameworkCalls = calls.filter((e) => e.evidence_strength === "framework-derived");
  const flowMeta = graph.analysis?.flows;
  const flowCount = flowMeta?.total_flows ?? 0;
  const allSingleHop = flowCount > 0 && (flowMeta?.flows ?? []).every((f) => f.depth <= 1);
  const truncatedHeavy = flowCount > 0 && (flowMeta?.truncated_flows ?? 0) > flowCount / 2;
  const proofAttempted = ledger.records.some((r) => r.dynamic_proof?.proof_kind === "dynamic_targeted");
  return [
    { key: "behaviors", label: "Behaviors", pr: "#146", on: summary.total > 0 ? "1" : "0" },
    { key: "endpoints", label: "Endpoint→handler", pr: "#148", on: implementedIn > 0 ? "1" : endpointCount > 0 ? "partial" : "0" },
    { key: "calls", label: "Hard CALLS (DI)", pr: "#149", on: injectedCalls.length > 0 ? "1" : calls.length > 0 ? "partial" : "0" },
    { key: "fw", label: "Framework-derived", pr: "#150", on: frameworkCalls.length > 0 ? "1" : "0" },
    { key: "flows", label: "Flow walker", pr: "#151", on: flowCount > 0 ? (allSingleHop || truncatedHeavy ? "partial" : "1") : "0" },
    { key: "proof", label: "Dynamic proof", pr: "proof", on: summary.proven > 0 ? "1" : proofAttempted ? "partial" : "0" }
  ];
}

const KEEP_ACTION =
  "Keep generating tests for high-risk gaps and close each one through the proof handoff; Statically Linked signals stay separate.";
const HANDOFF_ACTION =
  "Run OrangePro from a coding agent with a model key; follow the returned proof handoff so the agent generates a runnable test and calls orangepro_prove_loop. Direct CLI users can run prove-loop after writing or choosing a real passing test.";

function proofGuidance(
  ledger: Ledger,
  summary: BehaviorReportData["summary"],
  dyn?: DynamicProofReportInput
): BehaviorReportData["proofGuidance"] {
  if (summary.proven > 0) {
    return {
      state: "proven",
      title: "Dynamically Proven is active",
      body: `${summary.proven.toLocaleString()} behavior${summary.proven === 1 ? "" : "s"} closed with dynamic targeted proof. Each Dynamically Proven row requires a passing baseline, a targeted mutant failure at assertion, and the target running unmocked. Statically Linked signals stay separate.`,
      action: KEEP_ACTION
    };
  }

  // Prefer THIS RUN's dynamic-proof outcome (names the dominant block reason). Static breadth
  // — behaviors, flows, Statically Linked signals — is unaffected; only the dynamic pass is small.
  if (dyn) {
    if (dyn.attempted === 0) {
      return {
        state: "not_started",
        title: "0 Dynamically Proven — dynamic proof was not attempted",
        body: "Dynamic proof was not attempted in this run. Static behavior mapping and Statically Linked signals are still available.",
        action: HANDOFF_ACTION
      };
    }
    const dom = dominantBlockReason(dyn.needsSetup);
    const allBlocked = dyn.needsSetup.length > 0 && dyn.needsSetup.length >= dyn.attempted;
    const plural = dyn.attempted === 1 ? "" : "s";
    if (allBlocked && dom) {
      return {
        state: "attempted",
        title: `0 Dynamically Proven — top ${dyn.attempted} attempted, all setup-blocked`,
        body: `Dynamic proof attempted ${dyn.attempted} target${plural}; all were blocked by ${dom.label} (${dom.count}/${dom.total}). This is a sandbox setup gap, not a static-test failure — the Statically Linked signals are still shown.`,
        action: nextStepFor(dom) ?? HANDOFF_ACTION
      };
    }
    const because = dom ? ` Blocked because: ${dom.label} (${dom.count}/${dom.total}).` : "";
    return {
      state: "attempted",
      title: `0 Dynamically Proven — top ${dyn.attempted} attempted, 0 closed`,
      body: `OrangePro mapped this repo statically. Dynamic proof is a targeted verification pass: it runs existing or generated tests, mutates the exact behavior, and promotes only tests that fail at an assertion. This run attempted the top ${dyn.attempted} eligible behavior${plural} and closed 0.${because} Static test signals stay Statically Linked.`,
      action: nextStepFor(dom) ?? HANDOFF_ACTION
    };
  }

  // Standalone report regen (no THIS-RUN data) → derive from the ledger only.
  const dynamicAttempts = ledger.records.filter((r) => r.dynamic_proof?.proof_kind === "dynamic_targeted");
  if (dynamicAttempts.length > 0) {
    return {
      state: "attempted",
      title: "0 Dynamically Proven — dynamic proof ran, none closed yet",
      body: "OrangePro found dynamic proof attempts in the local ledger, but none satisfied the full Dynamically Proven gate. Static tests still show as Statically Linked only.",
      action: "Use the coding-agent handoff to repair or regenerate the test, then run the provided prove_loop step again."
    };
  }
  return {
    state: "not_started",
    title: "0 Dynamically Proven means no dynamic proof has run yet",
    body: "This report is an analysis pass. It can find behaviors, static test evidence, risk, and reachable flows, but it will not label anything Dynamically Proven until a real test kills a targeted mutant of the behavior.",
    action: HANDOFF_ACTION
  };
}

function scanBlock(graph: LocalGraph, rows: RtmRow[]): BehaviorReportData["scan"] {
  const services = new Map<string, number>();
  for (const row of rows) {
    const sig = row.behavior || row.code_symbol;
    const name = serviceName(sig);
    if (!name) continue;
    services.set(name, (services.get(name) ?? 0) + 1);
  }
  const tests = graph.nodes.filter((n) => n.kind === "TestCase");
  const integration = tests.filter((n) => n.properties.test_layer === "integration" || n.properties.test_layer === "api" || n.properties.test_layer === "e2e").length;
  const unit = tests.filter((n) => n.properties.test_layer === "unit" || n.properties.test_layer === "component").length;
  const denominator = graph.analysis?.denominator;
  const excludedCount =
    (denominator?.excluded_boilerplate ?? 0) +
    (denominator?.excluded_infra ?? 0) +
    (denominator?.excluded_generated ?? 0) +
    (denominator?.excluded_test_inferred ?? 0);
  return {
    services: [...services.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).slice(0, 50),
    serviceTotal: services.size,
    tests: { total: tests.length, integration, unit },
    excluded: {
      count: excludedCount > 0 ? String(excludedCount) : "0",
      text: "non-behavior symbols were excluded from the behavior count — generated code, framework internals, test-inferred flows, and infrastructure plumbing."
    }
  };
}

function behaviorLists(rows: RtmRow[], flowIds: Set<string>): Pick<BehaviorReportData, "behaviorGroups" | "behaviors"> {
  const groups = new Map<string, number>();
  const behaviors = rows.map((row) => {
    const group = groupOf(row.file);
    groups.set(group, (groups.get(group) ?? 0) + 1);
    const tier: "proven" | "assoc" | "candidate" | "none" =
      row.evidence_tier === "proven"
        ? "proven"
        : row.evidence_tier === "associated" || row.evidence_tier === "runtime"
          ? "assoc"
          : row.evidence_tier === "candidate"
            ? "candidate"
            : "none";
    return {
      sig: row.behavior || row.code_symbol,
      group,
      file: row.file,
      tier,
      // DISPLAY-ONLY: whether this symbol appears in a static flow (splits none → Reachable Untested vs No Signal).
      reachable: flowIds.has(row.behavior_id),
      desc: row.suggested_next_test || row.test_signal || row.status
    };
  });
  return {
    behaviorGroups: [...groups.entries()].map(([key, count]) => ({ key, count })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    behaviors
  };
}

/**
 * Severity is RELATIVE to this repo's own score distribution, mirroring the
 * blast-radius tier table (>=0.75 of max -> Tier 0/critical, >=0.50 -> high,
 * >=0.25 -> medium). Absolute cutoffs (old: 500/200) were calibrated to the
 * pre-normalization scale and could never fire after ORS de-saturation — every
 * risk rendered "medium". Relative bucketing also matches the methodology:
 * ORS is a structural risk *indicator*, never an absolute risk claim.
 */
function riskBucket(score: number, maxScore: number): "critical" | "high" | "medium" | null {
  if (score <= 0 || maxScore <= 0) return null;
  const rel = score / maxScore;
  if (rel >= 0.75) return "critical";
  if (rel >= 0.5) return "high";
  if (rel >= 0.25) return "medium";
  return "medium";
}

function flowWhy(flow: BehaviorFlow, proof: "proven" | "none"): string {
  const tier = flow.flow_tier === "framework-derived: reachable" ? "framework-derived reachable" : "hard reachable";
  const proofText = proof === "proven" ? "the entry behavior has dynamic proof" : "no dynamic proof exercises this chain yet";
  return `This chain is ${tier}; ${proofText}. Reachability is static and is not an execution claim.`;
}

function flows(graph: LocalGraph, rows: RtmRow[], risks: RiskGap[]): BehaviorReportFlow[] {
  const maxRiskScore = risks.reduce((m, r) => Math.max(m, r.risk_score), 0);
  const nodesById = new Map(graph.nodes.map((n) => [n.external_id, n]));
  const proven = new Set(rows.filter((r) => r.evidence_tier === "proven").map((r) => r.behavior_id));
  const riskById = new Map(risks.map((r) => [r.id, r]));
  return (graph.analysis?.flows?.flows ?? []).map((flow) => {
    const rootNode = nodesById.get(flow.entry_point.external_id);
    const trigger = endpointTrigger(rootNode);
    const root_entry = rootNode ? isEntryPoint(rootNode) : false;
    const proof: "proven" | "none" = proven.has(flow.entry_point.external_id) || proven.has(flow.hops[0]?.from ?? "") ? "proven" : "none";
    const steps = [
      {
        sig: symbolDisplay(flow.hops[0]?.from ?? flow.entry_point.external_id, nodesById),
        tier: "hard" as const,
        edge: null,
        desc: nodeDescription(flow.hops[0]?.from ?? flow.entry_point.external_id, nodesById)
      },
      ...flow.hops.map((hop) => ({
        sig: symbolDisplay(hop.to, nodesById),
        tier: hop.evidence_strength,
        edge: hop.evidence_strength,
        desc: nodeDescription(hop.to, nodesById)
      }))
    ];
    const services = new Set(steps.map((s) => serviceName(s.sig)).filter(Boolean)).size;
    const risk = riskById.get(flow.entry_point.external_id) ?? riskById.get(flow.hops[0]?.from ?? "");
    return {
      title: flow.entry_point.title || flow.entry_point.external_id,
      trigger,
      root_entry,
      risk: risk ? riskBucket(risk.risk_score, maxRiskScore) : null,
      proof,
      services,
      flow_tier: flow.flow_tier,
      why: flowWhy(flow, proof),
      steps
    };
  });
}

/** Report-only reader of analysis.candidate_flows — never touches deterministic flows or tiers. */
function candidateFlows(graph: LocalGraph): BehaviorReportCandidateFlows | null {
  const meta = graph.analysis?.candidate_flows;
  if (!meta) return null;
  const nodesById = new Map(graph.nodes.map((n) => [n.external_id, n]));
  return {
    proposed: meta.rejections.proposed,
    accepted: meta.rejections.accepted,
    model: `${meta.provenance.model_provider}/${meta.provenance.model_name}`,
    prompt_version: meta.provenance.prompt_version,
    flows: meta.flows.map((flow) => ({
      title: flow.title || flow.entry_point.title || flow.entry_point.external_id,
      confidence: flow.confidence,
      rationale: flow.rationale ?? "",
      steps: [
        {
          sig: symbolDisplay(flow.hops[0]?.from ?? flow.entry_point.external_id, nodesById),
          desc: nodeDescription(flow.hops[0]?.from ?? flow.entry_point.external_id, nodesById),
          hop: null
        },
        ...flow.hops.map((hop) => ({
          sig: symbolDisplay(hop.to, nodesById),
          desc: nodeDescription(hop.to, nodesById),
          hop: hop.hop_status
        }))
      ]
    }))
  };
}

/** Tier sort rank: Proven first, then Test signal, Reachable, No signal. */
function tierRank(b: { tier: string; reachable: boolean }): number {
  if (b.tier === "proven") return 0;
  if (b.tier === "assoc") return 1;
  return b.reachable ? 2 : 3;
}

/**
 * Link REAL generated tests (graph.generated_tests) to a risk row: exact
 * target-symbol match first, then same-file. Metadata shown is honest and
 * verbatim (title, test_type, framework hint, weak-evidence disclosure, body)
 * — nothing is fabricated; no tests ⇒ the template hides the section.
 */
function riskGeneratedTests(
  graph: LocalGraph,
  gap: RiskGap,
  riskIds: ReadonlySet<string>,
  isFirstRowForFile: boolean
): BehaviorReportData["risks"][number]["generatedTests"] {
  const all = graph.generated_tests ?? [];
  const fileOf = (sym: string | undefined) => sym?.match(/^sym:(.+)#/)?.[1];
  // Exact target wins. The same-file fallback (test targets an UNLISTED symbol
  // in this file) attaches to exactly ONE deterministic row — the file's first
  // (highest-ranked) risk row — and is labeled "same-file target" so a real
  // generated test never reads as generated FOR a sibling behavior.
  const linked = all.flatMap((t) => {
    if (!t.target_symbol_external_id) return [];
    if (t.target_symbol_external_id === gap.id) return [{ t, sameFile: false }];
    if (riskIds.has(t.target_symbol_external_id)) return [];
    if (!isFirstRowForFile) return [];
    return fileOf(t.target_symbol_external_id) === gap.file ? [{ t, sameFile: true }] : [];
  });
  // Mutually exclusive display: when ANY runnable generated test exists for
  // this target, English intents are suppressed — intents are strictly the
  // fallback for environments where runnable code was withheld. Never mix.
  const runnableLinked = linked.filter(({ t }) => t.runnable !== false);
  const shown = runnableLinked.length > 0 ? runnableLinked : linked;
  return shown.slice(0, 2).map(({ t, sameFile }) => ({
    name: t.title,
    concern: t.test_type && t.test_type !== "unknown" ? t.test_type : undefined,
    bucket: t.bucket,
    // The "English intent" marker renders ONCE, as the badge next to the name —
    // the assertion line stays pure metadata (framework, same-file, disclosure).
    assertion: [
      sameFile ? "same-file target" : "",
      t.framework_hint,
      t.weak_evidence_used ? "weak evidence disclosed" : ""
    ]
      .filter(Boolean)
      .join(" · "),
    code: t.body,
    runnable: t.runnable !== false
  }));
}

/** Incoming refs are method-attributed and can be fractional when a file-level
 * reference is split across its symbols. Preserve that weighting honestly. */
function fmtRefs(n: number): string {
  return Number.isInteger(n) ? String(n) : n.toFixed(1);
}

function displayTitle(title: string, file: string): string {
  if (title.includes(".")) return title;
  const pkg = file && file.includes("/") ? file.split("/").slice(-2, -1)[0] : "";
  return pkg ? `${pkg}.${title}` : title;
}

/** Deterministic 1–2 line behavior context from graph facts only — no LLM.
 *  Sensitivity label mirrors deriveDataSensitivity's tiers. */
function riskContext(risk: RiskGap): string {
  const sens =
    (risk.data_sensitivity ?? 1) >= 10 ? "payment/billing-sensitive"
      : (risk.data_sensitivity ?? 1) >= 9 ? "auth/session-sensitive"
        : (risk.data_sensitivity ?? 1) >= 7 ? "order/transaction"
          : (risk.data_sensitivity ?? 1) >= 6 ? "customer/user-data"
            : (risk.data_sensitivity ?? 1) >= 3 ? "notification/webhook"
              : "";
  const pos = (risk.flow_position ?? 0) >= 5
    ? "an entry point"
    : (risk.flow_position ?? 0) >= 3
      ? `${5 - (risk.flow_position ?? 0)} call${5 - (risk.flow_position ?? 0) === 1 ? "" : "s"} from the nearest entry point`
      : "deep in the call graph";
  const refs = fmtRefs(risk.incoming_refs);
  const churn = risk.churn_available !== false
    ? `${risk.git_churn} line${risk.git_churn === 1 ? "" : "s"} changed in 180 days`
    : "Git churn unavailable (provisional static-only ranking)";
  const parts = [
    `Sits at ${pos}${sens ? ` on ${sens} paths` : ""}.`,
    `${refs} weighted incoming reference${risk.incoming_refs === 1 ? "" : "s"}, ${risk.fan_out ?? 0} downstream call${(risk.fan_out ?? 0) === 1 ? "" : "s"}, ${churn} — and no test proves its behavior.`
  ];
  return parts.join(" ");
}



/** Snapshot of one run, persisted so the NEXT run can show what changed. */
export interface ReportBaseline {
  ts: string;
  summary: BehaviorReportData["summary"];
  riskPaths: string[]; // top-20 in rank order
  generatedTotal: number;
}

export interface ReportDelta {
  baselineTs: string;
  changed: boolean;
  totalDelta: number;
  provenDelta: number;
  associatedDelta: number;
  candidateDelta: number;
  noneDelta: number;
  newRisks: string[];      // entered the top-20
  droppedRisks: string[];  // left the top-20
  generatedDelta: number;
}

/** Pure delta between a persisted baseline and the current report data.
 *  Deterministic: same inputs, same delta. */
export function computeReportDelta(prev: ReportBaseline, cur: BehaviorReportData): ReportDelta {
  const curPaths = cur.risks.map((r) => r.path);
  const prevSet = new Set(prev.riskPaths);
  const curSet = new Set(curPaths);
  const newRisks = curPaths.filter((p) => !prevSet.has(p));
  const droppedRisks = prev.riskPaths.filter((p) => !curSet.has(p));
  const d: ReportDelta = {
    baselineTs: prev.ts,
    changed: false,
    totalDelta: cur.summary.total - prev.summary.total,
    provenDelta: cur.summary.proven - prev.summary.proven,
    associatedDelta: cur.summary.associated - prev.summary.associated,
    candidateDelta: cur.summary.candidate - prev.summary.candidate,
    noneDelta: cur.summary.none - prev.summary.none,
    newRisks,
    droppedRisks,
    generatedDelta: cur.generatedTotal - prev.generatedTotal
  };
  d.changed =
    d.totalDelta !== 0 || d.provenDelta !== 0 || d.associatedDelta !== 0 || d.candidateDelta !== 0 ||
    d.noneDelta !== 0 || d.generatedDelta !== 0 || newRisks.length > 0 || droppedRisks.length > 0;
  return d;
}

export function reportBaselineOf(cur: BehaviorReportData, ts: string): ReportBaseline {
  return { ts, summary: cur.summary, riskPaths: cur.risks.map((r) => r.path), generatedTotal: cur.generatedTotal };
}

/** Deterministic system-map model: trigger lanes → deepest services reached,
 *  weighted by flow traffic, tier-mixed, risk-ringed. Pure function of report
 *  data — identical every run; the map IS the determinism demo. */
export interface SystemMapModel {
  lanes: Array<{ id: string; label: string; flows: number }>;
  services: Array<{
    id: string;
    label: string;
    flows: number;
    tiers: { proven: number; assoc: number; candidate: number; none: number };
    riskRanks: number[];
    critical: boolean;
    /** Aggregated "everything below the cut" node for one lane — keeps each
     *  lane's drawn edges summing to its stated flow count. */
    rest?: { services: number };
  }>;
  edges: Array<{ lane: string; service: string; flows: number }>;
}

interface TriggerLane { id: string; label: string; priority: number }

const HTTP_TRIGGER_VERBS = new Set(["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS", "HEAD", "ALL"]);
const GRAPHQL_TRIGGER_VERBS = new Set(["MUTATION", "QUERY", "SUBSCRIPTION"]);

/** Map every trigger into a stable lane. Known protocol families get friendly
 * labels; unknown framework adapters still receive a deterministic lane rather
 * than being silently deleted from the system map. */
export function laneForTrigger(trigger: { verb: string; path: string }): TriggerLane {
  const verb = (trigger.verb || "OTHER").trim().toUpperCase();
  const triggerPath = (trigger.path || "").toLowerCase();
  if (HTTP_TRIGGER_VERBS.has(verb) || triggerPath.startsWith("http:")) return { id: "http", label: "HTTP", priority: 20 };
  if (GRAPHQL_TRIGGER_VERBS.has(verb) || triggerPath.startsWith("graphql:")) return { id: "graphql", label: "GraphQL", priority: 10 };
  if (["JOB", "QUEUE", "PROCESS", "WORKER"].includes(verb) || triggerPath.startsWith("queue:")) return { id: "job", label: "Jobs", priority: 30 };
  if (["SCHEDULE", "CRON", "TIMER"].includes(verb) || triggerPath.startsWith("schedule:") || triggerPath.startsWith("cron:")) return { id: "schedule", label: "Scheduled", priority: 40 };
  if (["EVENT", "MESSAGE", "CONSUME", "CONSUMER", "SUBSCRIBE"].includes(verb) || triggerPath.startsWith("event:")) return { id: "event", label: "Events", priority: 50 };
  if (["COMMAND", "CLI"].includes(verb) || triggerPath.startsWith("cli:")) return { id: "cli", label: "CLI", priority: 60 };
  if (["RPC", "GRPC"].includes(verb) || triggerPath.startsWith("rpc:") || triggerPath.startsWith("grpc:")) return { id: "rpc", label: "RPC", priority: 70 };
  const id = verb.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "other";
  const label = verb
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
    .map((part) => part[0].toUpperCase() + part.slice(1))
    .join(" ") || "Other";
  return { id, label, priority: 100 };
}

function ownerOfSig(sig: string): string {
  const base = sig.includes("#") ? sig.slice(sig.indexOf("#") + 1) : sig;
  return base.includes(".") ? base.slice(0, base.indexOf(".")) : base;
}

export function buildSystemMapModel(data: {
  flows: BehaviorReportFlow[];
  risks: BehaviorReportData["risks"];
  behaviors: BehaviorReportData["behaviors"];
}, maxServices = 12): SystemMapModel {
  // Pass 1: how many trigger flows does each owner appear in? Shared
  // infrastructure (config drivers, exception handlers, caches) appears in
  // nearly all of them — the LAST-step heuristic crowned exactly that plumbing
  // on a full-scale repo. A flow's representative service is its most
  // DISTINCTIVE owner: lowest global frequency, deepest step on ties, with
  // near-ubiquitous owners eligible only when a flow touches nothing else.
  const laneForFlow = (flow: (typeof data.flows)[number]): TriggerLane | null => {
    if (flow.trigger) return laneForTrigger(flow.trigger);
    // A program root without a framework trigger is still a real product entry
    // point (CLI/main). Internal call-graph roots remain excluded.
    return flow.root_entry ? { id: "entry", label: "Entry points", priority: 80 } : null;
  };
  const triggerFlows = data.flows.filter((flow) => laneForFlow(flow) !== null);
  const laneMeta = new Map<string, TriggerLane>();
  for (const flow of triggerFlows) {
    const lane = laneForFlow(flow)!;
    laneMeta.set(lane.id, lane);
  }
  const laneOrder = [...laneMeta.values()]
    .sort((a, b) => a.priority - b.priority || a.label.localeCompare(b.label) || a.id.localeCompare(b.id))
    .map((lane) => lane.id);
  const ownerFreq = new Map<string, number>();
  for (const f of triggerFlows) {
    const seen = new Set<string>();
    for (const st of f.steps ?? []) {
      const o = ownerOfSig(st.sig);
      if (o && !seen.has(o)) {
        seen.add(o);
        ownerFreq.set(o, (ownerFreq.get(o) ?? 0) + 1);
      }
    }
  }
  const infraCutoff = Math.max(3, Math.floor(triggerFlows.length * 0.4));
  const isSharedInfra = (o: string) => (ownerFreq.get(o) ?? 0) >= infraCutoff;

  const laneFlows = new Map<string, number>();
  const svcFlows = new Map<string, number>();
  const edgeFlows = new Map<string, number>();
  const svcLaneFlows = new Map<string, Map<string, number>>();
  for (const f of triggerFlows) {
    const lane = laneForFlow(f)!;
    const steps = f.steps ?? [];
    let svc = "";
    let bestFreq = Infinity;
    let bestDepth = -1;
    for (let i = 0; i < steps.length; i++) {
      const o = ownerOfSig(steps[i].sig);
      if (!o || isSharedInfra(o)) continue;
      const freq = ownerFreq.get(o) ?? 0;
      if (freq < bestFreq || (freq === bestFreq && i > bestDepth)) {
        svc = o;
        bestFreq = freq;
        bestDepth = i;
      }
    }
    if (!svc) {
      // Flow touches only shared infra — fall back to its deepest step.
      const last = steps.length ? steps[steps.length - 1] : undefined;
      svc = last ? ownerOfSig(last.sig) : "";
    }
    if (!svc) continue;
    laneFlows.set(lane.id, (laneFlows.get(lane.id) ?? 0) + 1);
    svcFlows.set(svc, (svcFlows.get(svc) ?? 0) + 1);
    const key = lane.id + "\u0000" + svc;
    edgeFlows.set(key, (edgeFlows.get(key) ?? 0) + 1);
    const perLane = svcLaneFlows.get(svc) ?? new Map<string, number>();
    perLane.set(lane.id, (perLane.get(lane.id) ?? 0) + 1);
    svcLaneFlows.set(svc, perLane);
  }
  const laneRank = (svc: string): number => {
    const perLane = svcLaneFlows.get(svc);
    if (!perLane) return 99;
    let best = "";
    let bestN = -1;
    for (const [l, n] of perLane) if (n > bestN) { best = l; bestN = n; }
    return laneOrder.indexOf(best);
  };
  const byTraffic = [...svcFlows.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  const chosen = new Set<string>();
  // 1) Every lane is guaranteed its top 2 services — a lane with 56 flows must
  //    never render edge-less just because its traffic is spread thin.
  for (const laneId of laneOrder) {
    let taken = 0;
    for (const [svc] of byTraffic) {
      if (taken >= 2) break;
      if (laneRank(svc) === laneOrder.indexOf(laneId) && !chosen.has(svc)) {
        chosen.add(svc);
        taken++;
      }
    }
  }
  // 2) Top-risk owners with real flow traffic join the map (up to 3) so the
  //    red rings — the whole point of the overlay — survive full scale.
  let riskAdds = 0;
  for (const r of data.risks) {
    if (riskAdds >= 3) break;
    const owner = ownerOfSig(r.path);
    if ((svcFlows.get(owner) ?? 0) > 0 && !chosen.has(owner)) {
      chosen.add(owner);
      riskAdds++;
    }
  }
  // 3) Fill remaining slots by global traffic.
  for (const [svc] of byTraffic) {
    if (chosen.size >= maxServices + riskAdds) break;
    chosen.add(svc);
  }
  const top = byTraffic
    .filter(([svc]) => chosen.has(svc))
    // Group vertically under each service's dominant lane so edges flow in
    // bands instead of crossing the whole canvas.
    .sort((a, b) => laneRank(a[0]) - laneRank(b[0]) || b[1] - a[1] || a[0].localeCompare(b[0]));
  const topSet = new Set(top.map(([k]) => k));

  const tiersBySvc = new Map<string, { proven: number; assoc: number; candidate: number; none: number }>();
  for (const b of data.behaviors) {
    const svc = ownerOfSig(b.sig);
    if (!topSet.has(svc)) continue;
    const t = tiersBySvc.get(svc) ?? { proven: 0, assoc: 0, candidate: 0, none: 0 };
    if (b.tier === "proven") t.proven++;
    else if (b.tier === "assoc") t.assoc++;
    else if (b.tier === "candidate") t.candidate++;
    else t.none++;
    tiersBySvc.set(svc, t);
  }
  const riskBySvc = new Map<string, { ranks: number[]; critical: boolean }>();
  for (const r of data.risks) {
    const svc = ownerOfSig(r.path);
    if (!topSet.has(svc)) continue;
    const e = riskBySvc.get(svc) ?? { ranks: [], critical: false };
    e.ranks.push(r.rank);
    if (r.tags.some(([label, kind]) => kind === "risk" && label.startsWith("critical"))) e.critical = true;
    riskBySvc.set(svc, e);
  }

  // Conservation: edges drawn per lane must sum to the lane's stated count.
  // Everything below the cut aggregates into one dashed "+N more services"
  // node per lane — 51 job flows must never silently vanish.
  const shownEdges = [...edgeFlows.entries()]
    .map(([k, flows]) => ({ lane: k.split("\u0000")[0], service: k.split("\u0000")[1], flows }))
    .filter((e) => topSet.has(e.service));
  const shownPerLane = new Map<string, number>();
  for (const e of shownEdges) shownPerLane.set(e.lane, (shownPerLane.get(e.lane) ?? 0) + e.flows);
  const restNodes: SystemMapModel["services"] = [];
  const restEdges: SystemMapModel["edges"] = [];
  for (const laneId of laneOrder) {
    const total = laneFlows.get(laneId) ?? 0;
    const shown = shownPerLane.get(laneId) ?? 0;
    if (total - shown <= 0) continue;
    const hiddenSvcs = new Set<string>();
    for (const [k, n] of edgeFlows) {
      const [l, svc] = k.split("\u0000");
      if (l === laneId && !topSet.has(svc) && n > 0) hiddenSvcs.add(svc);
    }
    const restId = "rest:" + laneId;
    restNodes.push({
      id: restId,
      label: "+" + hiddenSvcs.size + " more services",
      flows: total - shown,
      tiers: { proven: 0, assoc: 0, candidate: 0, none: 0 },
      riskRanks: [],
      critical: false,
      rest: { services: hiddenSvcs.size }
    });
    restEdges.push({ lane: laneId, service: restId, flows: total - shown });
  }
  return {
    lanes: laneOrder
      .filter((id) => laneFlows.has(id))
      .map((id) => ({ id, label: laneMeta.get(id)?.label ?? id, flows: laneFlows.get(id) ?? 0 })),
    services: [
      ...top.map(([label, flows]) => ({
        id: label,
        label,
        flows,
        tiers: tiersBySvc.get(label) ?? { proven: 0, assoc: 0, candidate: 0, none: 0 },
        riskRanks: (riskBySvc.get(label)?.ranks ?? []).sort((a, b) => a - b),
        critical: riskBySvc.get(label)?.critical ?? false
      })),
      ...restNodes
    ],
    edges: [...shownEdges, ...restEdges].sort(
      (a, b) => a.lane.localeCompare(b.lane) || b.flows - a.flows || a.service.localeCompare(b.service)
    )
  };
}

/** Deterministic per-risk APPLICABLE concern categories — derived from graph
 *  facts, never from whether tests exist. Covered = what attached tests
 *  address (via bucket). Locked pills = applicable − covered: the platform
 *  generates those categories; nothing pretends hidden tests already exist. */
const CONCERN_ORDER = ["contract", "authorization_safety", "boundary_limits", "integration_flow", "state_lifecycle", "failure_recovery", "data_integrity", "concurrency_ordering"] as const;

function riskApplicableConcerns(risk: RiskGap, verb: string): string[] {
  const out = new Set<string>(["contract"]); // an observable behavior always has a contract to verify
  const sens = risk.data_sensitivity ?? 1;
  if (sens >= 9) out.add("authorization_safety");
  if (sens >= 6) out.add("data_integrity");
  if (risk.entry_point || verb !== "BEHAVIOR") out.add("boundary_limits"); // external inputs cross here
  if ((risk.flow_position ?? 0) >= 3 || (risk.fan_out ?? 0) >= 1) out.add("integration_flow");
  if ((risk.fan_out ?? 0) >= 1 && risk.git_churn > 0) out.add("state_lifecycle");
  if ((risk.fan_out ?? 0) >= 2) out.add("failure_recovery"); // downstream dependencies can fail
  if (/job|queue|cron|stream|lock|worker/i.test(risk.title + " " + risk.file)) out.add("concurrency_ordering");
  return CONCERN_ORDER.filter((c) => out.has(c));
}

const BUCKET_TO_CONCERN: Record<string, string> = {
  happy_path: "contract",
  validation_error: "contract",
  edge_case: "boundary_limits",
  regression: "failure_recovery",
  security_privacy: "authorization_safety",
  integration_flow: "integration_flow"
};

/** State-aware next step — varies by attached tests, trigger kind, signal, and
 *  sensitivity, so no two cards read identically for different reasons. */
function riskTodo(
  risk: RiskGap,
  verb: string,
  path: string,
  generatedTests: Array<{ runnable?: boolean }>
): string {
  if (generatedTests.length && generatedTests.every((t) => t.runnable !== false)) {
    return "Run the generated test below in your repo; follow its prove handoff so a mutation failure can mint Dynamically Proven.";
  }
  if (generatedTests.length) {
    return "Install this repo's dependencies / set up the test runner, then re-run `opro start` to turn the English intents below into runnable tests.";
  }
  const call =
    verb !== "BEHAVIOR"
      ? `issues ${verb} ${path}`
      : risk.entry_point
        ? `invokes ${displayTitle(risk.title, risk.file)} through its entry point`
        : `calls ${displayTitle(risk.title, risk.file)} directly`;
  const sens = (risk.data_sensitivity ?? 1) >= 10
    ? " Include a failure case: a rejected payment must leave no partial state."
    : (risk.data_sensitivity ?? 1) >= 9
      ? " Include a negative case: invalid or expired credentials must fail closed."
      : (risk.data_sensitivity ?? 1) >= 7
        ? " Include a failure case: a rejected transaction must leave no partial state."
        : "";
  if (risk.integration_signal === "candidate") {
    return `A similarly named test exists but nothing links it. Write a test that imports and ${call}, asserting the observable outcome — that upgrades this from unconfirmed candidate to a hard link.${sens}`;
  }
  return `No test signal exists. Start with one integration test that ${call} and asserts the observable outcome.${sens}`;
}

function riskRows(risks: RiskGap[], graph: LocalGraph): BehaviorReportData["risks"] {
  const maxRiskScore = risks.reduce((m, r) => Math.max(m, r.risk_score), 0);
  const riskIds = new Set(risks.map((r) => r.id));
  const firstRowForFile = new Map<string, string>();
  for (const r of risks) if (!firstRowForFile.has(r.file)) firstRowForFile.set(r.file, r.id);
  // Ambiguity-qualified display: identical titles from DIFFERENT files
  // (multi-program repos: 76 x main) get their top-level dir as a prefix.
  // Purely display; single-file titles render unchanged everywhere else.
  const titleFiles = new Map<string, Set<string>>();
  for (const r of risks) {
    const t = (r.title || "").split("(")[0].trim();
    if (!titleFiles.has(t)) titleFiles.set(t, new Set());
    titleFiles.get(t)!.add(r.file);
  }
  const qualify = (risk: RiskGap, path: string): string => {
    const t = (risk.title || "").split("(")[0].trim();
    if ((titleFiles.get(t)?.size ?? 0) <= 1) return path;
    const top = (risk.file || "").split("/").filter(Boolean)[0] ?? "";
    return top ? `${top}: ${path}` : path;
  };
  return risks.map((risk, idx) => {
    const methodMatch = risk.title.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i);
    const tags: Array<[label: string, kind: "risk" | "info" | "entry"]> = [];
    const bucket = riskBucket(risk.risk_score, maxRiskScore);
    if (risk.churn_available === false) tags.push(["provisional rank", "info"]);
    else if (bucket) tags.push([`${bucket} risk`, "risk"]);
    tags.push([`${fmtRefs(risk.incoming_refs)} weighted refs`, "info"]);
    if (risk.entry_point) tags.push(["Entry point", "entry"]);
    return {
      rank: idx + 1,
      ...(() => {
        const generatedTests = riskGeneratedTests(graph, risk, riskIds, firstRowForFile.get(risk.file) === risk.id);
        const verb = methodMatch?.[1]?.toUpperCase() ?? "BEHAVIOR";
        const path = qualify(risk, methodMatch?.[2] ?? displayTitle(risk.title, risk.file));
        const generatedCategories = [...new Set([
          ...generatedTests.map((t) => (t.bucket ? BUCKET_TO_CONCERN[t.bucket] : undefined)),
          // An integration/api/e2e-layer draft targets integration_flow. This
          // remains generation metadata until dynamic proof closes.
          ...generatedTests.map((t) => (t.concern === "integration" || t.concern === "api" || t.concern === "e2e" ? "integration_flow" : undefined))
        ].filter((c): c is string => Boolean(c)))];
        return {
          generatedTests,
          applicableCategories: riskApplicableConcerns(risk, verb),
          generatedCategories,
          verb,
          path,
          todo: riskTodo(risk, verb, path, generatedTests)
        };
      })(),
      context: riskContext(risk),
      desc: risk.reasons.join(" · "),
      tags
    };
  });
}

function frameworkLabel(graph: LocalGraph): string {
  const frameworks = graph.nodes
    .filter((n) => n.kind === "Framework")
    .map((n) => n.title || n.external_id.replace(/^framework:/, ""))
    .sort();
  return frameworks.length ? frameworks.slice(0, 4).join(", ") : "Unknown framework";
}

export function buildBehaviorReportData(graph: LocalGraph, ledger: Ledger, opts: BehaviorReportDataOptions = {}): BehaviorReportData {
  const { rows } = buildRtm(graph, ledger);
  const flowIds = flowSymbolIds(graph);
  const summary = summaryFromRows(rows, flowIds);
  const repoRoot = opts.repoRoot ?? graph.workspace.root;
  const riskGaps = rankRiskGaps(graph, { repoRoot, limit: opts.riskLimit ?? 20, maxPerFile: 3, maxPerTitle: 1 });
  const riskHealth = inspectRiskInputHealth(repoRoot);
  const churnAvailable = riskHealth.churnAvailable && riskGaps.every((risk) => risk.churn_available !== false);
  const provenance: BehaviorReportData["provenance"] = {
    source: path.basename(repoRoot || graph.workspace.name || "repo"),
    gitRoot: riskHealth.gitRoot ? path.basename(riskHealth.gitRoot) : null,
    commit: riskHealth.commit,
    history: riskHealth.history,
    churn: churnAvailable ? "available" : "unavailable",
    churnWindow: riskHealth.churnWindow,
    toolVersion: ORANGEPRO_VERSION,
    inputFingerprint: createHash("sha256")
      .update(JSON.stringify({ root: graph.workspace.root_hash, commit: riskHealth.commit, history: riskHealth.history, churn: churnAvailable, window: riskHealth.churnWindow, version: ORANGEPRO_VERSION }))
      .digest("hex")
      .slice(0, 16),
    reason: churnAvailable ? undefined : (riskHealth.reason ?? "Git churn scan did not complete")
  };
  const lists = behaviorLists(rows, flowIds);
  const risks = riskRows(riskGaps, graph);
  const sortedBehaviors = [...lists.behaviors].sort((a, b) => tierRank(a) - tierRank(b));
  const flowRows = flows(graph, rows, riskGaps);
  return {
    repo: path.basename(repoRoot || graph.workspace.name || "repo"),
    scanned: (graph.updated_at || graph.created_at || new Date(0).toISOString()).slice(0, 10),
    framework: frameworkLabel(graph),
    analysisKind: summary.proven > 0 ? "static+dynamic" : "static",
    provenance,
    summary,
    proofGuidance: proofGuidance(ledger, summary, opts.dynamicProof),
    pipeline: pipeline(graph, ledger, summary),
    scan: scanBlock(graph, rows),
    behaviorGroups: lists.behaviorGroups,
    // Proven first so the strongest evidence leads the grid (stable within tiers).
    behaviors: sortedBehaviors,
    flows: flowRows,
    candidateFlows: candidateFlows(graph),
    risks,
    zeroProofExplainer: summary.proven === 0 ? { title: ZERO_PROOF_EXPLAINER.title, body: [...ZERO_PROOF_EXPLAINER.body] } : null,
    mapModel: buildSystemMapModel({ flows: flowRows, risks, behaviors: sortedBehaviors }),
    viewMeta: {
      // Every denominator behavior is scored; the risks tab surfaces the top N.
      risks: { shown: risks.length, scored: summary.total },
      flows: {
        shown: graph.analysis?.flows?.total_flows ?? 0,
        prunedByCaps:
          (graph.analysis?.flows?.dropped?.max_depth ?? 0) +
          (graph.analysis?.flows?.dropped?.max_flows_per_entry ?? 0) +
          (graph.analysis?.flows?.dropped?.global_cap ?? 0)
      }
    },
    generatedTotal: graph.generated_tests?.length ?? 0,
    shownCount: risks.reduce((acc, r) => acc + r.generatedTests.length, 0)
  };
}
