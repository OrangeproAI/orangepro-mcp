// A4: the verification receipt. One file, built only from observed run folders (the fault run, the
// verify run and the fresh replay), each checked against its manifest. Nothing in it is written by
// an agent: "verified" is computed from proof-contract rows A–H, each of which names the stage files
// that show it.

export const VERIFICATION_RECEIPT_VERSION = "orangepro.verification_receipt.v1" as const;

export const PROOF_ROWS = ["A", "B", "C", "D", "E", "F", "G", "H"] as const;
export type ProofRow = (typeof PROOF_ROWS)[number];

export const PROOF_ROW_MEANING: Record<ProofRow, string> = {
  A: "the existing whole suite passes on the original, with the fixture's count (fresh copy)",
  B: "the selected old tests pass on the original",
  C: "the same selected tests pass on the same valid, reached fault: they miss it",
  D: "the new test passes on the original, twice",
  E: "the new test fails at its declared assertion on the same fault, twice, alone in the whole suite, and under the text controls",
  F: "the new test passes after the original bytes are restored, and with the fault's code kept beside the site",
  G: "on a fresh copy with the test-only patch, the whole suite passes with one more test",
  H: "on a fresh copy with the patch and the same fault, only the new test fails, at its declared assertion; restored, it passes"
};

export interface StageRef {
  run_id: string;
  stage: string;
  path: string;
  sha256: string;
}

export interface ReceiptStage extends StageRef {
  fault_present: boolean;
  copy_target_sha256: string;
  argv: string[];
  exit_code: number | null;
  timed_out: boolean;
  started_at: string;
  duration_ms: number;
  executed: number | null;
  passed: number | null;
  failed: number | null;
  pending: number | null;
  new_test: "passed" | "failed" | "pending" | "missing" | "not_present";
  new_test_failed_at: { file: string; line: number; column: number | null } | null;
  logs: Array<{ path: string; sha256: string }>;
}

export interface ProofRowResult {
  row: ProofRow;
  meaning: string;
  met: boolean;
  /** Why not, in plain words; null when met. */
  reason: string | null;
  stages: StageRef[];
}

export interface VerificationReceipt {
  version: typeof VERIFICATION_RECEIPT_VERSION;
  evidence_kind: "runtime_observation";
  tool: { name: string; version: string };
  run_ids: { fault: string; brief: string; verify: string; export: string };
  run_manifests: Array<{ run_id: string; sha256: string }>;
  source: {
    repository: string | null;
    merged_commit: string;
    previous_base: string | null;
    pr_number: number | null;
    pr_head: string | null;
    target_file: string;
    target_file_sha256: string;
    lockfile_sha256: string | null;
    clean_checkout: { before: boolean; after: boolean };
  };
  environment: {
    container_image: string;
    container_node: string | null;
    host: { node: string; platform: string };
    runner: { name: "mocha"; version: string };
    installed_tree_sha256: string | null;
    run_profiles: Array<{ run_id: string; sha256: string }>;
  };
  selection: {
    target_record_sha256: string;
    symbol_id: string;
    function_span: unknown;
    function_sha256: string;
    changed_hunks: unknown;
    rank: unknown;
    oracle_sha256: string;
    oracle_approval: unknown;
    assisted: boolean;
  };
  mutation: {
    fault_record_sha256: string;
    operator: { id: string; version: number };
    site: unknown;
    diff_sha256: string;
    validity: unknown;
    reached_by_selected_tests: string;
    behavioral_difference: unknown;
    old_tests: { classification: string; scope: string | null; selected: Array<{ path: string; sha256: string }> };
  };
  generation: {
    state: "generated";
    by: string;
    agent: string;
    assisted: boolean;
    saw: string[];
    attempts: Array<{ run_id: string; attempt: number; result: string; reason: string | null }>;
    candidate_patch_sha256: string;
    assertion_record_sha256: string;
    declared_assertion: { file: string; line: number; text: string; condition: string };
    new_test: { file: string; full_title: string };
  };
  stages: ReceiptStage[];
  rows: ProofRowResult[];
  deliverables: {
    test_patch: { path: "orangepro-tests.patch"; sha256: string; files: string[]; added_lines: number; removed_lines: 0; allowlist: "passed" };
    diagnostic_fault_patch: { path: "diagnostic-fault.patch"; sha256: string; note: string };
    summary: { path: "summary.html" };
  };
  classification: {
    fault: "verified_gap" | "inconclusive" | "blocked";
    reason: string | null;
    generation: "generated";
    adoption: "not_delivered";
    delivery: "artifact_only";
  };
  limitations: string[];
}
