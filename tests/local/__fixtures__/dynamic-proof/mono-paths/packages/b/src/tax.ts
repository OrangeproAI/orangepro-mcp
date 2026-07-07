// Sibling workspace package `b`'s SOURCE. Package `a` imports it via the tsconfig `paths`
// alias "@b/*": ["../b/src/*"]. M-2 copies this file (bytes, read-only) into the sandbox and
// injects the alias so the baseline can transform + run.
export function taxCents(subtotal: number): number {
  return Math.round(subtotal * 0.1);
}
