import type { LocalGraph } from "../graph/ontology.js";
import { denominatorComposition } from "../graph/factories.js";
import type { Ledger } from "../ledger.js";
import { ANALYZER_VERSION } from "../provenance.js";
import { rankRiskGaps } from "../score/risk.js";
import type { ReportFeedback } from "../feedback.js";
import type { BehaviorReportBuild, DynamicProofReportInput } from "./behaviorReportData.js";
import type { RepoWeb } from "./shortReport.js";
import { areaOf, buildWorklist, verbCounts, type Evidence, type GenerationContext, type Verb, type WorkItem } from "./worklist.js";

/**
 * Everything both reports and the CSV show, computed once and saved as
 * `.orangepro/report-data.json`. A reuse run re-renders from this file without
 * analysing anything (R14 §5); bump REPORT_DATA_VERSION when its shape changes.
 */
export const REPORT_DATA_VERSION = 1;
/** Bump when either renderer changes what it draws from the same data. */
export const REPORT_RENDERER_VERSION = "r14.1";
export const REPORT_DATA_FILE = "report-data.json";
/** Rows the detailed report carries (filters and search run over these). */
export const WORKLIST_LIMIT = 500;

export interface AreaRow {
  name: string;
  total: number;
  evidence: Record<Evidence, number>;
  deletePaths: number;
}

export interface ProofRow {
  id: string;
  title: string;
  file: string;
  line?: number;
  test: string;
  testPath?: string;
}

export interface KeyValue { k: string; v: string }

export interface ReportSince {
  kind: "first" | "compared" | "unchanged" | "analysis_changed" | "rerendered";
  text: string;
}

export interface ReportModel {
  version: typeof REPORT_DATA_VERSION;
  repo: { name: string; web: RepoWeb | null; commit: string | null };
  tool: string;
  analyzer: string;
  generatedAt: string;
  /** Set when a later run found nothing changed and reused this report. */
  checked?: { at: string; text: string };
  since: ReportSince;
  noun: { plural: string; singular: string; title: string };
  history: { state: string; commits: number; days: number; complete: boolean };
  counts: {
    mapped: number;
    ranked: number;
    testFiles: number;
    evidence: Record<Evidence, number>;
    withEvidence: number;
    deletePaths: number;
    proven: number;
  };
  slotRows: number;
  worklist: WorkItem[];
  top: Record<Verb, number>;
  areas: AreaRow[];
  proofs: ProofRow[];
  run: {
    inputs: KeyValue[];
    counted: KeyValue[];
    proofs: KeyValue[];
    tests: KeyValue[];
    fingerprints: KeyValue[];
    settings: KeyValue[];
  };
  tests: { drafted: number; ready: number; plans: number; notDrafted: number; status?: string };
  feedback?: ReportFeedback;
  /** AI-suggested flows when a model proposed them: paths to verify, never evidence. */
  aiFlows?: { proposed: number; accepted: number; flows: Array<{ title: string; confidence: number; steps: string[] }> };
  links: { detailed: string; summary: string; csv: string };
}

export interface ReportModelInput {
  graph: LocalGraph;
  ledger: Ledger;
  build: BehaviorReportBuild;
  repoRoot: string;
  repoWeb: RepoWeb | null;
  noun: { plural: string; singular: string; title: string };
  proofs: ProofRow[];
  dynamicProof?: DynamicProofReportInput;
  generationShortfall?: ReadonlyMap<string, string>;
  feedback?: ReportFeedback;
  previous?: ReportModel | null;
  /** Why this run is a full run, from the reuse check (R14 §5). */
  runReason?: string;
  generatedAt: string;
  links: ReportModel["links"];
}

const EVIDENCE_OF_TIER: Record<string, Evidence> = { proven: "proven", runtime: "runtime", associated: "linked", candidate: "unconfirmed" };

function emptyEvidence(): Record<Evidence, number> {
  return { proven: 0, runtime: 0, linked: 0, unconfirmed: 0, none: 0 };
}

function n(value: number): string {
  return value.toLocaleString("en-US");
}

function short(hash: string | undefined): string {
  return (hash ?? "").replace(/^sha256:/, "").slice(0, 16);
}

function plural(count: number, one: string, many: string): string {
  return `${n(count)} ${count === 1 ? one : many}`;
}

/**
 * The one ranking behind the worklist, the summary's top rows and test drafting
 * (R14 Amendment A1): every function that is not Done, linked ones included, with
 * at most three per file and one per name so one file cannot fill the list.
 */
export function worklistRanking(graph: LocalGraph, opts: { repoRoot: string; provenIds: ReadonlySet<string>; limit: number }) {
  return rankRiskGaps(graph, {
    repoRoot: opts.repoRoot,
    limit: opts.limit,
    provenIds: new Set(opts.provenIds),
    includeAssociated: true,
    maxPerFile: 3,
    maxPerTitle: 1
  });
}

/** The "since the last report" line: what changed and why the run happened. */
export function sinceLine(previous: ReportModel | null | undefined, current: Pick<ReportModel, "worklist" | "counts" | "tool" | "analyzer">, runReason?: string): ReportSince {
  if (!previous) return { kind: "first", text: "No earlier report to compare with: this is the first one saved for this repository." };
  const prevTop = new Set(previous.worklist.filter((w) => w.slots).map((w) => w.id));
  const curTop = current.worklist.filter((w) => w.slots);
  const entered = curTop.filter((w) => !prevTop.has(w.id)).length;
  const left = [...prevTop].filter((id) => !curTop.some((w) => w.id === id)).length;
  const provenDelta = current.counts.proven - previous.counts.proven;
  const changes: string[] = [];
  if (provenDelta > 0) changes.push(`${plural(provenDelta, "function", "functions")} moved to Done`);
  if (provenDelta < 0) changes.push(`${plural(-provenDelta, "proof", "proofs")} no longer hold`);
  if (entered > 0) changes.push(`${n(entered)} new in the top ${curTop.length}`);
  if (left > 0) changes.push(`${n(left)} left it`);
  const when = previous.generatedAt.slice(0, 10);
  if (runReason === "analysis_changed") {
    if (changes.length === 0) return { kind: "analysis_changed", text: `Your code did not change. OrangePro ${current.tool} re-checked it with a new analysis and no findings changed.` };
    return { kind: "analysis_changed", text: `Your code did not change; OrangePro's analysis did (${previous.tool} to ${current.tool}): ${changes.join(", ")}.` };
  }
  const cause = runReason === "code_changed" ? "your code changed" : runReason === "inputs_changed" ? "settings, coverage or proofs changed" : "";
  if (changes.length === 0) return { kind: "compared", text: `Since the report of ${when}${cause ? ` (${cause})` : ""}: no change in the top ${curTop.length} or in what is proven.` };
  return { kind: "compared", text: `Since the report of ${when}${cause ? ` (${cause})` : ""}: ${changes.join(", ")}.` };
}

export function buildReportModel(input: ReportModelInput): ReportModel {
  const { graph, ledger, build, repoRoot } = input;
  const data = build.data;
  const days = data.configDisclosure.tuning.churn_window_days;
  const provenTests = new Map(input.proofs.map((p) => [p.id, p.test]));
  const ranked = worklistRanking(graph, { repoRoot, provenIds: build.provenIds, limit: WORKLIST_LIMIT });
  const generation: GenerationContext = {
    ...(data.generationOutcome?.status ? { status: data.generationOutcome.status } : {}),
    ...(input.generationShortfall ? { shortfall: input.generationShortfall } : {})
  };
  // Two test slots for each of the 20 highest-priority functions, the set test drafting targets.
  const slotRows = Math.min(20, ranked.length);
  const worklist = buildWorklist(graph, ledger, ranked, { provenIds: build.provenIds, provenTests, slotRows, churnWindowDays: days, generation });

  // Evidence for every mapped function, from the same RTM rows the old summary used.
  const evidence = emptyEvidence();
  const areaMap = new Map<string, AreaRow>();
  for (const row of build.rows) {
    if (row.off_denominator === true) continue;
    const ev = EVIDENCE_OF_TIER[row.evidence_tier] ?? "none";
    evidence[ev] += 1;
    const name = areaOf(row.file || "");
    const area = areaMap.get(name) ?? { name, total: 0, evidence: emptyEvidence(), deletePaths: 0 };
    area.total += 1;
    area.evidence[ev] += 1;
    areaMap.set(name, area);
  }
  for (const gap of build.deletePaths) {
    const area = areaMap.get(areaOf(gap.file));
    if (area) area.deletePaths += 1;
  }
  const areas = [...areaMap.values()].sort((a, b) => b.total - a.total || a.name.localeCompare(b.name)).slice(0, 14);
  const proven = data.summary.proven;
  const withEvidence = evidence.proven + evidence.runtime + evidence.linked;

  const cls = data.configDisclosure.classification;
  const comp = denominatorComposition(graph);
  const other = Math.max(0, comp.code_symbols_total - comp.code_export - comp.excluded_boilerplate - comp.excluded_infra - comp.excluded_generated);
  const leftOut: string[] = [];
  if (comp.excluded_generated) leftOut.push(`${n(comp.excluded_generated)} generated`);
  if (other) leftOut.push(`${n(other)} ${other === 1 ? "type or constant" : "types and constants"}`);
  if (comp.excluded_boilerplate) leftOut.push(`${n(comp.excluded_boilerplate)} trivial accessors`);
  if (comp.excluded_infra) leftOut.push(`${n(comp.excluded_infra)} CI and test helpers`);

  const runtimeMeta = graph.analysis?.runtime_coverage as { artifacts?: Array<{ path: string; format?: string; files?: number }> } | undefined;
  const coverageFiles = (runtimeMeta?.artifacts ?? []).map((a) => a.path);
  const prov = data.provenance;
  const identity = prov.identity;
  const dyn = input.dynamicProof;
  const tests = { drafted: 0, ready: 0, plans: 0, notDrafted: 0 };
  for (const item of worklist) for (const slot of item.slots ?? []) {
    if (slot.state === "ready") { tests.ready += 1; tests.drafted += 1; }
    else if (slot.state === "plan") { tests.plans += 1; tests.drafted += 1; }
    else tests.notDrafted += 1;
  }
  // "30: the code did not pass the compile check; 8: only a plan …", most common first.
  const reasonsOf = (state: "plan" | "not_drafted"): string => {
    const counts = new Map<string, number>();
    for (const w of worklist) for (const s of w.slots ?? []) if (s.state === state && s.reason) counts.set(s.reason, (counts.get(s.reason) ?? 0) + 1);
    const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
    if (groups.length === 1) return groups[0]![0];
    return groups.map(([r, c]) => `${n(c)} \u2014 ${r}`).join("\n");
  };

  const current = {
    worklist,
    counts: {
      mapped: data.summary.total,
      ranked: rankedTotal(graph, repoRoot, build),
      testFiles: data.scan.tests.total,
      evidence,
      withEvidence,
      deletePaths: build.deleteTotal + build.provenDeleteGaps.length,
      proven
    },
    tool: prov.toolVersion,
    analyzer: identity?.analyzer_version ?? ANALYZER_VERSION
  };

  const model: ReportModel = {
    version: REPORT_DATA_VERSION,
    // The host path names the repository better than a local folder name does.
    repo: { name: input.repoWeb ? input.repoWeb.base.replace(/^https:\/\/[^/]+\//, "") : data.repo, web: input.repoWeb, commit: prov.commit },
    tool: current.tool,
    analyzer: current.analyzer,
    generatedAt: input.generatedAt,
    since: sinceLine(input.previous, current, input.runReason),
    noun: input.noun,
    history: { state: prov.history, commits: prov.commitsScanned ?? 0, days, complete: prov.churnState === "complete" },
    counts: current.counts,
    slotRows,
    worklist,
    top: verbCounts(worklist.slice(0, slotRows)),
    areas,
    proofs: input.proofs,
    run: {
      inputs: [
        { k: "Repository", v: `${input.repoWeb ? input.repoWeb.base.replace(/^https:\/\/[^/]+\//, "") : data.repo}${prov.commit ? ` at ${prov.commit.slice(0, 7)}` : ""}${identity?.git_dirty ? ", with uncommitted changes" : ""}` },
        { k: "Git history", v: prov.churnState === "complete" ? `Full: ${plural(prov.commitsScanned ?? 0, "commit", "commits")} over the last ${days} days` : `Incomplete (${prov.history}); change counts may be low` },
        { k: "Coverage", v: coverageFiles.length ? `${coverageFiles.join(", ")}: ${n(evidence.runtime)} functions executed` : "None found. Run your tests with coverage to add this evidence." },
        { k: "Tests", v: plural(data.scan.tests.total, "test file", "test files") }
      ],
      counted: [
        { k: "Found", v: `${n(comp.code_symbols_total)} functions, types and constants` },
        { k: "Counted", v: `${n(data.summary.total)} ${input.noun.plural}, ${n(current.counts.ranked)} of them ranked` },
        ...(leftOut.length ? [{ k: "Left out", v: leftOut.join(", ") }] : []),
        { k: "Scoring", v: "Deterministic. No AI model was used." }
      ],
      proofs: [
        { k: "Proven", v: proven === 0 ? "None yet" : plural(proven, "function", "functions") },
        ...(dyn ? [{ k: "This run", v: dyn.attempted === 0 ? "No proof was attempted" : `${n(dyn.attempted)} attempted, ${n(dyn.proven)} proven` }] : []),
        ...(dyn && dyn.needsSetup.length ? [{ k: "Why", v: [...new Set(dyn.needsSetup.map((a) => a.reason ?? a.category ?? "setup"))].slice(0, 3).join("; ") }] : []),
        { k: "Details", v: "opro doctor --proof lists every attempt" }
      ],
      tests: slotRows === 0 ? [{ k: "Drafted", v: "None: no function is left to rank" }] : [
        { k: "Drafted", v: `${n(tests.drafted)} of ${n(slotRows * 2)} slots for the ${slotRows} highest-priority ${input.noun.plural}` },
        { k: "Ready", v: n(tests.ready) },
        ...(tests.plans ? [{ k: "Plan only", v: `${n(tests.plans)}\n${reasonsOf("plan")}` }] : []),
        ...(tests.notDrafted ? [{ k: "Not drafted", v: `${n(tests.notDrafted)}\n${reasonsOf("not_drafted")}` }] : [])
      ],
      fingerprints: [
        { k: "Run", v: short(identity?.run_fingerprint) },
        { k: "Analysis", v: short(identity?.analysis_fingerprint) },
        { k: "Ranking", v: short(identity?.ranking_fingerprint) },
        { k: "Versions", v: `OrangePro ${current.tool}, ${current.analyzer.replace(/^orangepro\./, "")}, ${identity?.ors_version?.replace(/^orangepro\./, "") ?? ""}` }
      ],
      settings: [
        { k: "Config", v: `${data.configDisclosure.hash}${data.configDisclosure.overridesActive ? `, ${data.configDisclosure.overridesActive} overrides` : ", no overrides"}${data.configDisclosure.suppressed.length ? `, ${data.configDisclosure.suppressed.length} suppressed` : ", nothing suppressed"}` },
        { k: "Change window", v: `${days} days, up to ${n(data.configDisclosure.tuning.churn_max_commits)} commits or ${data.configDisclosure.tuning.churn_timeout_seconds} s` },
        { k: "Proofs", v: `Up to ${data.configDisclosure.proof.attempt_limit} attempts, stop after ${data.configDisclosure.proof.baseline_green_target} green baselines` },
        // Every setting that changes the ranking is named, so a tuned report never passes as clean.
        ...(data.configDisclosure.rankExcludePaths.length ? [{ k: "Not ranked", v: data.configDisclosure.rankExcludePaths.join(", ") }] : []),
        ...(cls.test_support_paths.length ? [{ k: "Test helpers", v: cls.test_support_paths.join(", ") }] : []),
        ...(cls.scheduled_entry_paths.length ? [{ k: "Scheduled", v: cls.scheduled_entry_paths.join(", ") }] : []),
        ...(cls.destructive_sinks.length ? [{ k: "Delete calls", v: cls.destructive_sinks.join(", ") }] : []),
        ...(cls.sensitivity_ignore.length ? [{ k: "Not sensitive", v: cls.sensitivity_ignore.join(", ") }] : []),
        ...(data.configDisclosure.suppressed.length
          ? [{ k: "Suppressed", v: data.configDisclosure.suppressed.slice(0, 20).map((o) => `${o.symbol}: ${o.reason}`).join("\n") }]
          : []),
        ...(data.configDisclosure.warnings.length ? [{ k: "Config warnings", v: data.configDisclosure.warnings.join("\n") }] : [])
      ]
    },
    tests: { ...tests, ...(data.generationOutcome?.status ? { status: data.generationOutcome.status } : {}) },
    ...(input.feedback ? { feedback: input.feedback } : {}),
    ...(data.candidateFlows && data.candidateFlows.flows.length
      ? {
          aiFlows: {
            proposed: data.candidateFlows.proposed,
            accepted: data.candidateFlows.accepted,
            flows: data.candidateFlows.flows.slice(0, 20).map((f) => ({ title: f.title, confidence: f.confidence, steps: f.steps.map((st) => st.sig) }))
          }
        }
      : {}),
    links: input.links
  };
  return model;
}

let rankedTotalCache: { graph: LocalGraph; total: number } | null = null;
/** How many functions the full ranking holds (all evidence levels, before display caps). */
function rankedTotal(graph: LocalGraph, repoRoot: string, build: BehaviorReportBuild): number {
  if (rankedTotalCache?.graph === graph) return rankedTotalCache.total;
  const total = rankRiskGaps(graph, { repoRoot, limit: Number.MAX_SAFE_INTEGER, provenIds: build.provenIds, includeAssociated: true }).length;
  rankedTotalCache = { graph, total };
  return total;
}

export function isReportModel(value: unknown): value is ReportModel {
  return Boolean(value) && typeof value === "object" && (value as ReportModel).version === REPORT_DATA_VERSION && Array.isArray((value as ReportModel).worklist);
}
