import { LocalGraph, ManifestFileEntry } from "../graph/ontology.js";
import { FreshnessState } from "../types.js";

/**
 * Compare the graph's stored manifest (previous snapshot) against the current
 * per-file entries and report what changed.
 *
 * changed_files is the union of added (present now, missing before), removed
 * (present before, missing now), and modified (present in both with a differing
 * hash), sorted for stable output.
 *
 * state:
 *  - "missing" when the stored manifest has no files (never analyzed),
 *  - "fresh"   when nothing changed,
 *  - "stale"   otherwise.
 */
export function computeFreshness(
  graph: LocalGraph,
  currentEntries: Record<string, ManifestFileEntry>
): { state: FreshnessState; changed_files: string[] } {
  const previous = graph.manifest.files;
  const previousKeys = Object.keys(previous);

  const changed = new Set<string>();

  for (const [relPath, entry] of Object.entries(currentEntries)) {
    const prior = previous[relPath];
    if (!prior || prior.hash !== entry.hash) changed.add(relPath);
  }

  for (const relPath of previousKeys) {
    if (!(relPath in currentEntries)) changed.add(relPath);
  }

  const changed_files = [...changed].sort();

  const state: FreshnessState =
    previousKeys.length === 0 ? "missing" : changed_files.length === 0 ? "fresh" : "stale";

  return { state, changed_files };
}
