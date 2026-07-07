// N43 nested JSX under a wrapper (Codex review): `render(<Shell><LoginForm/></Shell>)`
// does NOT mount LoginForm — a wrapper may IGNORE its children (here Shell renders only
// its own <button>), so the assertion observes Shell's output, not LoginForm's. Changing
// LoginForm to return garbage still passes. A JSX tag render-confirms ONLY when it is the
// DIRECT rendered element (or a const that flows directly into render). Fails conjunct 3.
// Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LoginForm } from "./LoginForm.js";

function Shell(_: { children: unknown }): JSX.Element {
  return <button>Shell</button>;
}

describe("wrapper ignores children", () => {
  it("asserts Shell output, not LoginForm", () => {
    render(
      <Shell>
        <LoginForm />
      </Shell>
    );
    expect(screen.getByRole("button", { name: "Shell" })).toBeVisible();
  });
});
