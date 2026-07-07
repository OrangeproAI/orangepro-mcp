export interface ComputeResult {
  value: number;
  source: "real" | "mutant";
}

// Expression-body arrow (no `{` block). NOT supported — a wrapper rewrite could change behavior, so the
// locator must not match it → honest unrunnable, never a false proof.
export const compute = (a: number, b: number): ComputeResult => ({ value: a + b, source: "real" });
