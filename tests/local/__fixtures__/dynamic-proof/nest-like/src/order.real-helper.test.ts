import { describe, expect, it } from "vitest";
import { OrderService } from "./order.service";
import { Test } from "./testing-module";

async function exercise(service: OrderService) {
  return service.createOrder({ total: 7 });
}

describe("OrderService real binding through helper", () => {
  it("asserts the real result through a benign helper", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const service = moduleRef.get(OrderService);

    const result = await exercise(service);

    expect(result.source).toBe("real");
  });
});
