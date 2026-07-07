// B1 path-alias positive: `@app/orders` resolves (bundler + tsconfig paths) to
// src/orders.ts; runtime call + assertion → CONFIRMED.
import { describe, it, expect } from "vitest";
import { placeOrder } from "@app/orders";

describe("placeOrder via path alias", () => {
  it("places an order", () => {
    const r = placeOrder({ id: "o1" });
    expect(r).toBe("order:o1");
  });
});
