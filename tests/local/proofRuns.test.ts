import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { recordBytes, sha256Hex, writeRunManifest } from "../../src/local/contracts/io.js";
import { DELIVERY_RECORD_VERSION, loadPatchStatuses } from "../../src/local/proofRuns.js";
import { applyTestPatch, parseTestPatch, TestPatchError } from "../../src/local/testPatch.js";
import { EXPORT_RUN, MERGED, PATCH, TEST_AFTER, TEST_BEFORE, proofRunFixture } from "./support/proofRunFixture.js";

const view = (f: ReturnType<typeof proofRunFixture>) => loadPatchStatuses(f.runs, f.repo, join(f.repo, ".orangepro"));

describe("the test-only patch, read and applied in memory", () => {
  it("applies the export patch exactly, and refuses what is not a one-file, adds-only patch", () => {
    const p = parseTestPatch(PATCH);
    expect(p.file).toBe("test/round.js");
    expect(p.added).toBe(4);
    expect(applyTestPatch(p, Buffer.from(TEST_BEFORE)).toString()).toBe(TEST_AFTER);
    expect(() => applyTestPatch(p, Buffer.from(TEST_BEFORE.replace("2000), 2", "2000), 3")))).toThrow(TestPatchError);
    expect(() => parseTestPatch(PATCH.replace("+  it('rounds 1500", "-  it('rounds 1500"))).toThrow(/removes a line|counts/);
    expect(() => parseTestPatch(PATCH.replace(/a\/test\/round\.js/g, "a/../etc/passwd").replace(/b\/test\/round\.js/g, "b/../etc/passwd"))).toThrow(TestPatchError);
    expect(() => parseTestPatch(`${PATCH}diff --git a/x b/x\n`)).toThrow(TestPatchError);
  });
});

describe("patch status from finished proof runs (a row attribute, never a tier)", () => {
  it("a verified gap whose test file is as it was: Verified test patch (not merged), with links from the report folder", () => {
    const v = view(proofRunFixture());
    expect(v.ignored).toEqual([]);
    expect(v.statuses).toHaveLength(1);
    expect(v.statuses[0]).toMatchObject({ symbol_id: "sym:lib/round.js#round", state: "verified_not_merged", label: "Verified test patch (not merged)", page: `proof-runs/${EXPORT_RUN}/summary.html`, patch: `proof-runs/${EXPORT_RUN}/orangepro-tests.patch`, merged_commit: MERGED });
  });

  it("the patch's test in the checkout: in this checkout; the test file changed otherwise: stale", () => {
    const f = proofRunFixture();
    writeFileSync(join(f.repo, "test/round.js"), TEST_AFTER);
    expect(view(f).statuses[0].state).toBe("verified_in_checkout");
    writeFileSync(join(f.repo, "test/round.js"), `${TEST_AFTER}// edited\n`);
    expect(view(f).statuses[0]).toMatchObject({ state: "verified_stale", label: "Verified test patch, stale" });
  });

  it("the target changed since the proof: stale, and the text names the file", () => {
    const f = proofRunFixture();
    appendFileSync(join(f.repo, "lib/round.js"), "// changed\n");
    expect(view(f).statuses[0]).toMatchObject({ state: "verified_stale" });
    expect(view(f).statuses[0].text).toContain("lib/round.js changed since the proof");
  });

  it("one byte changed in the receipt or the patch: the run is not used, and the reason is given", () => {
    const f = proofRunFixture();
    appendFileSync(join(f.exportDir, "orangepro-tests.patch"), " ");
    const v = view(f);
    expect(v.statuses).toEqual([]);
    expect(v.ignored).toEqual([{ run_id: EXPORT_RUN, reason: expect.stringContaining("does not match its hash in MANIFEST.json") }]);
  });

  it("an inconclusive run is shown as no claim, never as verified", () => {
    const v = view(proofRunFixture({ fault: "inconclusive" }));
    expect(v.statuses[0]).toMatchObject({ state: "no_claim", label: "Proof run inconclusive: no claim" });
  });

  it("a delivery record with a read-back draft PR: Delivered as draft PR; a read-back merge: Adopted (merged)", () => {
    const f = proofRunFixture();
    const receiptSha = loadReceiptSha(f.exportDir);
    const write = (id: string, merged: boolean) => {
      const dir = join(f.runs, id);
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, "delivery-record.json"), recordBytes({ version: DELIVERY_RECORD_VERSION, run_id: id, export_run_id: EXPORT_RUN, receipt_sha256: receiptSha, repository: "example/round", base: "main", merged_commit: MERGED, branch: "orangepro/tests/246f6f5aeeba", status: "delivered", reason: null, commit: "c".repeat(40), pr: { number: 12, url: "https://github.com/example/round/pull/12", draft: !merged, state: merged ? "closed" : "open", merged, base_ref: "main", head_sha: "c".repeat(40), files: ["test/round.js"] }, checked_at: "2026-11-08T00:00:00.000Z" }));
      writeRunManifest(dir, id, "0.0.0-test");
    };
    write("run_mh0eeeee_eeeeee", false);
    expect(view(f).statuses[0]).toMatchObject({ state: "delivered", label: "Delivered as draft PR #12 (not merged)", pr: { number: 12 } });
    write("run_mh0fffff_ffffff", true);
    expect(view(f).statuses[0]).toMatchObject({ state: "adopted", label: "Adopted (merged): PR #12" });
  });

  it("no proof-runs folder: nothing to show", () => {
    expect(loadPatchStatuses("/nonexistent/proof-runs", "/nonexistent", "/nonexistent")).toEqual({ statuses: [], ignored: [] });
  });
});

function loadReceiptSha(exportDir: string): string {
  return sha256Hex(readFileSync(join(exportDir, "verification-receipt.json")));
}
