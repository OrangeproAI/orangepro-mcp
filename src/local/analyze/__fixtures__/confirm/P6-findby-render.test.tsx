// P6 confirmed-self-assert (Testing-Library findBy*): a JSX render of the
// terminal component, followed by an auto-waiting `screen.findByRole(...)` query
// (no `expect`). The query throws when the element is absent, so its call IS the
// assertion. Conjunct 3 (render) + conjunct 5 (self-assert) both satisfied.
// Expected: CONFIRMED.
import { describe, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginForm } from "./LoginForm.js";

describe("LoginForm found via findByRole", () => {
  it("renders and the button is found", async () => {
    render(<LoginForm />);
    await screen.findByRole("button", { name: "Sign in" });
  });
});
