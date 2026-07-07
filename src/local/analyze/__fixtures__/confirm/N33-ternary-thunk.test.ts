// N33 thunk-as-value wrapped in a ternary (round-4 review): like N30 but the
// un-invoked arrow is one level deep inside a ternary, so it is not the syntactic
// top-level arg. A function is descended only when the matcher invokes it (toThrow)
// or it is a known invoking higher-order callback (.map/.filter/…); a function merely
// STORED in a ternary/logical operand or literal is inspected as a value, never run.
// toBeInstanceOf never calls it, so saveUser never executes. Fails conjunct 5.
// Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("thunk-as-value behind a ternary", () => {
  it("inspects a stored arrow, never invokes it", () => {
    const cond = true;
    expect(cond ? (() => saveUser({ id: "u1" })) : null).toBeInstanceOf(Function);
  });
});
