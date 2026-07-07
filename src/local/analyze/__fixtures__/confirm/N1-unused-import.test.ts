// N1 unused-import: the binding is imported but never referenced.
// Fails conjunct 3 (no runtime reference). Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("unused", () => {
  it("checks something else entirely", () => {
    expect(1 + 1).toBe(2);
  });
});
