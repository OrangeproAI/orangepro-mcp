import { readdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_LARGE_FILE_THRESHOLD = 2_000;
const DEFAULT_LARGE_SCOPE_THRESHOLD = 1_000;
const MAX_VISITED_FILES = 100_000;

const SKIP_DIRS = new Set([
  ".cache",
  ".git",
  ".next",
  ".orangepro",
  ".serena",
  ".turbo",
  ".venv",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "target",
  "vendor",
  "venv"
]);

const INCLUDED_EXTENSIONS = new Set([
  ".c",
  ".cc",
  ".cpp",
  ".cs",
  ".css",
  ".go",
  ".h",
  ".hpp",
  ".java",
  ".js",
  ".jsx",
  ".kt",
  ".md",
  ".mdx",
  ".php",
  ".py",
  ".rb",
  ".rs",
  ".swift",
  ".ts",
  ".tsx",
  ".txt",
  ".vue"
]);

const INCLUDED_FILENAMES = new Set([
  "dockerfile",
  "gemfile",
  "go.mod",
  "package.json",
  "pom.xml",
  "requirements.txt"
]);

export interface CorpusScopeChild {
  path: string;
  files: number;
}

export interface CorpusScopeEntry {
  path: string;
  files: number;
  share_pct: number;
  note: string;
  children: CorpusScopeChild[];
}

export interface CorpusScopeSummary {
  root: string;
  files: number;
  truncated: boolean;
  is_large: boolean;
  thresholds: {
    large_files: number;
    large_scope_files: number;
  };
  top_level: CorpusScopeEntry[];
  suggested_scopes: CorpusScopeEntry[];
  guidance: string[];
}

interface CorpusScopeOptions {
  largeFileThreshold?: number;
  largeScopeThreshold?: number;
  maxVisitedFiles?: number;
}

function extensionOf(name: string): string {
  const idx = name.lastIndexOf(".");
  return idx >= 0 ? name.slice(idx).toLowerCase() : "";
}

function isIncludedFile(name: string): boolean {
  const lower = name.toLowerCase();
  return INCLUDED_FILENAMES.has(lower) || INCLUDED_EXTENSIONS.has(extensionOf(lower));
}

function increment(map: Map<string, number>, key: string): void {
  map.set(key, (map.get(key) ?? 0) + 1);
}

function noteFor(files: number, largeScopeThreshold: number): string {
  if (files >= largeScopeThreshold) return "still large — consider one level deeper";
  if (files >= Math.ceil(largeScopeThreshold / 2)) return "medium scope — usable, but narrower is cheaper";
  return "small enough to graph directly";
}

function topEntries(topCounts: Map<string, number>, childCounts: Map<string, Map<string, number>>, total: number, largeScopeThreshold: number): CorpusScopeEntry[] {
  return [...topCounts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([path, files]) => ({
      path,
      files,
      share_pct: total > 0 ? Math.round((files / total) * 1000) / 10 : 0,
      note: noteFor(files, largeScopeThreshold),
      children: [...(childCounts.get(path)?.entries() ?? [])]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 4)
        .map(([child, childFiles]) => ({ path: child, files: childFiles }))
    }));
}

export function summarizeCorpusScope(root: string, opts: CorpusScopeOptions = {}): CorpusScopeSummary {
  const largeFileThreshold = opts.largeFileThreshold ?? DEFAULT_LARGE_FILE_THRESHOLD;
  const largeScopeThreshold = opts.largeScopeThreshold ?? DEFAULT_LARGE_SCOPE_THRESHOLD;
  const maxVisitedFiles = opts.maxVisitedFiles ?? MAX_VISITED_FILES;
  const topCounts = new Map<string, number>();
  const childCounts = new Map<string, Map<string, number>>();
  let files = 0;
  let visited = 0;
  let truncated = false;

  const visit = (relDir: string): void => {
    if (truncated) return;
    let entries;
    try {
      entries = readdirSync(join(root, relDir), { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (truncated) return;
      if (entry.name.startsWith(".")) continue;
      const rel = relDir ? `${relDir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        visit(rel);
        continue;
      }
      if (!entry.isFile() || !isIncludedFile(entry.name)) continue;
      visited++;
      if (visited > maxVisitedFiles) {
        truncated = true;
        return;
      }
      files++;
      const parts = rel.split("/");
      if (parts.length === 1) continue;
      const top = parts[0] || ".";
      increment(topCounts, top);
      if (parts.length > 2) {
        const child = `${top}/${parts[1]}`;
        const children = childCounts.get(top) ?? new Map<string, number>();
        increment(children, child);
        childCounts.set(top, children);
      }
    }
  };

  visit("");
  const top = topEntries(topCounts, childCounts, files, largeScopeThreshold);
  const isLarge = files >= largeFileThreshold || top.some((entry) => entry.files >= largeScopeThreshold);
  return {
    root,
    files,
    truncated,
    is_large: isLarge,
    thresholds: {
      large_files: largeFileThreshold,
      large_scope_files: largeScopeThreshold
    },
    top_level: top.slice(0, 8),
    suggested_scopes: top.slice(0, 5),
    guidance: isLarge
      ? [
          "OrangePro can still build the deterministic graph locally.",
          "For faster AI grounding and cleaner agent work, start from a focused subdirectory or PR diff.",
          "If a suggested scope is still large, use one of its child directories."
        ]
      : ["This scope is small enough for a direct OrangePro run."]
  };
}
