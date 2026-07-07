import { describe, expect, it } from "vitest";
// @ts-expect-error - .mjs sibling of the oracle spike, no types
import { pickReportableFailureLine } from "../../scripts/spikes/failure-summary.mjs";

describe("pickReportableFailureLine — surface the fatal baseline error, not a build warning", () => {
  it("skips a leading [MIXED_EXPORTS] warning and returns the fatal error (the Medplum shape)", () => {
    const stderr = [
      "(!) /packages/core/src/index.ts is using named and default exports together [MIXED_EXPORTS]",
      "Error: Failed to resolve entry for package \"@medplum/core\"",
    ].join("\n");
    expect(pickReportableFailureLine(stderr)).toBe(
      'Error: Failed to resolve entry for package "@medplum/core"'
    );
  });

  it("skips an esbuild ▲ [WARNING] banner before the real error", () => {
    const stderr = [
      "▲ [WARNING] Duplicate key \"x\" in object literal [duplicate-object-key]",
      "✘ [ERROR] Could not resolve \"./missing\"",
    ].join("\n");
    expect(pickReportableFailureLine(stderr)).toBe('✘ [ERROR] Could not resolve "./missing"');
  });

  it("skips Node experimental-loader warning blocks before the real error", () => {
    const stderr = [
      "(node:12345) ExperimentalWarning: `--experimental-loader` may be removed in the future; instead use `register()`:",
      "--import 'data:text/javascript,import { register } from \"node:module\"; register(\"ts-node/esm\");'",
      "(Use `node --trace-warnings ...` to show where the warning was created)",
      "Exception during run: Error: Cannot find module './decorators'",
    ].join("\n");
    expect(pickReportableFailureLine(stderr)).toBe(
      "Exception during run: Error: Cannot find module './decorators'"
    );
  });

  it("returns the error line unchanged when there is no preceding warning", () => {
    expect(pickReportableFailureLine("Error: connection refused\n    at foo (x.ts:1)")).toBe(
      "Error: connection refused"
    );
  });

  it("falls back to the first line when every line is a build warning (never hides a failure)", () => {
    const allWarnings = [
      "(!) circular dependency [CIRCULAR_DEPENDENCY]",
      "▲ [WARNING] something [MIXED_EXPORTS]",
    ].join("\n");
    expect(pickReportableFailureLine(allWarnings)).toBe("(!) circular dependency [CIRCULAR_DEPENDENCY]");
  });

  it("returns an empty string for empty/whitespace input", () => {
    expect(pickReportableFailureLine("")).toBe("");
    expect(pickReportableFailureLine("   \n  \n")).toBe("");
    expect(pickReportableFailureLine(null)).toBe("");
  });
});
