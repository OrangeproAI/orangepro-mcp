import { describe, expect, it } from "vitest";
import { OrderResult, OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService defineProperty substitution", () => {
  it("asserts the defined fake result", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const service = moduleRef.get(OrderService);
    Object.defineProperty(service, "createOrder", {
      value: async (input: { total: number }): Promise<OrderResult> => ({
        id: "define-property-order",
        total: input.total,
        source: "fake"
      })
    });

    const result = await service.createOrder({ total: 42 });

    expect(result.source).toBe("fake");
  });
});
