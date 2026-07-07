/**
 * CLI argument parsing for the OrangePro Local Proof Kit.
 *
 * Extracted from cli.ts so it can be unit-tested without importing the CLI
 * entrypoint (cli.ts runs main() at module load).
 */

export interface ParsedArgs {
  positionals: string[];
  flags: Record<string, string | boolean>;
}

/**
 * Flags that consume the FOLLOWING token as their value (e.g. `--limit 10`).
 * Every other `--flag` is treated as a value-less boolean, so a trailing
 * positional after a boolean flag (e.g. `opro start --no-ai server/public`)
 * is preserved as a positional rather than swallowed as the flag's value.
 */
export const VALUE_FLAGS = new Set([
  "agent-pass",
  "auto-limit",
  "base",
  "client",
  "coverage-timeout-ms",
  "entity",
  "evidence-ids",
  "format",
  "framework",
  "include-markdown",
  "job-id",
  "limit",
  "jest-config",
  "max-behaviors",
  "max-prompt-tokens",
  "method",
  "min-priority",
  "model",
  "out",
  "paths",
  "pr",
  "prompt-version",
  "provider",
  "replacement",
  "replacement-mode",
  "runner",
  "run-id",
  "seed-field",
  "setup",
  "setup-timeout-ms",
  "source",
  "status",
  "symbols-per-behavior",
  "target",
  "target-file",
  "target-symbol",
  "test",
  "test-env",
  "test-run",
  "vitest-config",
  "timeout-ms"
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = argv[i + 1];
      if (VALUE_FLAGS.has(key) && next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positionals.push(token);
    }
  }
  return { positionals, flags };
}

/**
 * Split a `--setup "cmd arg arg"` value into an argv, respecting single/double
 * quotes so a space-bearing arg (e.g. `--schema "a b.prisma"` or `--schema="a b"`)
 * stays one token.
 *
 * ponytail: not a full shell parser — no backslash escapes, env expansion, or
 * unbalanced-quote recovery. For exotic args use the MCP structured setup_commands.
 */
export function tokenizeSetup(value: string): string[] {
  const tokens: string[] = [];
  const re = /(?:[^\s"']+|"[^"]*"|'[^']*')+/g;
  for (const raw of value.match(re) ?? []) {
    tokens.push(raw.replace(/"([^"]*)"|'([^']*)'/g, (_, dq, sq) => dq ?? sq));
  }
  return tokens;
}

/**
 * Collect repeatable `--setup "cmd arg arg"` flags into setup commands. Scans the
 * raw arg list (parseArgs collapses repeated flags to the last value), tokenizing
 * each value quote-aware into { command, args }.
 */
export function collectSetupCommands(rest: string[]): Array<{ command: string; args: string[] }> {
  const commands: Array<{ command: string; args: string[] }> = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i] !== "--setup") continue;
    const value = rest[i + 1];
    if (typeof value !== "string" || value.startsWith("--")) continue;
    const [command, ...args] = tokenizeSetup(value);
    if (command) commands.push({ command, args });
    i++;
  }
  return commands;
}
