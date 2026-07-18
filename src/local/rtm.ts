import type { GraphNode, LocalGraph } from "./graph/ontology.js";
import { denominatorBehaviors } from "./graph/factories.js";
import { languageOf } from "./analyze/classify.js";
import { targetFingerprint, type Ledger } from "./ledger.js";

export type RtmFormat = "md" | "csv" | "json";
export type RtmStatus = "Proven" | "Runtime-covered" | "Associated signal" | "Candidate signal (unconfirmed)" | "No integration signal" | "Reproven (this run)" | "Generated-unverifiable";
export type RtmEvidenceTier = "proven" | "runtime" | "associated" | "candidate" | "none";

export interface RtmRow {
  behavior: string;
  behavior_id: string;
  kind: string;
  code_symbol: string;
  file: string;
  area: string;
  language: string;
  evidence_tier: RtmEvidenceTier;
  test_signal: string;
  status: RtmStatus;
  suggested_next_test: string;
  ledger_outcome: string;
  ledger_run_id: string;
  /**
   * True for a row surfaced by the display-union: a CodeSymbol carrying a CURRENT valid
   * dynamic-proof cert that is NOT in the deterministic denominator (e.g. a Formatter SPI
   * method below the entry-point-adjacent bar). Counted in `summary.proven` but NEVER in
   * `total`/`coverage_total`/`coverage_pct` — the denominator math stays the deterministic set.
   */
  off_denominator?: boolean;
}

export interface RtmSummary {
  total: number;
  proven: number;
  runtime_covered: number;
  associated: number;
  candidate: number;
  no_link: number;
  reproven_this_run: number;
  generated_unverifiable: number;
  attempted: number;
  kept_rate: number;
  coverage_confirmed: number;
  coverage_total: number;
  coverage_pct: number;
}

export interface RtmScope {
  base_ref?: string;
  status?: string;
  guidance?: string;
  target_ids?: string[];
  changed_files?: string[];
}

export interface RtmResult {
  summary: RtmSummary;
  rows: RtmRow[];
  scope?: RtmScope;
}

interface RtmIndexes {
  staticSignalsById: Map<string, string[]>;
  candidateSignalsById: Map<string, string[]>;
  candidateSignalsByFile: Map<string, string[]>;
}

const STATUS_ORDER: Record<RtmStatus, number> = {
  "No integration signal": 0,
  "Candidate signal (unconfirmed)": 1,
  "Associated signal": 2,
  "Generated-unverifiable": 3,
  "Runtime-covered": 4,
  "Proven": 5,
  "Reproven (this run)": 6
};

const GENERIC_TEST_CATEGORIES = [
  "happy-path",
  "validation",
  "auth-permission",
  "state-transition",
  "error-handling",
  "boundary",
  "idempotency-concurrency"
] as const;
const ASSOCIATED_IMPORT_PROPAGATION_LIMIT = 25;

export function buildRtm(
  graph: LocalGraph,
  ledger: Ledger,
  opts: { targetIds?: string[]; changedFiles?: string[]; statuses?: string[]; limit?: number; scope?: RtmScope } = {}
): RtmResult {
  const targetSet = opts.targetIds ? new Set(opts.targetIds) : null;
  const fileSet = opts.changedFiles ? new Set(opts.changedFiles) : null;
  const statusSet = normalizeStatusFilter(opts.statuses);
  const ledgerBySymbol = selectLedgerBySymbol(ledger, graph);
  const indexes = buildRtmIndexes(graph);
  const baseRows = denominatorBehaviors(graph)
    .filter((node) => inScope(node, targetSet, fileSet))
    .map((node) => toRtmRow(indexes, node, ledgerBySymbol.get(node.external_id)))
    .sort((a, b) => STATUS_ORDER[a.status] - STATUS_ORDER[b.status] || a.area.localeCompare(b.area) || a.file.localeCompare(b.file) || a.behavior.localeCompare(b.behavior));
  // Display-union: surface CodeSymbols with a CURRENT valid dynamic-proof cert that fall
  // OUTSIDE the deterministic denominator (e.g. a Formatter SPI method below the
  // entry-point-adjacent bar). `ledgerBySymbol.get(...).proven` is already gated by
  // isDynamicProofRecord + fingerprint-match + closed, so a stale/invalid/unclosed cert
  // is never `true` here. These rows are counted in `summary.proven` but NOT in the
  // denominator math (total/coverage_total/coverage_pct) — the denominator stays stable.
  const denominatorIds = new Set(baseRows.map((row) => row.behavior_id));
  const unionRows = graph.nodes
    .filter((node) => node.kind === "CodeSymbol" && !denominatorIds.has(node.external_id) && ledgerBySymbol.get(node.external_id)?.proven === true)
    .filter((node) => inScope(node, targetSet, fileSet))
    .map((node) => ({ ...toRtmRow(indexes, node, ledgerBySymbol.get(node.external_id)), off_denominator: true }))
    .sort((a, b) => a.area.localeCompare(b.area) || a.file.localeCompare(b.file) || a.behavior.localeCompare(b.behavior));
  const displayRows = [...baseRows, ...unionRows];
  const filteredRows = displayRows.filter((row) => !statusSet || statusSet.has(row.status));
  const rows = opts.limit && opts.limit > 0 ? filteredRows.slice(0, opts.limit) : filteredRows;
  return { summary: summarizeRows(baseRows, unionRows), rows, ...(opts.scope ? { scope: opts.scope } : {}) };
}

function inScope(node: GraphNode, targetSet: Set<string> | null, fileSet: Set<string> | null): boolean {
  if (!targetSet && !fileSet) return true;
  if (targetSet?.has(node.external_id)) return true;
  const file = nodeFileRef(node);
  return file !== "" && fileSet?.has(file) === true;
}

export function renderRtmMarkdown(result: RtmResult): string {
  const s = result.summary;
  // Off-denominator proven symbols (display-union): counted in `proven` but not in `total`.
  const offDenominatorProven = result.rows.filter((row) => row.off_denominator === true && row.evidence_tier === "proven").length;
  const provenValue = offDenominatorProven > 0
    ? `${s.proven} (${s.proven - offDenominatorProven} in denominator + ${offDenominatorProven} off-denominator)`
    : `${s.proven}`;
  const lines = [
    "# OrangePro Traceability Matrix",
    "",
    "Deterministic local report. Public Proven is derived only from dynamic targeted-proof ledger records; static graph links and LLM output never set Proven.",
    "",
    "| Metric | Value |",
    "|---|---:|",
    `| Total denominator behaviors | ${s.total} |`,
    `| Dynamically Proven | ${provenValue} |`,
    `| Runtime-covered | ${s.runtime_covered} |`,
    `| Associated signal | ${s.associated} |`,
    `| Candidate signal (unconfirmed) | ${s.candidate} |`,
    `| No integration signal | ${s.no_link} |`,
    `| Reproven this run | ${s.reproven_this_run} |`,
    `| Generated unverifiable | ${s.generated_unverifiable} |`,
    `| Dynamic Proven source | ${s.coverage_confirmed} / ${s.coverage_total} (${s.coverage_pct}%) |`,
    `| Current graph kept rate | ${s.kept_rate}% (${s.reproven_this_run}/${s.attempted}) |`,
    ""
  ];

  if (result.scope?.guidance) {
    lines.push(`> ${escapeMarkdown(result.scope.guidance)}`, "");
  }
  if (offDenominatorProven > 0) {
    lines.push(
      `> ${offDenominatorProven} dynamically-proven symbol(s) sit OUTSIDE the deterministic denominator (marked \`off-denominator\` below). They are counted in Dynamically Proven but NOT in the denominator or Dynamic Proven source ratio.`,
      ""
    );
  }
  if (result.rows.length < s.total) {
    lines.push(
      `> Showing ${result.rows.length} row(s) from ${s.total} scoped denominator row(s). This can reflect \`--limit\` and/or \`--status\` filters. Use \`opro rtm --format json --out .orangepro/rtm-full.json\` for a full machine-readable RTM.`,
      ""
    );
  }

  if (result.rows.length === 0) {
    lines.push("No RTM rows matched this scope. Run `opro analyze .` first, widen filters, or use `opro gaps` for baseline opportunities.", "");
    return lines.join("\n");
  }

  lines.push("| Behavior | Code Symbol | Area | Language | Test Signal | Status | Suggested Next Test | Ledger Outcome |");
  lines.push("|---|---|---|---|---|---|---|---|");
  for (const row of result.rows) {
    lines.push(
      [
        row.behavior,
        row.code_symbol || row.behavior_id,
        row.off_denominator ? `${row.area} (off-denominator)` : row.area,
        row.language,
        row.test_signal,
        row.status,
        row.suggested_next_test,
        row.ledger_outcome
      ]
        .map((cell) => escapeMarkdown(cell))
        .join(" | ")
        .replace(/^/, "| ")
        .replace(/$/, " |")
    );
  }
  lines.push("");
  return lines.join("\n");
}

export function renderRtmCsv(result: RtmResult): string {
  const header = ["behavior", "behavior_id", "kind", "code_symbol", "file", "area", "language", "evidence_tier", "test_signal", "status", "suggested_next_test", "ledger_outcome", "ledger_run_id", "off_denominator"];
  const rows = result.rows.map((row) => [
    row.behavior,
    row.behavior_id,
    row.kind,
    row.code_symbol,
    row.file,
    row.area,
    row.language,
    row.evidence_tier,
    row.test_signal,
    row.status,
    row.suggested_next_test,
    row.ledger_outcome,
    row.ledger_run_id,
    row.off_denominator ? "true" : "false"
  ]);
  return [header, ...rows].map((row) => row.map(csvCell).join(",")).join("\n") + "\n";
}

function toRtmRow(indexes: RtmIndexes, node: GraphNode, selected: SelectedLedger | undefined): RtmRow {
  const ledgerRecord = selected?.record;
  const file = nodeFileRef(node);
  // `proven` was already gated on isDynamicProofRecord AND a current-fingerprint
  // match in selectLedgerBySymbol; a record that only passes isDynamicProofRecord
  // (stale/absent fingerprint) arrives here with proven === false → not Proven.
  const dynamicProof = selected?.proven === true;
  const evidence = evidenceTierFor(indexes, node, file, dynamicProof);
  const status = statusFor(evidence, ledgerRecord, dynamicProof);
  const testSignal = dynamicProof ? dynamicProofSignalFor(ledgerRecord) : evidence === "runtime" ? runtimeSignalFor(node) : testSignalFor(indexes, node.external_id, file);
  return {
    behavior: node.title || node.external_id,
    behavior_id: node.external_id,
    kind: node.kind,
    code_symbol: node.kind === "CodeSymbol" ? node.external_id : "",
    file,
    area: codeAreaOf(file),
    language: node.kind === "CodeSymbol" ? languageLabel(languageOf(file)) : "Requirement",
    evidence_tier: evidence,
    test_signal: testSignal,
    status,
    suggested_next_test: suggestedNextTest(node, file, status),
    ledger_outcome: ledgerRecord ? `${ledgerRecord.status}${ledgerRecord.closed ? " closed" : ""}` : "",
    ledger_run_id: ledgerRecord?.run_id ?? ""
  };
}

function evidenceTierFor(indexes: RtmIndexes, node: GraphNode, file: string, dynamicProof: boolean): RtmEvidenceTier {
  if (dynamicProof) return "proven";
  if (node.kind === "CodeSymbol" && node.properties.runtime_covered === true) return "runtime";
  // Epistemic tiers (mirrors the platform's Proof/Candidate/Weak model):
  // associated = a hard static test link (COVERS/TESTED_BY via real import) exists;
  // candidate  = only a lexical/Jaccard candidate edge exists — a lead, not evidence.
  if (indexes.staticSignalsById.has(node.external_id)) return "associated";
  if (indexes.candidateSignalsById.has(node.external_id) || (file !== "" && indexes.candidateSignalsByFile.has(file))) return "candidate";
  return "none";
}

function statusFor(evidence: RtmEvidenceTier, ledgerRecord: Ledger["records"][number] | undefined, dynamicProof: boolean): RtmStatus {
  if (evidence === "proven") return dynamicProof && ledgerRecord?.status === "reproven" && ledgerRecord.closed ? "Reproven (this run)" : "Proven";
  if (evidence === "runtime") return "Runtime-covered";
  if (ledgerRecord?.status === "generated_unverifiable") return "Generated-unverifiable";
  if (evidence === "associated") return "Associated signal";
  if (evidence === "candidate") return "Candidate signal (unconfirmed)";
  return "No integration signal";
}

/**
 * `rows` = the deterministic denominator rows (drives ALL denominator math). `unionRows`
 * = off-denominator symbols with a current valid dynamic-proof cert; they add ONLY to
 * `proven` (the honest "Dynamically Proven" headline), never to total/coverage_total/
 * coverage_pct. Splitting the two keeps the denominator stable while the headline counts
 * every genuinely-proven symbol.
 */
function summarizeRows(rows: RtmRow[], unionRows: RtmRow[] = []): RtmSummary {
  const attempted = rows.filter((row) => row.ledger_outcome.startsWith("reproven") || row.ledger_outcome.startsWith("unproven")).length;
  const reproven = rows.filter((row) => row.status === "Reproven (this run)").length;
  const denominatorProven = rows.filter((row) => row.evidence_tier === "proven").length;
  const proven = denominatorProven + unionRows.filter((row) => row.evidence_tier === "proven").length;
  return {
    total: rows.length,
    proven,
    runtime_covered: rows.filter((row) => row.evidence_tier === "runtime").length,
    associated: rows.filter((row) => row.evidence_tier === "associated").length,
    candidate: rows.filter((row) => row.evidence_tier === "candidate").length,
    no_link: rows.filter((row) => row.evidence_tier === "none").length,
    reproven_this_run: reproven,
    generated_unverifiable: rows.filter((row) => row.status === "Generated-unverifiable").length,
    attempted,
    kept_rate: attempted > 0 ? Number(((reproven / attempted) * 100).toFixed(2)) : 0,
    coverage_confirmed: denominatorProven,
    coverage_total: rows.length,
    coverage_pct: rows.length > 0 ? Number(((denominatorProven / rows.length) * 100).toFixed(1)) : 0
  };
}

interface SelectedLedger {
  record: Ledger["records"][number];
  /** true only when `record` is a valid dynamic proof whose fingerprint matches the current code. */
  proven: boolean;
}

/**
 * Best-ever-proven, fingerprint-scoped ledger selection (replaces pure
 * latest-timestamp-wins). Per symbol:
 *   1. Pick the NEWEST record that is a valid dynamic proof (`isDynamicProofRecord`)
 *      AND whose `target_fingerprint` equals the target's current fingerprint → Proven.
 *   2. Otherwise fall back to the latest overall record for status/diagnostics,
 *      but NOT Proven (this is the trust-conservative branch — a stale/absent
 *      fingerprint never counts as Proven).
 * A later flaky/failed prove can no longer demote a genuine proof of the same
 * unchanged code; a proof only lapses when the code (its file hash) changes.
 */
function selectLedgerBySymbol(ledger: Ledger, graph: LocalGraph): Map<string, SelectedLedger> {
  const bySymbol = new Map<string, Array<{ record: Ledger["records"][number]; index: number }>>();
  ledger.records.forEach((record, index) => {
    const list = bySymbol.get(record.target_symbol);
    if (list) list.push({ record, index });
    else bySymbol.set(record.target_symbol, [{ record, index }]);
  });

  const newest = (
    entries: Array<{ record: Ledger["records"][number]; index: number }>
  ): { record: Ledger["records"][number]; index: number } =>
    entries.reduce((best, e) => (compareLedgerRecords(e.record, e.index, best.record, best.index) > 0 ? e : best));

  const out = new Map<string, SelectedLedger>();
  for (const [symbol, entries] of bySymbol) {
    const currentFingerprint = targetFingerprint(graph, symbol);
    const matches = currentFingerprint
      ? entries.filter((e) => isDynamicProofRecord(e.record) && e.record.target_fingerprint === currentFingerprint)
      : [];
    if (matches.length > 0) {
      out.set(symbol, { record: newest(matches).record, proven: true });
    } else {
      out.set(symbol, { record: newest(entries).record, proven: false });
    }
  }
  return out;
}

function compareLedgerRecords(a: Ledger["records"][number], aIndex: number, b: Ledger["records"][number], bIndex: number): number {
  const aTs = Date.parse(a.ts);
  const bTs = Date.parse(b.ts);
  const safeATs = Number.isFinite(aTs) ? aTs : 0;
  const safeBTs = Number.isFinite(bTs) ? bTs : 0;
  return safeATs - safeBTs || aIndex - bIndex;
}

function buildRtmIndexes(graph: LocalGraph): RtmIndexes {
  const nodeById = new Map(graph.nodes.map((n) => [n.external_id, n]));
  const staticSignalsById = new Map<string, Set<string>>();
  const candidateSignalsById = new Map<string, Set<string>>();
  const candidateSignalsByFile = new Map<string, Set<string>>();

  const add = (map: Map<string, Set<string>>, key: string, value: string): void => {
    const set = map.get(key);
    if (set) set.add(value);
    else map.set(key, new Set([value]));
  };
  // Candidate (lexical/Jaccard) signals attach ONLY to the matched file itself.
  // They must never propagate through imports: one lexical match on a barrel file
  // previously marked its whole import subtree as "associated" — that inflated
  // 93% of Twenty behaviors into the test-signal tier with zero real evidence.
  const addFileAssociation = (file: string, value: string): void => {
    add(candidateSignalsByFile, file, value);
  };

  for (const e of graph.edges) {
    if (e.evidence_strength !== "hard") continue;
    if (e.relationship_type !== "COVERS" && e.relationship_type !== "TESTED_BY") continue;
    const from = nodeById.get(e.from_external_id);
    const to = nodeById.get(e.to_external_id);
    if (from?.kind === "TestCase" && to) add(staticSignalsById, e.to_external_id, e.from_external_id);
    if (to?.kind === "TestCase" && from) add(staticSignalsById, e.from_external_id, e.to_external_id);
  }

  for (const e of graph.candidate_edges) {
    if (e.review_status === "ai_suggested") continue;
    if (e.relationship_type !== "MAY_RELATE_TO" && e.relationship_type !== "MAY_BE_TESTED_BY" && e.relationship_type !== "MAY_COVER") continue;
    add(candidateSignalsById, e.from_external_id, e.to_external_id);
    add(candidateSignalsById, e.to_external_id, e.from_external_id);
    for (const [key, value] of [[e.from_external_id, e.to_external_id], [e.to_external_id, e.from_external_id]] as const) {
      if (isFileSignalKey(key)) addFileAssociation(key, value);
    }
  }

  const freeze = (map: Map<string, Set<string>>): Map<string, string[]> => new Map([...map.entries()].map(([key, values]) => [key, [...values].sort()]));
  return {
    staticSignalsById: freeze(staticSignalsById),
    candidateSignalsById: freeze(candidateSignalsById),
    candidateSignalsByFile: freeze(candidateSignalsByFile)
  };
}

function isFileSignalKey(id: string): boolean {
  return !id.startsWith("sym:") && !id.startsWith("test:") && !id.startsWith("flow:");
}

function testSignalFor(indexes: RtmIndexes, externalId: string, file: string): string {
  const staticSignals = indexes.staticSignalsById.get(externalId) ?? [];
  if (staticSignals.length > 0) return `static candidate: ${staticSignals.slice(0, 3).join("; ")}`;

  const associated = [...(indexes.candidateSignalsById.get(externalId) ?? []), ...(file ? indexes.candidateSignalsByFile.get(file) ?? [] : [])]
    .filter((id) => id !== externalId && id !== file)
    .sort();
  if (associated.length > 0) return associated.slice(0, 3).join("; ");
  return "";
}

function isDynamicProofRecord(record: Ledger["records"][number] | undefined): boolean {
  const proof = record?.dynamic_proof;
  return (
    record?.status === "reproven" &&
    record.closed === true &&
    proof?.proof_kind === "dynamic_targeted" &&
    proof.baseline_green === true &&
    proof.mutant_failed_assertion === true &&
    proof.target_not_mocked === true
  );
}

function dynamicProofSignalFor(record: Ledger["records"][number] | undefined): string {
  const proof = record?.dynamic_proof;
  const parts = ["dynamic targeted proof"];
  if (proof?.runner) parts.push(proof.runner);
  if (proof?.sentinel) parts.push(`sentinel:${proof.sentinel}`);
  if (record?.run_id) parts.push(record.run_id);
  return parts.join(" · ");
}

function suggestedNextTest(node: GraphNode, file: string, status: RtmStatus): string {
  if (status === "Proven" || status === "Reproven (this run)" || status === "Runtime-covered") return "";
  const haystack = `${node.title ?? ""} ${node.external_id} ${file}`.toLowerCase();
  const category =
    haystack.match(/auth|permission|role|rbac|login|session|token/) ? "auth-permission" :
    haystack.match(/valid|parse|schema|sanitize|input|required/) ? "validation" :
    haystack.match(/create|update|delete|remove|archive|status|enable|disable|transition/) ? "state-transition" :
    haystack.match(/error|fail|recover|retry|exception/) ? "error-handling" :
    haystack.match(/limit|range|empty|max|min|overflow|boundary/) ? "boundary" :
    haystack.match(/concurrent|lock|race|idempot|duplicate/) ? "idempotency-concurrency" :
    GENERIC_TEST_CATEGORIES[0];
  return `Add a ${category} test that asserts this behavior.`;
}

function normalizeStatusFilter(statuses: string[] | undefined): Set<RtmStatus> | null {
  if (!statuses || statuses.length === 0) return null;
  const out = new Set<RtmStatus>();
  for (const raw of statuses) {
    const s = raw.trim().toLowerCase().replace(/_/g, "-");
    if (s === "proven") out.add("Proven");
    else if (s === "runtime" || s === "runtime-covered" || s === "runtimecovered") out.add("Runtime-covered");
    else if (s === "associated") out.add("Associated signal");
    else if (s === "candidate" || s === "candidate-signal") out.add("Candidate signal (unconfirmed)");
    else if (s === "no-link" || s === "nolink" || s === "none") out.add("No integration signal");
    else if (s === "reproven" || s === "reproven-this-run") out.add("Reproven (this run)");
    else if (s === "generated-unverifiable" || s === "unverifiable") out.add("Generated-unverifiable");
  }
  return out.size > 0 ? out : null;
}

function runtimeSignalFor(node: GraphNode): string {
  const formats = Array.isArray(node.properties.runtime_coverage_formats)
    ? node.properties.runtime_coverage_formats.filter((f): f is string => typeof f === "string")
    : [];
  return formats.length > 0 ? `runtime coverage (${formats.sort().join(", ")})` : "runtime coverage";
}

function nodeFileRef(n: GraphNode): string {
  if (typeof n.properties.file === "string") return n.properties.file;
  if (typeof n.provenance?.source_ref === "string") return n.provenance.source_ref;
  return n.external_id.startsWith("sym:") ? n.external_id.replace(/^sym:/, "").split("#")[0] : "";
}

function cleanPathParts(sourceRefOrPath: string | undefined): string[] {
  if (!sourceRefOrPath) return [];
  return sourceRefOrPath.replace(/^[./]+/, "").split(/[#?]/)[0].split(/[\\/]/).filter(Boolean);
}

function parentDir(parts: string[]): string {
  return parts.length > 1 ? parts[parts.length - 2] : parts[0] || "core";
}

function codeAreaOf(sourceRefOrPath: string | undefined): string {
  const parts = cleanPathParts(sourceRefOrPath);
  if (parts.length === 0) return "core";
  const language = languageOf(sourceRefOrPath ?? "");
  if (language === "go") {
    if (parts[0] === "server" && parts[1] === "channels" && parts[2]) return `server/${parts[2]}`;
    return parts.length > 2 ? parts.slice(0, 2).join("/") : parentDir(parts);
  }
  if (language === "typescript" || language === "javascript") {
    if (parts[0] === "webapp" && parts[1] === "channels" && parts[2] === "src" && parts[3]) return `webapp/${parts[3]}`;
    return parts.length > 2 ? parts.slice(0, 2).join("/") : parentDir(parts);
  }
  return parts.length > 2 ? parts.slice(0, 2).join("/") : parentDir(parts);
}

function languageLabel(language: string): string {
  const labels: Record<string, string> = {
    typescript: "TypeScript/JavaScript",
    javascript: "TypeScript/JavaScript",
    python: "Python",
    go: "Go",
    java: "Java",
    ruby: "Ruby",
    kotlin: "Kotlin",
    rust: "Rust",
    php: "PHP",
    csharp: "C#",
    swift: "Swift",
    c: "C",
    cpp: "C++"
  };
  return labels[language] ?? (language || "Unknown");
}

function escapeMarkdown(value: string): string {
  return value.replace(/\|/g, "\\|").replace(/[\r\n\t]/g, " ");
}

function csvCell(value: string): string {
  const normalized = value.replace(/\r/g, " ");
  const safe = /^[=+\-@\t]/.test(normalized) ? `'${normalized}` : normalized;
  if (!/[",\n]/.test(safe)) return safe;
  return `"${safe.replace(/"/g, '""')}"`;
}
