// N48 .map on a CUSTOM object (Codex review): `collection.map(cb)` where collection is a
// plain object whose `map` returns a constant and never calls `cb`. A HOF callback counts
// as invoked ONLY when the receiver is provably a built-in Array/ReadonlyArray/tuple (or a
// Promise for then/catch); a method merely NAMED map on an unknown object does not run its
// callback, so saveUser is never exercised. Fails conjunct 5. Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

const collection = {
  map(_: (value: { id: string }) => string): string[] {
    return ["constant"];
  }
};

describe("custom map ignores callback", () => {
  it("asserts custom map result without invoking callback", () => {
    expect(collection.map((user) => saveUser(user))).toEqual(["constant"]);
  });
});
