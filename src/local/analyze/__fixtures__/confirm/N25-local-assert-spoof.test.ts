// N25 local assert spoof (adversarial review): the assert* branch matches by name.
// A LOCAL no-op named `assert` (NOT imported from node:assert/chai) asserts nothing
// — it ignores its argument and returns undefined. An assert must resolve to a
// trusted assert module to count; a local shadow cannot fake evidence (mirrors the
// framework-render trust). Fails conjunct 5. Expected: INFERRED.
import { describe, it } from "vitest";
import { saveUser } from "./impl.js";

// LOCAL no-op named `assert` — not node:assert.
const assert = (_: unknown): void => {};

describe("local assert spoof", () => {
  it("calls a no-op local assert on the result", () => {
    assert(saveUser({ id: "u1" }));
  });
});
