import { describe, expect, it } from "vitest";
import { mode } from "./svc";

describe("svc", () => {
  // A: mutation-INDEPENDENT, always passes. Seeds identity "svc handles mode" into baseline-passed.
  it("handles mode", () => {
    expect(1 + 1).toBe(2);
  });

  // B: SAME identity "svc handles mode". Skipped at baseline (mode().kind === "real"),
  // so it never passes baseline. Under the mutant (kind => "mutant") skipIf is false,
  // B runs and fails at a real assertion line. If #191 credits this as proven, the
  // flat-Set identity binding is defeated by the collision.
  it.skipIf(mode().kind === "real")("handles mode", () => {
    expect(mode().kind).toBe("real");
  });
});
