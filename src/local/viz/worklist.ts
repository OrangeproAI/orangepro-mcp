import type { GraphNode, LocalGraph } from "../graph/ontology.js";
import type { Ledger, LedgerRecord } from "../ledger.js";
import { targetFingerprint } from "../ledger.js";
import type { RiskGap } from "../score/risk.js";
import { storeLabel } from "./shortReport.js";

/**
 * One vocabulary for every report (R14). Each ranked function carries one of five
 * evidence states and one of four verbs. The evidence says what OrangePro found;
 * the verb says what to do about it. Both are derived here so the summary, the
 * detailed report, the CSV export and the MCP answer can never disagree.
 */
export type Evidence = "proven" | "runtime" | "linked" | "unconfirmed" | "none";
export type Verb = "done" | "prove" | "check" | "write";

export const VERB_LABEL: Record<Verb, string> = { done: "Done", prove: "Prove", check: "Check", write: "Write" };
export const VERB_MEANING: Record<Verb, string> = {
  done: "A test fails when this code breaks.",
  prove: "A test runs it. Confirm the test catches a break.",
  check: "A test file points here. Read it before writing a new test.",
  write: "No test catches a break here yet."
};
export const VERB_ORDER: readonly Verb[] = ["done", "prove", "check", "write"];
export const EVIDENCE_LABEL: Record<Evidence, string> = {
  proven: "Proven",
  runtime: "Runs under tests",
  linked: "Linked",
  unconfirmed: "Unconfirmed",
  none: "No test found"
};

export interface ProofOutcome {
  status: "proven" | "survived" | "non_assertion" | "unrunnable";
  test?: string;
  reason?: string;
  /** The record was made against the function's current code. */
  current: boolean;
}

export function evidenceOf(gap: Pick<RiskGap, "detection_tier"> | undefined, proven: boolean): Evidence {
  if (proven) return "proven";
  switch (gap?.detection_tier) {
    case "runtime": return "runtime";
    case "associated": return "linked";
    case "candidate": return "unconfirmed";
    default: return "none";
  }
}

export interface VerbInput {
  evidence: Evidence;
  proof?: ProofOutcome;
  /** A test file a candidate edge names (Check). */
  readFirst?: string;
  /** A test file a hard edge names (Linked). */
  linkedTest?: string;
  /** The test that proved it (Done). */
  provenTest?: string;
}

/** The verb and the one-line reason shown under it. Rules: r14-preregistration.md §1. */
export function verbFor(input: VerbInput): { verb: Verb; reason: string } {
  const { evidence, proof } = input;
  if (evidence === "proven") {
    return { verb: "done", reason: input.provenTest ? `${input.provenTest} fails when it breaks.` : "A test fails when it breaks." };
  }
  if (proof?.current && proof.status === "survived") {
    return { verb: "write", reason: `${proof.test ?? "The linked test"} runs it but does not catch a break.` };
  }
  if (proof?.current && proof.status === "non_assertion") {
    return { verb: "write", reason: `${proof.test ?? "The linked test"} fails when it breaks, but not at an assertion.` };
  }
  if (proof && !proof.current && proof.status === "proven") {
    return { verb: "prove", reason: "The code changed since it was proven." };
  }
  const couldNotRun = proof?.current && proof.status === "unrunnable" ? ` The last proof could not run: ${proof.reason ?? "setup failed"}.` : "";
  if (evidence === "runtime") {
    return { verb: "prove", reason: `A coverage run executes it; no test is proven to catch a break.${couldNotRun}` };
  }
  if (evidence === "linked") {
    return { verb: "prove", reason: `${input.linkedTest ?? "A test"} calls it; not yet proven to catch a break.${couldNotRun}` };
  }
  if (evidence === "unconfirmed") {
    return {
      verb: "check",
      reason: input.readFirst
        ? `Read ${input.readFirst} first: a test there may cover it, but no call was traced.`
        : "A test name points here, but no call was traced."
    };
  }
  return { verb: "write", reason: "No test points here." };
}

// ── Test slots ──

export interface TestPlan {
  scenario?: string;
  preconditions: string[];
  steps: string[];
  testData?: string;
  expected: string[];
  why?: string;
}

export interface TestSlot {
  state: "ready" | "plan" | "not_drafted";
  id?: string;
  title: string;
  /** regression, edge case, integration flow, security or privacy, validation error. */
  type?: string;
  framework?: string;
  plan?: TestPlan;
  code?: string;
  /** Why the code was withheld (plan), or why nothing was drafted (not_drafted). */
  reason?: string;
  /** Where a new test for this function would go, by the repository's own convention. */
  addTo?: string;
}

const BUCKET_LABEL: Record<string, string> = {
  regression: "Regression",
  edge_case: "Edge case",
  integration_flow: "Integration",
  security_privacy: "Security or privacy",
  validation_error: "Validation error"
};

export function testTypeLabel(bucket: string | undefined): string | undefined {
  if (!bucket) return undefined;
  return BUCKET_LABEL[bucket] ?? bucket.replace(/_/g, " ");
}

/**
 * Split a generated plan ("Scenario: … Steps: 1. Given … When … Then … Test data: …
 * Expected: …") into the fields a test-management tool imports. Returns null when the
 * body is code, not a plan. "And" lines join the group above them.
 */
export function parseTestPlan(body: string): TestPlan | null {
  if (!/^\s*Scenario:/m.test(body) || !/^\s*Steps:/m.test(body)) return null;
  const section = (name: string): string | undefined => {
    const re = new RegExp(`^\\s*${name}:\\s*([\\s\\S]*?)(?=^\\s*(?:Scenario|Steps|Test data|Expected|Why this test):|$(?![\\s\\S]))`, "m");
    const m = body.match(re);
    return m ? m[1].trim() : undefined;
  };
  const plan: TestPlan = { preconditions: [], steps: [], expected: [] };
  const scenario = section("Scenario");
  if (scenario) plan.scenario = scenario.split("\n")[0].trim();
  let group: "preconditions" | "steps" | "expected" = "steps";
  for (const raw of (section("Steps") ?? "").split("\n")) {
    const line = raw.replace(/^\s*\d+[.)]\s*/, "").trim();
    if (!line) continue;
    if (/^given\b/i.test(line)) group = "preconditions";
    else if (/^when\b/i.test(line)) group = "steps";
    else if (/^then\b/i.test(line)) group = "expected";
    plan[group].push(line);
  }
  const testData = section("Test data");
  if (testData) plan.testData = testData.replace(/\s*\n\s*/g, " ");
  const expected = section("Expected");
  if (expected) plan.expected.push(...expected.split(/;\s+|\n/).map((s) => s.trim()).filter(Boolean));
  const why = section("Why this test");
  if (why) plan.why = why.replace(/\s*\n\s*/g, " ");
  return plan;
}

/** The test file a new test for `file` would go in, by the language's usual convention. */
export function conventionalTestFile(file: string): string | undefined {
  const m = file.match(/^(.*\/)?([^/]+)\.([a-z]+)$/i);
  if (!m) return undefined;
  const dir = m[1] ?? "";
  const stem = m[2];
  const ext = m[3].toLowerCase();
  if (ext === "go") return `${dir}${stem}_test.go`;
  if (ext === "py") return `${dir}test_${stem}.py`;
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return `${dir}${stem}.test.${ext === "tsx" || ext === "jsx" ? ext.replace("x", "") : ext}`;
  if (ext === "java") return `${dir.replace(/src\/main\//, "src/test/")}${stem}Test.java`;
  return undefined;
}

// ── The worklist ──

export interface WorkItem {
  id: string;
  rank: number;
  title: string;
  file: string;
  line?: number;
  area: string;
  score: number;
  evidence: Evidence;
  verb: Verb;
  reason: string;
  readFirst?: string;
  linkedTest?: string;
  deletes?: { via: string; store: string };
  churn: number;
  churnAvailable: boolean;
  callers: number;
  scheduled: boolean;
  facts: string[];
  /** Where a new test for it would go: its own test file, the test that reaches it, or the convention. */
  addTo?: string;
  /** Two slots for the functions tests are drafted for; absent below that cut. */
  slots?: TestSlot[];
  prove: string;
}

export interface GenerationContext {
  /** graph.analysis.start_generation.status of the latest run, when known. */
  status?: string;
  /** Per target: the last reason drafting fell short (from generation diagnostics). */
  shortfall?: ReadonlyMap<string, string>;
}

export interface WorklistOptions {
  provenIds: ReadonlySet<string>;
  /** Function id → the test that proved it. */
  provenTests?: ReadonlyMap<string, string>;
  /** How many top rows get test slots (the generation target count). */
  slotRows?: number;
  churnWindowDays: number;
  generation?: GenerationContext;
}

/** First two directories of a path: the "area" the map and filters group by. */
export function areaOf(file: string): string {
  const parts = file.split("/");
  if (parts.length <= 2) return parts.length === 2 ? parts[0] : ".";
  return parts.slice(0, 2).join("/");
}

function testFileOf(externalId: string): string | undefined {
  return externalId.startsWith("test:") ? externalId.slice(5) : undefined;
}

const TEST_FILE_RE = /(^|\/)(test_[^/]+\.py|[^/]+_test\.(go|py)|[^/]+\.(test|spec)\.[cm]?[jt]sx?|[^/]+Tests?\.(java|kt|cs)|[^/]+_spec\.rb|[^/]+Test\.php)$/;
// Runners that find tests by folder (Jest __tests__, Mocha test/, RSpec spec/).
const TEST_DIR_RE = /(^|\/)(__tests__|tests?|spec)\/.+\.(py|[cm]?[jt]sx?|rb|java|kt)$/;
const FIXTURE_DIR_RE = /(^|\/)(__fixtures__|fixtures?|testdata|__mocks__|mocks?)\//i;

/** A file named like a test, outside fixture and mock folders. */
export function looksLikeTestFile(file: string): boolean {
  return (TEST_FILE_RE.test(file) || TEST_DIR_RE.test(file)) && !FIXTURE_DIR_RE.test(file);
}

/** A test file a function points to, with how strongly (candidate confidence; 1 for hard edges). */
export interface TestPointer { file: string; confidence: number }

/** Test files linked to each function: hard edges (Linked) and candidate edges (Check), plus every test file. */
export function testPointers(graph: LocalGraph): { linked: Map<string, TestPointer[]>; candidate: Map<string, TestPointer[]>; files: Set<string> } {
  const kinds = new Map(graph.nodes.map((n) => [n.external_id, n.kind]));
  const add = (m: Map<string, TestPointer[]>, sym: string, file: string | undefined, confidence: number): void => {
    if (!file) return;
    const list = m.get(sym) ?? [];
    const seen = list.find((p) => p.file === file);
    if (seen) seen.confidence = Math.max(seen.confidence, confidence);
    else list.push({ file, confidence });
    m.set(sym, list);
  };
  const linked = new Map<string, TestPointer[]>();
  for (const e of graph.edges) {
    if (e.evidence_strength !== "hard" || (e.relationship_type !== "TESTED_BY" && e.relationship_type !== "COVERS")) continue;
    if (kinds.get(e.from_external_id) === "CodeSymbol") add(linked, e.from_external_id, testFileOf(e.to_external_id), 1);
    if (kinds.get(e.to_external_id) === "CodeSymbol") add(linked, e.to_external_id, testFileOf(e.from_external_id), 1);
  }
  const candidate = new Map<string, TestPointer[]>();
  for (const e of graph.candidate_edges ?? []) {
    if (e.review_status === "ai_suggested") continue;
    if (e.relationship_type !== "MAY_BE_TESTED_BY" && e.relationship_type !== "MAY_COVER") continue;
    const c = typeof e.confidence === "number" ? e.confidence : 0;
    if (kinds.get(e.from_external_id) === "CodeSymbol") add(candidate, e.from_external_id, testFileOf(e.to_external_id), c);
    if (kinds.get(e.to_external_id) === "CodeSymbol") add(candidate, e.to_external_id, testFileOf(e.from_external_id), c);
  }
  const files = new Set<string>();
  for (const n of graph.nodes) {
    if (n.kind !== "TestCase") continue;
    const f = testFileOf(n.external_id) ?? (typeof n.properties?.file === "string" ? n.properties.file : undefined);
    if (f) files.add(f);
  }
  return { linked, candidate, files };
}

/**
 * The test file to name. The source file's own test file (`task.go` → `task_test.go`)
 * comes first when it is one of the pointers; then the strongest pointer; then one in
 * the function's own directory; then the shortest path.
 */
export function pickTestFile(sourceFile: string, pointers: readonly (TestPointer | string)[] | undefined): string | undefined {
  if (!pointers || pointers.length === 0) return undefined;
  // Fixtures and helpers under a test folder are not tests to read first.
  const list = pointers.map((p) => (typeof p === "string" ? { file: p, confidence: 0 } : p)).filter((p) => looksLikeTestFile(p.file));
  if (list.length === 0) return undefined;
  const own = conventionalTestFile(sourceFile);
  if (own && list.some((p) => p.file === own)) return own;
  const dir = sourceFile.includes("/") ? sourceFile.slice(0, sourceFile.lastIndexOf("/") + 1) : "";
  const sameDir = (f: string): number => (f.startsWith(dir) && !f.slice(dir.length).includes("/") ? 1 : 0);
  return [...list].sort((a, b) => b.confidence - a.confidence || sameDir(b.file) - sameDir(a.file) || a.file.length - b.file.length || a.file.localeCompare(b.file))[0]?.file;
}

/** The latest proof record per function, judged against the function's current code. */
export function latestProofOutcomes(graph: LocalGraph, ledger: Ledger): Map<string, ProofOutcome> {
  const latest = new Map<string, LedgerRecord>();
  for (const r of ledger.records) {
    if (!r.target_symbol || !r.dynamic_proof) continue;
    const prev = latest.get(r.target_symbol);
    if (!prev || String(r.ts ?? "") >= String(prev.ts ?? "")) latest.set(r.target_symbol, r);
  }
  const out = new Map<string, ProofOutcome>();
  for (const [sym, r] of latest) {
    const status = r.dynamic_proof?.mutant_status;
    const mapped: ProofOutcome["status"] | undefined =
      status === "proven" ? "proven"
        : status === "associated_survived" || status === "survived" ? "survived"
          : status === "associated_non_assertion_failure" ? "non_assertion"
            : status === "unrunnable" ? "unrunnable"
              : undefined;
    if (!mapped) continue;
    const current = Boolean(r.target_fingerprint) && r.target_fingerprint === targetFingerprint(graph, sym);
    const test = typeof r.dynamic_proof?.test_path === "string" ? r.dynamic_proof.test_path.replace(/^\^|\$$/g, "") : undefined;
    out.set(sym, { status: mapped, current, ...(test ? { test } : {}), ...(r.reason ? { reason: r.reason } : {}) });
  }
  return out;
}

/** Plain reason a slot holds no draft. */
export function notDraftedReason(rank: number, slotRows: number, gen: GenerationContext | undefined, shortfall: string | undefined): string {
  if (rank > slotRows) return `Tests are drafted for the ${slotRows} highest-priority functions.`;
  if (gen?.status === "no_provider") return "Add a model key to draft two tests for this function.";
  if (gen?.status === "disabled") return "Test drafting was turned off for this run.";
  if (shortfall) {
    if (/\b429\b|credit|quota|rate.?limit/i.test(shortfall)) return "The model provider refused the request (no credits or rate limit).";
    if (/no missing scenarios/i.test(shortfall)) return "The model found no further scenario to add.";
    return shortfall.length > 160 ? `${shortfall.slice(0, 157)}…` : shortfall;
  }
  return "Not drafted yet. The next run with a model key drafts it, or copy the prompt for your coding agent.";
}

/**
 * Why a draft's code was withheld, in one plain sentence. Raw validator or provider
 * output is never shown: it can be long, and provider errors can carry request details.
 */
export function withheldReason(reason: string | undefined): string {
  const text = reason ?? "";
  if (/\b429\b|credit|quota|rate.?limit/i.test(text)) return "Only a plan: the model provider refused the request for code (no credits or rate limit).";
  if (/no missing scenarios|manual fallback retained|no accepted codified test/i.test(text)) return "Only a plan: the model returned no test code for this scenario.";
  if (/undefined:|unresolved|invented|cannot find module|no required module/i.test(text)) return "The generated code referred to names that do not exist in this package.";
  if (/compile check failed|did not compile|build failed|setup failed|syntax check failed|expected .+ found/i.test(text)) return "The generated code did not pass the compile check.";
  if (/timed?\s*out|timeout/i.test(text)) return "Checking the generated code timed out.";
  return "The generated code did not pass validation.";
}

function slotsFor(graph: LocalGraph, item: Pick<WorkItem, "id" | "file" | "rank" | "addTo">, slotRows: number, gen: GenerationContext | undefined): TestSlot[] {
  const drafted = (graph.generated_tests ?? []).filter((t) => t.target_symbol_external_id === item.id).slice(0, 2);
  const addTo = item.addTo;
  const slots: TestSlot[] = drafted.map((t) => {
    const title = t.title.includes(" — ") ? t.title.slice(t.title.indexOf(" — ") + 3) : t.title;
    const base = {
      id: t.id,
      title,
      ...(testTypeLabel(t.bucket) ? { type: testTypeLabel(t.bucket) } : {}),
      ...(t.framework_hint ? { framework: t.framework_hint } : {}),
      ...(addTo ? { addTo } : {})
    };
    const plan = parseTestPlan(t.body ?? "");
    if (t.runnable !== false) return { ...base, state: "ready" as const, code: t.body, ...(plan ? { plan } : {}) };
    return { ...base, state: "plan" as const, ...(plan ? { plan } : { code: t.body }), reason: withheldReason(t.unresolved_reason) };
  });
  while (slots.length < 2) {
    slots.push({ state: "not_drafted", title: "Not drafted", reason: notDraftedReason(item.rank, slotRows, gen, gen?.shortfall?.get(item.id)), ...(addTo ? { addTo } : {}) });
  }
  return slots;
}

export function proveCommand(id: string, file: string, test: string | undefined): string {
  const ext = file.split(".").pop()?.toLowerCase() ?? "";
  const target = `opro prove-loop --target-symbol '${id}' --test '${test ?? "<your test file>"}'`;
  if (ext === "py") return `${target} --replacement sentinel`;
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return `${target} --replacement 'return null;'`;
  return target;
}

function factsFor(gap: RiskGap, store: string | undefined, days: number): string[] {
  const facts: string[] = [];
  if (gap.sink_callee) facts.push(`Deletes data through ${gap.sink_callee}${store ? ` (${store})` : ""}, within two calls.`);
  if (gap.churn_available === false) facts.push("Change history was not available, so change counts are missing.");
  else facts.push(gap.git_churn > 0 ? `${gap.git_churn.toLocaleString("en-US")} changed lines in the last ${days} days.` : `No changes in the last ${days} days.`);
  if (gap.incoming_refs > 0) facts.push(`${gap.incoming_refs.toLocaleString("en-US")} ${gap.incoming_refs === 1 ? "place calls" : "places call"} it.`);
  else facts.push(gap.entry_point ? "It is an entry point: requests or commands reach it directly." : "No other code calls it directly.");
  if (gap.scheduled_entry) facts.push("It runs on a schedule or from a queue, so a failure can go unnoticed.");
  return facts;
}

export function buildWorklist(graph: LocalGraph, ledger: Ledger, ranked: readonly RiskGap[], opts: WorklistOptions): WorkItem[] {
  const pointers = testPointers(graph);
  const proofs = latestProofOutcomes(graph, ledger);
  const nodes = new Map<string, GraphNode>(graph.nodes.map((n) => [n.external_id, n]));
  const slotRows = opts.slotRows ?? 20;
  return ranked.map((gap, index) => {
    const rank = index + 1;
    const proven = opts.provenIds.has(gap.id);
    const evidence = evidenceOf(gap, proven);
    // Check: the function's own test file when it exists, else the strongest candidate.
    const own = conventionalTestFile(gap.file);
    const readFirst = evidence === "unconfirmed"
      ? (own && pointers.files.has(own) ? own : pickTestFile(gap.file, pointers.candidate.get(gap.id)))
      : undefined;
    const linkedTest = pickTestFile(gap.file, pointers.linked.get(gap.id));
    // A new test goes in the function's own test file when it exists, else next to the
    // test that already reaches it, else where the language's convention puts it.
    const addTo = own && pointers.files.has(own) ? own : linkedTest ?? readFirst ?? own;
    const proof = proofs.get(gap.id);
    const { verb, reason } = verbFor({
      evidence,
      ...(proof ? { proof } : {}),
      ...(readFirst ? { readFirst } : {}),
      ...(linkedTest ? { linkedTest } : {}),
      ...(opts.provenTests?.get(gap.id) ? { provenTest: opts.provenTests.get(gap.id) } : {})
    });
    const owner = gap.sink_owner ? nodes.get(gap.sink_owner)?.title : undefined;
    const store = gap.sink_callee ? storeLabel(gap.sink_callee, owner) : undefined;
    const line = (nodes.get(gap.id)?.properties as { start_line?: number } | undefined)?.start_line;
    const item: WorkItem = {
      id: gap.id,
      rank,
      title: gap.title,
      file: gap.file,
      ...(typeof line === "number" ? { line } : {}),
      area: areaOf(gap.file),
      score: gap.risk_score,
      evidence,
      verb,
      reason,
      ...(readFirst ? { readFirst } : {}),
      ...(linkedTest ? { linkedTest } : {}),
      ...(gap.sink_callee ? { deletes: { via: gap.sink_callee, store: store || "Stored data" } } : {}),
      churn: gap.git_churn,
      churnAvailable: gap.churn_available !== false,
      callers: gap.incoming_refs,
      scheduled: gap.scheduled_entry === true,
      facts: factsFor(gap, store, opts.churnWindowDays),
      ...(addTo ? { addTo } : {}),
      prove: proveCommand(gap.id, gap.file, proof?.test ?? linkedTest ?? readFirst)
    };
    if (rank <= slotRows) item.slots = slotsFor(graph, item, slotRows, opts.generation);
    return item;
  });
}

/** How many of `items` carry each verb, in the fixed display order. */
export function verbCounts(items: readonly Pick<WorkItem, "verb">[]): Record<Verb, number> {
  const out: Record<Verb, number> = { done: 0, prove: 0, check: 0, write: 0 };
  for (const i of items) out[i.verb] += 1;
  return out;
}
