// N42 side-effect call in an HOF block body (Codex review): inside a .map callback the
// binding runs as a side-effect statement, but the callback RETURNS a constant — so the
// mapped result is [1], independent of saveUser. An invoked HOF callback is descended only
// through its value-producing (returned) expressions, not its discarded side-effect
// statements. Returning garbage from saveUser still passes. Fails conjunct 5. Expected:
// INFERRED.
import { it, expect } from "vitest";
import { saveUser } from "./impl.js";

it("asserts the mapped constant, not the binding's result", () => {
  expect(
    [1].map(() => {
      saveUser({ id: "u1" });
      return 1;
    })
  ).toEqual([1]);
});
