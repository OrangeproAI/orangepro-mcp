// N35 chained skip.each (Codex review): describe.skip.each(...) skips the whole suite, but
// the skip marker lives in a chained/parametrized callee the exact-match skip set missed.
// The full callee chain is scanned for skip/todo/fails markers; the suite never runs.
// Fails conjunct 4. Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe.skip.each([["skipped"]])("%s", () => {
  it("does not run", () => {
    expect(saveUser({ id: "u1" })).toBe("saved:u1");
  });
});
