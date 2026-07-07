// P9 confirmed via trusted node:assert: a real assertion library (node:assert)
// observes the binding's result. assert.equal resolves to a trusted module, so it
// IS a real assertion site (unlike a local no-op assert — see N25). Locks in that
// the assert-trust gate does not lose recall for genuine assert usage. Expected:
// CONFIRMED.
import { describe, it } from "vitest";
import assert from "node:assert";
import { saveUser } from "./impl.js";

describe("saveUser via node:assert", () => {
  it("asserts the result with assert.equal", () => {
    assert.equal(saveUser({ id: "u1" }), "saved:u1");
  });
});
