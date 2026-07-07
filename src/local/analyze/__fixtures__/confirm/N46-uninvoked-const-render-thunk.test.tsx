// N46 const element rendered only inside an uninvoked thunk (Codex review): the element is
// bound to a const, but the sole render(ui) lives in `doRender`, which is never invoked, so
// LoginForm never mounts. The const-binding render path must require the render() call to be
// in a LIVE position. Fails conjunct 3. Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginForm } from "./LoginForm.js";

describe("uninvoked const render thunk", () => {
  it("asserts seeded DOM", () => {
    const ui = <LoginForm />;
    const doRender = () => render(ui);
    document.body.innerHTML = "<button>Sign in</button>";
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(doRender).toBeDefined();
  });
});
