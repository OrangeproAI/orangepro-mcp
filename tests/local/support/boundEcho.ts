/**
 * What the real proof script adds to its JSON when it changes a function at its exact position:
 * the file hash and the body span it was sent. A fake runner that leaves this out is treated as a
 * runner that did not confirm the position, and its answer is not credited. Every JS/TS proof
 * carries a position, so a fake that stands in for the script echoes it with this helper.
 */
export function withBoundEcho(stdout: string, args: readonly string[]): string {
  const valueOf = (flag: string): string | undefined => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
  const fileSha256 = valueOf("--bound-file-sha256");
  if (fileSha256 === undefined) return stdout;
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return stdout;
  }
  if (typeof parsed !== "object" || parsed === null) return stdout;
  const changedBytes = { start: Number(valueOf("--bound-body-start")), end: Number(valueOf("--bound-body-end")) };
  return JSON.stringify({ ...parsed, bound: { fileSha256, changedBytes } });
}
