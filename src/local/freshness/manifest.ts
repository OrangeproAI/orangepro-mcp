import { GitInfo, Manifest, ManifestFileEntry } from "../graph/ontology.js";
import { GitRunner } from "../types.js";

/**
 * Read coarse git provenance for the freshness manifest.
 *
 * Metadata only — commit/branch/dirty flag. Returns null when the workspace is
 * not a git checkout (HEAD cannot be resolved), so freshness still works on
 * plain directories.
 */
export function readGitInfo(git: GitRunner): GitInfo | null {
  const head = git(["rev-parse", "HEAD"]);
  if (head === null) return null;

  const commit = head.trim().slice(0, 40);
  const branchRaw = git(["rev-parse", "--abbrev-ref", "HEAD"]);
  const branch = branchRaw === null ? undefined : branchRaw.trim();
  const statusRaw = git(["status", "--porcelain"]);
  const dirty = statusRaw === null ? undefined : statusRaw.trim().length > 0;

  return {
    commit,
    ...(branch !== undefined ? { branch } : {}),
    ...(dirty !== undefined ? { dirty } : {})
  };
}

/**
 * Assemble a freshness manifest from per-file entries and git provenance.
 *
 * Copies the file_entries map so the returned manifest never aliases the
 * caller's input.
 */
export function buildManifest(
  file_entries: Record<string, ManifestFileEntry>,
  git: GitInfo | null,
  now: string
): Manifest {
  return {
    generated_at: now,
    git,
    files: { ...file_entries }
  };
}
