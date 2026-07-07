import { shortHash } from "./hash.js";

/**
 * Deterministic internal node id. Stable across runs for the same (kind, key)
 * so incremental updates can re-find and refresh existing nodes.
 */
export function stableId(kind: string, key: string): string {
  return `${kind}:${shortHash(`${kind}|${key}`)}`;
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
  return slug || "item";
}
