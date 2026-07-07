// N8 fixture-helper-import: the binding is imported from a test helper that
// shares the behavior's NAME but is a different file/binding. Fails conjunct 1
// (resolves to helper.ts, not the terminal impl). Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./helper.js";

describe("helper, not the behavior", () => {
  it("exercises the helper of the same name", () => {
    const r = saveUser();
    expect(r).toBe("helper-stub");
  });
});
