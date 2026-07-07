import { describe, expect, it } from "vitest";
import { CalcService } from "./calc.service";

describe("CalcService (monorepo package, extends ../../tsconfig.json)", () => {
  it("adds two numbers and asserts the concrete result", () => {
    const svc = new CalcService();
    expect(svc.add(2, 3)).toEqual({ value: 5, source: "real" });
  });
});
