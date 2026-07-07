import { describe, expect, it } from "vitest";
import { DecoyOrderService } from "./order.decoy.service";
import { Test } from "./testing-module";

describe("DecoyOrderService real DI binding", () => {
  it("asserts the real order creation result", async () => {
    const moduleRef = await Test.createTestingModule({
      providers: [DecoyOrderService]
    }).compile();
    const service = moduleRef.get(DecoyOrderService);

    const result = await service.createOrder({ total: 42 });

    expect(result.source).toBe("real");
  });
});
