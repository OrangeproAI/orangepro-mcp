/**
 * Static-only mode (context §13.2 item 34): read the repository and draft tests, but never
 * run any of its code. Meant for runs on code we do not trust, such as a free report on a
 * stranger's public repository.
 *
 * Turned on by `--static-only` or `ORANGEPRO_STATIC_ONLY=1`. The flag sets the variable for
 * the whole run, so every command and every child process sees the same answer.
 *
 * `start` checks it to skip proof, runtime coverage and the Go compile check. The places that
 * start repository code (the proof runner, prove-loop setup commands, coverage runs and
 * containers) also check it, as a backstop, and refuse.
 */
export const STATIC_ONLY_ENV = "ORANGEPRO_STATIC_ONLY";

export const STATIC_ONLY_REFUSAL =
  "Static-only mode (--static-only or ORANGEPRO_STATIC_ONLY=1): OrangePro does not run the repository's code, tests or setup commands.";

/** The reason a Go draft carries when static-only mode skipped its compile check. */
export const NOT_COMPILE_CHECKED =
  "Not compile-checked: static-only mode does not build the package, because the Go check starts its test program.";

export function isStaticOnly(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes)$/i.test(String(env[STATIC_ONLY_ENV] ?? "").trim());
}

/** Throws in static-only mode. `what` names what was about to run. */
export function assertMayRunRepositoryCode(what: string, env: NodeJS.ProcessEnv = process.env): void {
  if (isStaticOnly(env)) throw new Error(`${STATIC_ONLY_REFUSAL} Refused: ${what}.`);
}
