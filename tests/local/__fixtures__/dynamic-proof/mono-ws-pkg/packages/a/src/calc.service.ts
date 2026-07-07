// Imports sibling workspace package `@wspkg/b` by PACKAGE NAME (declared in a's dependencies).
// `@wspkg/b` ships BUILT OUTPUT (dist/index.js); there is no local node_modules, so this bare import
// only resolves when M-3 aspect-2 copies b's dist + package.json into the sandbox and injects the
// package-name resolver alias (Vitest resolve.alias / Jest moduleNameMapper). The credited target for
// the spike; an inert sentinel replaces this body to close Proven.
import { base } from "@wspkg/b";

export interface CalcResult {
  value: number;
  source: "real" | "mutant";
}

export class CalcService {
  add(a: number, b: number): CalcResult {
    return { value: a + b + base, source: "real" };
  }
}
