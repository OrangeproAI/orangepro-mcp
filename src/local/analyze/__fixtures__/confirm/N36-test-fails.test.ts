// N36 expected-failure runner (Codex review): test.fails marks the test as EXPECTED to
// fail — a passing assertion means the behavior is still WRONG, not covered. Expected-
// failure markers (fails/failing) are treated as non-live. Fails conjunct 4. Expected:
// INFERRED.
import { test, expect } from "vitest";
import { saveUser } from "./impl.js";

test.fails("expected failure is not coverage", () => {
  expect(saveUser({ id: "u1" })).toBe("future-fixed-value");
});
