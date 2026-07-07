// P20 render inside an act() callback (Codex review guard): act() SYNCHRONOUSLY invokes its
// callback, so render(<LoginForm/>) genuinely mounts the component before the framework-effect
// assertion observes it. The liveness filter must treat known test-runtime invokers (act/
// waitFor) as live boundaries so this real RTL idiom still confirms. Expected: CONFIRMED.
import { describe, it, expect } from "vitest";
import { render, screen, act } from "@testing-library/react";
import { LoginForm } from "./LoginForm.js";

describe("act renders", () => {
  it("mounts inside act then asserts output", () => {
    act(() => {
      render(<LoginForm />);
    });
    expect(screen.getByRole("button", { name: "Sign in" })).toBeVisible();
  });
});
