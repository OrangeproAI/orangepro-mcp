// The expected behavior a fault is judged against (`oracle.json`). Written and approved
// by a person before any faulty copy runs, and never filled in from what a faulty copy
// did. A proof run reads it as a claim: wrong version, a missing or unknown field, or a
// target that is not the run's target refuses the run.

export const ORACLE_VERSION = "orangepro.oracle.v1" as const;

export const ORACLE_BASIS_KINDS = ["source_doc", "spec", "library", "api_doc", "test_name"] as const;
export type OracleBasisKind = (typeof ORACLE_BASIS_KINDS)[number];

export interface OracleBasis {
  kind: OracleBasisKind;
  /** Where it was read: a file and line range, a section number, a package and version. */
  ref: string;
  /** What it says, in a few words. */
  note: string;
}

export interface OracleWitness {
  /** The witness script's own file name, for people. The run folder always stores it as `inputs/witness.cjs`. */
  file: string;
  sha256: string;
  /** The one input it exercises, in plain words. */
  input: string;
}

export interface OracleApproval {
  status: "proposed" | "approved";
  by?: string;
  /** ISO date or date-time. */
  at?: string;
  /** Where the approval is recorded. */
  where?: string;
}

export interface Oracle {
  version: typeof ORACLE_VERSION;
  /** sha256 of the target record's canonical JSON. */
  target_record_sha256: string;
  symbol_id: string;
  /** One sentence: the observable behavior. */
  behavior: string;
  /** The public way in that a test or a witness goes through. */
  entry_point: string;
  inputs: string;
  expected: string;
  excluded_inputs: string;
  why_observable: string;
  basis: OracleBasis[];
  witness: OracleWitness;
  assisted: { flag: boolean; visible_before: string[] };
  approval: OracleApproval;
}

export type OracleCheck = { ok: true; oracle: Oracle } | { ok: false; message: string };

const TOP_KEYS = [
  "version",
  "target_record_sha256",
  "symbol_id",
  "behavior",
  "entry_point",
  "inputs",
  "expected",
  "excluded_inputs",
  "why_observable",
  "basis",
  "witness",
  "assisted",
  "approval"
] as const;
const TEXT_KEYS = ["symbol_id", "behavior", "entry_point", "inputs", "expected", "excluded_inputs", "why_observable"] as const;

function isPlain(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function onlyKeys(value: Record<string, unknown>, allowed: readonly string[], required: readonly string[]): string | null {
  const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
  if (unknown.length > 0) return `unknown field(s): ${unknown.join(", ")}`;
  const missing = required.filter((key) => !(key in value));
  return missing.length > 0 ? `missing field(s): ${missing.join(", ")}` : null;
}

const SHA256_RE = /^[0-9a-f]{64}$/;
const nonEmpty = (value: unknown): value is string => typeof value === "string" && value.trim() !== "";

/** Check the shape of an oracle read from a file. Says what is wrong; never repairs. */
export function checkOracle(value: unknown): OracleCheck {
  const fail = (message: string): OracleCheck => ({ ok: false, message: `oracle: ${message}` });
  if (!isPlain(value)) return fail("not a JSON object.");
  const keys = onlyKeys(value, TOP_KEYS, TOP_KEYS);
  if (keys) return fail(`${keys}.`);
  if (value.version !== ORACLE_VERSION) return fail(`version must be ${ORACLE_VERSION}.`);
  if (typeof value.target_record_sha256 !== "string" || !SHA256_RE.test(value.target_record_sha256)) {
    return fail("target_record_sha256 must be a sha256 in lowercase hex.");
  }
  for (const key of TEXT_KEYS) if (!nonEmpty(value[key])) return fail(`${key} must be a non-empty string.`);
  if (!Array.isArray(value.basis) || value.basis.length === 0) return fail("basis must list at least one source.");
  for (const entry of value.basis) {
    if (!isPlain(entry)) return fail("each basis entry must be an object.");
    const bad = onlyKeys(entry, ["kind", "ref", "note"], ["kind", "ref", "note"]);
    if (bad) return fail(`basis entry: ${bad}.`);
    if (!(ORACLE_BASIS_KINDS as readonly unknown[]).includes(entry.kind)) return fail(`basis kind must be one of ${ORACLE_BASIS_KINDS.join(", ")}.`);
    if (!nonEmpty(entry.ref) || !nonEmpty(entry.note)) return fail("basis ref and note must be non-empty strings.");
  }
  const witness = value.witness;
  if (!isPlain(witness)) return fail("witness must be an object.");
  const badWitness = onlyKeys(witness, ["file", "sha256", "input"], ["file", "sha256", "input"]);
  if (badWitness) return fail(`witness: ${badWitness}.`);
  if (!nonEmpty(witness.file) || !/^[A-Za-z0-9][A-Za-z0-9_-]*\.(?:c?js|mjs)$/.test(witness.file)) return fail("witness.file must be a plain .js, .cjs or .mjs file name.");
  if (typeof witness.sha256 !== "string" || !SHA256_RE.test(witness.sha256)) return fail("witness.sha256 must be a sha256 in lowercase hex.");
  if (!nonEmpty(witness.input)) return fail("witness.input must be a non-empty string.");
  const assisted = value.assisted;
  if (!isPlain(assisted)) return fail("assisted must be an object.");
  const badAssisted = onlyKeys(assisted, ["flag", "visible_before"], ["flag", "visible_before"]);
  if (badAssisted) return fail(`assisted: ${badAssisted}.`);
  if (typeof assisted.flag !== "boolean") return fail("assisted.flag must be true or false.");
  if (!Array.isArray(assisted.visible_before) || !assisted.visible_before.every(nonEmpty)) return fail("assisted.visible_before must be a list of strings.");
  if (assisted.flag && assisted.visible_before.length === 0) return fail("an assisted oracle must say what was visible before.");
  const approval = value.approval;
  if (!isPlain(approval)) return fail("approval must be an object.");
  const badApproval = onlyKeys(approval, ["status", "by", "at", "where"], ["status"]);
  if (badApproval) return fail(`approval: ${badApproval}.`);
  if (approval.status !== "proposed" && approval.status !== "approved") return fail("approval.status must be proposed or approved.");
  if (approval.status === "approved" && !(nonEmpty(approval.by) && nonEmpty(approval.at) && nonEmpty(approval.where))) {
    return fail("an approved oracle must say by whom, when and where.");
  }
  for (const key of ["by", "at", "where"] as const) {
    if (approval[key] !== undefined && !nonEmpty(approval[key])) return fail(`approval.${key} must be a non-empty string when given.`);
  }
  return { ok: true, oracle: value as unknown as Oracle };
}
