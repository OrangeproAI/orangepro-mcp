// N31 assert.fail message (round-3 review): assert.fail([message]) unconditionally
// throws — its sole argument is the failure MESSAGE, never a comparand. A binding
// interpolated into that message runs but its value is never asserted. assert.fail
// is modelled as a ZERO-comparand method. Fails conjunct 5. Expected: INFERRED.
import { describe, it } from "vitest";
import assert from "node:assert";
import { saveUser } from "./impl.js";

describe("assert.fail message laundering", () => {
  it("interpolates the binding into assert.fail's message", () => {
    assert.fail(`unexpected: ${saveUser({ id: "u1" })}`);
  });
});
