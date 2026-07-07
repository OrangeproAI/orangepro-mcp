// P10 confirmed via the MATCHER argument: `expect(expected).toEqual(saveUser(...))`
// genuinely asserts saveUser — its result is the comparand the matcher checks. A
// common idiom (assert an expected literal equals a function's output). The expect
// relatedness observes arg0 AND the matcher call's arguments, so the use in the
// matcher arg confirms. Locks in that the expect-arg0 hardening did not lose this
// recall. Expected: CONFIRMED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("saveUser asserted in the matcher argument", () => {
  it("expected literal toEqual the binding's output", () => {
    const expected = "saved:u1";
    expect(expected).toEqual(saveUser({ id: "u1" }));
  });
});
