// N49 Array.from with a function as arg0 (Codex review): in `Array.from(fn)` the function is
// the array-LIKE SOURCE, not the map callback — Array.from only invokes its SECOND argument.
// saveUser is never called (the result is a degenerate array), so asserting it must not
// confirm. Only Array.from(source, mapFn) invokes mapFn, and only when Array is the global.
// Fails conjunct 5. Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("Array.from source function", () => {
  it("does not invoke the array-like source function", () => {
    expect(Array.from((user: { id: string }) => saveUser(user) as unknown as number)).toEqual([]);
  });
});
