import { describe, expect, it } from "vitest";
import { OrderResult, OrderService } from "./order.service";
import { Test } from "./testing-module";

class FakeOrderService {
  async createOrder(input: { total: number }): Promise<OrderResult> {
    return {
      id: "fake-class-order",
      total: input.total,
      source: "fake"
    };
  }
}

describe("OrderService useClass substitution", () => {
  it("asserts the substituted class result", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: OrderService, useClass: FakeOrderService }]
    }).compile();
    const service = moduleRef.get(OrderService);

    const result = await service.createOrder({ total: 42 });

    expect(result.source).toBe("fake");
  });
});
