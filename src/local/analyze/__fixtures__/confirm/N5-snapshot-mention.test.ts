// N5 snapshot-mention: the behavior name appears only inside an inline-snapshot
// body (a template string). Fails conjunct 3 (no runtime reference).
// Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("snapshot mention", () => {
  it("only names the behavior inside a snapshot body", () => {
    const rendered = "ok";
    expect(rendered).toMatchInlineSnapshot(`"calls saveUser then returns ok"`);
  });
});
