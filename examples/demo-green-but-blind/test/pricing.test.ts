import { describe, it, expect } from "vitest";
import { applyDiscount, isEligibleForFreeShipping } from "../src/pricing";

describe("pricing", () => {
  it("applyDiscount returns a number", () => {
    expect(typeof applyDiscount(100, 10)).toBe("number");
  });
  it("isEligibleForFreeShipping returns a boolean", () => {
    expect(typeof isEligibleForFreeShipping(60, false)).toBe("boolean");
  });
});
