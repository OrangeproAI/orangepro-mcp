import { taxCents } from "@b/tax";

export interface OrderTotal {
  value: number;
  source: "real" | "mutant";
}

export class OrdersService {
  // Calls into sibling package `b` (resolved via the "@b/*" tsconfig paths alias). The credited
  // target for the spike; an inert sentinel replaces this body to close Proven.
  total(subtotal: number): OrderTotal {
    return { value: subtotal + taxCents(subtotal), source: "real" };
  }
}
