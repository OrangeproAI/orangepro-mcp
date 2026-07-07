import { describe, expect, it } from "vitest";
import { OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService real DI binding", () => {
  it("asserts the real order creation result", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const service = moduleRef.get(OrderService);

    const result = await service.createOrder({ total: 42 });

    expect(result).toEqual({
      id: "real-order",
      total: 42,
      source: "real"
    });
  });
});
