// Imports a bare dependency (`@wsdep/base`) that is HOISTED to the workspace-root node_modules and is
// NOT present in this package's own node_modules. In the isolated sandbox this import only resolves
// when the workspace-root node_modules is linked at an ancestor of the package copy (M-3 aspect 1),
// so this fixture makes the read-only workspace-root dependency link load-bearing for the baseline.
import { offset } from "@wsdep/base";

export interface CalcResult {
  value: number;
  source: "real" | "mutant";
}

export class CalcService {
  add(a: number, b: number): CalcResult {
    return { value: a + b + offset, source: "real" };
  }
}
