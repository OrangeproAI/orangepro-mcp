// N24 local self-assert spoof (adversarial review): a self-asserting query
// (getByRole) observes a RENDER effect, never a plain value call. Here a LOCAL
// `screen` object (NOT imported from @testing-library) wraps a value use in its
// query argument. A self-assert must not confirm a value call via its arguments —
// only expect/assert do that. (A local screen also fails framework-DOM trust on the
// render path.) Fails conjunct 5. Expected: INFERRED.
import { describe, it } from "vitest";
import { saveUser } from "./impl.js";

const screen = {
  getByRole(_x: string): null {
    return null; // asserts NOTHING
  }
};

describe("local self-assert spoof", () => {
  it("wraps a value use in a local (fake) query", () => {
    const u = { id: "u1" };
    screen.getByRole(saveUser(u));
  });
});
