import { afterEach, describe, expect, it } from "vitest";
import { OrderResult, OrderService } from "./order.service";
import { Test } from "./testing-module";

const original = OrderService.prototype.createOrder;

describe("OrderService prototype patch substitution", () => {
  afterEach(() => {
    OrderService.prototype.createOrder = original;
  });

  it("asserts the patched prototype result", async () => {
    OrderService.prototype.createOrder = async function createOrder(input: { total: number }): Promise<OrderResult> {
      return {
        id: "prototype-order",
        total: input.total,
        source: "fake"
      };
    };
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const service = moduleRef.get(OrderService);

    const result = await service.createOrder({ total: 42 });

    expect(result.source).toBe("fake");
  });
});
