import assert from "node:assert/strict";
import { CartService } from "../src/cart.service.js";

describe("CartService", () => {
  it("asserts the concrete total", () => {
    const service = new CartService();
    assert.equal(service.total([{ price: 2 }, { price: 3 }]), 5);
  });

  it("throws a non-assertion error when explode changes", () => {
    const service = new CartService();
    if (service.explode() !== "real") {
      throw new Error("mutant changed setup");
    }
    assert.equal(service.explode(), "real");
  });
});
