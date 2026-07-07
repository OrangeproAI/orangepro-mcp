// N50 mocked framework package (Codex review): the test vi.mock()s @testing-library/react,
// so render/screen/act are FAKES — mocked act drops its callback (LoginForm never mounts) and
// mocked screen supplies the asserted value. Framework trust must be revoked when the package
// providing render/screen/act is mocked, downgrading render-effect confirmation. Fails
// conjunct 5. Expected: INFERRED.
import { render, screen, act } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import { LoginForm } from "./LoginForm.js";

vi.mock("@testing-library/react", () => ({
  render: () => undefined,
  screen: { getByRole: () => "seeded" },
  act: (_: () => void) => undefined
}));

describe("mocked framework", () => {
  it("asserts mocked screen without rendering LoginForm", () => {
    act(() => render(<LoginForm />));
    expect(screen.getByRole("button", { name: "Sign in" })).toBe("seeded");
  });
});
