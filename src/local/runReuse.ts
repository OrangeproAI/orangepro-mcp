import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { coverageArtifactPathsForReuse } from "./analyze/coverage.js";

/**
 * Reuse a run when nothing changed (R14 §5). Before any analysis, `opro start`
 * computes a key from everything that decides the result. When the key matches the
 * last full run, the reports are reused: no analysis, no proof, no model call.
 *
 * The key has four parts so the report can say WHY it reran:
 *  - code: HEAD plus the bytes of every changed or untracked file (OrangePro's own
 *    `.orangepro/` outputs excluded);
 *  - inputs: config, ignore files, coverage files, the proof ledger, the start
 *    options that change output, and whether a model key is configured (never the key);
 *  - analysis: the analyzer, ranking, proof-oracle and graph-schema versions;
 *  - renderer: the report renderer version (a mismatch re-renders saved data, no analysis).
 */
export const RUN_KEY_FILE = "run-key.json";
const RUN_KEY_SCHEMA = 1;
/** Files above this size are keyed by size and modification time instead of content. */
const HASH_BYTES_LIMIT = 64 * 1024 * 1024;

export interface RunKeyParts {
  code: string;
  inputs: string;
  analysis: string;
  renderer: string;
  tool: string;
  commit: string | null;
}

export interface RunKey extends RunKeyParts {
  schema: typeof RUN_KEY_SCHEMA;
  /** When the reports were produced by a full run. */
  generated_at: string;
  /** When a run last checked this key (equal to generated_at after a full run). */
  checked_at: string;
}

export type ReuseDecision =
  | { kind: "full"; reason: "fresh" | "not_git" | "first_run" | "missing_outputs" | "code_changed" | "inputs_changed" | "analysis_changed" | "generation_pending"; previous?: RunKey }
  | { kind: "reuse"; rerender: boolean; previous: RunKey };

function sha(data: string | Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function fileDigest(abs: string): string {
  try {
    const st = statSync(abs);
    if (!st.isFile()) return st.isDirectory() ? "dir" : "other";
    if (st.size > HASH_BYTES_LIMIT) return `size:${st.size}:mtime:${Math.floor(st.mtimeMs)}`;
    return sha(readFileSync(abs));
  } catch {
    return "missing";
  }
}

function git(cwd: string, args: string[]): string | null {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 15_000, maxBuffer: 256 * 1024 * 1024 });
  } catch {
    return null;
  }
}

/**
 * HEAD plus every changed or untracked file under `scanRoot`, by content. Null outside git.
 * Paths are matched in git's own terms (the scan root's prefix inside the repository),
 * never by comparing absolute paths: git reports the real path, and a scan root reached
 * through a symlink (macOS /var → /private/var, a linked home folder) would otherwise hide
 * every edit.
 */
export function codeKey(scanRoot: string): { key: string; commit: string } | null {
  const top = git(scanRoot, ["rev-parse", "--show-toplevel"])?.trim();
  const head = git(scanRoot, ["rev-parse", "HEAD"])?.trim();
  const prefix = git(scanRoot, ["rev-parse", "--show-prefix"])?.trim();
  if (!top || !head || prefix === undefined) return null;
  const status = git(scanRoot, ["status", "--porcelain=v1", "-z", "--untracked-files=all", "--", "."]);
  if (status === null) return null;
  const ownOutputs = `${prefix}.orangepro/`;
  const entries: string[] = [];
  const parts = status.split("\0").filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    const code = entry.slice(0, 2);
    const rel = entry.slice(3);
    // A rename lists its source as the next NUL-separated field.
    if (code[0] === "R" || code[0] === "C") i += 1;
    if (!rel.startsWith(prefix) || rel.startsWith(ownOutputs)) continue;
    entries.push(`${code} ${rel} ${fileDigest(join(top, rel))}`);
  }
  entries.sort();
  return { key: sha(`${head}\n${entries.join("\n")}`), commit: head };
}

export interface InputKeyOptions {
  root: string;
  scanRoot: string;
  /** Start options that change the output, as plain values. */
  flags: Record<string, unknown>;
  /** Whether a model provider is configured (presence only, never the key). */
  providerConfigured: boolean;
  env?: NodeJS.ProcessEnv;
}

export function inputsKey(opts: InputKeyOptions): string {
  const env = opts.env ?? process.env;
  const files = new Map<string, string>();
  const add = (label: string, abs: string): void => {
    if (existsSync(abs)) files.set(label, fileDigest(abs));
  };
  add("user-config", env.ORANGEPRO_USER_CONFIG ?? join(homedir(), ".orangepro", "config.json"));
  for (const base of new Set([resolve(opts.root), resolve(opts.scanRoot)])) {
    add(`${base}:config`, join(base, ".orangepro", "config.json"));
    add(`${base}:coverage-suites`, join(base, ".orangepro", "coverage-suites.json"));
    add(`${base}:ledger`, join(base, ".orangepro", "ledger.json"));
    add(`${base}:ignore`, join(base, ".orangeproignore"));
  }
  for (const rel of coverageArtifactPathsForReuse(opts.scanRoot)) add(`coverage:${rel}`, join(opts.scanRoot, rel));
  const sortedFlags = Object.fromEntries(Object.entries(opts.flags).filter(([, v]) => v !== undefined).sort(([a], [b]) => a.localeCompare(b)));
  return sha(JSON.stringify({ files: [...files.entries()].sort(([a], [b]) => a.localeCompare(b)), flags: sortedFlags, provider: opts.providerConfigured }));
}

export function computeRunKey(
  opts: InputKeyOptions & { analysisVersions: readonly string[]; renderer: string; tool: string }
): RunKeyParts | null {
  const code = codeKey(opts.scanRoot);
  if (!code) return null;
  return {
    code: code.key,
    inputs: inputsKey(opts),
    analysis: sha(opts.analysisVersions.join("\n")),
    renderer: opts.renderer,
    tool: opts.tool,
    commit: code.commit
  };
}

export function readRunKey(workspaceDir: string): RunKey | null {
  try {
    const parsed = JSON.parse(readFileSync(join(workspaceDir, RUN_KEY_FILE), "utf8")) as Partial<RunKey>;
    if (parsed.schema !== RUN_KEY_SCHEMA || typeof parsed.code !== "string" || typeof parsed.inputs !== "string" || typeof parsed.analysis !== "string") return null;
    return parsed as RunKey;
  } catch {
    return null;
  }
}

export function writeRunKey(workspaceDir: string, key: RunKey): void {
  const file = join(workspaceDir, RUN_KEY_FILE);
  writeFileSync(`${file}.tmp`, `${JSON.stringify(key, null, 2)}\n`, "utf8");
  renameSync(`${file}.tmp`, file);
}

export function decideReuse(input: {
  previous: RunKey | null;
  current: RunKeyParts | null;
  fresh?: boolean;
  outputsPresent: boolean;
  generationPending: boolean;
}): ReuseDecision {
  const { previous, current } = input;
  const prev = previous ?? undefined;
  if (input.fresh) return { kind: "full", reason: "fresh", ...(prev ? { previous: prev } : {}) };
  if (!current) return { kind: "full", reason: "not_git", ...(prev ? { previous: prev } : {}) };
  if (!previous) return { kind: "full", reason: "first_run" };
  if (!input.outputsPresent) return { kind: "full", reason: "missing_outputs", previous };
  if (previous.code !== current.code) return { kind: "full", reason: "code_changed", previous };
  if (previous.inputs !== current.inputs) return { kind: "full", reason: "inputs_changed", previous };
  if (previous.analysis !== current.analysis) return { kind: "full", reason: "analysis_changed", previous };
  if (input.generationPending) return { kind: "full", reason: "generation_pending", previous };
  return { kind: "reuse", rerender: previous.renderer !== current.renderer || previous.tool !== current.tool, previous };
}
