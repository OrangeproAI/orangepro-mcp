// N37 forEach discards the callback value (Codex review): forEach returns undefined, so
// the binding runs inside the callback but its result never reaches the asserted value
// (toBeUndefined asserts forEach's undefined). Only value-CARRYING HOFs (map/reduce/then/
// …) are descended; forEach/filter/find/some/every are not. Fails conjunct 5. Expected:
// INFERRED.
import { it, expect } from "vitest";
import { saveUser } from "./impl.js";

it("forEach result is undefined, not the binding's value", () => {
  expect([1].forEach(() => saveUser({ id: "u1" }))).toBeUndefined();
});
