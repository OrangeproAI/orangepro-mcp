import { describe, expect, it } from "vitest";
import { classifyGeneratedDraftBlocker, generatedDraftRemediation } from "../../src/local/generate/draftGuidance.js";

describe("generated draft guidance", () => {
  it.each([
    ["Go compile check failed: undefined: testLogger", "generated_code"],
    ["Go syntax check failed: expected '}', found EOF", "generated_code"],
    ["no required module provides package go.temporal.io/api/matchingservice/v1", "unresolved_import"],
    ["gofmt not found; cannot verify Go syntax", "toolchain_or_runner"],
    ["spawnSync go ETIMEDOUT", "validation_timeout"],
    ["Go compile check failed: package baseline failed", "unknown"]
  ] as const)("classifies %s as %s", (reason, expected) => {
    expect(classifyGeneratedDraftBlocker(reason)).toBe(expected);
  });

  it("does not prescribe dependency installation for invented generated code", () => {
    expect(generatedDraftRemediation("Go compile check failed: undefined: testLogger"))
      .toContain("installing dependencies will not fix");
  });
});
