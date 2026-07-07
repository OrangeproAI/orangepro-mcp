// N23 ES2024 String built-in impostor (adversarial review): `.toWellFormed()` is a
// real, callable, no-throw String method (ES2024) that shares the `to[A-Z]` matcher
// shape but asserts nothing. It must be in the closed built-in `to*` denylist so it
// is not mistaken for a Jest matcher. Fails conjunct 5. Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("toWellFormed builtin impostor", () => {
  it("invokes the ES2024 String.toWellFormed, which asserts nothing", () => {
    expect(saveUser({ id: "u1" })).toWellFormed();
  });
});
