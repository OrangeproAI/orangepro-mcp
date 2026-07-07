// B6 path-alias type-only negative: the aliased binding is imported `import type`
// and used only in a type position — no runtime value is exercised. INFERRED.
import { describe, it, expect } from "vitest";
import type { placeOrder } from "@app/orders";

describe("type-only aliased import", () => {
  it("references the type, not the value", () => {
    let ref: typeof placeOrder | undefined;
    expect(typeof ref).toBe("undefined");
  });
});
