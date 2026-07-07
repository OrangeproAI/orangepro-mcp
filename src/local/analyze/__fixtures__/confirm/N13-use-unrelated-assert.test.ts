// N13 use + UNRELATED assertion (Codex review CRITICAL): the real binding runs,
// but the only assertion in the block is a tautology that neither consumes the
// call's result nor observes its effect. A co-located but unrelated assertion is
// NOT coverage. Fails conjunct 5 (relatedness). Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("use but unrelated assertion", () => {
  it("calls the behavior, asserts something else", () => {
    saveUser({ id: "u1" }); // result discarded
    expect(1 + 1).toBe(2); // unrelated to saveUser
  });
});
