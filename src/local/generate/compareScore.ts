/**
 * Deterministic quality scoring + comparison matrix for the `generate --compare` view.
 *
 * Dimensions (0-100): Completeness, Context awareness, Accuracy, Domain specificity.
 * (When a real model is configured these come from the LLM judge; offline they use
 * the heuristics below.)
 *
 * Matrix = objective, reliable per-arm signals shown alongside the dimensions:
 * tests, concrete assertions, traceability (source/provenance refs), weak-evidence
 * disclosure, smoke-only. Import-regex "real-vs-invented" guesses are intentionally
 * NOT in the matrix — they are unreliable on live model output (the model writes its
 * own imports; sanitization redacts lines) and the Accuracy dimension already judges
 * hallucination authoritatively.
 */
import { GeneratedTest, LocalGraph } from "../graph/ontology.js";

export interface CompareDimensions {
  completeness: number;
  context_awareness: number;
  accuracy: number;
  domain_specificity: number;
}

/** Objective per-arm comparison signals (the deterministic "matrix"). */
export interface CompareMetrics {
  tests: number;
  concrete_assertions_avg: number;
  traceability_refs: number;
  weak_evidence_disclosed: number;
  smoke_only: number;
}

export interface CompareOracle {
  fileStems: Set<string>;
  tokens: Set<string>;
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");
const stemOf = (p: string): string =>
  norm(String(p).split("/").pop()!.replace(/\.(test|spec)\.[a-z0-9]+$/i, "").replace(/\.[a-z0-9]+$/i, ""));

// JS/TS + Python assertion shapes (concrete, not smoke/existence-only).
const CONCRETE_ASSERTION =
  /\.(toBe|toEqual|toContain|toBeCloseTo|toMatch|toHaveLength|toStrictEqual|toThrow|toHaveBeenCalled|toHaveBeenCalledWith|toMatchObject)\(|assert(Equal|True|False|Raises|In|Is|Almost)?\s*\(/g;

const importsOf = (body: string): string[] => [
  ...[...body.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]),
  ...[...body.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1])
];
const isFramework = (s: string): boolean =>
  /vitest|vue|jest|mocha|chai|playwright|cypress|pytest|testing-library|unittest/i.test(s);

/** Build the "real things exist" oracle from the graph: file stems + domain tokens. */
export function buildOracle(graph: LocalGraph): CompareOracle {
  const fileStems = new Set<string>();
  const tokens = new Set<string>();
  const add = (raw: unknown): void => {
    const t = norm(String(raw ?? ""));
    if (t.length >= 5) tokens.add(t);
  };
  for (const n of graph.nodes) {
    if (n.kind === "File") {
      const s = stemOf(n.external_id);
      if (s) {
        fileStems.add(s);
        if (s.length >= 5) tokens.add(s);
      }
    }
    if (n.kind === "CodeSymbol") add(n.title);
    if (n.title) add(n.title);
    if (n.properties && n.properties.feature) {
      const f = norm(String(n.properties.feature));
      if (f.length >= 4) {
        tokens.add(f);
        fileStems.add(f);
      }
    }
  }
  return { fileStems, tokens };
}

interface ArmAnalysis {
  n: number;
  assertionsSum: number;
  groundedCount: number;
  realApiCount: number;
  inventedSum: number;
  domainCount: number;
  smokeCount: number;
  traceRefs: number;
  weakCount: number;
}

/** Single per-test pass that feeds both the dimension scores and the matrix. */
function analyzeArm(tests: GeneratedTest[], oracle: CompareOracle): ArmAnalysis {
  const a: ArmAnalysis = {
    n: tests.length,
    assertionsSum: 0,
    groundedCount: 0,
    realApiCount: 0,
    inventedSum: 0,
    domainCount: 0,
    smokeCount: 0,
    traceRefs: 0,
    weakCount: 0
  };
  for (const t of tests) {
    const body = t.body || "";
    const nb = norm(body);

    const assertions = (body.match(CONCRETE_ASSERTION) || []).length;
    a.assertionsSum += assertions;
    if (assertions === 0) a.smokeCount++;

    const refs = t.grounding.source_refs?.length || 0;
    a.traceRefs += refs;
    if (refs > 0) a.groundedCount++;
    if (t.weak_evidence_used) a.weakCount++;

    const nonFw = importsOf(body).filter((s) => !isFramework(s));
    const importsReal = nonFw.some((s) => oracle.fileStems.has(stemOf(s)));
    a.inventedSum += nonFw.filter((s) => !oracle.fileStems.has(stemOf(s))).length;

    const mentionsDomain = [...oracle.tokens].some((tok) => nb.includes(tok));
    if (mentionsDomain) a.domainCount++;
    if (importsReal || mentionsDomain) a.realApiCount++;
  }
  return a;
}

/** Score one arm's tests across the four dimensions (0-100 each). */
export function scoreArm(tests: GeneratedTest[], oracle: CompareOracle): CompareDimensions {
  const a = analyzeArm(tests, oracle);
  if (a.n === 0) return { completeness: 0, context_awareness: 0, accuracy: 0, domain_specificity: 0 };
  const assertionsAvg = a.assertionsSum / a.n;
  const inventedAvg = a.inventedSum / a.n;
  const pct = (x: number): number => Math.max(0, Math.min(100, Math.round(100 * x)));
  return {
    // depth (assertions, target ~3) blended with breadth (scenario count, target ~3)
    completeness: pct(0.6 * Math.min(1, assertionsAvg / 3) + 0.4 * Math.min(1, a.n / 3)),
    context_awareness: pct(a.groundedCount / a.n),
    accuracy: pct(Math.max(0, a.realApiCount / a.n - 0.5 * Math.min(1, inventedAvg / 2))),
    domain_specificity: pct(a.domainCount / a.n)
  };
}

/** Objective comparison matrix (incl. traceability) for one arm. */
export function armMetrics(tests: GeneratedTest[], oracle: CompareOracle): CompareMetrics {
  const a = analyzeArm(tests, oracle);
  return {
    tests: a.n,
    concrete_assertions_avg: a.n ? Math.round((a.assertionsSum / a.n) * 10) / 10 : 0,
    traceability_refs: a.traceRefs,
    weak_evidence_disclosed: a.weakCount,
    smoke_only: a.smokeCount
  };
}
