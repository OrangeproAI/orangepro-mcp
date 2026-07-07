import { describe, expect, it } from "vitest";
import { BumpService } from "./subpath.service";

// bonus comes from @wspkg/b/extra (the copied-sibling subpath alias) === 5, so bump(10) === 15.
describe("BumpService (imports @wspkg/b/extra sibling subpath export)", () => {
  it("adds the sibling subpath bonus and asserts the concrete result", () => {
    const svc = new BumpService();
    expect(svc.bump(10)).toEqual({ value: 15, source: "real" });
  });
});
