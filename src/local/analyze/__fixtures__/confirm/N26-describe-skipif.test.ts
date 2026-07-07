// N26 conditional-skip suite (adversarial review): `describe.skipIf(true)(...)`
// skips the whole suite at runtime, so the inner it() never runs and the matcher
// never executes. The suite call's callee is itself a CallExpression, so the
// exact-string SKIP_CALLEES set misses it; the inner it() looked live. A
// conditional skip/run we cannot evaluate must be treated as not-live (conjunct 4).
// Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe.skipIf(true)("conditionally skipped suite", () => {
  it("has a genuine use+matcher but the suite is skipped at runtime", () => {
    expect(saveUser({ id: "u1" })).toBe("saved:u1");
  });
});
