import { beforeEach, describe, expect, it } from "vitest";
import { OrderService } from "./order.service";
import { Test } from "./testing-module";

describe("OrderService setup assertion", () => {
  let service: OrderService;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [OrderService]
    }).compile();
    service = moduleRef.get(OrderService);
    const result = await service.createOrder({ total: 42 });
    expect(result).toEqual({
      id: "real-order",
      total: 42,
      source: "real"
    });
  });

  it("has a body that does not assert the target output", () => {
    expect(service).toBeInstanceOf(OrderService);
  });
});
