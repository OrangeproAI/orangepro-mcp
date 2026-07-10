import { describe, expect, it } from "vitest";

import { coverageRevealLine } from "../../src/local/viz/coverageReveal.js";

describe("coverageRevealLine (G6)", () => {
  it("renders same-denominator percentages for runtime-covered vs in-denominator proven", () => {
    const line = coverageRevealLine({ total: 100, coverage_confirmed: 12, runtime_covered: 75 });
    expect(line).toBe(
      "Coverage vs proof: 75/100 behaviors are runtime-covered but not Dynamically Proven (75%) vs 12/100 Dynamically Proven (12%) — " +
        "coverage only proves execution; the unproven side may be unattempted, blocked, or covered by tests that never assert these behaviors."
    );
  });

  it("uses coverage_confirmed, NEVER summary.proven — off-denominator proofs cannot inflate past 100%", () => {
    // Codex's reproduced #214 case: proven=5 includes off-denominator certs while
    // only 2 of the 3 denominator behaviors are proven. The line must show 2/3
    // (67%), never 5/3 (167%). The extra `proven` field is ignored by construction.
    const summaryWithOffDenominator = { total: 3, coverage_confirmed: 2, proven: 5, runtime_covered: 1 };
    const line = coverageRevealLine(summaryWithOffDenominator);
    expect(line).toContain("2/3 Dynamically Proven (67%)");
    expect(line).not.toContain("5/3");
    expect(line).not.toContain("167");
  });

  it("is silent when no runtime coverage was ingested (nothing to reveal)", () => {
    expect(coverageRevealLine({ total: 50, coverage_confirmed: 3, runtime_covered: 0 })).toBeNull();
  });

  it("is silent on an empty denominator (never divides by zero, never invents a %)", () => {
    expect(coverageRevealLine({ total: 0, coverage_confirmed: 0, runtime_covered: 0 })).toBeNull();
  });

  it("both percentages come from the SAME total — the guardrail's same-scope requirement", () => {
    const line = coverageRevealLine({ total: 3, coverage_confirmed: 1, runtime_covered: 2 });
    // 2/3 → 67%, 1/3 → 33% — both over total=3, no source-report line-% is invented.
    expect(line).toContain("2/3");
    expect(line).toContain("(67%)");
    expect(line).toContain("1/3");
    expect(line).toContain("(33%)");
  });

  it("renders even when nothing is proven — the gap is the whole point", () => {
    const line = coverageRevealLine({ total: 10, coverage_confirmed: 0, runtime_covered: 7 });
    expect(line).toContain("7/10");
    expect(line).toContain("0/10 Dynamically Proven (0%)");
  });
});
