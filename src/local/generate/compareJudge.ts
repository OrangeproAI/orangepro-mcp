/**
 * LLM judge for the `generate --compare` A/B view.
 *
 * The two arms (prompt-only baseline vs Local KG) produce DIFFERENT test cases, so
 * they cannot be compared test-by-test. Instead we score each arm HOLISTICALLY
 * against the same shared context: the model is given the target behaviors +
 * acceptance criteria + the repo's REAL module/symbol names (so it can judge
 * accuracy/hallucination), plus both full test suites, and returns 0-100 scores per
 * arm on four dimensions. Used only when a real BYOK model is configured; the
 * deterministic offline path falls back to the heuristic in compareScore.ts.
 *
 * Privacy: only metadata (behavior titles, acceptance criteria, real symbol names)
 * and the already-sanitized generated test bodies are sent — never raw source.
 */
import { GeneratedTest, LocalGraph } from "../graph/ontology.js";
import { behaviorNodes } from "../graph/factories.js";
import { ModelProvider } from "../types.js";
import { CompareDimensions } from "./compareScore.js";

export interface JudgeResult {
  baseline: CompareDimensions;
  grounded: CompareDimensions;
  rationale?: string;
}

const JUDGE_SYSTEM = [
  "You are a strict, impartial test-quality judge.",
  "You are given the testing context (target behaviors, acceptance criteria, and the REAL modules/symbols that exist in the repo) and two candidate test suites:",
  "A = prompt-only baseline, B = Local KG (graph-grounded).",
  "Score EACH suite from 0 to 100 on four dimensions:",
  "- completeness: depth and breadth of meaningful, concrete assertions and scenarios for the behavior.",
  "- context_awareness: how well it uses the provided behaviors / acceptance criteria / context.",
  "- accuracy: targets REAL modules/symbols from the provided list; penalize invented or hallucinated imports/APIs.",
  "- domain_specificity: uses the repo's real domain vocabulary rather than generic placeholders.",
  "The two suites may test different things — judge each on its own merits against the context; do NOT require them to match.",
  'Return ONLY JSON: {"baseline":{"completeness":N,"context_awareness":N,"accuracy":N,"domain_specificity":N},"grounded":{"completeness":N,"context_awareness":N,"accuracy":N,"domain_specificity":N},"rationale":"one short sentence"}'
].join("\n");

function clampScore(v: unknown): number {
  const n = typeof v === "number" ? v : Number(v);
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function coerceDims(value: unknown): CompareDimensions {
  const o = (value && typeof value === "object" ? value : {}) as Record<string, unknown>;
  return {
    completeness: clampScore(o.completeness),
    context_awareness: clampScore(o.context_awareness),
    accuracy: clampScore(o.accuracy),
    domain_specificity: clampScore(o.domain_specificity)
  };
}

/** Parse the judge's JSON response (tolerant of code fences / surrounding prose). */
export function parseJudgeResponse(text: string): JudgeResult | null {
  const stripped = text.replace(/```(?:json)?/gi, "");
  const start = stripped.indexOf("{");
  const end = stripped.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stripped.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  const o = parsed as Record<string, unknown>;
  if (!o.baseline && !o.grounded) return null;
  return {
    baseline: coerceDims(o.baseline),
    grounded: coerceDims(o.grounded),
    rationale: typeof o.rationale === "string" ? o.rationale : undefined
  };
}

/** Compact, metadata-only context for the judge: targeted behaviors + real names. */
export function buildJudgeContext(graph: LocalGraph, groundedTests: GeneratedTest[]): string {
  const behaviorIds = new Set(behaviorNodes(graph).map((b) => b.external_id));
  const targeted = new Set<string>();
  for (const t of groundedTests) for (const id of t.grounding.entity_ids) if (behaviorIds.has(id)) targeted.add(id);

  const lines: string[] = ["TARGET BEHAVIORS:"];
  for (const id of targeted) {
    const n = graph.nodes.find((x) => x.external_id === id);
    if (!n) continue;
    const ac = Array.isArray(n.properties.acceptance_criteria) ? (n.properties.acceptance_criteria as unknown[]) : [];
    lines.push(`- ${n.title || id}${ac.length ? ` (acceptance criteria: ${ac.slice(0, 4).map(String).join("; ")})` : ""}`);
  }
  if (targeted.size === 0) lines.push("- (none resolved from grounding)");

  // The grounded arm's source refs were validated against the local graph —
  // list them explicitly so the judge can never call them invented. (The global
  // sample below is 40-of-N: on a big repo it almost never contains the
  // targeted files, and the old "treat names outside this list as possibly
  // invented" wording made the judge zero accuracy/domain on that false
  // premise — "ProfilePopover not present in this repo" on Mattermost.)
  const groundedRefs: string[] = [];
  for (const t of groundedTests) {
    for (const r of t.grounding.source_refs || []) if (!groundedRefs.includes(r)) groundedRefs.push(r);
  }
  if (groundedRefs.length) {
    lines.push(
      "",
      "GROUNDED REPO FILES (validated to exist in this repo — never treat these files, or symbols imported from them, as invented):",
      groundedRefs.slice(0, 12).join(", ")
    );
  }

  const realNames: string[] = [];
  for (const n of graph.nodes) {
    if (realNames.length >= 40) break;
    if (n.kind === "File") realNames.push(n.external_id.split("/").pop() || n.external_id);
    else if (n.kind === "CodeSymbol" && n.title) realNames.push(n.title);
  }
  lines.push(
    "",
    "OTHER REAL MODULES/SYMBOLS (a small sample of a much larger repo — a name absent from this sample is NOT necessarily invented; only penalize clearly generic placeholders):",
    [...new Set(realNames)].join(", ") || "(none extracted)"
  );
  return lines.join("\n");
}

/** Ask the model to score both suites. Returns null on any failure (caller falls back). */
export async function judgeComparison(
  provider: ModelProvider,
  contextText: string,
  baselineCode: string,
  groundedCode: string
): Promise<JudgeResult | null> {
  const user = [
    "CONTEXT:",
    contextText,
    "",
    "SUITE A — prompt-only baseline:",
    "```",
    baselineCode || "(no tests generated)",
    "```",
    "",
    "SUITE B — Local KG (graph-grounded):",
    "```",
    groundedCode || "(no tests generated)",
    "```",
    "",
    "Score both suites now. Return ONLY the JSON object."
  ].join("\n");
  try {
    const raw = await provider.complete({ system: JUDGE_SYSTEM, user, temperature: 0 });
    return parseJudgeResponse(raw);
  } catch {
    return null;
  }
}
