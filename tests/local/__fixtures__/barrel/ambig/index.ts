// Two star re-exports that BOTH export `dup` -> ambiguous for `dup`,
// but `only1`/`only2` are each supplied by exactly ONE star -> deterministic.
export * from "./star1.js";
export * from "./star2.js";
