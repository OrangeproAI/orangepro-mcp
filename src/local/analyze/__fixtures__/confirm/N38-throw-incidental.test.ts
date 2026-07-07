// N38 incidental call in a throwing block (Codex review): toThrow invokes the thunk, but
// the asserted throw comes from the explicit `throw`, not the binding — saveUser's result
// is discarded. An invoking matcher descends only a CONCISE-body arrow; a block body with
// extra statements / an explicit throw is ambiguous. Fails conjunct 5. Expected: INFERRED.
import { it, expect } from "vitest";
import { saveUser } from "./impl.js";

it("the explicit throw is asserted, not the binding", () => {
  expect(() => {
    saveUser({ id: "u1" });
    throw new Error("boom");
  }).toThrow("boom");
});
