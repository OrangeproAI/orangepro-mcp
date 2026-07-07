export interface OrderResult {
  id: string;
  total: number;
  source: "real" | "fake" | "mutant";
}

export class OrderService {
  private lastSource: OrderResult["source"] | undefined;

  async createOrder(input: { total: number }): Promise<OrderResult> {
    this.lastSource = "real";
    return {
      id: "real-order",
      total: input.total,
      source: "real"
    };
  }

  listOrders(): Promise<OrderResult[]> {
    return Promise.resolve([
      {
        id: "real-order",
        total: 42,
        source: "real"
      }
    ]);
  }

  lastCreatedSource(): OrderResult["source"] | undefined {
    return this.lastSource;
  }
}
