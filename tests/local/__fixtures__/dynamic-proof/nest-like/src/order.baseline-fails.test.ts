import { describe, expect, it } from "vitest";

describe("baseline failure fixture", () => {
  it("fails before mutation", () => {
    expect("baseline").toBe("green");
  });
});
