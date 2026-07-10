import type { RtmSummary } from "../rtm.js";

/**
 * G6 — the coverage-vs-proof reveal line for the start summary.
 *
 * Compares ONLY same-scope numbers: both sides are RTM counts over the SAME
 * denominator (`summary.total`). The proven side is `coverage_confirmed` — the
 * IN-DENOMINATOR proven count — never `summary.proven`, which also counts
 * off-denominator proofs (relaxed hard-edge targets below the entry-point bar)
 * and can exceed `total` (a 5/3 = 167% render). The signature omits `proven`
 * entirely so the off-denominator number cannot be passed by mistake.
 *
 * `runtime_covered` is the DISJOINT runtime tier — behaviors a repo coverage
 * report executed that are NOT dynamically proven. Runtime coverage only proves
 * EXECUTION, and the unproven side may simply be unattempted or unrunnable —
 * the line says so and never blames the tests outright. Source-report
 * line-coverage totals (lcov LF/LH etc.) are NOT retained by ingestion and are
 * never invented here (spec G6 guardrail). Never implies proven SHOULD equal
 * coverage — they measure different things.
 *
 * Null when no runtime coverage was ingested (nothing to reveal) or the
 * denominator is empty.
 */
export function coverageRevealLine(summary: Pick<RtmSummary, "total" | "coverage_confirmed" | "runtime_covered">): string | null {
  if (summary.runtime_covered <= 0 || summary.total <= 0) return null;
  const pct = (n: number): number => Math.round((n / summary.total) * 100);
  return (
    `Coverage vs proof: ${summary.runtime_covered}/${summary.total} behaviors are runtime-covered but not Dynamically Proven ` +
    `(${pct(summary.runtime_covered)}%) vs ${summary.coverage_confirmed}/${summary.total} Dynamically Proven (${pct(summary.coverage_confirmed)}%) — ` +
    `coverage only proves execution; the unproven side may be unattempted, blocked, or covered by tests that never assert these behaviors.`
  );
}
