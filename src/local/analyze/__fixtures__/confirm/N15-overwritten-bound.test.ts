// N15 overwritten bound result (Codex review CRITICAL): the call's result is bound
// to a `let`, then REASSIGNED before the assertion, so the asserted value no longer
// comes from saveUser. Fails conjunct 5 (bound-result observation requires a const
// that cannot be reassigned). Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("overwritten bound result", () => {
  it("asserts a value no longer produced by saveUser", () => {
    let result = saveUser({ id: "u1" });
    result = "not-from-saveUser";
    expect(result).toBe("not-from-saveUser");
  });
});
