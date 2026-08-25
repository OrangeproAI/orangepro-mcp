export type GeneratedDraftBlocker =
  | "generated_code"
  | "unresolved_import"
  | "toolchain_or_runner"
  | "validation_timeout"
  | "unknown";

/** Classify only high-confidence generator/validator diagnostics. Ambiguous
 * failures stay unknown rather than being mislabeled as a repo setup problem. */
export function classifyGeneratedDraftBlocker(reason: string | undefined): GeneratedDraftBlocker {
  const text = reason ?? "";
  if (/timed?\s*out|timeout|ETIMEDOUT|signal:\s*killed/i.test(text)) return "validation_timeout";
  if (
    /(?:^|\b)(?:go|gofmt|python3|pytest|mvn|gradle|node|npm|vitest|jest|mocha)(?:\b[^.\n]*)?(?:not found|ENOENT|not installed)/i.test(text) ||
    /(?:test runner|toolchain).*(?:missing|not found|not installed)/i.test(text)
  ) return "toolchain_or_runner";
  if (/no required module provides package|cannot find module|module not found|unresolved import|imports module-path package/i.test(text)) {
    return "unresolved_import";
  }
  if (
    /syntax check failed|undefined:|unknown field|expected (?:declaration|operand|'[^']+'|"[^"]+"|[^ ]+),? found|literal not terminated|cannot assign/i.test(text)
  ) return "generated_code";
  return "unknown";
}

export function generatedDraftRemediation(reason: string | undefined): string {
  switch (classifyGeneratedDraftBlocker(reason)) {
    case "generated_code":
      return "Regenerate or repair the draft using symbols and APIs that exist in this package; installing dependencies will not fix this compiler error.";
    case "unresolved_import":
      return "Verify that the generated import path exists and is already declared by this repo; install dependencies only when the repo expects that import, then regenerate.";
    case "toolchain_or_runner":
      return "Install or configure the named toolchain/test runner, then re-run `opro start`.";
    case "validation_timeout":
      return "Warm the dependency cache or raise the relevant OrangePro validation timeout, then re-run `opro start`.";
    default:
      return "Review the named blocker, repair or regenerate the draft as needed, then re-run `opro start`; do not assume dependencies are missing.";
  }
}
