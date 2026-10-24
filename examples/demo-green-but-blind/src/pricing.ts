export function applyDiscount(price: number, percent: number): number {
  if (percent < 0 || percent > 100) {
    throw new Error("percent must be between 0 and 100");
  }
  return Math.round(price * (1 - percent / 100) * 100) / 100;
}

export function isEligibleForFreeShipping(subtotal: number, isMember: boolean): boolean {
  const threshold = isMember ? 25 : 50;
  return subtotal >= threshold;
}
