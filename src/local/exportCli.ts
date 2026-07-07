import { opExport, opGraphHtml } from "./operations.js";

/** Parsed flags relevant to the `export` command. */
export interface ExportCliFlags {
  /** `graph-html` selects the explorer-only output; anything else exports the pack. */
  format?: string;
  out?: string;
  /** Embed generated test bodies in the pack (default false → bodies stay local). */
  include_generated_bodies?: boolean;
  /** Also write the offline explorer alongside the pack. */
  graph_html?: boolean;
}

export interface ExportCliResult {
  mode: "graph_html" | "pack";
  graph_html_path?: string;
  pack_path?: string;
  summary_path?: string;
  valid?: boolean;
  errors?: string[];
}

/**
 * Dispatch the `export` command.
 *
 * Only `--format graph-html` takes the explorer-only path; the boolean
 * `--graph-html` flag falls through to a full pack export (JSON + Markdown, and
 * the explorer too). Keeping this pure makes both modes unit-testable.
 */
export function runExportCli(cwd: string, flags: ExportCliFlags): ExportCliResult {
  if (flags.format === "graph-html") {
    const g = opGraphHtml(cwd, flags.out ?? "orangepro-graph.html");
    return { mode: "graph_html", graph_html_path: g.graph_html_path };
  }
  const res = opExport(cwd, flags.out ?? "orangepro-evidence-pack.json", {
    include_generated_bodies: flags.include_generated_bodies ?? false,
    graph_html: flags.graph_html ?? false
  });
  return {
    mode: "pack",
    pack_path: res.pack_path,
    summary_path: res.summary_path,
    valid: res.validation.valid,
    errors: res.validation.errors,
    graph_html_path: res.graph_html_path
  };
}
