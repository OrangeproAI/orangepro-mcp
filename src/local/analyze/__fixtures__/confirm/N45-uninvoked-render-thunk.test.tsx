// N45 render inside an uninvoked thunk (Codex review): `const doRender = () => render(<X/>)`
// stores a function that is NEVER called, so LoginForm is never mounted — the assertion
// observes only the pre-seeded DOM. A render() call confirms ONLY when it executes in a
// LIVE position (the path to the test block crosses no uninvoked function boundary), and
// the "exactly one render" count likewise ignores dead renders. Fails conjunct 3.
// Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginForm } from "./LoginForm.js";

describe("uninvoked render thunk", () => {
  it("asserts seeded DOM without rendering LoginForm", () => {
    const doRender = () => render(<LoginForm />);
    document.body.innerHTML = "<button>Sign in</button>";
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
    expect(doRender).toBeDefined();
  });
});
