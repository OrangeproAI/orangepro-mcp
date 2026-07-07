import { describe, expect, it } from "vitest";
import { OrderResult, OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService Map stash substitution", () => {
  it("asserts the mapped alias fake result", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const services = new Map<string, OrderService>();
    services.set("order", moduleRef.get(OrderService));
    const service = services.get("order");
    if (!service) {
      throw new Error("missing service");
    }
    service.createOrder = async (input: { total: number }): Promise<OrderResult> => ({
      id: "map-stash-order",
      total: input.total,
      source: "fake"
    });

    const result = await service.createOrder({ total: 42 });

    expect(result.source).toBe("fake");
  });
});
