import { AnalysisMeta } from "../graph/ontology.js";
import { EvidencePack } from "./schema.js";

/**
 * Render an evidence pack as a human-readable Markdown summary.
 *
 * This is a trust artifact: it explains *what* evidence backs the pack and the
 * generated tests WITHOUT exposing how anything was scored or prompted. It
 * deliberately omits scoring weights, prompt text, and traversal traces — only
 * the metadata already present in the pack is rendered.
 */
export function packToMarkdown(pack: EvidencePack, analysis?: AnalysisMeta | null): string {
  const lines: string[] = [];

  lines.push("# OrangePro Local Evidence Pack");
  lines.push("");
  lines.push(`- Created at: ${pack.created_at}`);
  lines.push(`- Workspace: ${pack.workspace.name}`);
  lines.push(`- Source upload policy: ${pack.workspace.source_upload_policy}`);
  lines.push("");

  if (analysis) {
    // Phase 5.3: COVERAGE_REPORT.md is the SINGLE source of coverage truth
    // (dynamic Proven %, denominator composition, resolver metrics). The pack defers
    // to it and only surfaces completeness caveats that affect THIS pack — no
    // competing coverage numbers live here.
    lines.push("## Coverage");
    lines.push("");
    lines.push(
      "Dynamic Proven, static association diagnostics, the denominator composition, and import-resolution metrics live in `COVERAGE_REPORT.md` (the 3-file contract: graph.html / COVERAGE_REPORT.md / graph.json). This pack does not restate them."
    );
    if (analysis.flows_truncated > 0) {
      lines.push(
        `- ⚠ Truncated: ${analysis.flows_truncated} test file(s) exceeded the inferred-behavior cap and are not represented. Raise ORANGEPRO_MAX_FLOWS to include them.`
      );
    }
    if (analysis.symbol_cap_hit) {
      lines.push("- ⚠ Code-symbol extraction cap was reached; some symbols are omitted (the denominator understates the repo). Raise ORANGEPRO_MAX_SYMBOLS.");
    }
    if (analysis.not_analyzed_due_to_budget) {
      const b = analysis.not_analyzed_due_to_budget;
      lines.push(
        `- ⚠ PARTIAL SCAN: the analyze budget (${b.budget_ms}ms) stopped with ${b.files_not_analyzed} file(s) NOT analyzed — this pack came from a partial graph; coverage is a floor, not complete. Raise ORANGEPRO_MAX_ANALYZE_MS or scope with --base.`
      );
    }
    lines.push("");
  }

  lines.push("## Quality score");
  lines.push("");
  lines.push(`Overall: ${pack.quality_score.overall}/100 (band: ${pack.quality_score.band})`);
  lines.push("");
  for (const [dimension, value] of Object.entries(pack.quality_score.breakdown)) {
    lines.push(`- ${labelDimension(dimension)}: ${formatFraction(value)}`);
  }
  lines.push("");

  lines.push("## Why the score is not higher");
  lines.push("");
  if (pack.quality_score.missing_evidence.length === 0) {
    lines.push("- No outstanding evidence gaps reported.");
  } else {
    for (const item of pack.quality_score.missing_evidence) {
      lines.push(`- ${item}`);
    }
  }
  lines.push("");

  lines.push("## Sources");
  lines.push("");
  if (pack.sources.length === 0) {
    lines.push("- No sources recorded.");
  } else {
    for (const source of pack.sources) {
      lines.push(`- ${source.display_name} (${source.source_system} / ${source.source_type})`);
    }
  }
  lines.push("");

  lines.push("## Entities");
  lines.push("");
  lines.push(`Total entities: ${pack.entities.length}`);
  lines.push("");
  const counts = countByEntityType(pack.entities);
  if (counts.length === 0) {
    lines.push("- No entities recorded.");
  } else {
    for (const { entity_type, count } of counts) {
      lines.push(`- ${entity_type}: ${count}`);
    }
  }
  lines.push("");

  lines.push("## Generated tests");
  lines.push("");
  const tests = pack.generation_runs.flatMap((run) => run.generated_tests);
  if (tests.length === 0) {
    lines.push("- No generated tests in this pack.");
  } else {
    for (const test of tests) {
      lines.push(`### ${test.title}`);
      lines.push("");
      if (test.bucket) lines.push(`- Local bucket: ${test.bucket}`);
      lines.push(`- Test type: ${test.test_type}`);
      lines.push(`- Framework hint: ${test.framework_hint || "(none)"}`);
      lines.push(`- Grounded by entities: ${formatList(test.grounding.entity_ids)}`);
      lines.push(`- Source refs: ${formatList(test.grounding.source_refs)}`);
      lines.push(`- Weak/candidate evidence used: ${test.weak_evidence_used ? "yes" : "no"}`);
      lines.push("");
    }
  }

  lines.push("## Provenance");
  lines.push("");
  lines.push(
    "Every entity and relationship in this pack carries provenance (source scope, optional source reference and quote hash). The pack contains metadata, provenance, and grounding only — no raw source code, prompts, or scoring internals."
  );
  lines.push("");

  return lines.join("\n");
}

function labelDimension(dimension: string): string {
  return dimension
    .split("_")
    .map((part) => (part.length > 0 ? part[0].toUpperCase() + part.slice(1) : part))
    .join(" ");
}

function formatFraction(value: number): string {
  return value.toFixed(2);
}

function formatList(values: string[]): string {
  return values.length > 0 ? values.join(", ") : "(none)";
}

function countByEntityType(
  entities: EvidencePack["entities"]
): Array<{ entity_type: string; count: number }> {
  const counts = new Map<string, number>();
  for (const entity of entities) {
    counts.set(entity.entity_type, (counts.get(entity.entity_type) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([entity_type, count]) => ({ entity_type, count }))
    .sort((a, b) => a.entity_type.localeCompare(b.entity_type));
}
