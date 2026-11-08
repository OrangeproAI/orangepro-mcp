import type { LocalGraph } from "../graph/ontology.js";
import { denominatorComposition } from "../graph/factories.js";
import type { Ledger } from "../ledger.js";
import { ANALYZER_VERSION } from "../provenance.js";
import { TEST_SUPPORT_RANKING_REASON_CODE } from "../score/rankEligibility.js";
import { rankRiskGaps } from "../score/risk.js";
import { BOILERPLATE_REASON, TRIVIAL_BODY_REASON } from "../analyze/boilerplate.js";
import { GENERATED_CODE_REASON, NON_PRODUCT_REASON } from "../analyze/classify.js";
import { dateText, localTimeZone, type ReportTimeZone } from "./reportTheme.js";
import type { ReportFeedback } from "../feedback.js";
import type { BehaviorReportBuild, DynamicProofReportInput } from "./behaviorReportData.js";
import type { RepoWeb } from "./shortReport.js";
import { areaOf, buildWorklist, verbCounts, type Evidence, type GenerationContext, type RowPatch, type Verb, type WorkItem } from "./worklist.js";
import type { PatchState, ProofRunsView } from "../proofRuns.js";

/**
 * Everything both reports and the CSV show, computed once and saved as
 * `.orangepro/report-data.json`. A reuse run re-renders from this file without
 * analysing anything (R14 §5); bump REPORT_DATA_VERSION when its shape changes.
 */
export const REPORT_DATA_VERSION = 4;
/** Bump when either renderer changes what it draws from the same data. */
export const REPORT_RENDERER_VERSION = "r15.0";
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
  /** The zone the run happened in: dates render in it, never in the viewer's zone. */
  timeZone: ReportTimeZone;
  /** Set when a later run found nothing changed and reused this report. */
  checked?: { at: string; text: string };
  since: ReportSince;
  /** Set when test-support code is most of what OrangePro counts: the line both reports show. */
  testSupport?: { count: number; counted: number; text: string };
  noun: { plural: string; singular: string; title: string };
  history: { state: string; commits: number; days: number; complete: boolean };
  counts: {
    mapped: number;
    ranked: number;
    testFiles: number;
    /** Test files with a traced call to at least one counted function (README "Linked"). */
    testFilesLinked: number;
    /** Test files with no traced call to any counted function. */
    testFilesUnlinked: number;
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
  /**
   * V3: what finished proof runs say, per function. A patch status, never an evidence tier: the
   * tier counts above stay on the five names. Present only when there is a proof run to show.
   */
  patches?: {
    /** One sentence both reports show beside the Proven count, e.g. "1 verified test patch, not merged". */
    line: string;
    counts: Record<PatchState, number>;
    rows: Array<RowPatch & { id: string; title: string }>;
    ignored: Array<{ run_id: string; reason: string }>;
  };
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
  /** Minutes east of UTC at `generatedAt`; read from this machine when absent. */
  timeZoneOffsetMinutes?: number;
  /** V3: patch statuses from finished proof runs (`loadPatchStatuses`). */
  patches?: ProofRunsView;
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

/** A previous report this recent is the same session's earlier run, not a baseline. */
export const RECENT_RUN_MINUTES = 60;

/** The "since the last report" line: what changed and why the run happened. */
export function sinceLine(
  previous: ReportModel | null | undefined,
  current: Pick<ReportModel, "worklist" | "counts" | "tool" | "analyzer"> & Partial<Pick<ReportModel, "generatedAt" | "timeZone">>,
  runReason?: string
): ReportSince {
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
  if (runReason === "analysis_changed") {
    if (changes.length === 0) return { kind: "analysis_changed", text: `Your code did not change. OrangePro ${current.tool} re-checked it with a new analysis and no findings changed.` };
    return { kind: "analysis_changed", text: `Your code did not change; OrangePro's analysis did (${previous.tool} to ${current.tool}): ${changes.join(", ")}.` };
  }
  const minutes = current.generatedAt ? (Date.parse(current.generatedAt) - Date.parse(previous.generatedAt)) / 60_000 : Number.NaN;
  const recent = Number.isFinite(minutes) && minutes >= 0 && minutes < RECENT_RUN_MINUTES;
  const rounded = Math.round(minutes);
  const since = recent
    ? `Since the run ${rounded < 1 ? "less than a minute" : rounded === 1 ? "1 minute" : `${rounded} minutes`} ago`
    : `Since the report of ${dateText(previous.generatedAt, previous.timeZone ?? current.timeZone)}`;
  const cause = runReason === "code_changed" ? "your code changed" : runReason === "inputs_changed" ? "settings, coverage or proofs changed" : "";
  if (changes.length === 0) return { kind: "compared", text: `${since}${cause ? ` (${cause})` : ""}: no change in the top ${curTop.length} or in what is proven.` };
  return { kind: "compared", text: `${since}${cause ? ` (${cause})` : ""}: ${changes.join(", ")}.` };
}

/**
 * Test files that call at least one counted function through a traced link (a hard
 * COVERS / TESTED_BY edge: the README's "Linked"), and those that call none. A name
 * match is a lead, not a link, so it does not count here.
 */
export function testFileLinks(graph: Pick<LocalGraph, "nodes" | "edges">): { testFiles: number; linked: number; unlinked: number } {
  const byId = new Map(graph.nodes.map((node) => [node.external_id, node]));
  const tests = graph.nodes.filter((node) => node.kind === "TestCase" && node.stale !== true);
  const linked = new Set<string>();
  for (const e of graph.edges) {
    if (e.evidence_strength !== "hard" || (e.relationship_type !== "COVERS" && e.relationship_type !== "TESTED_BY")) continue;
    const a = byId.get(e.from_external_id);
    const b = byId.get(e.to_external_id);
    for (const [test, code] of [[a, b], [b, a]] as const) {
      if (test?.kind === "TestCase" && test.stale !== true && code?.kind === "CodeSymbol" && code.denominator_eligible === true && code.stale !== true) linked.add(test.external_id);
    }
  }
  return { testFiles: tests.length, linked: linked.size, unlinked: tests.length - linked.size };
}

/**
 * Why each code symbol that is found but not counted was left out, from the reason the
 * analyzer recorded on it, so the parts and the total add up on the page.
 */
export function leftOutParts(graph: Pick<LocalGraph, "nodes">): {
  found: number;
  counted: number;
  generated: number;
  notEntryPoint: number;
  infraSurface: number;
  trivial: number;
  ciAndTest: number;
  other: number;
} {
  const out = { found: 0, counted: 0, generated: 0, notEntryPoint: 0, infraSurface: 0, trivial: 0, ciAndTest: 0, other: 0 };
  for (const node of graph.nodes) {
    if (node.kind !== "CodeSymbol" || node.stale === true) continue;
    out.found += 1;
    if (node.denominator_eligible === true) out.counted += 1;
    else if (node.denominator_reason === GENERATED_CODE_REASON) out.generated += 1;
    else if (node.denominator_reason === BOILERPLATE_REASON || node.denominator_reason === TRIVIAL_BODY_REASON) out.trivial += 1;
    else if (node.denominator_reason === NON_PRODUCT_REASON) out.ciAndTest += 1;
    else if (node.properties.denominator_reason_code === "not_entry_point_adjacent") out.notEntryPoint += 1;
    else if (node.properties.denominator_reason_code === "infra_behavior_surface") out.infraSurface += 1;
    else out.other += 1;
  }
  return out;
}

/**
 * One plain line when most counted functions are test support (page objects, fixtures,
 * helpers on a test framework): they are mapped but kept out of the worklist, and the
 * application they test is often in another repository.
 */
export function testSupportNote(graph: LocalGraph): { testSupport?: NonNullable<ReportModel["testSupport"]> } {
  let counted = 0;
  let count = 0;
  for (const node of graph.nodes) {
    if (node.kind !== "CodeSymbol" || node.denominator_eligible !== true || node.stale) continue;
    counted += 1;
    if (node.properties.ranking_exclusion_reason_code === TEST_SUPPORT_RANKING_REASON_CODE) count += 1;
  }
  if (count * 2 <= counted) return {};
  return {
    testSupport: {
      count,
      counted,
      text: `Most functions OrangePro counted here (${n(count)} of ${n(counted)}) are test support: page objects, fixtures and helpers that import a test framework. They stay mapped but are left out of the worklist. The application code they test may not be in this repository.`
    }
  };
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
  const patches = patchSection(input.patches, worklist, graph);

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
  const parts = leftOutParts(graph);
  const leftOut: string[] = [];
  if (parts.generated) leftOut.push(`${n(parts.generated)} generated`);
  if (parts.notEntryPoint) leftOut.push(`${n(parts.notEntryPoint)} not near an API, route, command or job`);
  if (parts.infraSurface) leftOut.push(`${n(parts.infraSurface)} utility, model and tooling code`);
  if (parts.other) leftOut.push(`${n(parts.other)} ${parts.other === 1 ? "type, constant or other declaration" : "types, constants and other declarations"}`);
  if (parts.trivial) leftOut.push(`${n(parts.trivial)} trivial accessors`);
  if (parts.ciAndTest) leftOut.push(`${n(parts.ciAndTest)} CI and test helpers`);
  const leftOutTotal = parts.found - parts.counted;
  const requirements = comp.markdown_requirement + comp.requirement_template;
  const arithmetic = ((): string => {
    const base = `${n(parts.found)} found \u2212 ${n(leftOutTotal)} left out = ${n(parts.counted)} ${input.noun.plural}`;
    if (data.summary.total === parts.counted) return `${base} counted.`;
    if (requirements > 0 && data.summary.total === parts.counted + requirements) {
      const from = comp.requirement_template === 0 ? "from Markdown docs" : "from requirement files";
      return `${base}, plus ${n(requirements)} ${requirements === 1 ? "requirement" : "requirements"} ${from} = ${n(data.summary.total)} counted.`;
    }
    return `The parts do not add up to the total: ${base}, but ${n(data.summary.total)} are counted.`;
  })();
  const links = testFileLinks(graph);

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
      testFilesLinked: links.linked,
      testFilesUnlinked: links.unlinked,
      evidence,
      withEvidence,
      deletePaths: build.deleteTotal + build.provenDeleteGaps.length,
      proven
    },
    tool: prov.toolVersion,
    analyzer: identity?.analyzer_version ?? ANALYZER_VERSION,
    generatedAt: input.generatedAt,
    timeZone: localTimeZone(input.generatedAt, input.timeZoneOffsetMinutes)
  };

  const model: ReportModel = {
    version: REPORT_DATA_VERSION,
    // The host path names the repository better than a local folder name does.
    repo: { name: input.repoWeb ? input.repoWeb.base.replace(/^https:\/\/[^/]+\//, "") : data.repo, web: input.repoWeb, commit: prov.commit },
    tool: current.tool,
    analyzer: current.analyzer,
    generatedAt: input.generatedAt,
    timeZone: current.timeZone,
    since: sinceLine(input.previous, current, input.runReason),
    ...testSupportNote(graph),
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
        { k: "Tests", v: testsInput(data.scan.tests.total, links) }
      ],
      counted: [
        { k: "Found", v: `${n(comp.code_symbols_total)} functions, types and constants` },
        { k: "Counted", v: `${n(data.summary.total)} ${input.noun.plural}, ${n(current.counts.ranked)} of them ranked` },
        ...(leftOut.length ? [{ k: "Left out", v: leftOut.join(", ") }] : []),
        ...(leftOut.length || requirements ? [{ k: "Arithmetic", v: arithmetic }] : []),
        { k: "Scoring", v: "Deterministic. No AI model was used." }
      ],
      proofs: [
        { k: "Proven", v: proven === 0 ? "None yet" : plural(proven, "function", "functions") },
        ...(dyn ? [{ k: "This run", v: dyn.attempted === 0 ? "No proof was attempted" : `${n(dyn.attempted)} attempted, ${n(dyn.proven)} proven` }] : []),
        ...(dyn && dyn.needsSetup.length ? [{ k: "Why", v: [...new Set(dyn.needsSetup.map((a) => a.reason ?? a.category ?? "setup"))].slice(0, 3).join("; ") }] : []),
        { k: "Details", v: "opro doctor --proof lists every attempt" },
        ...(patches ? [{ k: "Test patches", v: `${patches.line}${patches.rows.length ? `\n${patches.rows.map((r) => `${r.title}: ${r.label}`).join("\n")}` : ""}` }] : []),
        ...(patches && patches.ignored.length ? [{ k: "Not used", v: patches.ignored.map((x) => `${x.run_id}: ${x.reason}`).join("\n") }] : [])
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
    ...(patches ? { patches } : {}),
    links: input.links
  };
  return model;
}

const PATCH_WORDS: Record<PatchState, [string, string]> = {
  verified_not_merged: ["verified test patch, not merged", "verified test patches, not merged"],
  delivered: ["delivered as a draft PR, not merged", "delivered as draft PRs, not merged"],
  adopted: ["adopted (merged)", "adopted (merged)"],
  closed: ["draft PR closed without merging", "draft PRs closed without merging"],
  verified_in_checkout: ["verified test patch in this checkout", "verified test patches in this checkout"],
  verified_stale: ["verified test patch, stale", "verified test patches, stale"],
  no_claim: ["proof run with no claim", "proof runs with no claim"]
};

/**
 * Attach each function's patch status to its worklist row, and the one line both reports show.
 * The row keeps its tier and verb (owner, 8 Nov): the status only adds what to review.
 */
function patchSection(view: ProofRunsView | undefined, worklist: WorkItem[], graph: LocalGraph): ReportModel["patches"] | undefined {
  if (!view || (view.statuses.length === 0 && view.ignored.length === 0)) return undefined;
  const counts = Object.fromEntries(Object.keys(PATCH_WORDS).map((k) => [k, 0])) as Record<PatchState, number>;
  const byId = new Map(worklist.map((w) => [w.id, w]));
  const titles = new Map(graph.nodes.map((node) => [node.external_id, node.title ?? node.external_id]));
  const rows: NonNullable<ReportModel["patches"]>["rows"] = [];
  for (const status of view.statuses) {
    counts[status.state] += 1;
    const patch: RowPatch = { state: status.state, label: status.label, text: status.text, run: status.run_id, page: status.page, patch: status.patch, ...(status.pr ? { pr: status.pr } : {}) };
    const row = byId.get(status.symbol_id);
    if (row) row.patch = patch;
    rows.push({ ...patch, id: status.symbol_id, title: row?.title ?? titles.get(status.symbol_id) ?? status.symbol_id.replace(/^sym:[^#]*#/, "") });
  }
  const parts = (Object.keys(PATCH_WORDS) as PatchState[]).filter((k) => counts[k] > 0).map((k) => `${n(counts[k])} ${counts[k] === 1 ? PATCH_WORDS[k][0] : PATCH_WORDS[k][1]}`);
  const line = parts.length ? `${parts.join("; ")}.` : "No proof run can be used.";
  return { line: line.charAt(0).toUpperCase() + line.slice(1), counts, rows, ignored: view.ignored };
}

/** "1,022 test files: 69 call a counted function, 953 call none that OrangePro traced." */
export function testsInput(total: number, links: { linked: number; unlinked: number }): string {
  const files = plural(total, "test file", "test files");
  if (total === 0) return files;
  return `${files}: ${n(links.linked)} ${links.linked === 1 ? "calls" : "call"} a counted function, ${n(links.unlinked)} ${links.unlinked === 1 ? "calls" : "call"} none that OrangePro traced`;
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
