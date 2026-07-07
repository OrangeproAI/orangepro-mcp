import { describe, it, expect } from "vitest";
import { packToMarkdown } from "../../src/local/pack/summary.js";
import { AnalysisMeta } from "../../src/local/graph/ontology.js";
import { EvidencePack } from "../../src/local/pack/schema.js";

const pack: EvidencePack = {
  schema_version: "orangepro.evidence_pack.v1",
  created_at: "2026-06-13T00:00:00Z",
  workspace: { name: "w", root: "/w", root_hash: "h", source_upload_policy: "metadata_only" },
  sources: [],
  entities: [],
  relationships: [],
  generation_runs: [],
  quality_score: { overall: 50, band: "usable", breakdown: {}, missing_evidence: [] }
} as unknown as EvidencePack;

const analysis: AnalysisMeta = {
  test_files: 10,
  inferred_flows: 40,
  flows_truncated: 0,
  max_inferred_flows: 50000,
  symbol_cap_hit: false,
  denominator: {
    total: 198,
    code_export: 192,
    requirement_template: 6,
    markdown_requirement: 0,
    excluded_test_inferred: 122,
    excluded_boilerplate: 0,
    excluded_infra: 0,
    excluded_generated: 0,
    code_symbols_total: 192,
    unattributed: 0
  },
  confirmed_by_layer: {
    total_behaviors: 198,
    confirmed: 102,
    confirmed_pct: 51.5,
    by_layer: { unit: 102, component: 0, integration: 0, api: 0, e2e: 0, manual: 0, unknown: 0 },
    unknown_count: 0,
    unknown_pct: 0
  }
} as unknown as AnalysisMeta;

describe("pack defers coverage to COVERAGE_REPORT.md (Phase 5.3)", () => {
  const md = packToMarkdown(pack, analysis);

  it("points at COVERAGE_REPORT.md as the single coverage doc", () => {
    expect(md).toContain("COVERAGE_REPORT.md");
  });

  it("drops the old '## Coverage notes' section", () => {
    expect(md).not.toContain("## Coverage notes");
    expect(md).not.toContain("Behavior anchors inferred");
  });

  it("does NOT restate competing coverage numbers (confirmed-% / denominator total)", () => {
    expect(md).not.toContain("51.5");
    expect(md).not.toContain("behaviors confirmed");
    expect(md).not.toMatch(/198 behaviors/);
  });

  it("still surfaces completeness caveats that affect the pack", () => {
    const capped = packToMarkdown(pack, { ...analysis, symbol_cap_hit: true, flows_truncated: 3 } as AnalysisMeta);
    expect(capped).toContain("ORANGEPRO_MAX_SYMBOLS");
    expect(capped).toContain("ORANGEPRO_MAX_FLOWS");
  });
});
