// N14 barrel-source mock (Codex review CRITICAL): the binding is imported through
// a clean barrel that re-exports the real impl, AND that barrel module is mocked.
// The call hits the mock, not the impl — even though the binding walks to the
// terminal impl. Fails conjunct 4: a behavior is mocked when ANY of its
// import-source modules (here the barrel) is mocked, not only the impl file.
// Expected: INFERRED.
import { describe, it, expect, vi } from "vitest";
import { saveUser } from "./goodBarrel.js";

vi.mock("./goodBarrel.js", () => ({ saveUser: vi.fn(() => "mocked") }));

describe("mocked barrel export", () => {
  it("asserts the mock, not the real impl", () => {
    expect(saveUser({ id: "u1" })).toBe("mocked");
  });
});
