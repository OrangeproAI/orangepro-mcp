import { describe, expect, it } from "vitest";
import { OrdersService } from "./orders.service";

describe("OrdersService (imports @b/tax sibling source via tsconfig paths alias)", () => {
  it("adds tax from the aliased sibling package and asserts the concrete total", () => {
    const svc = new OrdersService();
    expect(svc.total(100)).toEqual({ value: 110, source: "real" });
  });
});
