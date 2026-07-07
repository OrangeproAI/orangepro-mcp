// An ambiguous barrel: `saveUser` is re-exported by BOTH impl.ts and altImpl.ts,
// so a consumer importing `{ saveUser }` from here cannot be bound to a single
// terminal definition. N7 imports through this barrel — must downgrade to
// INFERRED (fails conjunct 1: non-terminal / ambiguous, 2+ candidate defs).
export * from "./impl.js";
export * from "./altImpl.js";
