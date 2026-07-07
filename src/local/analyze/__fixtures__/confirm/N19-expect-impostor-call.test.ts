// N19 expect + non-matcher call (impostor of the bare-expect fix): the real
// binding runs inside `expect(...)` and the chain IS invoked — but `.toString()`
// is an inherited Object method, not a matcher, so it asserts nothing. Only a
// `to[A-Z]` matcher call (`toBe`/`toEqual`/`toThrow`/…) may confirm. A constructed
// adversarial case (real code never asserts via `.toString()`); the confirmer must
// be false-confirm-safe BY CONSTRUCTION. Fails conjunct 5. Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("expect with a non-matcher call", () => {
  it("invokes .toString() on the expectation, which asserts nothing", () => {
    expect(saveUser({ id: "u1" })).toString();
  });
});
