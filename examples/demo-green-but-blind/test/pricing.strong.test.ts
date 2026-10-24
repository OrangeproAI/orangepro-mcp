import { describe, it, expect } from "vitest";
import { applyDiscount, isEligibleForFreeShipping } from "../src/pricing";

describe("pricing (specific values)", () => {
  it("applyDiscount takes 10% off 100", () => {
    expect(applyDiscount(100, 10)).toBe(90);
  });
  it("applyDiscount rejects percent over 100", () => {
    expect(() => applyDiscount(100, 101)).toThrow();
  });
  it("free shipping at the member threshold of 25, not below", () => {
    expect(isEligibleForFreeShipping(25, true)).toBe(true);
    expect(isEligibleForFreeShipping(24.99, true)).toBe(false);
  });
  it("non-member needs 50", () => {
    expect(isEligibleForFreeShipping(49.99, false)).toBe(false);
    expect(isEligibleForFreeShipping(50, false)).toBe(true);
  });
});
