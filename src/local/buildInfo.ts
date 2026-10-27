/**
 * The build's own identity (P0.6). `npm run build` stamps dist/local/build-info.json with every file the
 * package ships to run and its sha256 (scripts/build-info.mjs). Run from a build, OrangePro checks those
 * files before it does anything, and refuses a build changed or mixed after it was made, so the binary
 * that ran is the one its records name. Run from source (tsx, vitest) there is no build to check.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { ORANGEPRO_VERSION } from "./version.js";

export interface BuildCheck {
  /** `build`: a stamped build whose files match; `source`: running from source; `stale`: refuse. */
  status: "build" | "source" | "stale";
  build_sha256: string | null;
  reason: string | null;
}

interface BuildStamp {
  schema: string;
  build_sha256: string;
  version: string;
  files: Array<{ path: string; sha256: string }>;
}

let cached: BuildCheck | null = null;

export function checkBuild(): BuildCheck {
  if (cached) return cached;
  cached = check();
  return cached;
}

function check(): BuildCheck {
  return checkBuildAt(dirname(fileURLToPath(import.meta.url)), ORANGEPRO_VERSION);
}

/** The check for the build whose dist/local folder is `here`, expected to be `expectedVersion`. */
export function checkBuildAt(here: string, expectedVersion: string): BuildCheck {
  if (basename(here) !== "local" || basename(dirname(here)) !== "dist") return { status: "source", build_sha256: null, reason: null };
  const root = dirname(dirname(here));
  const stale = (reason: string, sha: string | null = null): BuildCheck => ({ status: "stale", build_sha256: sha, reason });
  const stampPath = join(here, "build-info.json");
  if (!existsSync(stampPath)) return stale("it has no build stamp (dist/local/build-info.json)");
  let stamp: BuildStamp;
  try {
    stamp = JSON.parse(readFileSync(stampPath, "utf8")) as BuildStamp;
  } catch {
    return stale("its build stamp is not readable");
  }
  if (stamp.version !== expectedVersion) return stale(`it was built as ${stamp.version}, but package.json says ${expectedVersion}`, stamp.build_sha256);
  const listed = new Set<string>();
  for (const file of stamp.files ?? []) {
    listed.add(file.path);
    const abs = join(root, file.path);
    if (!existsSync(abs)) return stale(`${file.path} is missing`, stamp.build_sha256);
    if (createHash("sha256").update(readFileSync(abs)).digest("hex") !== file.sha256) return stale(`${file.path} changed after the build`, stamp.build_sha256);
  }
  // A file the stamp does not name (left over from another build) makes the build mixed.
  for (const file of walk(here)) {
    const rel = relative(root, file).split(sep).join("/");
    if (rel.endsWith(".js") && !listed.has(rel)) return stale(`${rel} is not part of this build`, stamp.build_sha256);
  }
  return { status: "build", build_sha256: stamp.build_sha256, reason: null };
}

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  });
}

/** One line for the user: the version and the short build id, or that this runs from source. */
export function buildLabel(check: BuildCheck = checkBuild()): string {
  return check.build_sha256 ? `${ORANGEPRO_VERSION} (build ${check.build_sha256.slice(0, 12)})` : `${ORANGEPRO_VERSION} (from source, no build stamp)`;
}
