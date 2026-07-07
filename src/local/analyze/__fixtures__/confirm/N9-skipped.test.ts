// N9 skipped-test: conjuncts 1-3 and 5 are satisfied, but the test is skipped.
// Fails conjunct 4 (disabled block — it.skip). Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("skipped", () => {
  it.skip("would exercise it but is skipped", () => {
    const r = saveUser({ id: "u1" });
    expect(r).toBe("saved:u1");
  });
});
