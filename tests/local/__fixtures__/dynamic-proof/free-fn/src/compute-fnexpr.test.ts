import { describe, expect, it } from "vitest";
import { compute } from "./compute-fnexpr";

describe("free-function function-expression", () => {
  it("computes the concrete value", () => {
    expect(compute(2, 3)).toEqual({ value: 5, source: "real" });
  });
});
