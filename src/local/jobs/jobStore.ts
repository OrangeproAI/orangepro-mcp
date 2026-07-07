/**
 * Background-job state, persisted under `.orangepro/jobs/` (gitignored via the
 * `.orangepro` ignore). Pure file helpers — NO process spawning here — so they are
 * unit-testable with a tmp root. The detached child writes its status JSON so an
 * agent can poll completion; the bell/notification is best-effort on top.
 */
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { workspacePaths } from "../workspace.js";

export type JobStatus = "queued" | "running" | "done" | "failed";

export interface JobRecord {
  id: string;
  status: JobStatus;
  command: "generate";
  created_at: string;
  started_at?: string;
  finished_at?: string;
  pid?: number;
  cwd: string;
  /** Safe, non-secret generation params only — never env / keys. */
  args: Record<string, string | number | boolean>;
  log_path: string;
  outputs?: { tests_path?: string; report_path?: string; report_json_path?: string; result_path?: string };
  error?: string;
}

export function jobsDir(root: string): string {
  return join(workspacePaths(root).dir, "jobs");
}

export function jobJsonPath(root: string, id: string): string {
  return join(jobsDir(root), `${id}.json`);
}

export function jobLogPath(root: string, id: string): string {
  return join(jobsDir(root), `${id}.log`);
}

/** Result payload for a --single (agent-mode) job: generated tests + run hints. */
export function jobResultPath(root: string, id: string): string {
  return join(jobsDir(root), `${id}.result.json`);
}

/** Fresh, time-sortable job id. Injectable clock/rng for deterministic tests. */
export function newJobId(now: () => number = Date.now, rnd: () => string = () => randomBytes(3).toString("hex")): string {
  return `job_${now().toString(36)}_${rnd()}`;
}

function ensureDir(root: string): void {
  mkdirSync(jobsDir(root), { recursive: true });
}

/** Write the record atomically (temp + rename) so a poller never reads a half file. */
export function writeJobRecord(root: string, rec: JobRecord): void {
  ensureDir(root);
  const path = jobJsonPath(root, rec.id);
  const tmp = `${path}.tmp`;
  writeFileSync(tmp, JSON.stringify(rec, null, 2) + "\n", "utf8");
  renameSync(tmp, path);
}

export function readJobRecord(root: string, id: string): JobRecord | null {
  const path = jobJsonPath(root, id);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as JobRecord;
  } catch {
    return null;
  }
}

/** Immutable read-modify-write of a job record. Returns the new record (or null if absent). */
export function updateJobRecord(root: string, id: string, patch: Partial<JobRecord>): JobRecord | null {
  const cur = readJobRecord(root, id);
  if (!cur) return null;
  const next: JobRecord = { ...cur, ...patch };
  writeJobRecord(root, next);
  return next;
}

/** All job records, newest first. */
export function listJobs(root: string): JobRecord[] {
  const dir = jobsDir(root);
  if (!existsSync(dir)) return [];
  const recs: JobRecord[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      recs.push(JSON.parse(readFileSync(join(dir, f), "utf8")) as JobRecord);
    } catch {
      // skip a corrupt/partial record
    }
  }
  return recs.sort((a, b) => (a.created_at < b.created_at ? 1 : a.created_at > b.created_at ? -1 : 0));
}

export function appendJobLog(root: string, id: string, line: string): void {
  ensureDir(root);
  appendFileSync(jobLogPath(root, id), line.endsWith("\n") ? line : `${line}\n`, "utf8");
}
