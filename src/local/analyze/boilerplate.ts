// Trivial-accessor / object-protocol exclusion from the BEHAVIOR denominator.
//
// Boilerplate accessors (Java getId/setName, toString/equals/hashCode, Python
// __repr__/__str__) have no meaningful behavior to test. Counting them as
// untested behaviors under-claims coverage on entity-heavy repos (Spring
// Petclinic was ~33% getters/setters). They stay in the graph as CodeSymbol
// nodes for completeness, but are marked denominator_eligible:false with a
// reason, and surfaced as `excluded_boilerplate` so the report can disclose:
// "107 symbols found, 35 boilerplate accessors excluded, 72 behaviors counted."
//
// Name-based and deliberately CONSERVATIVE — language-aware so it never strips
// real logic. Body-aware refinement is a documented follow-up.

export const BOILERPLATE_REASON = "Trivial accessor/object method — excluded from behavior denominator.";

/**
 * True iff `name` is a trivial accessor/object-protocol member for `language`.
 * Only ever applied to function/method symbols (classes are never boilerplate).
 *
 *  - Java/Kotlin: getX/setX/isX ONLY when the body is AST-proven trivial
 *    (trivialAccessor); toString/equals/hashCode by name (object plumbing).
 *  - Python: low-signal dunders __repr__ and __str__ ONLY. snake_case accessors
 *    like get_x / is_x are NOT excluded — those routinely hit DB/API/business logic.
 *  - Go and everything else: nothing (e.g. `main` may be real runtime wiring).
 */
export function isBoilerplateSymbol(name: string, language: string, symbolKind: string, trivialAccessor?: boolean): boolean {
  if (symbolKind !== "method" && symbolKind !== "function") return false;
  switch (language) {
    case "java":
    case "kotlin":
      // A getX/setX/isX JavaBean accessor is excluded ONLY when the AST proved
      // its body is trivial — so `getOwner()` that calls a repository, or any
      // get-named method with real logic, stays a counted behavior.
      if (/^(get|set|is)[A-Z]/.test(name)) return trivialAccessor === true;
      // Object-protocol plumbing, excluded by name (not business behavior).
      return name === "toString" || name === "equals" || name === "hashCode";
    case "python":
      return name === "__repr__" || name === "__str__";
    default:
      return false;
  }
}
