// N7 barrel-ambiguous: the binding is imported through a barrel that re-exports
// `saveUser` from TWO modules (impl + altImpl), so it cannot be followed to a
// single terminal definition. Fails conjunct 1 (non-terminal / ambiguous, 2+
// candidate defs). Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./barrel.js";

describe("ambiguous barrel", () => {
  it("calls a binding that resolves to no single terminal", () => {
    const r = saveUser({ id: "u1" });
    expect(typeof r).toBe("string");
  });
});
