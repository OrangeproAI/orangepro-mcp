// N41 stored JSX element (Codex review): `const el = <LoginForm/>` constructs an element
// OBJECT — it only uses LoginForm as a JSX tag identity; the component is never invoked
// and nothing is rendered to the DOM. Asserting the element object (toBeDefined) does not
// exercise the component — a garbage LoginForm still passes. A JSX tag counts as a render
// use ONLY when passed to a framework render()/mount(). Fails conjunct 3. Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { LoginForm } from "./LoginForm.js";

describe("stored jsx element", () => {
  it("asserts the element object, not rendered output", () => {
    const unused = <LoginForm />;
    expect(unused).toBeDefined();
  });
});
