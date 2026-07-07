import { describe, expect, it } from "vitest";
import { OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService pre-assertion read", () => {
  it("uses the result before asserting it", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    const service = moduleRef.get(OrderService);

    const result = await service.createOrder({ total: 42 });
    const source = result.source.toUpperCase();

    expect(source).toBe("REAL");
  });
});
