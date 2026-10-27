// The run's observations, shaped as the entries of the verification receipt A4 will
// assemble. A2 writes three kinds of file into `.orangepro/proof-runs/<run-id>/`:
//   run-profile.json      what was going to run, written before the first stage
//   stages/<stage>.json   what one stage observed, one file each
//   classification.json   the result, computed from the stage files as read back
// Host paths never appear: a mount is named by its role (`<original>`, `<out>`, …).

export const RUN_PROFILE_VERSION = "orangepro.run_profile.v1" as const;
export const STAGE_OBSERVATION_VERSION = "orangepro.stage_observation.v1" as const;
export const CLASSIFICATION_VERSION = "orangepro.fault_classification.v1" as const;
export const FAULT_CLASSIFIER_VERSION = "orangepro.fault_classifier.v1" as const;

export const STAGE_NAMES = [
  "original_selected",
  "fault_syntax",
  "witness_original",
  "witness_original_repeat",
  "witness_fault",
  "fault_selected",
  "original_full_suite",
  "fault_full_suite"
] as const;
export type StageName = (typeof STAGE_NAMES)[number];

export interface ContainerProfile {
  image: string;
  platform: string;
  user: string;
  network: "none";
  read_only_root: true;
  capabilities: "none";
  memory: string;
  cpus: string;
  processes: number;
  tmp_size: string;
  deadline_seconds: number;
  /** Every mount, by role: `<original>` or `<mutant>` copy, `<node_modules>`, `<out>`, `<reporter>`, `<witness>`. */
  mounts: Array<{ source: string; target: string; mode: "ro" | "rw" }>;
  env_names: string[];
}

export interface RunProfile {
  version: typeof RUN_PROFILE_VERSION;
  run_id: string;
  tool: { name: string; version: string };
  fixture_manifest_sha256: string;
  /** `source.pr.number` of the fixture, when it records one. */
  source_pr: number | null;
  merged_commit: string;
  target_record_sha256: string;
  oracle_sha256: string;
  fault_record_sha256: string;
  witness_sha256: string;
  selected_tests: Array<{ path: string; sha256: string }>;
  /** The command run inside the container for the selected tests (files appended). */
  selected_argv: string[];
  /** The command for the whole suite, when it was asked for. */
  full_suite_argv: string[] | null;
  runner: { name: "mocha"; version: string };
  container: ContainerProfile;
  limits: { stage_deadline_ms: number };
}

export interface ObservedTest {
  /** Path inside the repository, `/`-separated. */
  file: string;
  full_title: string;
  state: "passed" | "failed" | "pending";
  /** A failure in a before/after hook rather than in the test. */
  hook: boolean;
  duration_ms: number | null;
  failure: {
    name: string | null;
    message: string;
    first_frame: string | null;
    /** The A2 rule: an AssertionError, an error with expected/actual, or one raised on a line of the test's own file. */
    at_assertion: boolean;
  } | null;
}

export interface FileRef {
  /** Run-folder-relative path. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface StageObservation {
  version: typeof STAGE_OBSERVATION_VERSION;
  stage: StageName;
  run_id: string;
  run_profile_sha256: string;
  /** null for stages on the original copy. */
  fault_record_sha256: string | null;
  copy: "original" | "mutant";
  /** sha256 of the target file in the copy, read just before the stage ran. */
  copy_target_sha256: string;
  /** The command inside the container. */
  argv: string[];
  /** The full `docker run` command, host paths replaced by their role. */
  docker_argv: string[];
  /** The boundary probe run just before this stage, in the stage's own shape. The stage runs only when it holds. */
  boundary: { failures: string[]; report: unknown };
  /** false when the stage's container could not be confirmed gone after its deadline. */
  stopped: boolean;
  /** Why something the container left in its output folder was not read (a link, not a regular file, too large, not JSON). */
  output_problems: string[];
  cwd: string;
  env_names: string[];
  started_at: string;
  duration_ms: number;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  /** Mocha stages only; null when the boundary did not hold, or the runner left no readable report. */
  tests: {
    executed: number;
    passed: number;
    failed: number;
    pending: number;
    hook_failures: number;
    runner_totals: { tests: number | null; passes: number | null; failures: number | null; pending: number | null } | null;
    observed: ObservedTest[];
  } | null;
  /** Witness stages: the one JSON line printed last, parsed; null when there was none. */
  output: unknown;
  /** Selected-test stage on the original only: the fault span's execution count from V8 coverage, or null when unknown. */
  fault_span_count: number | null;
  stdout: FileRef;
  stderr: FileRef;
  report: FileRef | null;
  coverage: FileRef | null;
}

export const FAULT_CLASSES = ["caught_by_existing", "survived_unverified", "invalid_mutation", "inconclusive", "blocked"] as const;
export type FaultClass = (typeof FAULT_CLASSES)[number];

export interface Classification {
  version: typeof CLASSIFICATION_VERSION;
  classifier_version: typeof FAULT_CLASSIFIER_VERSION;
  run_id: string;
  fault_record_sha256: string;
  classification: FaultClass;
  /** Which tests the claim covers: the selected files, or the whole suite. null when no claim is made. */
  scope: "selected" | "full_suite" | null;
  /** A short machine-readable reason (`red_baseline`, `no_tests_executed`, …) or null. */
  reason: string | null;
  /** The sentence shown to people. */
  statement: string;
  assisted: boolean;
  reached_by_selected_tests: "reached" | "not_reached" | "unknown";
  behavioral_difference: { status: "differs" | "same" | "unknown"; original: unknown; fault: unknown };
  /** Selected tests that passed on the original and failed on the fault. */
  caught_by: Array<{ file: string; full_title: string; at_assertion: boolean }>;
  /** Every stage file the classification was computed from, in run order. */
  stages: Array<{ stage: StageName; path: string; sha256: string }>;
}
