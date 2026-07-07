// P7 confirmed-map-nested: the runtime call is inside a `.map(...)` callback (a
// nested arrow), and the assertion is in the SAME it() block. Conjunct 5 must
// match across the nested arrow because both share the it() test callback.
// Expected: CONFIRMED — pins the recall the test-callback scoping restores.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("batch save", () => {
  it("saves each user", () => {
    const r = [1, 2].map((x) => saveUser({ id: String(x) }));
    expect(r).toEqual(["saved:1", "saved:2"]);
  });
});
