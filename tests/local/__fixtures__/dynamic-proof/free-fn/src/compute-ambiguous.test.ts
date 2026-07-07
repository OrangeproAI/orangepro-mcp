import { describe, expect, it } from "vitest";
import { compute } from "./compute-ambiguous";

describe("free-function ambiguous name", () => {
  it("computes the concrete value", () => {
    expect(compute(2, 3)).toEqual({ value: 5, source: "real" });
  });
});
