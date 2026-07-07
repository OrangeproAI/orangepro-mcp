// P11 confirmed with an ALIASED framework query (round-2 recall): `screen` imported
// as `scr` (idiomatic testing-library, to avoid collisions) is still a framework DOM
// query. Framework trust must match the IMPORTED name, not the local text, so a
// genuine render observed by an aliased query still confirms. Expected: CONFIRMED.
import { describe, it } from "vitest";
import { render, screen as scr } from "@testing-library/react";
import { LoginForm } from "./LoginForm.js";

describe("LoginForm via aliased screen", () => {
  it("renders the sign-in button, queried via scr", () => {
    render(<LoginForm />);
    scr.getByRole("button", { name: "Sign in" });
  });
});
