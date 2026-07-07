// P22 Array.from(source, mapFn) (Codex round-7 recall guard): the SECOND argument IS the map
// callback and the global Array.from genuinely invokes it, so saveUser runs and its result is
// the asserted array. The Array.from trust-gate must still confirm this real idiom.
// Expected: CONFIRMED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("saveUser via Array.from map callback", () => {
  it("maps the source through the second-arg callback", () => {
    expect(Array.from([{ id: "a" }], (u) => saveUser(u))).toEqual(["saved:a"]);
  });
});
