// P1 confirmed-call-assert: a resolved runtime call of the terminal impl binding,
// followed by an assertion on its result. All conjuncts 1-5 pass.
// Expected: CONFIRMED (hard TESTED_BY + COVERS to sym:impl.ts#saveUser).
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("saveUser", () => {
  it("saves a user", () => {
    const r = saveUser({ id: "u1" });
    expect(r).toBe("saved:u1");
  });
});
