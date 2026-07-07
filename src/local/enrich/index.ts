import { GraphFragment } from "../types.js";
import { enrichFromCsv, looksLikeTemplateHeader } from "./csv.js";
import { enrichFromMarkdown } from "./markdown.js";

export { enrichFromCsv } from "./csv.js";
export { enrichFromMarkdown } from "./markdown.js";

/** Lowercased file extension including the leading dot (e.g. ".csv"); "" if none. */
function extensionOf(relPath: string): string {
  const base = relPath.slice(relPath.lastIndexOf("/") + 1);
  const dot = base.lastIndexOf(".");
  return dot <= 0 ? "" : base.slice(dot).toLowerCase();
}

/** First non-empty line of the content, used for .txt header sniffing. */
function firstLine(content: string): string {
  for (const line of content.split(/\r\n|\r|\n/)) {
    if (line.trim() !== "") return line;
  }
  return "";
}

/**
 * Dispatch enrichment by file type.
 *
 * `.csv` → CSV template; `.md`/`.mdx`/`.markdown` → Markdown docs. A `.txt`
 * file whose first line looks like the template header is routed to CSV.
 * Returns null for unsupported content.
 */
export function enrichFromContent(relPath: string, content: string): GraphFragment | null {
  const ext = extensionOf(relPath);

  let fragment: GraphFragment | null = null;
  if (ext === ".csv") fragment = enrichFromCsv(relPath, content);
  else if (ext === ".md" || ext === ".mdx" || ext === ".markdown") fragment = enrichFromMarkdown(relPath, content);
  else if (ext === ".txt" && looksLikeTemplateHeader(firstLine(content))) fragment = enrichFromCsv(relPath, content);

  if (!fragment) return null;
  // A source that yields zero anchors/evidence is noise — keep the diagnostic
  // warning but do not register the SourceScope (e.g. a non-template data CSV).
  if (fragment.nodes.length === 0) {
    return { nodes: [], edges: [], candidate_edges: [], sources: [], warnings: fragment.warnings };
  }
  return fragment;
}
