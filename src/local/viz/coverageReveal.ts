import type { RtmSummary } from "../rtm.js";

/**
 * G6 — the coverage-vs-proof reveal line for the start summary.
 *
 * Compares ONLY same-scope numbers: both sides are RTM tier counts over the SAME
 * denominator (`summary.total`), so the two percentages can never mix scopes.
 * `runtime_covered` is the DISJOINT runtime tier — behaviors a repo coverage
 * report executed that are NOT dynamically proven — which is exactly the
 * coverage-theater gap the line reveals. Source-report line-coverage totals
 * (lcov LF/LH, coverage.py line-rate, jacoco counters) are NOT retained by
 * ingestion and are never invented here (spec G6 guardrail: same scope or
 * counts, never a fabricated percentage). Never implies proven SHOULD equal
 * coverage — they measure different things.
 *
 * Null when no runtime coverage was ingested (nothing to reveal) or the
 * denominator is empty.
 */
export function coverageRevealLine(summary: Pick<RtmSummary, "total" | "proven" | "runtime_covered">): string | null {
  if (summary.runtime_covered <= 0 || summary.total <= 0) return null;
  const pct = (n: number): number => Math.round((n / summary.total) * 100);
  return (
    `Coverage vs proof: ${summary.runtime_covered}/${summary.total} behaviors are runtime-covered but NOT proven ` +
    `(${pct(summary.runtime_covered)}%) vs ${summary.proven}/${summary.total} Dynamically Proven (${pct(summary.proven)}%) — ` +
    `that gap is tests that run your code without asserting its behavior.`
  );
}
