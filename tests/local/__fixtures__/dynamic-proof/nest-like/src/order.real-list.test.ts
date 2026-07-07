import { describe, expect, it } from "vitest";
import { OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService listOrders", () => {
  it("returns persisted orders", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const service = moduleRef.get(OrderService);

    const orders = await service.listOrders();

    expect(orders).toEqual([
      {
        id: "real-order",
        total: 42,
        source: "real"
      }
    ]);
  });
});
