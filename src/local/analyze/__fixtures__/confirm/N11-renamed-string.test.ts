// N11 renamed-binding-string: the binding is imported with a rename, then the
// renamed name appears ONLY inside a template literal. Fails conjunct 3 (no
// runtime reference — a string is not a use, even when renamed). Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser as save } from "./impl.js";

describe("renamed then stringified", () => {
  it("only names the renamed binding inside a template", () => {
    const note = `we should call ${"save"} but do not`;
    expect(note).toContain("save");
  });
});
