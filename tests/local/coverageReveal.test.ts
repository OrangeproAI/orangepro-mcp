import { describe, expect, it } from "vitest";

import { coverageRevealLine } from "../../src/local/viz/coverageReveal.js";

describe("coverageRevealLine (G6)", () => {
  it("renders same-denominator percentages for runtime-covered vs proven", () => {
    const line = coverageRevealLine({ total: 100, proven: 12, runtime_covered: 75 });
    expect(line).toBe(
      "Coverage vs proof: 75/100 behaviors are runtime-covered but NOT proven (75%) vs 12/100 Dynamically Proven (12%) — " +
        "that gap is tests that run your code without asserting its behavior."
    );
  });

  it("is silent when no runtime coverage was ingested (nothing to reveal)", () => {
    expect(coverageRevealLine({ total: 50, proven: 3, runtime_covered: 0 })).toBeNull();
  });

  it("is silent on an empty denominator (never divides by zero, never invents a %)", () => {
    expect(coverageRevealLine({ total: 0, proven: 0, runtime_covered: 0 })).toBeNull();
  });

  it("both percentages come from the SAME total — the guardrail's same-scope requirement", () => {
    const line = coverageRevealLine({ total: 3, proven: 1, runtime_covered: 2 });
    // 2/3 → 67%, 1/3 → 33% — both over total=3, no source-report line-% is invented.
    expect(line).toContain("2/3");
    expect(line).toContain("(67%)");
    expect(line).toContain("1/3");
    expect(line).toContain("(33%)");
  });

  it("renders even when proven is 0 — the gap is the whole point", () => {
    const line = coverageRevealLine({ total: 10, proven: 0, runtime_covered: 7 });
    expect(line).toContain("7/10");
    expect(line).toContain("0/10 Dynamically Proven (0%)");
  });
});
