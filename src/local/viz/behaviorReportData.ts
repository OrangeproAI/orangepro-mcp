import path from "node:path";
import type { BehaviorFlow, GraphNode, LocalGraph } from "../graph/ontology.js";
import type { Ledger } from "../ledger.js";
import { buildRtm, type RtmRow } from "../rtm.js";
import { rankRiskGaps, type RiskGap } from "../score/risk.js";
import { PROOF_BLOCKER_GUIDE } from "../proofDoctor.js";

export interface BehaviorReportData {
  repo: string;
  scanned: string;
  framework: string;
  analysisKind: "static" | "static+dynamic";
  /**
   * Tier counts. `proven`/`associated`/`none` are the classification (unchanged).
   * `reachableUntested`/`noSignal` are a DISPLAY-ONLY split of the `none` bucket
   * (reachableUntested + noSignal === none): a none-tier behavior whose symbol
   * appears in a static flow is "Reachable Untested"; the rest are "No Signal".
   */
  summary: { total: number; proven: number; associated: number; none: number; reachableUntested: number; noSignal: number };
  proofGuidance: { state: "proven" | "attempted" | "not_started"; title: string; body: string; action: string };
  pipeline: Array<{ key: string; label: string; pr: string; on: "1" | "partial" | "0" }>;
  scan: {
    services: Array<[name: string, behaviorCount: number]>;
    serviceTotal: number;
    tests: { total: number; integration: number; unit: number };
    excluded: { count: string; text: string };
  };
  behaviorGroups: Array<{ key: string; count: number }>;
  behaviors: Array<{ sig: string; group: string; file: string; tier: "proven" | "assoc" | "none"; reachable: boolean; desc: string }>;
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
    desc: string;
    tags: Array<[label: string, kind: "risk" | "info" | "entry"]>;
    todo: string;
    /**
     * v6 gap-card extensions (display-only). Concern categories that apply to
     * this flow (snake_case keys, rendered as locked/shown pills) and the
     * generated integration tests linked to it. Empty arrays until the
     * generated-test linkage is wired — the template hides both sections.
     */
    applicableCategories: string[];
    generatedTests: Array<{ name: string; concern?: string; technique?: string; assertion?: string; code: string }>;
  }>;
  /** Verbatim "why 0 dynamic proof" explainer — populated ONLY when summary.proven === 0. Display copy; changes no classification. */
  zeroProofExplainer: { title: string; body: string[] } | null;
  /** Total generated tests recorded in the graph (honest count; 0 hides the CTA band). */
  generatedTotal: number;
  /** How many of those are rendered inline in risk cards (0 until linkage is wired). */
  shownCount: number;
}

export interface BehaviorReportFlow {
  title: string;
  trigger: { verb: string; path: string } | null;
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
  return tier !== "proven" && tier !== "associated" && tier !== "runtime";
}

function summaryFromRows(rows: RtmRow[], flowIds: Set<string>): BehaviorReportData["summary"] {
  const proven = rows.filter((r) => r.evidence_tier === "proven").length;
  const associated = rows.filter((r) => r.evidence_tier === "associated" || r.evidence_tier === "runtime").length;
  const noneRows = rows.filter((r) => isNoneTier(r.evidence_tier));
  // DISPLAY-ONLY split of `none`: a none-tier symbol that shows up in a static flow is "Reachable Untested".
  const reachableUntested = noneRows.filter((r) => flowIds.has(r.behavior_id)).length;
  return { total: rows.length, proven, associated, none: noneRows.length, reachableUntested, noSignal: noneRows.length - reachableUntested };
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
    const tier: "proven" | "assoc" | "none" =
      row.evidence_tier === "proven" ? "proven" : row.evidence_tier === "associated" || row.evidence_tier === "runtime" ? "assoc" : "none";
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

function riskBucket(score: number): "critical" | "high" | "medium" | null {
  if (score >= 500) return "critical";
  if (score >= 200) return "high";
  if (score > 0) return "medium";
  return null;
}

function flowWhy(flow: BehaviorFlow, proof: "proven" | "none"): string {
  const tier = flow.flow_tier === "framework-derived: reachable" ? "framework-derived reachable" : "hard reachable";
  const proofText = proof === "proven" ? "the entry behavior has dynamic proof" : "no dynamic proof exercises this chain yet";
  return `This chain is ${tier}; ${proofText}. Reachability is static and is not an execution claim.`;
}

function flows(graph: LocalGraph, rows: RtmRow[], risks: RiskGap[]): BehaviorReportFlow[] {
  const nodesById = new Map(graph.nodes.map((n) => [n.external_id, n]));
  const proven = new Set(rows.filter((r) => r.evidence_tier === "proven").map((r) => r.behavior_id));
  const riskById = new Map(risks.map((r) => [r.id, r]));
  return (graph.analysis?.flows?.flows ?? []).map((flow) => {
    const trigger = endpointTrigger(nodesById.get(flow.entry_point.external_id));
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
      risk: risk ? riskBucket(risk.risk_score) : null,
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
  return linked.slice(0, 2).map(({ t, sameFile }) => ({
    name: t.title,
    concern: t.test_type && t.test_type !== "unknown" ? t.test_type : undefined,
    assertion: [sameFile ? "same-file target" : "", t.framework_hint, t.weak_evidence_used ? "weak evidence disclosed" : ""]
      .filter(Boolean)
      .join(" · "),
    code: t.body
  }));
}

function riskRows(risks: RiskGap[], graph: LocalGraph): BehaviorReportData["risks"] {
  const riskIds = new Set(risks.map((r) => r.id));
  const firstRowForFile = new Map<string, string>();
  for (const r of risks) if (!firstRowForFile.has(r.file)) firstRowForFile.set(r.file, r.id);
  return risks.map((risk, idx) => {
    const methodMatch = risk.title.match(/^(GET|POST|PUT|PATCH|DELETE)\s+(.+)$/i);
    const pathMatch = risk.file.match(/\/api\/(.+)$/);
    const tags: Array<[label: string, kind: "risk" | "info" | "entry"]> = [];
    const bucket = riskBucket(risk.risk_score);
    if (bucket) tags.push([`${bucket} risk`, "risk"]);
    tags.push([`${risk.incoming_refs} incoming refs`, "info"]);
    if (risk.entry_point) tags.push(["Entry point", "entry"]);
    return {
      rank: idx + 1,
      ...(() => {
        const generatedTests = riskGeneratedTests(graph, risk, riskIds, firstRowForFile.get(risk.file) === risk.id);
        return {
          generatedTests,
          // Honest category strip: only the concerns of REAL attached tests —
          // every pill renders as shown ("n of n"), none fabricated as locked.
          applicableCategories: [...new Set(generatedTests.map((t) => t.concern).filter((c): c is string => Boolean(c)))]
        };
      })(),
      verb: methodMatch?.[1]?.toUpperCase() ?? (risk.entry_point ? "ENTRY" : "CODE"),
      path: methodMatch?.[2] ?? (pathMatch ? `/${pathMatch[1]}` : risk.file),
      desc: risk.reasons.join(" · "),
      tags,
      todo: "Write an integration or behavior test that calls this behavior and asserts the observable outcome."
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
  const riskGaps = rankRiskGaps(graph, { repoRoot, limit: opts.riskLimit ?? 20 });
  const lists = behaviorLists(rows, flowIds);
  const risks = riskRows(riskGaps, graph);
  return {
    repo: path.basename(repoRoot || graph.workspace.name || "repo"),
    scanned: (graph.updated_at || graph.created_at || new Date(0).toISOString()).slice(0, 10),
    framework: frameworkLabel(graph),
    analysisKind: summary.proven > 0 ? "static+dynamic" : "static",
    summary,
    proofGuidance: proofGuidance(ledger, summary, opts.dynamicProof),
    pipeline: pipeline(graph, ledger, summary),
    scan: scanBlock(graph, rows),
    behaviorGroups: lists.behaviorGroups,
    // Proven first so the strongest evidence leads the grid (stable within tiers).
    behaviors: [...lists.behaviors].sort((a, b) => tierRank(a) - tierRank(b)),
    flows: flows(graph, rows, riskGaps),
    candidateFlows: candidateFlows(graph),
    risks,
    zeroProofExplainer: summary.proven === 0 ? { title: ZERO_PROOF_EXPLAINER.title, body: [...ZERO_PROOF_EXPLAINER.body] } : null,
    generatedTotal: graph.generated_tests?.length ?? 0,
    shownCount: risks.reduce((acc, r) => acc + r.generatedTests.length, 0)
  };
}
