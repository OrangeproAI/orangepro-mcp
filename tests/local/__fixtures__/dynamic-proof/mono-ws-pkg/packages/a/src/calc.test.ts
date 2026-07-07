import { describe, expect, it } from "vitest";
import { CalcService } from "./calc.service";

// base comes from the BUILT dist entry of @wspkg/b (=== 1). b's SOURCE decoy sets base=999, so if the
// alias pointed at src instead of dist this assertion would fail — it pins the built-output entry.
describe("CalcService (imports @wspkg/b sibling BUILT output by package name)", () => {
  it("adds two numbers plus the sibling's built base and asserts the concrete result", () => {
    const svc = new CalcService();
    expect(svc.add(2, 3)).toEqual({ value: 6, source: "real" });
  });
});
