// P4 confirmed-barrel-followed: the binding is imported through a single,
// unambiguous re-export barrel. getAliasedSymbol follows the re-export to the
// terminal impl, then a runtime call + assertion confirms. Proves the
// TypeChecker barrel-following win the parse-only path could not make.
// Expected: CONFIRMED (COVERS targets sym:impl.ts#saveUser, NOT the barrel).
import { describe, it, expect } from "vitest";
import { saveUser } from "./goodBarrel.js";

describe("saveUser via a clean barrel", () => {
  it("saves a user through the re-export", () => {
    const r = saveUser({ id: "u2" });
    expect(r).toBe("saved:u2");
  });
});
