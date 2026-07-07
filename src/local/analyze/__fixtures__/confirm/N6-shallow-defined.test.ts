// N6 shallow-defined: an import-existence smoke test. The binding is passed to
// expect() but never called/constructed/rendered. Fails conjunct 3 (no runtime
// use — `toBeDefined` on the bare binding is not an exercise). Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("shallow smoke", () => {
  it("only asserts the export is defined", () => {
    expect(saveUser).toBeDefined();
  });
});
