// N18 bare expect, no matcher (Codex review CRITICAL): the real binding runs and
// its result is wrapped by `expect(...)`, but NO matcher is invoked. `expect(x)`
// alone asserts nothing in Jest/Vitest — only a complete matcher CALL chain
// (`expect(x).toBe(...)`, `await expect(p).resolves.toEqual(...)`,
// `expect(() => x()).toThrow()`) actually asserts. A bare `expect(...)` must not
// satisfy conjunct 5. Expected: INFERRED (rejected_conjunct 5).
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("bare expect without a matcher", () => {
  it("wraps the call in expect but never calls a matcher", () => {
    expect(saveUser({ id: "u1" }));
  });
});
