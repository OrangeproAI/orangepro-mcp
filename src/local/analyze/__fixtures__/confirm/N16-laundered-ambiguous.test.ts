// N16 clean-unused import laundering an ambiguous used import (Codex review
// CRITICAL): a clean DIRECT import of saveUser is present but UNUSED; the binding
// actually exercised comes from the AMBIGUOUS barrel. Conjunct 1 must be checked
// against the binding actually used (per-binding), not any import of the behavior.
// Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js"; // clean, but UNUSED
import { saveUser as runSaveUser } from "./barrel.js"; // ambiguous, USED

describe("ambiguous binding not laundered by a clean unused import", () => {
  it("exercises the ambiguous barrel binding", () => {
    const result = runSaveUser({ id: "u1" });
    expect(result).toBe("saved:u1");
  });
});
