// N30 use inside an UNINVOKED function expression (round-2 review): the binding is
// wrapped in an arrow that is never called, and the matcher (toBeInstanceOf) inspects
// the function OBJECT rather than invoking it — so the binding never runs and nothing
// about it is asserted. The WRAPPED relatedness path must not descend into a function
// body unless the matcher invokes the callback (toThrow — see P12). Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("uninvoked thunk inspected by a non-invoking matcher", () => {
  it("asserts the wrapper function, never invokes it", () => {
    expect(() => saveUser({ id: "u1" })).toBeInstanceOf(Function);
  });
});
