// B2 path-alias + barrel positive: `@app/barrel` re-exports placeOrder from
// ./orders; the confirmer must follow the re-export to the terminal and CONFIRM
// against sym for src/orders.ts#placeOrder (NOT the barrel).
import { describe, it, expect } from "vitest";
import { placeOrder } from "@app/barrel";

describe("placeOrder via aliased barrel", () => {
  it("places an order through the re-export", () => {
    const r = placeOrder({ id: "o2" });
    expect(r).toBe("order:o2");
  });
});
