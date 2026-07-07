import { describe, expect, it } from "vitest";
import { OrderService } from "./order.service";

describe("OrderService with explicit test env", () => {
  it("uses the local database URL supplied by the measurement harness", async () => {
    expect(process.env.OPRO_TEST_DATABASE_URL).toBe("sqlite://local-test-db");

    const result = await new OrderService().createOrder({ total: 9 });

    expect(result).toEqual({
      id: "real-order",
      total: 9,
      source: "real"
    });
  });
});
