// P19 const-element render idiom (Codex review): `const ui = <LoginForm/>; render(ui)`
// genuinely mounts LoginForm — the element is bound to a CONST that flows DIRECTLY into a
// trusted render(), then the framework DOM query observes the render effect. This is the
// common RTL idiom and must CONFIRM (the bare-element N41 case differs: it never renders).
// Expected: CONFIRMED.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginForm } from "./LoginForm.js";

describe("const ui idiom", () => {
  it("renders ui then asserts its output", () => {
    const ui = <LoginForm />;
    render(ui);
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});
