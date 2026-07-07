// N34 dynamic-import mock (Codex review): vi.mock(import("./impl.js"), factory) mocks the
// module via a dynamic-import specifier, not a string literal. The real saveUser is
// replaced, so the test asserts the MOCK — real saveUser returning garbage still passes.
// The mock specifier must be extracted from the import(...) call. Fails conjunct 4.
// Expected: INFERRED.
import { describe, it, expect, vi } from "vitest";
import { saveUser } from "./impl.js";

vi.mock(import("./impl.js"), () => ({ saveUser: () => "fake" }));

describe("dynamic-import mock", () => {
  it("asserts the mock, not the real implementation", () => {
    expect(saveUser({ id: "u1" })).toBe("fake");
  });
});
