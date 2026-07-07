import { LocalGraph, ResolverMetricsMeta, TestLayer } from "../graph/ontology.js";
import { LEDGER_SCHEMA_VERSION, type Ledger } from "../ledger.js";
import { resolveCoverage } from "../score/coverage.js";
import { rankRiskGaps } from "../score/risk.js";
import { buildRtm } from "../rtm.js";

/**
 * Phase 5.2 — `COVERAGE_REPORT.md`, the human-readable summary beside
 * `behavior-coverage.html`, `graph.json`, and optional graph export. It states,
 * auditably and in one place:
 *  - dynamic Proven % over the DENOMINATOR behaviors;
 *  - what the denominator is made of (Gate 3 composition line);
 *  - import-resolution coverage (the 7 resolver axes) — unresolved imports are
 *    test→source links the confirmer could not follow, so coverage can't be
 *    proven across them;
 *  - the graph schema version.
 */

const LAYER_ORDER: TestLayer[] = ["unit", "component", "integration", "api", "e2e", "manual", "unknown"];

// The 7 resolver axes that matter for static-association defensibility, in
// reading order; test→source is the gate axis.
const AXIS_LABELS: Array<{ key: keyof ResolverMetricsMeta; label: string }> = [
  { key: "test_to_source", label: "test → source (gate axis)" },
  { key: "test_to_test", label: "test → test" },
  { key: "test_internal", label: "test → internal" },
  { key: "source_to_source", label: "source → source" },
  { key: "barrel_terminal", label: "barrel → terminal" },
  { key: "workspace_package", label: "workspace package" },
  { key: "all_internal", label: "all internal" }
];

function emptyLedger(): Ledger {
  return { schema_version: LEDGER_SCHEMA_VERSION, records: [] };
}

export function renderCoverageReport(graph: LocalGraph, ledger: Ledger = emptyLedger()): string {
  const a = graph.analysis;
  const lines: string[] = [];
  lines.push("# Coverage Report");
  lines.push("");
  lines.push(`_Graph schema: ${graph.schema_version}_`);
  lines.push(`_Generated: ${graph.updated_at || graph.created_at || "(unknown)"}_`);
  lines.push("");

  // ---- Public Proven + denominator: ONE atomic pair (shared with report views) ----
  const { coverage: staticCov, denominator: comp } = resolveCoverage(graph);
  const rtm = buildRtm(graph, ledger);
  const s = rtm.summary;
  lines.push("## Dynamic Proven");
  lines.push("");
  lines.push(
    `**${s.proven} of ${s.total} behaviors Proven (${s.coverage_pct}%)** — public Proven requires a closed dynamic targeted-proof ledger record. Static TESTED_BY/COVERS edges are Associated signal diagnostics, not proof.`
  );
  const gate = a?.resolver_gate;
  if (gate) {
    lines.push("");
    lines.push(
      gate.defensible
        ? `Defensible for static association diagnostics: import resolution on the gate axis (test → source) is ${gate.pct ?? "?"}% (≥ ${gate.threshold_pct}%).`
        : `⚠ Static association diagnostics are not defensible repo-wide: test → source resolution is ${gate.pct ?? "?"}% (< ${gate.threshold_pct}%) or the scan was truncated.`
    );
  }
  lines.push("");
  lines.push("Static assertion candidates by test layer (diagnostic only — never counted as Proven):");
  lines.push("");
  lines.push("| layer | static candidate behaviors |");
  lines.push("| --- | ---: |");
  for (const l of LAYER_ORDER) lines.push(`| ${l} | ${staticCov.by_layer[l]} |`);
  lines.push("");
  if (staticCov.confirmed > 0 && staticCov.unknown_count > 0) {
    lines.push(`${staticCov.unknown_count} static candidate behavior(s) (${staticCov.unknown_pct}%) have an undetermined test layer.`);
    lines.push("");
  }

  const runtime = a?.runtime_coverage;
  lines.push("## Runtime coverage");
  lines.push("");
  if (runtime) {
    lines.push(
      `**${runtime.covered_symbols} of ${runtime.total_eligible_symbols} eligible symbols runtime-covered (${runtime.covered_pct}%)** — measured from local coverage-tool output, not name matching and not assertion-level proof.`
    );
    lines.push("");
    lines.push("| language | covered / eligible | covered % | symbols with spans |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const [language, row] of Object.entries(runtime.by_language).sort(([a], [b]) => a.localeCompare(b))) {
      lines.push(`| ${language} | ${row.covered} / ${row.eligible} | ${row.covered_pct}% | ${row.symbols_with_spans} |`);
    }
    lines.push("");
    lines.push("Artifacts:");
    lines.push("");
    lines.push("| artifact | format | files | covered ranges |");
    lines.push("| --- | --- | ---: | ---: |");
    for (const artifact of runtime.artifacts) {
      lines.push(`| ${escapeMd(artifact.path)} | ${artifact.format} | ${artifact.files} | ${artifact.covered_ranges} |`);
    }
    lines.push("");
    if (runtime.skipped_artifacts?.length) {
      lines.push("Skipped artifacts:");
      lines.push("");
      lines.push("| artifact | format | reason |");
      lines.push("| --- | --- | --- |");
      for (const artifact of runtime.skipped_artifacts) {
        lines.push(`| ${escapeMd(artifact.path)} | ${artifact.format} | ${escapeMd(artifact.reason)} |`);
      }
      lines.push("");
    }
  } else {
    lines.push(
      "No runtime coverage report was ingested. This report still shows dynamic Proven and static association diagnostics, but it does not claim actual executed coverage. Run `opro coverage .` for detected local coverage commands, or `opro analyze . --generate-coverage` where supported."
    );
    lines.push("");
  }

  // ---- Denominator composition (Gate 3) — the SAME comp paired with cov above ----
  const requirement = comp.requirement_template + comp.markdown_requirement;
  lines.push("## Denominator");
  lines.push("");
  let compLine = `${comp.total} behaviors: ${comp.code_export} code_export, ${requirement} requirement`;
  if (comp.excluded_test_inferred > 0) compLine += `; ${comp.excluded_test_inferred} test-inferred excluded`;
  if (comp.unattributed > 0) compLine += `; ${comp.unattributed} unattributed`;
  lines.push(compLine + ".");
  lines.push("");
  // Recomputed from nodes (comp), NOT read from persisted analysis — the
  // disclosure is paired with the same graph the denominator was computed over.
  // Complete accounting: total = counted + boilerplate + infra + generated + other (the
  // buckets are disjoint and sum to every CodeSymbol node), so the "found" count
  // is never a partial sum that drops non-callable consts / .d.ts / infra symbols.
  const boilerplate = comp.excluded_boilerplate;
  const infra = comp.excluded_infra;
  const generated = comp.excluded_generated;
  if (boilerplate > 0 || infra > 0 || generated > 0) {
    const total = comp.code_symbols_total;
    const other = Math.max(0, total - comp.code_export - boilerplate - infra - generated);
    let line = `${total} code symbols found: ${comp.code_export} counted as behaviors`;
    if (boilerplate > 0) line += `, ${boilerplate} excluded as trivial accessors (getters/setters, toString/equals/hashCode, __repr__/__str__)`;
    if (infra > 0) line += `, ${infra} excluded as CI/test-infra (.github, e2e/playwright/cypress, fixtures/mocks)`;
    if (generated > 0) line += `, ${generated} excluded as generated code (Code generated ... DO NOT EDIT)`;
    if (other > 0) line += `, ${other} excluded as non-behavioral (type declarations, non-callable consts)`;
    lines.push(line + ". Excluded symbols stay in the graph but carry no testable behavior, so counting them would distort coverage.");
    lines.push("");
  }
  lines.push("Test-inferred behaviors (guessed from test describe-names) are inventoried but never counted — a test cannot prove its own requirement.");
  lines.push("");

  const riskGaps = rankRiskGaps(graph, { limit: 20 });
  if (riskGaps.length > 0) {
    lines.push("## Top gaps by risk");
    lines.push("");
    lines.push("Unconfirmed code behaviors ranked by structural impact and recent change activity. This is a prioritization list, not coverage proof.");
    lines.push("");
    lines.push("Risk score = Probability(1-10) × Impact(1-10) × DetectionDifficulty(1|5|10).");
    lines.push("");
    lines.push("| rank | behavior | file | risk | why |");
    lines.push("| ---: | --- | --- | ---: | --- |");
    riskGaps.forEach((g, i) => {
      lines.push(`| ${i + 1} | ${escapeMd(g.title)} | ${escapeMd(g.file)} | ${g.risk_score} | ${escapeMd(g.reasons.join("; "))} |`);
    });
    lines.push("");
  }

  // ---- Import resolution (the 7 axes) ----
  lines.push("## Import resolution");
  lines.push("");
  if (a?.resolver_metrics) {
    const rm = a.resolver_metrics;
    lines.push("Unresolved imports are links the confirmer cannot follow, so coverage can't be proven across them.");
    lines.push("");
    lines.push("| axis | resolved / eligible | resolved % | unresolved % |");
    lines.push("| --- | ---: | ---: | ---: |");
    for (const { key, label } of AXIS_LABELS) {
      const m = rm[key];
      if (!m) continue;
      const unresolved = m.n > 0 ? round1(100 - (m.resolved / m.n) * 100) : 0;
      lines.push(`| ${label} | ${m.resolved} / ${m.n} | ${m.pct}% | ${unresolved}% |`);
    }
  } else {
    lines.push("_No TypeScript/JavaScript imports were scanned, so resolver metrics are not available._");
  }
  lines.push("");

  const budget = a?.not_analyzed_due_to_budget;
  if (a?.symbol_cap_hit || a?.files_cap_hit || budget) {
    lines.push("## Caveats");
    lines.push("");
    if (budget) {
      lines.push(
        `- ⚠ PARTIAL SCAN: the analyze budget (${budget.budget_ms}ms) stopped after ${budget.elapsed_ms}ms with ${budget.files_not_analyzed} file(s) NOT analyzed. The denominator is incomplete, so the Dynamic Proven headline is a partial view. Raise \`ORANGEPRO_MAX_ANALYZE_MS\` or scope with \`--base\`.`
      );
    }
    if (a?.symbol_cap_hit) lines.push("- Symbol cap hit: some code symbols were omitted; the denominator understates the repo, so Dynamic Proven reads low. Raise `ORANGEPRO_MAX_SYMBOLS`.");
    if (a?.files_cap_hit) lines.push("- File cap hit: not all files were scanned; coverage measured an unknown fraction of the repo. Raise `ORANGEPRO_MAX_FILES`.");
    lines.push("");
  }

  return lines.join("\n");
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}

function escapeMd(s: string): string {
  return s.replace(/\|/g, "\\|").replace(/\n/g, " ");
}
