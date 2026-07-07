import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { GraphEdge, LocalGraph } from "./graph/ontology.js";
import { workspacePaths } from "./workspace.js";
import { hashString } from "./util/hash.js";

export const LEDGER_SCHEMA_VERSION = "orangepro.local_ledger.v1" as const;
export const LEDGER_FILE = "ledger.json";

export type LedgerStatus = "reproven" | "unproven" | "already_proven" | "generated_unverifiable";

export interface DynamicProofCertificate {
  proof_kind: "dynamic_targeted";
  baseline_green: boolean;
  mutant_failed_assertion: boolean;
  target_not_mocked: boolean;
  sentinel: "return-json" | "promise-json" | string;
  runner?: string;
  test_path?: string;
  mutant_status?: string;
}

export interface LedgerRecordInput {
  run_id?: string;
  target_id?: string;
  target_symbol: string;
  pre_edges: string[];
  new_edges: string[];
  closed: boolean;
  vacuous?: boolean;
  agent_pass?: boolean;
  evidence_ids?: string[];
  provider?: string;
  model?: string;
  prompt_version?: string;
  language?: string;
  dynamic_proof?: DynamicProofCertificate;
  /**
   * Composite code-identity fingerprint of the proven target at prove time
   * (see `targetFingerprint`). RTM only re-surfaces a dynamic proof as Proven
   * while this equals the target's current fingerprint. Optional → pre-existing
   * records without it are never counted as Proven (they fall back to diagnostics).
   */
  target_fingerprint?: string;
  status: LedgerStatus;
  reprove_mode?: "scoped" | "full";
  reprove_reason?: string;
  reason?: string;
  ts: string;
}

export interface LedgerRecord extends LedgerRecordInput {
  run_id: string;
  pre_edge_count: number;
}

export interface Ledger {
  schema_version: typeof LEDGER_SCHEMA_VERSION;
  records: LedgerRecord[];
}

export interface LedgerStats {
  ledger_path: string;
  records: number;
  attempted: number;
  reproven: number;
  unproven: number;
  already_proven: number;
  generated_unverifiable: number;
  quality_adjusted_kept_rate: number;
}

export function ledgerPath(root: string): string {
  return join(workspacePaths(root).dir, LEDGER_FILE);
}

export function proofEdgesFor(graph: LocalGraph, symExtId: string): string[] {
  return graph.edges
    .filter((e) => e.relationship_type === "COVERS" && e.evidence_strength === "hard" && e.to_external_id === symExtId)
    .map(edgeKey)
    .sort();
}

export function reproveTarget(preEdges: string[], postGraph: LocalGraph, symExtId: string): { closed: boolean; newEdges: string[] } {
  const pre = new Set(preEdges);
  const newEdges = proofEdgesFor(postGraph, symExtId).filter((e) => !pre.has(e));
  return { closed: newEdges.length > 0, newEdges };
}

export function resolveTargetSymbol(graph: LocalGraph, target: string): string | null {
  const node = graph.nodes.find((n) => n.external_id === target);
  if (node?.kind === "CodeSymbol") return node.external_id;
  const directSymbols = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.from_external_id !== target && edge.to_external_id !== target) continue;
    if (edge.evidence_strength !== "hard") continue;
    const other = edge.from_external_id === target ? edge.to_external_id : edge.from_external_id;
    if (graph.nodes.find((n) => n.external_id === other && n.kind === "CodeSymbol")) directSymbols.add(other);
  }
  return directSymbols.size === 1 ? [...directSymbols][0] : null;
}

export function targetLanguage(symExtId: string): string {
  const file = symExtId.match(/^sym:(.+)#/)?.[1] ?? "";
  const ext = file.split(".").pop()?.toLowerCase();
  if (ext === "ts" || ext === "tsx" || ext === "js" || ext === "jsx" || ext === "mts" || ext === "cts" || ext === "mjs" || ext === "cjs") return "typescript";
  if (ext === "go") return "go";
  if (ext === "java") return "java";
  if (ext === "py") return "python";
  return ext || "unknown";
}

export function canReproveLanguage(language: string): boolean {
  return language === "typescript" || language === "go" || language === "python";
}

export function loadLedger(root: string): Ledger {
  const path = ledgerPath(root);
  if (!existsSync(path)) return { schema_version: LEDGER_SCHEMA_VERSION, records: [] };
  const parsed = JSON.parse(readFileSync(path, "utf8")) as Ledger;
  if (parsed.schema_version !== LEDGER_SCHEMA_VERSION) {
    throw new Error(`Ledger schema mismatch: found ${parsed.schema_version ?? "unknown"}, expected ${LEDGER_SCHEMA_VERSION}.`);
  }
  return parsed;
}

export function appendLedgerRecord(root: string, input: LedgerRecordInput): { ledger_path: string; record: LedgerRecord } {
  const path = ledgerPath(root);
  const ledger = loadLedger(root);
  const record: LedgerRecord = {
    ...input,
    run_id: input.run_id || `run:${String(ledger.records.length + 1).padStart(6, "0")}`,
    evidence_ids: [...new Set(input.evidence_ids ?? [])].sort(),
    pre_edge_count: input.pre_edges.length
  };
  ledger.records.push(record);
  mkdirSync(workspacePaths(root).dir, { recursive: true });
  writeFileSync(path, JSON.stringify(ledger, null, 2) + "\n", "utf8");
  return { ledger_path: path, record };
}

export function ledgerStats(root: string): LedgerStats {
  const path = ledgerPath(root);
  const ledger = loadLedger(root);
  const attempted = ledger.records.filter((r) => r.status === "reproven" || r.status === "unproven").length;
  const reproven = ledger.records.filter((r) => r.status === "reproven").length;
  const unproven = ledger.records.filter((r) => r.status === "unproven").length;
  return {
    ledger_path: path,
    records: ledger.records.length,
    attempted,
    reproven,
    unproven,
    already_proven: ledger.records.filter((r) => r.status === "already_proven").length,
    generated_unverifiable: ledger.records.filter((r) => r.status === "generated_unverifiable").length,
    quality_adjusted_kept_rate: attempted > 0 ? Number(((reproven / attempted) * 100).toFixed(2)) : 0
  };
}

function edgeKey(edge: GraphEdge): string {
  return `${edge.from_external_id}->${edge.to_external_id}`;
}

/**
 * Composite code-identity fingerprint for a proven target: the target file's
 * manifest content hash + the symbol external id + the credited member/method.
 * Both the ledger writer (`opDynamicProof`) and RTM call THIS one function, so a
 * proof only re-surfaces as Proven while the code it proved is byte-identical
 * (any change to the file's content — hence its hash — lapses the proof).
 * Returns `undefined` when the file has no manifest hash (synthesized symbol /
 * not analyzed) or the id is not a parseable `sym:<file>#<name>` → no fingerprint
 * → the record is never counted as Proven.
 */
export function targetFingerprint(graph: LocalGraph, symExtId: string): string | undefined {
  const match = /^sym:(.+)#([^#]+)$/.exec(symExtId);
  if (!match) return undefined;
  const [, file, symbolName] = match;
  const member = symbolName.split(".").filter(Boolean).pop();
  const fileHash = graph.manifest.files[file]?.hash;
  if (!fileHash || !member) return undefined;
  return hashString([fileHash, symExtId, member].join("|"));
}
