// B3 bundler extensionless-relative positive: `./src/orders` (no extension)
// resolves under bundler moduleResolution; runtime call + assertion → CONFIRMED.
import { describe, it, expect } from "vitest";
import { placeOrder } from "./src/orders";

describe("placeOrder via extensionless relative", () => {
  it("places an order", () => {
    expect(placeOrder({ id: "o3" })).toBe("order:o3");
  });
});
