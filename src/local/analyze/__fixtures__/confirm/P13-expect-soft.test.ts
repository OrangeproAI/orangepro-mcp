// P13 confirmed via expect.soft (round-3 recall): Vitest's soft assertion is a
// first-class `expect` variant that genuinely runs-and-asserts. The expect-root
// regex admits `expect.soft`/`expect.poll`, so a soft assertion confirms. Expected:
// CONFIRMED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("saveUser via expect.soft", () => {
  it("soft-asserts the binding's result", () => {
    expect.soft(saveUser({ id: "u1" })).toBe("saved:u1");
  });
});
