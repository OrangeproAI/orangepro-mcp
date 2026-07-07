// Bundler-resolution subject: reached via the `@app/*` path-alias (Mattermost
// idiom). Behavior = `placeOrder`.
export function placeOrder(order: { id: string }): string {
  return "order:" + order.id;
}

export type Order = { id: string };
