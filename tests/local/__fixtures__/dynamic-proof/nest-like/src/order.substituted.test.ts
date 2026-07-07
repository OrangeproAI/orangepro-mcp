import { describe, expect, it } from "vitest";
import { OrderResult, OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService substituted DI binding", () => {
  it("asserts the fake provider result without exercising the real service", async () => {
    const fakeService = {
      async createOrder(input: { total: number }): Promise<OrderResult> {
        return {
          id: "fake-order",
          total: input.total,
          source: "fake"
        };
      }
    };
    const moduleRef = await Test.createTestingModule({
      providers: [{ provide: OrderService, useValue: fakeService }]
    }).compile();
    const service = moduleRef.get(OrderService);

    const result = await service.createOrder({ total: 42 });

    expect(result).toEqual({
      id: "fake-order",
      total: 42,
      source: "fake"
    });
  });
});
