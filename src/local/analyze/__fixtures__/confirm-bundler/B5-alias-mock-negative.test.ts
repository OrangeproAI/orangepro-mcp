// B5 path-alias mock negative: the aliased impl module is mocked, so the call
// hits the mock — must NOT confirm even though resolution succeeds. INFERRED.
import { describe, it, expect, vi } from "vitest";
import { placeOrder } from "@app/orders";

vi.mock("@app/orders", () => ({ placeOrder: vi.fn(() => "mocked") }));

describe("mocked placeOrder", () => {
  it("hits the mock", () => {
    expect(placeOrder({ id: "x" })).toBe("mocked");
  });
});
