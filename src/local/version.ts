import { readFileSync } from "node:fs";

interface PackageManifest {
  version?: unknown;
}

const manifest = JSON.parse(
  readFileSync(new URL("../../package.json", import.meta.url), "utf8")
) as PackageManifest;

if (typeof manifest.version !== "string" || manifest.version.length === 0) {
  throw new Error("OrangePro package version is missing");
}

export const ORANGEPRO_VERSION = manifest.version;

/** The launcher's own package version (`@orangepro/mcp-server`) passes this to the engine it runs. */
export const LAUNCHER_VERSION_ENV = "ORANGEPRO_LAUNCHER_VERSION";
const VERSION_RE = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The launcher version that started this process, or null when the engine was run
 * directly (`opro`) or the value is not a version. Provenance only: no fingerprint
 * or decision reads it.
 */
export function launcherVersion(env: NodeJS.ProcessEnv = process.env): string | null {
  const value = env[LAUNCHER_VERSION_ENV];
  return typeof value === "string" && VERSION_RE.test(value) ? value : null;
}
