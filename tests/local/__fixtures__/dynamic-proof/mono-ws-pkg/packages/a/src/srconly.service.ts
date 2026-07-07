// Imports sibling `@wspkg/src-only`, whose package.json `main` points at SOURCE (src/index.ts) — there
// is no built output. Aspect-2 falls back to copying the sibling `src` + its tsconfig so the runner
// transforms it, and aliases the package name to the copied source entry.
import { greet } from "@wspkg/src-only";

export interface GreetResult {
  value: number;
  source: "real" | "mutant";
}

export class GreetService {
  compute(n: number): GreetResult {
    return { value: n + greet, source: "real" };
  }
}
