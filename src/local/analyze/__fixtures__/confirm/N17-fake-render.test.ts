// N17 local render/screen fakes a render-confirm (Codex review CRITICAL): `render`
// and `screen` are LOCAL (not testing-library). `render(saveUser)` never calls
// saveUser, and `screen.getByText` is a local stub. Neither the render helper nor
// the DOM-query receiver resolves to a real framework, so this is not a render use
// nor an effect observation. Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

const screen = { getByText: (_: string): string => "ok" };
function render(_: unknown): void {
  // intentionally does NOT call its argument
}

describe("local render/screen", () => {
  it("does not actually run saveUser", () => {
    render(saveUser);
    expect(screen.getByText("ok")).toBe("ok");
  });
});
