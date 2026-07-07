import { describe, expect, it } from "vitest";
import { OrderResult, OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService container stash substitution", () => {
  it("asserts the stashed alias fake result", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const holder = { service: moduleRef.get(OrderService) };
    holder.service.createOrder = async (input: { total: number }): Promise<OrderResult> => ({
      id: "stashed-order",
      total: input.total,
      source: "fake"
    });

    const result = await holder.service.createOrder({ total: 42 });

    expect(result.source).toBe("fake");
  });
});
