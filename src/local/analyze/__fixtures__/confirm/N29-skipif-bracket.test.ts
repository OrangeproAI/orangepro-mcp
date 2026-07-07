// N29 conditional-skip via element (bracket) access (round-2 review): semantically
// identical to N26's `describe.skipIf(true)(...)`, but written with bracket member
// access. calleeText must normalize element access with a string-literal key so the
// skip marker cannot be evaded by bracket notation. The suite is skipped at runtime;
// the binding never runs. Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe["skipIf"](true)("conditionally skipped suite (bracket)", () => {
  it("has a use+matcher but the suite is skipped at runtime", () => {
    expect(saveUser({ id: "u1" })).toBe("saved:u1");
  });
});
