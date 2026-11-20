/**
 * What a mutated run that still passed says about its test.
 *
 * A test "misses a break" only when it ran the changed function. The proof scripts record that
 * with a marker the mutated body writes (see scripts/spikes/dynamic-proof-spike.mjs). Three
 * readings follow, and they are never merged:
 *
 *   ran_but_missed  the function ran and the test still passed: the test does not catch a break
 *   never_ran       the marker file is there and empty: the test never runs the function
 *   cant_tell       the marker could not be set up or read, the language has none, or the record
 *                   was written before the marker existed
 *
 * Only the first is a statement about what the test asserts.
 */
export type Reach = "ran" | "never_ran" | "unknown";
export type SurvivorKind = "ran_but_missed" | "never_ran" | "cant_tell";

export const SURVIVED_STATUS = "associated_survived";
export const NOT_EXERCISED_STATUS = "not_exercised";
export const REACH_UNKNOWN_STATUS = "reach_unknown";

export function isReach(value: unknown): value is Reach {
  return value === "ran" || value === "never_ran" || value === "unknown";
}

/** undefined when the status is not a passed-on-the-mutant outcome at all. */
export function survivorKind(mutantStatus: string | undefined, reach: string | undefined): SurvivorKind | undefined {
  if (mutantStatus === NOT_EXERCISED_STATUS) return "never_ran";
  if (mutantStatus === REACH_UNKNOWN_STATUS) return "cant_tell";
  if (mutantStatus === SURVIVED_STATUS || mutantStatus === "survived") {
    // A survivor with no reach on record predates the marker, or comes from a language without one.
    if (reach === "ran") return "ran_but_missed";
    if (reach === "never_ran") return "never_ran";
    return "cant_tell";
  }
  return undefined;
}

export function notExercisedReason(fn: string | undefined): string {
  return `not exercised: this test never runs ${fn && fn.trim() ? fn : "the function"}`;
}

export function reachUnknownReason(fn: string | undefined): string {
  return `reach unknown: could not check whether this test runs ${fn && fn.trim() ? fn : "the function"}`;
}
