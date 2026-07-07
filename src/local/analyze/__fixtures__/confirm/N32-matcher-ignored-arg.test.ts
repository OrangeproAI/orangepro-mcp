// N32 ignored matcher argument (round-3 review): a single-comparand matcher (toBe)
// ignores any 2nd+ argument — Jest/Vitest silently drop it. A binding smuggled into
// that ignored slot runs but is never compared (the assertion is `true === true`).
// Only a matcher's comparand argument(s) are observed; the variadic call/return
// families are the exception. Fails conjunct 5. Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("ignored matcher argument", () => {
  it("hides the use in toBe's ignored 2nd argument", () => {
    // @ts-expect-error — toBe takes one argument; the 2nd is ignored at runtime.
    expect(true).toBe(true, saveUser({ id: "u1" }));
  });
});
