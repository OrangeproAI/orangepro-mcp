import { describe, expect, it } from "vitest";
import { compute } from "./compute-arrow";

describe("free-function arrow-const block", () => {
  it("computes the concrete value", () => {
    expect(compute(2, 3)).toEqual({ value: 5, source: "real" });
  });
});
