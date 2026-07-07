// N20 expect + built-in value method (impostor, non-Object class): like N19 but
// the invoked member is `.toFixed(...)` — a Number built-in that shares the
// `to[A-Z]` matcher shape yet asserts nothing. Pins that the impostor denylist
// covers the broader ECMAScript `to*` built-ins (Number/String/Array/Date), not
// just `toString`. Constructed adversarial case. Fails conjunct 5. Expected:
// INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("expect with a built-in value method", () => {
  it("invokes .toFixed() on the expectation, which asserts nothing", () => {
    expect(saveUser({ id: "u1" })).toFixed(2);
  });
});
