export interface ComputeResult {
  value: number;
  source: "real" | "mutant";
}

// Function expression bound to a const — `const foo = function (…) { … }`.
export const compute = function (a: number, b: number): ComputeResult {
  return { value: a + b, source: "real" };
};
