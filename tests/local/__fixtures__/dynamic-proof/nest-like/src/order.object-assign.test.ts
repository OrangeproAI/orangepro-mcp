import { describe, expect, it } from "vitest";
import { OrderResult, OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService Object.assign substitution", () => {
  it("asserts the assigned fake result", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const service = moduleRef.get(OrderService);
    Object.assign(service, {
      async createOrder(input: { total: number }): Promise<OrderResult> {
        return {
          id: "object-assign-order",
          total: input.total,
          source: "fake"
        };
      }
    });

    const result = await service.createOrder({ total: 42 });

    expect(result.source).toBe("fake");
  });
});
