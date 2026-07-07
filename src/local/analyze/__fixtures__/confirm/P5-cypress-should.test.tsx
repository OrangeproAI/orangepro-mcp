// P5 confirmed-self-assert (Testing-Library findByText): a JSX render of the
// terminal component observed by an auto-waiting `screen.findByText(...)` query
// (no separate `expect`). The query throws when absent, so it IS the assertion,
// observing the render's effect (conjunct 5, render path). Expected: CONFIRMED.
import { describe, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginForm } from "./LoginForm.js";

describe("LoginForm observed via findByText", () => {
  it("renders the email label", async () => {
    render(<LoginForm />);
    await screen.findByText("Email");
  });
});
