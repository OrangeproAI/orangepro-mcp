import { describe, expect, it } from "vitest";
import { OrderResult, OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService Reflect.set substitution", () => {
  it("asserts the reflected fake result", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const service = moduleRef.get(OrderService);
    Reflect.set(service, "createOrder", async (input: { total: number }): Promise<OrderResult> => ({
      id: "reflect-order",
      total: input.total,
      source: "fake"
    }));

    const result = await service.createOrder({ total: 42 });

    expect(result.source).toBe("fake");
  });
});
