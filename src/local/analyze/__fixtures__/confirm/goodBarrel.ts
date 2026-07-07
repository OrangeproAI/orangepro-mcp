// A FOLLOWABLE barrel: a single, unambiguous re-export of the real impl binding.
// Used by P4 to prove the TypeChecker (getAliasedSymbol) follows a re-export to
// the terminal definition — a runtime+asserted use through this barrel CONFIRMS.
export { saveUser } from "./impl.js";
