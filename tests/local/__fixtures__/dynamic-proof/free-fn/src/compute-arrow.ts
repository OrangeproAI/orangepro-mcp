export interface ComputeResult {
  value: number;
  source: "real" | "mutant";
}

// Arrow-const block: `export const foo = (…) => { … }` — the shape methodRe cannot see.
export const compute = (a: number, b: number): ComputeResult => {
  return { value: a + b, source: "real" };
};
