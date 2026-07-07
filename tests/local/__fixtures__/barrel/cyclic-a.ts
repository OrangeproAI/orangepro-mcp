// Cyclic barrel pair (real-world barrels are often cyclic). `onlyA` defined here.
export * from "./cyclic-b.js";
export function onlyA(): string {
  return "a";
}
