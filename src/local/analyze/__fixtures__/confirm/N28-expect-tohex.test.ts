// N28 ES/host builtin to* impostor escaping a denylist (round-2 review): `.toHex()`
// is a real Uint8Array method (Node 22+) matching the `to[A-Z]` shape but asserting
// nothing. It proves the matcher gate must be an ALLOW-list of matcher conventions,
// not a denylist of built-ins (which is open-ended: toHex/toBase64/toArray/Temporal
// keep appearing). `toHex` is not a Jest matcher convention. Fails conjunct 5.
// Expected: INFERRED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("toHex builtin impostor", () => {
  it("invokes the Node-22 Uint8Array.toHex, which asserts nothing", () => {
    // @ts-expect-error — toHex is not a Vitest matcher.
    expect(saveUser({ id: "u1" })).toHex();
  });
});
