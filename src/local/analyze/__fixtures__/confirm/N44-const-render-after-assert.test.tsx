// N44 const-element rendered AFTER the assertion (Codex review): the element is bound to a
// const early, but render(ui) runs AFTER the framework-effect assertion, which therefore
// observes only the pre-seeded DOM (here document.body.innerHTML). If LoginForm returned
// null the test would still pass — its rendered output is never asserted. The render-effect
// ordering check compares against the actual render() CALL position, not the JSX initializer
// position, so the late render does not confirm. Fails conjunct 5. Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginForm } from "./LoginForm.js";

describe("const ui render order", () => {
  it("asserts seeded DOM before rendering LoginForm", () => {
    const ui = <LoginForm />;
    document.body.innerHTML = "<button>Sign in</button>";
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
    render(ui);
  });
});
