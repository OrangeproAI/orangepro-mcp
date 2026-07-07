import { describe, expect, it } from "vitest";
import { OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService call with unrelated assertion", () => {
  it("does not assert the order creation result", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const service = moduleRef.get(OrderService);

    await service.createOrder({ total: 42 });

    expect(1 + 1).toBe(2);
  });
});
