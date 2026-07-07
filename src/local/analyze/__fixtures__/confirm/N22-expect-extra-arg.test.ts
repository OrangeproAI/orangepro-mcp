// N22 ignored second expect argument (adversarial review): expect() asserts only
// its FIRST argument; a runtime use smuggled into a 2nd, ignored argument is never
// observed by the matcher. The test passes for any saveUser implementation. Fails
// conjunct 5. Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("ignored second expect argument", () => {
  it("hides the use in expect's 2nd (ignored) argument", () => {
    // @ts-expect-error — expect takes one argument; the 2nd is ignored at runtime.
    expect(7, saveUser({ id: "u1" })).toBe(7);
  });
});
