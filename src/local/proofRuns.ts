// V3: what the finished proof runs under `.orangepro/proof-runs/` say about each function, for the
// reports. A run counts only when its folder verifies against its manifest and its receipt is a
// receipt; then its patch status is read from the checkout: the target file must still have the
// proven bytes, and the test file is either as it was (not merged), as the patch leaves it (in this
// checkout) or something else (stale). The status is an attribute of the row, never an evidence
// tier: a verified patch is not a proven function until its merged test is proven (owner, 8 Nov).
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { sha256Hex, verifyRunFolder } from "./contracts/io.js";
import { VERIFICATION_RECEIPT_VERSION, type VerificationReceipt } from "./contracts/verificationReceipt.js";
import { applyTestPatch, parseTestPatch, TestPatchError, type TestPatch } from "./testPatch.js";

export const DELIVERY_RECORD_VERSION = "orangepro.delivery_record.v1" as const;

/** What `opro publish-tests` wrote after delivering (or refusing to deliver) one export run. */
export interface DeliveryRecord {
  version: typeof DELIVERY_RECORD_VERSION;
  run_id: string;
  export_run_id: string;
  receipt_sha256: string;
  repository: string;
  base: string;
  merged_commit: string;
  branch: string;
  status: DeliveryStatus;
  reason: string | null;
  commit: string | null;
  /** Read back from GitHub after the write; null when nothing was delivered. */
  pr: { number: number; url: string; draft: boolean; state: "open" | "closed"; merged: boolean; base_ref: string; head_sha: string; files: string[] } | null;
  checked_at: string;
}

export type DeliveryStatus = "delivered" | "updated" | "unchanged" | "dry_run" | "stale_base" | "diverged" | "blocked" | "refused" | "not_deliverable";

export type PatchState = "verified_not_merged" | "verified_in_checkout" | "verified_stale" | "delivered" | "adopted" | "closed" | "no_claim";

export interface PatchStatus {
  symbol_id: string;
  state: PatchState;
  /** The row's patch-status label, the same words in both reports and the job summary. */
  label: string;
  /** One plain sentence: what the receipt shows and what to do. */
  text: string;
  run_id: string;
  merged_commit: string;
  test_file: string;
  /** Paths relative to the report's folder. */
  page: string;
  patch: string;
  pr?: { number: number; url: string };
}

export interface ProofRunsView {
  statuses: PatchStatus[];
  /** Runs that were not used, with the reason (a folder that does not verify, a receipt that is not one). */
  ignored: Array<{ run_id: string; reason: string }>;
}

export type ExportRun =
  | { ok: true; runId: string; dir: string; receipt: VerificationReceipt; receiptSha256: string; patchText: string; patch: TestPatch }
  | { ok: false; runId: string; reason: string };

/** One export run folder: its manifest, its receipt and its patch, each checked. Reads only. */
export function readExportRun(dir: string, runId: string): ExportRun {
  const check = verifyRunFolder(dir);
  if (!check.ok) return { ok: false, runId, reason: check.message };
  let receipt: VerificationReceipt;
  const receiptBytes = readFileSync(join(dir, "verification-receipt.json"));
  try {
    receipt = JSON.parse(receiptBytes.toString("utf8")) as VerificationReceipt;
  } catch {
    return { ok: false, runId, reason: "verification-receipt.json is not valid JSON." };
  }
  if (receipt?.version !== VERIFICATION_RECEIPT_VERSION) return { ok: false, runId, reason: `not a ${VERIFICATION_RECEIPT_VERSION} receipt.` };
  if (receipt.run_ids?.export !== runId) return { ok: false, runId, reason: "the receipt names another export run." };
  const patchPath = join(dir, "orangepro-tests.patch");
  if (!existsSync(patchPath)) return { ok: false, runId, reason: "orangepro-tests.patch is missing." };
  const patchBytes = readFileSync(patchPath);
  if (sha256Hex(patchBytes) !== receipt.deliverables?.test_patch?.sha256) return { ok: false, runId, reason: "orangepro-tests.patch is not the patch the receipt names." };
  let patch: TestPatch;
  try {
    patch = parseTestPatch(patchBytes.toString("utf8"));
  } catch (error) {
    return { ok: false, runId, reason: `orangepro-tests.patch: ${(error as Error).message}` };
  }
  const files = receipt.deliverables.test_patch.files;
  if (!Array.isArray(files) || files.length !== 1 || files[0] !== patch.file) return { ok: false, runId, reason: "the patch's file is not the one the receipt names." };
  return { ok: true, runId, dir, receipt, receiptSha256: sha256Hex(receiptBytes), patchText: patchBytes.toString("utf8"), patch };
}

/** Every finished delivery record under proof-runs, newest last. */
export function readDeliveryRecords(proofRunsDir: string): DeliveryRecord[] {
  const out: DeliveryRecord[] = [];
  for (const runId of listRunIds(proofRunsDir)) {
    const dir = join(proofRunsDir, runId);
    const path = join(dir, "delivery-record.json");
    if (!existsSync(path) || !verifyRunFolder(dir).ok) continue;
    try {
      const record = JSON.parse(readFileSync(path, "utf8")) as DeliveryRecord;
      if (record?.version === DELIVERY_RECORD_VERSION && record.run_id === runId) out.push(record);
    } catch {
      // not a record
    }
  }
  return out;
}

function listRunIds(proofRunsDir: string): string[] {
  if (!existsSync(proofRunsDir)) return [];
  return readdirSync(proofRunsDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && /^run_[0-9a-z]+_[0-9a-f]+$/.test(entry.name))
    .map((entry) => entry.name)
    .sort();
}

function fileOrNull(abs: string): Buffer | null {
  return existsSync(abs) ? readFileSync(abs) : null;
}

/** The file the patch started from, from the file the checkout has now, if that is the patched file. */
function unapply(patch: TestPatch, current: Buffer): Buffer | null {
  if (patch.creates) return null;
  const text = current.toString("utf8");
  if (!text.endsWith("\n")) return null;
  const lines = text.slice(0, -1).split("\n");
  const out: string[] = [];
  let cursor = 0;
  for (const hunk of patch.hunks) {
    const start = hunk.newCount === 0 ? hunk.newStart : hunk.newStart - 1;
    if (start < cursor || start > lines.length) return null;
    out.push(...lines.slice(cursor, start));
    let at = start;
    for (const line of hunk.lines) {
      if (lines[at] !== line.slice(1)) return null;
      if (line[0] === " ") out.push(lines[at]);
      at += 1;
    }
    cursor = at;
  }
  out.push(...lines.slice(cursor));
  return Buffer.from(out.join("\n") + "\n", "utf8");
}

const short = (sha: string): string => sha.slice(0, 12);

/**
 * The patch status of every function a finished export run names, newest run first per function.
 * `sourceRoot` is the analysed checkout; `reportDir` is the folder the reports are written to.
 */
export function loadPatchStatuses(proofRunsDir: string, sourceRoot: string, reportDir: string): ProofRunsView {
  const ignored: ProofRunsView["ignored"] = [];
  const bySymbol = new Map<string, PatchStatus>();
  const deliveries = readDeliveryRecords(proofRunsDir);
  const rel = (abs: string): string => relative(reportDir, abs).split(sep).join("/");
  for (const runId of listRunIds(proofRunsDir).reverse()) {
    const dir = join(proofRunsDir, runId);
    if (!existsSync(join(dir, "verification-receipt.json"))) continue; // not an export run
    const run = readExportRun(dir, runId);
    if (!run.ok) {
      ignored.push({ run_id: runId, reason: run.reason });
      continue;
    }
    const r = run.receipt;
    const symbol = r.selection?.symbol_id;
    if (typeof symbol !== "string" || bySymbol.has(symbol)) continue; // a newer run already speaks for it
    const base = {
      symbol_id: symbol,
      run_id: runId,
      merged_commit: r.source.merged_commit,
      test_file: run.patch.file,
      page: rel(join(dir, "summary.html")),
      patch: rel(join(dir, "orangepro-tests.patch"))
    };
    const verified = r.classification?.fault === "verified_gap" && Array.isArray(r.rows) && r.rows.length === 8 && r.rows.every((row) => row.met === true);
    if (!verified) {
      const word = r.classification?.fault === "blocked" ? "blocked" : "inconclusive";
      bySymbol.set(symbol, { ...base, state: "no_claim", label: `Proof run ${word}: no claim`, text: `The proof run on ${short(r.source.merged_commit)} was ${word}${r.classification?.reason ? ` (${r.classification.reason})` : ""}, so it claims nothing about this function.` });
      continue;
    }
    // The target: the proven bytes, or the receipt no longer applies.
    const target = fileOrNull(join(sourceRoot, r.source.target_file));
    if (!target || sha256Hex(target) !== r.source.target_file_sha256) {
      bySymbol.set(symbol, { ...base, state: "verified_stale", label: "Verified test patch, stale", text: `${r.source.target_file} changed since the proof on ${short(r.source.merged_commit)}, so the receipt no longer applies. Prove it again.` });
      continue;
    }
    // The test file: as it was, as the patch leaves it, or changed.
    const original = r.mutation?.old_tests?.selected?.find((t) => t.path === run.patch.file)?.sha256 ?? null;
    const current = fileOrNull(join(sourceRoot, run.patch.file));
    let state: PatchState = "verified_stale";
    if (run.patch.creates) {
      if (current === null) state = "verified_not_merged";
      else {
        try {
          if (sha256Hex(applyTestPatch(run.patch, null)) === sha256Hex(current)) state = "verified_in_checkout";
        } catch (error) {
          if (!(error instanceof TestPatchError)) throw error;
        }
      }
    } else if (current !== null) {
      if (original !== null && sha256Hex(current) === original) state = "verified_not_merged";
      else {
        const before = unapply(run.patch, current);
        if (before && (original === null || sha256Hex(before) === original)) state = "verified_in_checkout";
      }
    }
    if (state === "verified_stale") {
      bySymbol.set(symbol, { ...base, state, label: "Verified test patch, stale", text: `${run.patch.file} changed since the proof on ${short(r.source.merged_commit)}, and is neither as it was nor as the patch leaves it.` });
      continue;
    }
    if (state === "verified_in_checkout") {
      bySymbol.set(symbol, { ...base, state, label: "Verified test patch (in this checkout)", text: `The new test from the patch is in ${run.patch.file}. Prove it to count this function as Proven.` });
      continue;
    }
    const delivery = deliveries.filter((d) => d.export_run_id === runId && d.receipt_sha256 === run.receiptSha256 && d.pr).pop();
    if (delivery?.pr) {
      const pr = { number: delivery.pr.number, url: delivery.pr.url };
      if (delivery.pr.merged) bySymbol.set(symbol, { ...base, state: "adopted", label: `Adopted (merged): PR #${pr.number}`, text: `PR #${pr.number} with the new test was merged (read back from GitHub). Pull, then prove it to count this function as Proven.`, pr });
      else if (delivery.pr.state === "closed") bySymbol.set(symbol, { ...base, state: "closed", label: `Draft PR #${pr.number} closed, not merged`, text: `PR #${pr.number} with the new test was closed without merging (read back from GitHub).`, pr });
      else bySymbol.set(symbol, { ...base, state: "delivered", label: `Delivered as draft PR #${pr.number} (not merged)`, text: `A new test catches a fault the existing tests missed on ${short(r.source.merged_commit)}. Review draft PR #${pr.number}.`, pr });
      continue;
    }
    bySymbol.set(symbol, { ...base, state: "verified_not_merged", label: "Verified test patch (not merged)", text: `A new test catches a fault the existing tests missed on ${short(r.source.merged_commit)}. Review orangepro-tests.patch.` });
  }
  const statuses = [...bySymbol.values()].sort((a, b) => (a.symbol_id < b.symbol_id ? -1 : a.symbol_id > b.symbol_id ? 1 : 0));
  return { statuses, ignored: ignored.sort((a, b) => (a.run_id < b.run_id ? -1 : 1)) };
}
