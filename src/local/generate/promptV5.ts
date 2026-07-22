import type { TestLayer } from "../graph/ontology.js";
import type { GenerationContext } from "./prompt.js";

export const PROMPT_VERSION_V5 = "orangepro.local.testgen.v5" as const;

export type TestConcern =
  | "contract"
  | "state_lifecycle"
  | "boundary_limits"
  | "integration_flow"
  | "failure_recovery"
  | "authorization_safety"
  | "concurrency_ordering"
  | "data_integrity"
  | `custom:${string}`;

const STANDARD_CONCERNS = new Set<string>([
  "contract",
  "state_lifecycle",
  "boundary_limits",
  "integration_flow",
  "failure_recovery",
  "authorization_safety",
  "concurrency_ordering",
  "data_integrity"
]);

export type TestDesignTechnique =
  | "happy_path_validation"
  | "equivalence_partitioning"
  | "boundary_value_analysis"
  | "state_transition"
  | "decision_table"
  | "error_guessing"
  | "pairwise_combination"
  | "contract_verification"
  | "integration_chain"
  | "data_flow_analysis"
  | "concurrency_interleaving"
  | "idempotency_check"
  | "rollback_recovery"
  | "permission_matrix"
  | "input_sanitization"
  | "chaos_injection";

export interface FlowStep {
  behavior_id: string;
  behavior_title: string;
  service: string;
  method: string;
  position: number;
}

export interface PlanningContext extends GenerationContext {
  flow_chain?: FlowStep[];
  upstream_callers?: string[];
  downstream_callees?: string[];
  docs_summary?: string;
  related_issues?: string[];
}

export interface PlannedScenario {
  id: number;
  title: string;
  concern: TestConcern;
  technique: TestDesignTechnique;
  rationale: string;
  assertion_targets: string[];
  /** Optional Given/When/Then steps for the human-readable manual test. */
  steps?: string[];
  /** Optional synthetic example inputs demonstrating the edge case. */
  test_data?: string;
  complexity: "basic" | "intermediate" | "advanced";
  risk_rank: number;
}

export interface BatchGenerationContext {
  behavior_title: string;
  description?: string;
  actors: string[];
  framework: string;
  test_layer: TestLayer;
  code_context: string[];
  source_excerpts: string[];
  existing_tests: string[];
  subject_imports: string[];
  weak_context: string[];
  flow_chain?: FlowStep[];
  scenarios: PlannedScenario[];
}

export interface ParsedScenarioTest {
  scenario_id: number | null;
  body: string;
}

export const TECHNIQUE_DESC: Record<TestDesignTechnique, string> = {
  happy_path_validation: "Exercise the primary success path with valid input. Assert correct output AND all expected side effects.",
  equivalence_partitioning: "Pick ONE representative from each input class. Assert consistent behavior within the class.",
  boundary_value_analysis: "Test at exact boundaries (0, 1, max, max+1). Include both last valid and first invalid values.",
  state_transition: "Set up initial state, trigger transition, assert new state AND that invalid transitions are rejected.",
  decision_table: "Enumerate condition combinations and verify each produces the correct action/output.",
  error_guessing: "Target the most likely production failure. Simulate the condition and assert graceful handling.",
  pairwise_combination: "Combine 2+ independent parameters. Use minimal pairwise set covering all 2-way interactions.",
  contract_verification: "Assert return types, status codes, error shapes, response schemas. Use type guards or validators.",
  integration_chain: "Exercise the real service chain end-to-end. Mock only external I/O, not internal services. Assert final state reflects all intermediate transformations.",
  data_flow_analysis: "Provide input at entry point, trace through transformations, assert final output reflects all steps.",
  concurrency_interleaving: "Simulate parallel execution. Assert no races, no double-processing, no lost updates.",
  idempotency_check: "Call operation twice with identical input. Assert same result, no duplicate side effects.",
  rollback_recovery: "Trigger failure mid-chain. Assert upstream state is consistent. No orphaned records.",
  permission_matrix: "Test with each actor type. Assert authorized succeed, unauthorized get 403/401, no data leakage.",
  input_sanitization: "Provide malicious input. Assert rejected or sanitized, no side effects.",
  chaos_injection: "Simulate infrastructure failure. Assert graceful degradation."
};

export function getFrameworkRules(framework: string): string {
  const fw = framework.toLowerCase();
  if (fw.includes("pytest") || fw.includes("python")) {
    return "Python: `def test_...` with `assert`. Use `# Concern:` and `# Technique:` comments.";
  }
  if (fw.includes("go")) {
    return "Go: same-package `_test.go`, `func Test...(t *testing.T)`. Stdlib preferred.";
  }
  if (fw.includes("junit4") || fw.includes("java4")) {
    return "JUnit 4: `import org.junit.Test;` + `import static org.junit.Assert.*;`. Complete .java file.";
  }
  if (fw.includes("junit") || fw.includes("java")) {
    return "JUnit 5: `import org.junit.jupiter.api.Test;` with assertion imports. Complete .java file.";
  }
  if (fw.includes("ava")) {
    return "AVA: `import test from \"ava\";` with `t.is`, `t.deepEqual`, `t.throws`.";
  }
  return `${framework}: use this framework only. Reuse SUBJECT IMPORTS. Do not invent module paths.`;
}

export function buildPlanningSystemPromptV5(): string {
  return [
    "You are a test gap identification engine.",
    "Given a behavior and its evidence, identify every missing test scenario justified by the evidence.",
    "",
    "Concerns:",
    "1. contract — wrong return type, missing field, wrong status code, schema violation",
    "2. state_lifecycle — invalid transitions, corrupted state, terminal state bypass",
    "3. boundary_limits — empty/null/zero/max/overflow, pagination edge, timeout threshold",
    "4. integration_flow — cross-service chain produces wrong end state",
    "5. failure_recovery — partial failure leaves inconsistent state, no rollback",
    "6. authorization_safety — wrong actor accesses data, unsanitized input, sensitive errors",
    "7. concurrency_ordering — race, double-processing, lost update, out-of-order event",
    "8. data_integrity — transformation corrupts data, precision loss, stale cache",
    "9. custom:<name> — repo-specific failure mode",
    "",
    "Rules:",
    "- Only propose scenarios justified by evidence. No evidence = skip concern.",
    "- Each scenario must be distinct.",
    "- Existing tests are already covered. Never re-propose them.",
    "- Rank all scenarios by risk_rank (1 = highest blast radius × likelihood × coverage absence).",
    "- Find all gaps. No cap. If evidence justifies 3, output 3. If 30, output 30.",
    "- When FLOW CHAIN exists, prioritize gaps at service boundaries.",
    `- technique must be exactly one of: ${Object.keys(TECHNIQUE_DESC).join(", ")}.`,
    "",
    "Output contract:",
    "- Return a raw JSON array only. No prose, no markdown fences, no heading, no explanation.",
    "- If no missing scenario is justified, return [] exactly.",
    "- The first character of your response must be [ and the last character must be ].",
    '[{"id":1,"title":"...","concern":"...","technique":"...","rationale":"...","assertion_targets":["..."],"steps":["Given ...","When ...","Then ..."],"test_data":"concrete example input values (synthetic, showing the edge case)","complexity":"basic|intermediate|advanced","risk_rank":1}]'
  ].join("\n");
}

export function buildPlanningUserPromptV5(ctx: PlanningContext): string {
  const lines: string[] = [];
  lines.push(`BEHAVIOR: ${ctx.behavior_title}`);
  if (ctx.description) lines.push(`DESCRIPTION: ${ctx.description}`);
  if (ctx.actors.length) lines.push(`ACTORS: ${ctx.actors.join(", ")}`);
  lines.push(`FRAMEWORK: ${ctx.framework} | LAYER: ${ctx.test_layer}`);
  lines.push("");
  if (ctx.flow_chain?.length) {
    lines.push("FLOW CHAIN:");
    for (const step of ctx.flow_chain) {
      const marker = step.behavior_id === ctx.behavior_external_id ? " ←" : "";
      lines.push(`  ${step.position}. ${step.service}.${step.method}${marker}`);
    }
    lines.push("");
  }
  if (ctx.upstream_callers?.length) lines.push(`UPSTREAM: ${ctx.upstream_callers.join(", ")}`);
  if (ctx.downstream_callees?.length) lines.push(`DOWNSTREAM: ${ctx.downstream_callees.join(", ")}`);
  if (ctx.upstream_callers?.length || ctx.downstream_callees?.length) lines.push("");
  if (ctx.acceptance_criteria.length) {
    lines.push("ACCEPTANCE CRITERIA:");
    for (const ac of ctx.acceptance_criteria) lines.push(`- ${ac}`);
    lines.push("");
  }
  if (ctx.workflow_steps.length) {
    lines.push("WORKFLOW:");
    for (const step of ctx.workflow_steps) lines.push(`- ${step}`);
    lines.push("");
  }
  if (ctx.code_context.length) {
    lines.push("CODE CONTEXT:");
    for (const c of ctx.code_context) lines.push(`- ${c}`);
    lines.push("");
  }
  if (ctx.source_excerpts.length) {
    lines.push("SOURCE (understand only):");
    for (const e of ctx.source_excerpts) lines.push(e);
    lines.push("");
  }
  if (ctx.existing_tests.length) {
    lines.push("EXISTING TESTS (already covered — do NOT re-propose):");
    for (const t of ctx.existing_tests) lines.push(`- ${t}`);
    lines.push("");
  }
  if (ctx.docs_summary) {
    lines.push(`DOCS: ${ctx.docs_summary}`);
    lines.push("");
  }
  if (ctx.related_issues?.length) {
    lines.push("ISSUES:");
    for (const issue of ctx.related_issues) lines.push(`- ${issue}`);
    lines.push("");
  }
  if (ctx.weak_context.length) {
    lines.push("WEAK HINTS:");
    for (const w of ctx.weak_context) lines.push(`- ${w}`);
    lines.push("");
  }
  lines.push("Find missing test scenarios. Rank by risk. Return a raw JSON array only. If none are justified, return [] exactly.");
  return lines.join("\n");
}

export function buildBatchGenerationSystemPromptV5(): string {
  return [
    "You are a test generation engine.",
    "Generate one focused, runnable test for each scenario listed below.",
    "",
    "Rules:",
    "- Never mock, stub, or spy on the behavior-under-test itself. The subject must execute for real. Mock only true external I/O boundaries — network calls, the system clock, third-party SDKs, outbound HTTP. If the behavior calls internal services in the same codebase, let them run (or use real test doubles at the I/O edge, never at the subject). A test that mocks the subject proves nothing and will be rejected.",
    "- Each test is complete and runnable (all imports, setup, assertions, cleanup).",
    "- Start each test with: // Concern: <concern> | Technique: <technique>",
    "- When asserting an exact return value (string, number, constant), copy the expected value VERBATIM from the provided source code. Never invent an expected value.",
    "- If the exact value is not visible in the provided source, assert structure instead (non-nil, error vs no-error, type, boolean outcome) — never a guessed literal.",
    "- Assert all targets listed in each scenario.",
    "- Do not copy source excerpts verbatim. Use them to understand, then write original code.",
    "- Reuse SUBJECT IMPORTS. Do not invent module paths.",
    "- Existing tests are already covered. Do not regenerate them.",
    "- Separate each test with: // ═══ SCENARIO <id> ═══",
    "- Output only code. No prose, no markdown fences."
  ].join("\n");
}

export function buildBatchGenerationUserPromptV5(ctx: BatchGenerationContext): string {
  const lines: string[] = [];
  lines.push("═══ SHARED CONTEXT ═══");
  lines.push(`BEHAVIOR: ${ctx.behavior_title}`);
  if (ctx.description) lines.push(`DESCRIPTION: ${ctx.description}`);
  if (ctx.actors.length) lines.push(`ACTORS: ${ctx.actors.join(", ")}`);
  lines.push(`FRAMEWORK: ${ctx.framework} | LAYER: ${ctx.test_layer}`);
  lines.push(`FRAMEWORK RULES: ${getFrameworkRules(ctx.framework)}`);
  lines.push("");
  if (ctx.flow_chain?.length) {
    lines.push("FLOW CHAIN:");
    for (const step of ctx.flow_chain) lines.push(`  ${step.position}. ${step.service}.${step.method}`);
    lines.push("");
  }
  if (ctx.code_context.length) {
    lines.push("CODE CONTEXT:");
    for (const c of ctx.code_context) lines.push(`- ${c}`);
    lines.push("");
  }
  if (ctx.subject_imports.length) {
    lines.push("SUBJECT IMPORTS (reuse these):");
    for (const imp of ctx.subject_imports) lines.push(imp);
    lines.push("");
  }
  if (ctx.source_excerpts.length) {
    lines.push("SOURCE (understand only — do not copy):");
    for (const e of ctx.source_excerpts) lines.push(e);
    lines.push("");
  }
  if (ctx.existing_tests.length) {
    lines.push("EXISTING TESTS (do NOT regenerate):");
    for (const t of ctx.existing_tests) lines.push(`- ${t}`);
    lines.push("");
  }
  if (ctx.weak_context.length) {
    lines.push("WEAK HINTS:");
    for (const w of ctx.weak_context) lines.push(`- ${w}`);
    lines.push("");
  }
  lines.push("═══ SCENARIOS (generate one test per scenario) ═══");
  lines.push("");
  for (const s of ctx.scenarios) {
    lines.push(`--- SCENARIO ${s.id} (risk_rank: ${s.risk_rank}) ---`);
    lines.push(`TITLE: ${s.title}`);
    lines.push(`CONCERN: ${s.concern}`);
    lines.push(`TECHNIQUE: ${s.technique}`);
    lines.push(`HOW: ${TECHNIQUE_DESC[s.technique]}`);
    lines.push(`COMPLEXITY: ${s.complexity}`);
    lines.push("ASSERT:");
    for (const t of s.assertion_targets) lines.push(`  - ${t}`);
    lines.push("");
  }
  lines.push("Generate one test per scenario. Separate with: // ═══ SCENARIO <id> ═══");
  lines.push("Output code only.");
  return lines.join("\n");
}

const KNOWN_TECHNIQUES = new Set<string>(Object.keys(TECHNIQUE_DESC));

/** Result of hardened planning-output parsing: validated scenarios plus counted drops. */
export interface PlannedScenarioParse {
  scenarios: PlannedScenario[];
  dropped: number;
  /** One "<n> item(s): <reason>" line per distinct drop reason, for warnings. */
  dropSummary: string[];
}

/** Strip a single leading/trailing Markdown code fence (```json … ```). */
function stripJsonFences(raw: string): string {
  return raw.trim().replace(/^```(?:json)?\s*/i, "").replace(/```\s*$/i, "").trim();
}

/**
 * Extract the FIRST complete, balanced top-level JSON array from text that may be
 * wrapped in prose. String-aware (ignores brackets inside quoted strings) so an
 * assertion target like `returns [1,2]` cannot truncate the array early.
 */
function extractFirstJsonArray(text: string): string | null {
  const start = text.indexOf("[");
  if (start === -1) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === "\"") inStr = false;
      continue;
    }
    if (ch === "\"") inStr = true;
    else if (ch === "[") depth++;
    else if (ch === "]" && --depth === 0) return text.slice(start, i + 1);
  }
  return null;
}

function toInteger(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isInteger(n) ? n : null;
}

function toFinite(v: unknown): number | null {
  const n = typeof v === "number" ? v : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN;
  return Number.isFinite(n) ? n : null;
}

/** Validate one raw item against the CLOSED PlannedScenario schema. */
function validatePlannedScenario(
  v: Record<string, unknown>
): { ok: true; value: PlannedScenario } | { ok: false; reason: string } {
  const id = toInteger(v.id);
  if (id === null) return { ok: false, reason: "id not an integer" };
  const title = typeof v.title === "string" ? v.title.trim() : "";
  if (!title) return { ok: false, reason: "empty title" };
  const concern = typeof v.concern === "string" ? v.concern : "";
  if (!STANDARD_CONCERNS.has(concern) && !/^custom:.+/.test(concern)) return { ok: false, reason: "unknown concern" };
  const technique = typeof v.technique === "string" ? v.technique : "";
  if (!KNOWN_TECHNIQUES.has(technique)) return { ok: false, reason: "unknown technique" };
  if (!Array.isArray(v.assertion_targets)) return { ok: false, reason: "assertion_targets not an array" };
  const targets = v.assertion_targets.filter((t): t is string => typeof t === "string" && t.trim().length > 0);
  if (targets.length === 0) return { ok: false, reason: "empty assertion_targets" };
  const complexity = v.complexity;
  if (complexity !== "basic" && complexity !== "intermediate" && complexity !== "advanced") {
    return { ok: false, reason: "invalid complexity" };
  }
  const riskRank = toFinite(v.risk_rank);
  if (riskRank === null) return { ok: false, reason: "non-finite risk_rank" };
  // Optional human-readable fields (tolerant: absent/malformed → omitted, never a rejection).
  const steps = Array.isArray(v.steps)
    ? v.steps.filter((x): x is string => typeof x === "string" && x.trim().length > 0).slice(0, 6).map((x) => x.slice(0, 240))
    : undefined;
  const test_data =
    typeof v.test_data === "string" && v.test_data.trim()
      ? v.test_data.slice(0, 400)
      : v.test_data && typeof v.test_data === "object"
        ? JSON.stringify(v.test_data).slice(0, 400)
        : undefined;
  return {
    ok: true,
    value: {
      id,
      title,
      concern: concern as TestConcern,
      technique: technique as TestDesignTechnique,
      rationale: typeof v.rationale === "string" ? v.rationale : "",
      assertion_targets: targets,
      ...(steps && steps.length ? { steps } : {}),
      ...(test_data ? { test_data } : {}),
      complexity,
      risk_rank: riskRank
    }
  };
}

/**
 * Hardened parse of v5 planning output. Strips Markdown fences, extracts the first
 * complete JSON array even when wrapped in prose, then validates EVERY item against
 * the closed PlannedScenario schema — dropping invalid items with counted reasons,
 * capping, and stable-sorting by risk_rank. Throws only on hard failure (no JSON
 * array extractable / not valid JSON / not an array), which is the caller's signal
 * to attempt a single repair pass. An empty array is valid ("no missing scenarios")
 * and never triggers repair. Error messages carry NO fragment of the raw output.
 */
export function parsePlannedScenariosStrict(raw: string, maxScenarios = 20): PlannedScenarioParse {
  const arrayText = extractFirstJsonArray(stripJsonFences(raw)) ?? extractFirstJsonArray(raw);
  if (!arrayText) throw new Error("Planning output contained no JSON array.");
  let parsed: unknown;
  try {
    parsed = JSON.parse(arrayText);
  } catch {
    throw new Error("Planning output was not valid JSON.");
  }
  if (!Array.isArray(parsed)) throw new Error("Planning output was not a JSON array.");
  const out: PlannedScenario[] = [];
  const reasons = new Map<string, number>();
  for (const item of parsed) {
    if (!item || typeof item !== "object") {
      reasons.set("not an object", (reasons.get("not an object") ?? 0) + 1);
      continue;
    }
    const res = validatePlannedScenario(item as Record<string, unknown>);
    if (res.ok) out.push(res.value);
    else reasons.set(res.reason, (reasons.get(res.reason) ?? 0) + 1);
  }
  const scenarios = out.sort((a, b) => a.risk_rank - b.risk_rank || a.id - b.id).slice(0, maxScenarios);
  const dropSummary = [...reasons.entries()].map(([reason, n]) => `${n} item(s): ${reason}`);
  const dropped = [...reasons.values()].reduce((sum, n) => sum + n, 0);
  return { scenarios, dropped, dropSummary };
}

/** Back-compat wrapper: the validated scenarios only (drops surfaced by the strict parser). */
export function parsePlannedScenarios(raw: string, maxScenarios = 20): PlannedScenario[] {
  return parsePlannedScenariosStrict(raw, maxScenarios).scenarios;
}

/** System prompt for the single transient JSON-repair pass (see generator v5 planning). */
export function buildPlanningRepairSystemPromptV5(): string {
  return "You are a JSON repair engine. Convert ONLY the scenarios already present in the following malformed plan into a JSON array matching this schema. Output raw JSON only. The first character must be [ and the last character must be ]. Do NOT add, invent, or infer any scenario not already in the input. If the input contains no scenarios, output [] exactly.";
}

/**
 * A cheap DETERMINISTIC pre-gate: does the raw planning output contain enough recoverable
 * scenario structure to be worth repairing? Requires a JSON-array shape (`[` … `]` with an
 * object) AND at least one closed-schema key. Total garbage / prose with no array → false, so the
 * caller fails closed instead of letting the repair model invent a fresh plan from nothing.
 */
export function hasRepairableScenarioStructure(raw: string): boolean {
  const s = stripJsonFences(raw);
  const open = s.indexOf("[");
  if (open === -1) return false; // no array at all → total garbage / prose → fail closed
  const after = s.slice(open); // a TRUNCATED array (no closing "]") is still recoverable, so don't require it
  if (!after.includes("{")) return false; // array of non-objects → nothing scenario-shaped to recover
  return /"(?:title|concern|technique|assertion_targets|risk_rank|complexity)"\s*:/.test(after);
}

/**
 * DETERMINISTIC tie-back: a repaired scenario is only trusted if it can be traced to the ORIGINAL
 * malformed text — a significant title token OR an assertion-target substring must appear in it. An
 * invented scenario (fabricated title/targets not in the input) fails this and is dropped. Conservative
 * by design: an over-rephrased-but-real scenario may be dropped too, which is the fail-closed direction.
 */
export function scenarioTiesBackToRaw(scenario: { title: string; assertion_targets: string[] }, raw: string): boolean {
  const rawN = raw.toLowerCase();
  const titleHit = scenario.title
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .some((tok) => tok.length >= 4 && rawN.includes(tok));
  const targetHit = scenario.assertion_targets.some((t) => {
    const n = t.toLowerCase().trim();
    return n.length >= 3 && rawN.includes(n.slice(0, 40));
  });
  return titleHit || targetHit;
}

/**
 * User prompt for the repair pass. Carries the malformed output ONLY as transient
 * input to the model — it is never persisted. Restates the closed schema so the
 * model corrects, rather than invents, scenarios.
 */
export function buildPlanningRepairUserPromptV5(malformed: string): string {
  return [
    "SCHEMA — a JSON array of objects, each:",
    '{"id":<integer>,"title":<nonempty string>,"concern":"contract|state_lifecycle|boundary_limits|integration_flow|failure_recovery|authorization_safety|concurrency_ordering|data_integrity|custom:<name>","technique":"<allowed technique id>","rationale":<string>,"assertion_targets":[<nonempty string>,"..."],"complexity":"basic|intermediate|advanced","risk_rank":<number>}',
    `ALLOWED technique ids: ${Object.keys(TECHNIQUE_DESC).join(", ")}`,
    "",
    "MALFORMED PLAN:",
    malformed,
    "",
    "Convert the malformed scenario plan above into a JSON array matching the schema. Output raw JSON only. Do not add new scenarios. If there are no recoverable scenarios, return [] exactly."
  ].join("\n");
}

export function parseBatchGeneratedTests(raw: string): ParsedScenarioTest[] {
  const clean = raw.trim();
  if (!clean) return [];
  const delimiter = /\/\/\s*═══\s*SCENARIO\s+(\d+)\s*═══/g;
  const matches = [...clean.matchAll(delimiter)];
  if (matches.length === 0) return [{ scenario_id: null, body: clean }];
  const out: ParsedScenarioTest[] = [];
  for (let i = 0; i < matches.length; i++) {
    const current = matches[i];
    const next = matches[i + 1];
    const start = (current.index ?? 0) + current[0].length;
    const end = next?.index ?? clean.length;
    const body = clean.slice(start, end).trim();
    if (body) out.push({ scenario_id: Number(current[1]), body });
  }
  return out;
}
