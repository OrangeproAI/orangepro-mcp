import { describe, expect, it } from "vitest";
import { OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService real binding with state observation", () => {
  it("asserts observable state after calling the real method", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const service = moduleRef.get(OrderService);

    await service.createOrder({ total: 11 });

    expect(service.lastCreatedSource()).toBe("real");
  });
});
