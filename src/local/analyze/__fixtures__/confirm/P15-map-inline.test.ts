// P15 confirmed via an INLINE higher-order callback (round-3 recall, the critical
// regression): the binding is called inside a `.map` callback that is itself the
// expect() argument, asserting the mapped result. `.map` genuinely INVOKES the
// callback, so the use runs and its result IS the asserted array. The WRAPPED path
// descends a function NESTED in the arg (only a top-level thunk-as-value is blocked),
// so the common map-then-assert idiom confirms. Expected: CONFIRMED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("saveUser via an inline map callback", () => {
  it("maps then asserts the array, callback un-bound", () => {
    expect([{ id: "a" }, { id: "b" }].map((u) => saveUser(u))).toEqual(["saved:a", "saved:b"]);
  });
});
