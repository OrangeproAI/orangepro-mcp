// N21 comma-operator argument laundering (adversarial review): the real binding
// runs INSIDE expect(...)'s argument, but the JS comma/sequence operator discards
// its return value — the matcher only asserts the final operand (a constant). The
// test passes for ANY saveUser implementation, so it asserts nothing about the
// binding. Structural containment is not data flow. Fails conjunct 5. Expected:
// INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("comma-operator discard", () => {
  it("evaluates saveUser for side effect then asserts an unrelated constant", () => {
    expect((saveUser({ id: "u1" }), true)).toBe(true);
  });
});
