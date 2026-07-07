// N40 multiple distinct renders (Codex review): two render() calls in one block — the
// effect cannot be tied to LoginForm specifically (OtherForm could supply the button). A
// render effect confirms only when the block has exactly one render. Fails conjunct 5.
// Expected: INFERRED.
import { it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginForm, OtherForm } from "./LoginForm.js";

it("renders two components then asserts ambiguously", () => {
  render(<LoginForm />);
  render(<OtherForm />);
  expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
});
