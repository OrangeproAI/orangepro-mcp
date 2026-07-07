// N2 mock-only: the impl module is mocked; the call hits the mock, not the impl.
// Fails conjunct 4 (mock factory / mocked module). Expected: INFERRED.
import { describe, it, expect, vi } from "vitest";
import { saveUser } from "./impl.js";

vi.mock("./impl.js", () => ({ saveUser: vi.fn(() => "mocked") }));

describe("mocked", () => {
  it("hits the mock not the impl", () => {
    expect(saveUser({ id: "x" })).toBe("mocked");
  });
});
