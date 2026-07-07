// P3 confirmed-self-assert (Testing-Library getBy*): a JSX render of the terminal
// component, observed by a synchronous `screen.getByRole(...)` query (no separate
// `expect`). getByRole throws when the element is absent, so the query IS the
// assertion — and it observes the render's effect (conjunct 5, render path).
// Expected: CONFIRMED. (A self-assert only rescues a RENDER exercise, not a plain
// value call — see N13.)
import { describe, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginForm } from "./LoginForm.js";

describe("LoginForm observed via getByRole", () => {
  it("renders the sign-in button", () => {
    render(<LoginForm />);
    screen.getByRole("button", { name: "Sign in" });
  });
});
