// B4 workspace-package positive: `@pkg/orders` resolves (tsconfig paths) to a
// packages/ entry — the monorepo/workspace-package idiom; runtime call +
// assertion → CONFIRMED against packages/orders/index.ts#archiveOrder.
import { describe, it, expect } from "vitest";
import { archiveOrder } from "@pkg/orders";

describe("archiveOrder via workspace package", () => {
  it("archives an order", () => {
    expect(archiveOrder("o4")).toBe(true);
  });
});
