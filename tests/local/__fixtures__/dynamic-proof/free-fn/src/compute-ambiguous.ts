export interface ComputeResult {
  value: number;
  source: "real" | "mutant";
}

// A free `const compute` AND a class method `compute` of the same name: freeFnRe matches the const and
// methodRe matches the method → 2 candidates → the ambiguity guard must refuse (unrunnable), never mutate a
// decoy. Compiles cleanly (no redeclaration — different binding scopes).
export const compute = (a: number, b: number): ComputeResult => {
  return { value: a + b, source: "real" };
};

export class Helper {
  compute(a: number, b: number): ComputeResult {
    return { value: a - b, source: "real" };
  }
}
