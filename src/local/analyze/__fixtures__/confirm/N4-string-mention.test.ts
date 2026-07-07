// N4 string-mention: the behavior name only appears inside a string literal.
// Fails conjunct 3 (no runtime reference — a string is not a binding use).
// Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("string mention", () => {
  it("only mentions the name in a string", () => {
    const text = "calls saveUser internally";
    expect(text).toContain("saveUser");
  });
});
