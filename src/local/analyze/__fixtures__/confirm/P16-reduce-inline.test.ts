// P16 confirmed via an inline .reduce callback (round-4 recall): proves the
// invoking higher-order callback rule is not map-specific — reduce/filter/find/
// flatMap/forEach/Array.from callbacks are all descended (they genuinely invoke the
// callback), so the binding called inside one and asserted via the result confirms.
// Expected: CONFIRMED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("saveUser via an inline reduce callback", () => {
  it("reduces with the binding, asserts the accumulator", () => {
    expect([{ id: "a" }, { id: "b" }].reduce((acc, u) => acc + saveUser(u), "")).toBe("saved:asaved:b");
  });
});
