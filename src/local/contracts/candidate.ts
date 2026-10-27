import type { Oracle } from "./oracle.js";

// A3: a new test for a fault the existing tests missed. Three records, in the order they
// are written:
//   generation-request.json  what the coding agent is given (`opro test-brief`)
//   assertion-record.json    which line of the new test must fail, frozen before any faulty run
//   classification.json      what `opro verify-test` observed, computed from its stage files
// The test itself arrives as a patch that only adds lines to one test file the fault's run selected,
// all of them inside the one new it(…) call.

export const GENERATION_REQUEST_VERSION = "orangepro.generation_request.v1" as const;
export const ASSERTION_RECORD_VERSION = "orangepro.assertion_record.v1" as const;
export const CANDIDATE_VERDICT_VERSION = "orangepro.candidate_verdict.v1" as const;

/** At most three candidates per fault, over every fault run of it: the first and two repairs (context file §12.3). */
export const MAX_CANDIDATE_ATTEMPTS = 3;

export interface GenerationRequest {
  version: typeof GENERATION_REQUEST_VERSION;
  /** The finished A2 run this request is about, named by its manifest's sha256. */
  fault_run: { run_id: string; manifest_sha256: string };
  target_record_sha256: string;
  oracle_sha256: string;
  fault_record_sha256: string;
  symbol_id: string;
  oracle: Oracle;
  fault: { operator: string; file: string; line: number; original_text: string; replacement_text: string; diff: string };
  old_tests: {
    classification: string;
    scope: string | null;
    statement: string;
    selected: Array<{ path: string; sha256: string }>;
    witness: { input: string; original: unknown; fault: unknown };
    /** What each stage of the fault run counted, on the original and on the faulty copy. */
    counts: Record<string, { executed: number; passed: number; failed: number; pending: number }>;
  };
  /** One full title the fault run observed, to show the format: suite titles and the test's own, joined by single spaces. */
  full_title_example: string | null;
  /** The selected test files, whole, as the commit has them: where the new test goes and how its neighbours are written. */
  neighbours: Array<{ path: string; sha256: string; text: string }>;
  allowed_paths: { patterns: string[]; never: string[] };
  rules: string[];
  assertion_record_template: Omit<AssertionRecord, "generation_request_sha256" | "candidate"> & {
    generation_request_sha256: "<sha256 of generation-request.json>";
    candidate: { patch_sha256: "<sha256 of your patch>"; files: Array<{ path: string; sha256_after: "<sha256 of the file after your patch>" }> };
  };
}

export interface AssertionRecord {
  version: typeof ASSERTION_RECORD_VERSION;
  generation_request_sha256: string;
  fault_record_sha256: string;
  candidate: { patch_sha256: string; files: Array<{ path: string; sha256_after: string }> };
  /** The new test: its file and its full title as the runner reports it. */
  test: { file: string; full_title: string };
  /** The one line whose failure counts, in the patched file, and what it checks. */
  assertion: { file: string; line: number; text: string; condition: string };
  failure_recognition: "first_frame_at_declared_line";
  generation: { by: "host_agent" | "provider" | "person"; agent: string; assisted: boolean; saw: string[]; attempt: number };
}

export const CANDIDATE_RESULTS = ["verified_gap", "candidate_failed", "not_caught", "caught_off_assertion", "inconclusive", "blocked"] as const;
export type CandidateResult = (typeof CANDIDATE_RESULTS)[number];

export interface CandidateVerdict {
  version: typeof CANDIDATE_VERDICT_VERSION;
  classifier_version: string;
  run_id: string;
  fault_run: { run_id: string; manifest_sha256: string };
  generation_request_sha256: string;
  assertion_record_sha256: string;
  fault_record_sha256: string;
  result: CandidateResult;
  reason: string | null;
  statement: string;
  assisted: boolean;
  attribution: { by: string; agent: string; attempt: number };
  new_test: { file: string; full_title: string; assertion: { file: string; line: number } };
  /** What the new test did in each stage, and how many tests ran. */
  observed: Record<string, { executed: number; passed: number; failed: number; new_test: "passed" | "failed" | "pending" | "missing"; new_test_failed_at: { file: string; line: number } | null }>;
  /** Existing tests that also failed when the whole suite ran on the fault with the new test (they catch it already). */
  other_failures_on_fault: Array<{ file: string; full_title: string }>;
  /** The earlier finished candidates for this fault, in attempt order. */
  earlier_attempts: Array<{ run_id: string; attempt: number; result: string; reason: string | null }>;
  /** What the result does not establish. */
  limits: string[];
  stages: Array<{ stage: string; path: string; sha256: string }>;
}

export type AssertionRecordCheck = { ok: true; record: AssertionRecord } | { ok: false; message: string };

const SHA256_RE = /^[0-9a-f]{64}$/;
const isPlain = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): string | null {
  const unknown = Object.keys(value).filter((key) => !keys.includes(key));
  if (unknown.length > 0) return `unknown field(s): ${unknown.join(", ")}`;
  const missing = keys.filter((key) => !(key in value));
  return missing.length > 0 ? `missing field(s): ${missing.join(", ")}` : null;
}

/** Check the shape of an assertion record read from a file. Says what is wrong; never repairs. */
export function checkAssertionRecord(value: unknown): AssertionRecordCheck {
  const fail = (message: string): AssertionRecordCheck => ({ ok: false, message: `assertion record: ${message}` });
  if (!isPlain(value)) return fail("not a JSON object.");
  const top = exactKeys(value, ["version", "generation_request_sha256", "fault_record_sha256", "candidate", "test", "assertion", "failure_recognition", "generation"]);
  if (top) return fail(`${top}.`);
  if (value.version !== ASSERTION_RECORD_VERSION) return fail(`version must be ${ASSERTION_RECORD_VERSION}.`);
  for (const key of ["generation_request_sha256", "fault_record_sha256"] as const) {
    if (typeof value[key] !== "string" || !SHA256_RE.test(value[key] as string)) return fail(`${key} must be a sha256 in lowercase hex.`);
  }
  const candidate = value.candidate;
  if (!isPlain(candidate) || exactKeys(candidate, ["patch_sha256", "files"])) return fail("candidate must have patch_sha256 and files.");
  if (typeof candidate.patch_sha256 !== "string" || !SHA256_RE.test(candidate.patch_sha256)) return fail("candidate.patch_sha256 must be a sha256.");
  if (!Array.isArray(candidate.files) || candidate.files.length === 0) return fail("candidate.files must list the changed files.");
  for (const file of candidate.files) {
    if (!isPlain(file) || exactKeys(file, ["path", "sha256_after"]) || !nonEmpty(file.path) || typeof file.sha256_after !== "string" || !SHA256_RE.test(file.sha256_after)) {
      return fail("each candidate file needs path and sha256_after.");
    }
  }
  const test = value.test;
  if (!isPlain(test) || exactKeys(test, ["file", "full_title"]) || !nonEmpty(test.file) || !nonEmpty(test.full_title)) return fail("test needs file and full_title.");
  const assertion = value.assertion;
  if (!isPlain(assertion) || exactKeys(assertion, ["file", "line", "text", "condition"])) return fail("assertion needs file, line, text and condition.");
  if (!nonEmpty(assertion.file) || !Number.isInteger(assertion.line) || (assertion.line as number) < 1 || !nonEmpty(assertion.text) || !nonEmpty(assertion.condition)) {
    return fail("assertion.file, text and condition must be non-empty and line a positive whole number.");
  }
  if (assertion.file !== test.file) return fail("the declared assertion must be in the new test's own file.");
  if (value.failure_recognition !== "first_frame_at_declared_line") return fail("failure_recognition must be first_frame_at_declared_line.");
  const generation = value.generation;
  if (!isPlain(generation) || exactKeys(generation, ["by", "agent", "assisted", "saw", "attempt"])) return fail("generation needs by, agent, assisted, saw and attempt.");
  if (!["host_agent", "provider", "person"].includes(generation.by as string)) return fail("generation.by must be host_agent, provider or person.");
  if (!nonEmpty(generation.agent) || typeof generation.assisted !== "boolean" || !Array.isArray(generation.saw) || generation.saw.length === 0 || !generation.saw.every(nonEmpty)) {
    return fail("generation.agent, assisted and saw must be filled in (saw names at least what the writer was given, for example the brief).");
  }
  if (generation.by !== "provider" && generation.assisted !== true) return fail("a test written by a coding agent or a person is assisted: generation.assisted must be true.");
  if (!Number.isInteger(generation.attempt) || (generation.attempt as number) < 1 || (generation.attempt as number) > MAX_CANDIDATE_ATTEMPTS) {
    return fail(`generation.attempt must be 1 to ${MAX_CANDIDATE_ATTEMPTS}.`);
  }
  return { ok: true, record: value as unknown as AssertionRecord };
}
