// P2 confirmed-render-assert: a JSX render of the terminal component binding,
// followed by an assertion. Conjunct 3 is satisfied via the JSX render path.
// Expected: CONFIRMED (hard TESTED_BY + COVERS to sym:LoginForm.tsx#LoginForm).
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginForm } from "./LoginForm.js";

describe("LoginForm", () => {
  it("renders the sign-in button", () => {
    render(<LoginForm />);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});
