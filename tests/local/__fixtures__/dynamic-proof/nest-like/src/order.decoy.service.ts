export const decoy = {
  createOrder() {
    return { id: "decoy-order", total: 0, source: "decoy" };
  }
};

export class DecoyOrderService {
  async createOrder(input: { total: number }) {
    return {
      id: "real-order",
      total: input.total,
      source: "real"
    };
  }
}
