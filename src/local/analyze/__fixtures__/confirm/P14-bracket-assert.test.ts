// P14 confirmed via bracket-accessed assert (round-3 recall): `assert["strictEqual"]`
// is semantically identical to `assert.strictEqual`. The trust gate (calleeRootId) and
// matcher detection descend string-keyed element access symmetrically with calleeText,
// so a genuine bracket-form assertion still confirms. Expected: CONFIRMED.
import { describe, it } from "vitest";
import assert from "node:assert";
import { saveUser } from "./impl.js";

describe("saveUser via bracket-accessed assert", () => {
  it("asserts the result with assert[\"strictEqual\"]", () => {
    assert["strictEqual"](saveUser({ id: "u1" }), "saved:u1");
  });
});
