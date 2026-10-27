import { randomBytes } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { sha256Hex } from "./targetRecord.js";

// Shared plumbing for the files of one proof run (`.orangepro/proof-runs/<run-id>/`):
// canonical JSON so two records compare by content, writes that never leave a half
// file, and a manifest written last. A run folder without a valid manifest is not a
// result.

export { sha256Hex };

export const RUN_MANIFEST_VERSION = "orangepro.proof_run_manifest.v1" as const;
export const RUN_MANIFEST_FILE = "MANIFEST.json";

function byCodeUnit(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/** JSON with sorted keys and no `undefined` members, so two records compare by content. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.sort(([a], [b]) => byCodeUnit(a, b)).map(([key, v]) => `${JSON.stringify(key)}:${canonicalJson(v)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The bytes a record is stored as: canonical JSON and one line feed. */
export function recordBytes(value: unknown): Buffer {
  return Buffer.from(`${canonicalJson(value)}\n`, "utf8");
}

/** A record's name: the sha256 of the bytes it is stored as, so it equals the file's hash in MANIFEST.json. */
export function recordSha256(value: unknown): string {
  return sha256Hex(recordBytes(value));
}

/** Write through a uniquely named temp file in the same folder, then rename: a reader never sees half a file. */
export function writeFileAtomic(path: string, bytes: Uint8Array | string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
}

/** Time-sortable run id: `run_<base36 ms>_<6 hex>`. Injectable for tests. */
export function newRunId(now: () => number = Date.now, rnd: () => string = () => randomBytes(3).toString("hex")): string {
  return `run_${now().toString(36)}_${rnd()}`;
}

export interface RunManifestEntry {
  /** Run-folder-relative path, `/`-separated. */
  path: string;
  sha256: string;
  bytes: number;
}

export interface RunManifest {
  version: typeof RUN_MANIFEST_VERSION;
  run_id: string;
  tool_version: string;
  files: RunManifestEntry[];
}

function listFiles(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir).sort(byCodeUnit)) {
    const abs = join(dir, name);
    const stat = lstatSync(abs);
    if (stat.isDirectory()) out.push(...listFiles(abs, base));
    else if (stat.isFile()) out.push(relative(base, abs).split(sep).join("/"));
  }
  return out;
}

/**
 * Write `MANIFEST.json` last, listing every other file in the run folder with its
 * sha256. Refuses when a manifest is already there: a finished run is not reopened.
 */
export function writeRunManifest(runDir: string, runId: string, toolVersion: string): RunManifest {
  const manifestPath = join(runDir, RUN_MANIFEST_FILE);
  if (existsSync(manifestPath)) throw new Error(`${manifestPath} already exists: a finished run is not rewritten.`);
  const files = listFiles(runDir)
    .filter((path) => path !== RUN_MANIFEST_FILE)
    .map((path) => {
      const bytes = readFileSync(join(runDir, path));
      return { path, sha256: sha256Hex(bytes), bytes: bytes.length };
    });
  const manifest: RunManifest = { version: RUN_MANIFEST_VERSION, run_id: runId, tool_version: toolVersion, files };
  writeFileAtomic(manifestPath, recordBytes(manifest));
  return manifest;
}

export type RunCheck = { ok: true; manifest: RunManifest } | { ok: false; message: string };

/**
 * A run folder is a result only when its manifest is there, names this run, and
 * every listed file has the recorded hash, with no other file beside them.
 */
export function verifyRunFolder(runDir: string): RunCheck {
  const manifestPath = join(runDir, RUN_MANIFEST_FILE);
  if (!existsSync(manifestPath)) return { ok: false, message: "the run has no MANIFEST.json: it did not finish." };
  let manifest: RunManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as RunManifest;
  } catch {
    return { ok: false, message: "MANIFEST.json is not valid JSON." };
  }
  if (manifest?.version !== RUN_MANIFEST_VERSION || !Array.isArray(manifest.files)) {
    return { ok: false, message: `MANIFEST.json is not a ${RUN_MANIFEST_VERSION} manifest.` };
  }
  const listed = new Set(manifest.files.map((entry) => entry.path));
  for (const entry of manifest.files) {
    const abs = join(runDir, entry.path);
    if (!existsSync(abs)) return { ok: false, message: `${entry.path} is listed in MANIFEST.json but missing.` };
    if (sha256Hex(readFileSync(abs)) !== entry.sha256) return { ok: false, message: `${entry.path} does not match its hash in MANIFEST.json.` };
  }
  const extra = listFiles(runDir).filter((path) => path !== RUN_MANIFEST_FILE && !listed.has(path));
  if (extra.length > 0) return { ok: false, message: `files not listed in MANIFEST.json: ${extra.join(", ")}.` };
  return { ok: true, manifest };
}
