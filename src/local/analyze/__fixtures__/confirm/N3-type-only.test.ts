// N3 type-only: the binding is imported with `import type` and used only in a
// type position. Fails conjunct 2 (type-only import). Expected: INFERRED.
import { describe, it, expect } from "vitest";
import type { saveUser } from "./impl.js";

describe("type-only", () => {
  it("references the type, not the runtime value", () => {
    let ref: typeof saveUser | undefined;
    expect(typeof ref).toBe("undefined");
  });
});
