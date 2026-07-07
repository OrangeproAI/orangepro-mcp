// N47 LOCAL no-op act (Codex review): a locally-defined `act` that ignores its callback
// never mounts LoginForm — the assertion observes pre-seeded DOM. act/waitFor count as
// callback-invoking ONLY when imported from a real test framework (INVOKING_WRAPPER_PKGS);
// a local/unresolved `act` is treated as a dead boundary, so the render inside it is not
// live. Fails conjunct 3. Expected: INFERRED.
import { render, screen } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LoginForm } from "./LoginForm.js";

function act(_: () => void): void {}

describe("local no-op act", () => {
  it("asserts seeded DOM without rendering LoginForm", () => {
    act(() => {
      render(<LoginForm />);
    });
    document.body.innerHTML = "<button>Sign in</button>";
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});
