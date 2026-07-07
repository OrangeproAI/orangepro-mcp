// N27 assert failure-MESSAGE argument laundering (round-2 review): node:assert
// treats the trailing argument of ok/equal/strictEqual/… as a human-readable
// failure MESSAGE — it is never compared. A real binding smuggled into the message
// slot runs but its value is never asserted (the actual check, `ok(true)`, is a
// tautology). Only an assert COMPARAND counts. Fails conjunct 5. Expected: INFERRED.
import { describe, it } from "vitest";
import assert from "node:assert";
import { saveUser } from "./impl.js";

describe("assert message-arg laundering", () => {
  it("hides the use in assert.ok's failure-message argument", () => {
    assert.ok(true, `result was ${saveUser({ id: "u1" })}`);
  });
});
