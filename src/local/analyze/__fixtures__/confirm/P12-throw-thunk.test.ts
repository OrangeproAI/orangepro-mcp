// P12 confirmed via an INVOKING matcher on a thunk (round-2 recall): `toThrow`
// INVOKES the callback, so the binding DOES run and the test asserts its throwing
// behavior. Unlike N30's non-invoking matcher, the WRAPPED path must descend into the
// thunk body here. Locks in that the uninvoked-function hardening keeps the genuine
// `expect(() => fn()).toThrow()` pattern confirmable. Expected: CONFIRMED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("saveUser exercised by toThrow", () => {
  it("invokes the binding via the throwing matcher", () => {
    expect(() => saveUser({ id: "u1" })).toThrow();
  });
});
