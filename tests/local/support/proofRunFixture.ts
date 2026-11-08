// V3 test support: a small checkout with one function and one test file, plus a finished fault run
// and export run under `.orangepro/proof-runs/`, as export-tests leaves them (manifest last).
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordBytes, sha256Hex, writeRunManifest } from "../../../src/local/contracts/io.js";

export const MERGED = "246f6f5aeebad1b9d6a0ea08cd96d3fe19f8f23c";
export const SOURCE = "exports.round = function (ms) {\n  return Math.floor(ms / 1000);\n};\n";
export const TEST_BEFORE = "describe('round', function () {\n  it('rounds 2000', function () {\n    assert.equal(round(2000), 2);\n  });\n});\n";
export const PATCH = [
  "diff --git a/test/round.js b/test/round.js",
  "--- a/test/round.js",
  "+++ b/test/round.js",
  "@@ -3,3 +3,7 @@",
  "     assert.equal(round(2000), 2);",
  "   });",
  "+",
  "+  it('rounds 1500 down', function () {",
  "+    assert.equal(round(1500), 1);",
  "+  });",
  " });",
  ""
].join("\n");
export const TEST_AFTER = "describe('round', function () {\n  it('rounds 2000', function () {\n    assert.equal(round(2000), 2);\n  });\n\n  it('rounds 1500 down', function () {\n    assert.equal(round(1500), 1);\n  });\n});\n";
export const FAULT_PATCH = "diff --git a/lib/round.js b/lib/round.js\n--- a/lib/round.js\n+++ b/lib/round.js\n@@ -1,3 +1,3 @@\n exports.round = function (ms) {\n-  return Math.floor(ms / 1000);\n+  return Math.ceil(ms / 1000);\n };\n";
export const FAULT_RUN = "run_mh0aaaaa_aaaaaa";
export const EXPORT_RUN = "run_mh0bbbbb_bbbbbb";
export const BUILD = "b".repeat(64);

export interface Fixture {
  repo: string;
  runs: string;
  exportDir: string;
  faultDir: string;
}

export function proofRunFixture(opts: { fault?: "verified_gap" | "inconclusive" | "blocked"; patch?: string; testFile?: string; neverPaths?: string[] } = {}): Fixture {
  const repo = mkdtempSync(join(tmpdir(), "opro-v3-"));
  mkdirSync(join(repo, "lib"), { recursive: true });
  mkdirSync(join(repo, "test"), { recursive: true });
  writeFileSync(join(repo, "lib/round.js"), SOURCE);
  writeFileSync(join(repo, opts.testFile ?? "test/round.js"), TEST_BEFORE);
  const runs = join(repo, ".orangepro", "proof-runs");
  const faultDir = join(runs, FAULT_RUN);
  mkdirSync(faultDir, { recursive: true });
  writeFileSync(
    join(faultDir, "fixture-manifest.json"),
    recordBytes({ origin: { upstream: "https://github.com/example/round", fork: null }, allowed_patch_paths: { patterns: ["test/*.js"], never: opts.neverPaths ?? ["test/support/**"] } })
  );
  writeFileSync(join(faultDir, "oracle.json"), recordBytes({ behavior: "round gives whole seconds, rounding down: 1500 ms gives 1.", expected: "round(1500) is 1" }));
  writeRunManifest(faultDir, FAULT_RUN, "0.0.0-test");
  const exportDir = join(runs, EXPORT_RUN);
  mkdirSync(exportDir, { recursive: true });
  const patch = opts.patch ?? PATCH;
  writeFileSync(join(exportDir, "orangepro-tests.patch"), patch);
  writeFileSync(join(exportDir, "diagnostic-fault.patch"), FAULT_PATCH);
  writeFileSync(join(exportDir, "summary.html"), "<!doctype html><title>s</title>\n");
  const fault = opts.fault ?? "verified_gap";
  const rows = ["A", "B", "C", "D", "E", "F", "G", "H"].map((row) => ({ row, meaning: `row ${row}`, met: fault === "verified_gap" || row !== "G", reason: null, stages: [] }));
  const receipt = {
    version: "orangepro.verification_receipt.v1",
    evidence_kind: "runtime_observation",
    tool: { name: "@orangepro/orangepro-mcp", version: "0.0.0-test", build_sha256: BUILD },
    run_ids: { fault: FAULT_RUN, brief: "run_mh0ccccc_cccccc", verify: "run_mh0ddddd_dddddd", export: EXPORT_RUN },
    run_manifests: [{ run_id: FAULT_RUN, sha256: sha256Hex(readFileSync(join(faultDir, "MANIFEST.json"))) }],
    source: { repository: "github.com/example/round", merged_commit: MERGED, previous_base: "1".repeat(40), pr_number: 7, pr_head: null, target_file: "lib/round.js", target_file_sha256: sha256Hex(Buffer.from(SOURCE)), lockfile_sha256: null, clean_checkout: { before: true, after: true } },
    selection: { symbol_id: "sym:lib/round.js#round", assisted: true },
    mutation: { old_tests: { classification: "survived_unverified", scope: "selected", selected: [{ path: "test/round.js", sha256: sha256Hex(Buffer.from(TEST_BEFORE)) }] } },
    generation: { by: "agent", agent: "test agent", assisted: true, new_test: { file: "test/round.js", full_title: "round rounds 1500 down" }, declared_assertion: { file: "test/round.js", line: 7, text: "assert.equal(round(1500), 1);", condition: "equal" } },
    rows,
    deliverables: { test_patch: { path: "orangepro-tests.patch", sha256: sha256Hex(Buffer.from(patch)), files: ["test/round.js"], added_lines: 4, removed_lines: 0, allowlist: "passed" }, diagnostic_fault_patch: { path: "diagnostic-fault.patch", sha256: sha256Hex(Buffer.from(FAULT_PATCH)), note: "" }, summary: { path: "summary.html" } },
    classification: { fault, reason: fault === "verified_gap" ? null : "row_G_not_met", generation: "generated", adoption: "not_delivered", delivery: "artifact_only" },
    limitations: ["One fault, one revision."]
  };
  writeFileSync(join(exportDir, "verification-receipt.json"), recordBytes(receipt));
  writeRunManifest(exportDir, EXPORT_RUN, "0.0.0-test");
  return { repo, runs, exportDir, faultDir };
}
