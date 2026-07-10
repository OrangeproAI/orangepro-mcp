import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { hashBuffer } from "./hash.js";

/** One scanned source file with content hash for provenance + freshness. */
export interface FileRecord {
  /** POSIX-style path relative to the workspace root. */
  relPath: string;
  absPath: string;
  size: number;
  hash: string;
}

export interface IgnoreRules {
  /** Directory/file base names that are skipped entirely. */
  names: Set<string>;
  /** Anchored-substring matchers derived from ignore files. */
  matchers: RegExp[];
}

export interface WalkOptions {
  maxFiles?: number;
  /** Skip individual files larger than this (binary/asset guard). */
  maxFileBytes?: number;
}

const DEFAULT_IGNORE_NAMES = [
  "node_modules",
  ".git",
  ".hg",
  ".svn",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".turbo",
  "coverage",
  ".orangepro",
  ".venv",
  "venv",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  "vendor",
  "target",
  ".gradle",
  ".idea",
  ".vscode",
  ".DS_Store",
  // Agent/tooling scaffolding and nested worktrees — noise, not the project under test.
  ".agent-worktrees",
  ".worktrees",
  ".claude",
  ".cursor",
  ".agent",
  ".paul",
  ".omc",
  ".repowise",
  ".agent-handoff",
  // The kit's own exported artifacts must not be re-ingested as source.
  "orangepro-evidence-pack.json",
  "orangepro-evidence-pack.md"
];

const DEFAULT_IGNORE_MATCHERS: RegExp[] = [/(^|\/)[^/]*evidence-pack\.(json|md)$/];

/**
 * High file-count ceiling: a pathological-run guard, NOT a tuning knob. The
 * default is high enough to scan large monorepos (Mattermost-scale) end to end;
 * lower it via ORANGEPRO_MAX_FILES only to bound an accidental huge directory.
 */
export const DEFAULT_MAX_FILES = 100_000;
const DEFAULT_MAX_FILE_BYTES = 1_000_000;

/** Load ignore rules from defaults plus `.gitignore` and `.orangeproignore`. */
export function loadIgnore(root: string): IgnoreRules {
  const names = new Set(DEFAULT_IGNORE_NAMES);
  const matchers: RegExp[] = [...DEFAULT_IGNORE_MATCHERS];

  for (const file of [".gitignore", ".orangeproignore"]) {
    const abs = join(root, file);
    if (!existsSync(abs)) continue;
    let lines: string[];
    try {
      lines = readFileSync(abs, "utf8").split(/\r?\n/);
    } catch {
      continue;
    }
    for (const raw of lines) {
      const line = raw.trim();
      if (!line || line.startsWith("#") || line.startsWith("!")) continue;
      const rootAnchored = line.startsWith("/");
      const cleaned = line.replace(/^\/+/, "").replace(/\/+$/, "");
      if (!cleaned) continue;
      if (!rootAnchored && !cleaned.includes("/") && !cleaned.includes("*")) {
        names.add(cleaned);
      } else {
        matchers.push(globToRegExp(cleaned, rootAnchored));
      }
    }
  }

  return { names, matchers };
}

function globToRegExp(glob: string, rootAnchored = false): RegExp {
  // Use a plain-ASCII sentinel for `**` so the file stays text (no NUL bytes)
  // and `*` substitution does not re-match the globstar.
  const GLOBSTAR = "__ORANGEPRO_GLOBSTAR__";
  const escaped = glob
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, GLOBSTAR)
    .replace(/\*/g, "[^/]*")
    .split(GLOBSTAR)
    .join(".*")
    .replace(/\?/g, "[^/]");
  return new RegExp(`${rootAnchored ? "^" : "(^|/)"}${escaped}(/|$)`);
}

function isIgnored(relPath: string, baseName: string, rules: IgnoreRules): boolean {
  if (rules.names.has(baseName)) return true;
  return rules.matchers.some((m) => m.test(relPath));
}

/** Whether a workspace-relative path is ignored (any segment in names, or a matcher hit). */
export function isPathIgnored(relPath: string, rules: IgnoreRules): boolean {
  if (relPath.split("/").some((segment) => rules.names.has(segment))) return true;
  return rules.matchers.some((m) => m.test(relPath));
}

/**
 * Recursively walk the workspace, returning content-hashed file records.
 * Honors ignore rules, size caps, and a global file cap so large or noisy
 * checkouts stay bounded. Symlinks are not followed.
 */
export function walkFiles(root: string, rules: IgnoreRules, opts: WalkOptions = {}): FileRecord[] {
  const maxFiles = opts.maxFiles ?? DEFAULT_MAX_FILES;
  const maxFileBytes = opts.maxFileBytes ?? DEFAULT_MAX_FILE_BYTES;
  const records: FileRecord[] = [];

  const visit = (dir: string, rel: string): void => {
    if (records.length >= maxFiles) return;
    let entries: import("node:fs").Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (records.length >= maxFiles) return;
      const childRel = rel ? `${rel}/${entry.name}` : entry.name;
      if (isIgnored(childRel, entry.name, rules)) continue;
      const childAbs = join(dir, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        visit(childAbs, childRel);
      } else if (entry.isFile()) {
        let size: number;
        try {
          size = statSync(childAbs).size;
        } catch {
          continue;
        }
        if (size > maxFileBytes) continue;
        let hash: string;
        try {
          hash = hashBuffer(readFileSync(childAbs));
        } catch {
          continue;
        }
        records.push({ relPath: childRel, absPath: childAbs, size, hash });
      }
    }
  };

  visit(root, "");
  return records;
}

export interface WalkResult {
  files: FileRecord[];
  /** True when the file-count cap was reached — some files were NOT scanned. */
  truncated: boolean;
  /** The file-count cap that applied to this walk. */
  max_files: number;
}

/**
 * Like {@link walkFiles}, but also reports whether the file-count cap was hit so
 * the analyzer can surface scanned-vs-skipped counts instead of silently dropping
 * files. (walkFiles stops at exactly maxFiles, so reaching it means more remained.)
 */
export function walkFilesWithMeta(root: string, rules: IgnoreRules, opts: WalkOptions = {}): WalkResult {
  const max_files = opts.maxFiles ?? DEFAULT_MAX_FILES;
  // Probe one past the cap so "exactly max_files files" is not misreported as
  // truncated (only > max_files means files were actually skipped).
  const probed = walkFiles(root, rules, { ...opts, maxFiles: max_files + 1 });
  const truncated = probed.length > max_files;
  return { files: truncated ? probed.slice(0, max_files) : probed, truncated, max_files };
}
