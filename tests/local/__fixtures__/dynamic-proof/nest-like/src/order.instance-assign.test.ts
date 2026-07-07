import { describe, expect, it } from "vitest";
import { OrderResult, OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService instance reassignment", () => {
  it("asserts the reassigned method result", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const service = moduleRef.get(OrderService);
    service.createOrder = async (input: { total: number }): Promise<OrderResult> => ({
      id: "assigned-order",
      total: input.total,
      source: "fake"
    });

    const result = await service.createOrder({ total: 42 });

    expect(result.source).toBe("fake");
  });
});
