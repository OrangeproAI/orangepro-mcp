import { describe, expect, it } from "vitest";
import { OrderResult, OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService overrideProvider substitution", () => {
  it("asserts the overridden provider result", async () => {
    const fakeService = {
      async createOrder(input: { total: number }): Promise<OrderResult> {
        return {
          id: "override-order",
          total: input.total,
          source: "fake"
        };
      }
    };
    const builder = Test.createTestingModule({
      providers: [OrderService]
    });
    builder.overrideProvider(OrderService).useValue(fakeService);
    const moduleRef = await builder.compile();
    const service = moduleRef.get(OrderService);

    const result = await service.createOrder({ total: 42 });

    expect(result.source).toBe("fake");
  });
});
