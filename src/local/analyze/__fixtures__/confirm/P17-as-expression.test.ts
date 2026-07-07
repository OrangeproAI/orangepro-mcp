// P17 confirmed through an `as` cast (Codex review, recall): `saveUser(...) as string`
// runs saveUser at runtime — only the cast's TYPE node is type-only, not the expression
// side. The bound const is then asserted. Locks in that as/satisfies/<T> casts do not
// misclassify a runtime call as type-only. Expected: CONFIRMED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("saveUser via an as-cast", () => {
  it("asserts the cast result", () => {
    const result = saveUser({ id: "u1" }) as string;
    expect(result).toBe("saved:u1");
  });
});
