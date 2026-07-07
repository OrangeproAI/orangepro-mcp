// N10 use-without-assertion: a resolved runtime call with NO assertion after it.
// Fails conjunct 5 (no observed assertion). Expected: INFERRED.
import { describe, it } from "vitest";
import { saveUser } from "./impl.js";

describe("use without assertion", () => {
  it("calls the behavior but never asserts", () => {
    saveUser({ id: "u1" });
  });
});
