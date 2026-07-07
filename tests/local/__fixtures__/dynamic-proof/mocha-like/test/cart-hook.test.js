import assert from "node:assert/strict";
import { CartService } from "../src/cart.service.js";

describe("CartService hook assertion", () => {
  let service;

  beforeEach(() => {
    service = new CartService();
    assert.equal(service.total([{ price: 2 }, { price: 3 }]), 5);
  });

  it("has a body that does not assert the target output", () => {
    assert.ok(service);
  });
});
