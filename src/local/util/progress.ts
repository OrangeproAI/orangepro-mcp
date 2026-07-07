/**
 * Optional progress reporter for long local operations. Analysis, coverage
 * generation, AI linking, and model generation can all take long enough to look
 * hung. The CLI wires this to stderr for interactive runs; the default is a
 * no-op, so tests, the MCP server, and `--json` stay silent.
 */
export interface ProgressInfo {
  current: number;
  total: number;
}

export type ProgressReporter = (message: string, progress?: ProgressInfo) => void;

let reporter: ProgressReporter | null = null;

export function setProgressReporter(fn: ProgressReporter | null): void {
  reporter = fn;
}

export function reportProgress(message: string, progress?: ProgressInfo): void {
  if (reporter) reporter(message, progress);
}
