// N39 render after the assertion (Codex review): the framework query asserts against the
// manually-set DOM and runs BEFORE the render, so the LoginForm render is not what the
// effect observes. A render effect must occur AFTER the render. Fails conjunct 5.
// Expected: INFERRED.
import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginForm } from "./LoginForm.js";

it("asserts before rendering LoginForm", () => {
  document.body.innerHTML = "<button>Sign in</button>";
  expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
  render(<LoginForm />);
});
