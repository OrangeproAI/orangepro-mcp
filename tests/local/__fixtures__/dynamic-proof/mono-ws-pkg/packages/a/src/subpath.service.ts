// Imports a SUBPATH export of the sibling: `@wspkg/b/extra` (mapped by b's package.json `exports`
// "./extra" → "./dist/extra.js"). Aspect-2 honors `exports`, injecting an exact subpath alias that must
// take precedence over any workspace-root node_modules copy of @wspkg/b.
import { bonus } from "@wspkg/b/extra";

export interface BumpResult {
  value: number;
  source: "real" | "mutant";
}

export class BumpService {
  bump(n: number): BumpResult {
    return { value: n + bonus, source: "real" };
  }
}
