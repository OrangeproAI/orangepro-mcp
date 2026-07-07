// Pick the reportable line from a baseline/mutant failure blob (a runner suite message,
// an assertion failure message, or captured stderr).
//
// Why: build tools (esbuild / Vite / Rollup) print NON-FATAL warnings — e.g.
// `[MIXED_EXPORTS]`, esbuild's `▲ [WARNING]`, Rollup's `(!) ...` prefix — to stderr
// BEFORE the fatal error that actually failed the baseline. Grabbing the first line then
// surfaced the warning (Medplum reported `[MIXED_EXPORTS]` instead of its real blocker),
// which also starved the R-1 classifier of the true error. This skips known build-tool
// warning lines and surfaces the first line that reads like the real failure.
//
// DIAGNOSTIC ONLY: the returned line feeds the report + classifier reason. It NEVER
// affects the proof judgment (baseline_green / mutant_failed_assertion / target_not_mocked
// are computed from exit codes + assertion results, not this string). Fail-safe: if every
// line looks like a warning (or there is nothing better), it returns the first line — the
// prior behaviour — so it can never hide a failure, only sharpen the label.
const BUILD_WARNING_LINE =
  /^(?:\(!\)|▲\s*\[WARNING\]|\[(?:MIXED_EXPORTS|CIRCULAR_DEPENDENCY|UNUSED_EXTERNAL_IMPORT|PLUGIN_WARNING|THIS_IS_UNDEFINED|EVAL|SOURCEMAP_ERROR|INVALID_ANNOTATION|EMPTY_BUNDLE)\]|\(node:\d+\)\s+ExperimentalWarning:|--import 'data:text\/javascript,import \{ register \} from "node:module"|\(Use `node --trace-warnings)/;

export function pickReportableFailureLine(text) {
  const lines = String(text ?? "")
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean);
  if (lines.length === 0) {
    return "";
  }
  const fatal = lines.find(line => !BUILD_WARNING_LINE.test(line));
  return fatal ?? lines[0];
}
