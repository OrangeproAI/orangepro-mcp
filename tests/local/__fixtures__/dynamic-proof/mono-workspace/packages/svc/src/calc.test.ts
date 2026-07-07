import { describe, expect, it } from "vitest";
import { CalcService } from "./calc.service";

// offset comes from @wsdep/base (hoisted to the workspace-root node_modules) === 1, so add(2, 3) === 6.
describe("CalcService (workspace package, runner + dep hoisted to the workspace root)", () => {
  it("adds two numbers plus the hoisted offset and asserts the concrete result", () => {
    const svc = new CalcService();
    expect(svc.add(2, 3)).toEqual({ value: 6, source: "real" });
  });
});
