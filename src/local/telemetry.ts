/**
 * Anonymous usage telemetry for OrangePro MCP (v2).
 *
 * Sends one lightweight ping per scan with: version, detected language,
 * file count bucket, behavior count bucket, whether BYOK is configured,
 * whether the report was generated, scan duration, OS, and node version.
 *
 * No code, no file names, no repo name, no identity, no IP stored.
 *
 * Disable: set DO_NOT_TRACK=1 or ORANGEPRO_NO_TELEMETRY=1
 */

import https from "https";
import { readFileSync } from "fs";
import { dirname, resolve } from "path";
import { fileURLToPath } from "url";


const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const ENDPOINT_HOST = "telemetry.orangepro.ai";
const ENDPOINT_PATH = "/v1/ping";
const TIMEOUT_MS = 3000;

function getVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "../../package.json"), "utf8"));
    return pkg.version || "unknown";
  } catch {
    return "unknown";
  }
}

function bucket(count: number, thresholds: number[]): string {
  for (let i = 0; i < thresholds.length; i++) {
    if (count < thresholds[i]) {
      const low = i === 0 ? 1 : thresholds[i - 1];
      return `${low}-${thresholds[i] - 1}`;
    }
  }
  return `${thresholds[thresholds.length - 1]}+`;
}

function fileBucket(count: number): string {
  return bucket(count, [50, 200, 500, 1000, 5000, 10000]);
}

function behaviorBucket(count: number): string {
  return bucket(count, [100, 500, 1000, 5000, 10000]);
}

export interface TelemetryPayload {
  /** The operation that completed: "scan_complete", "scan_start", "generate_tests" */
  event?: string;
  /** Total source files scanned */
  fileCount: number;
  /** Dominant language detected (e.g. "typescript", "java", "go") */
  language: string;
  /** Total behaviors mapped */
  behaviors?: number;
  /** Whether the user has any LLM API key configured */
  hasByok?: boolean;
  /** Whether the HTML report was successfully generated */
  reportGenerated?: boolean;
  /** Duration of the scan in milliseconds */
  durationMs?: number;
}

export function pingTelemetry(payload: TelemetryPayload): void {
  // Respect DO_NOT_TRACK standard and custom env var
  if (
    process.env.DO_NOT_TRACK === "1" ||
    process.env.ORANGEPRO_NO_TELEMETRY === "1"
  ) {
    return;
  }

  const data = JSON.stringify({
    event: payload.event || "scan_complete",
    v: getVersion(),
    lang: payload.language,
    files: fileBucket(payload.fileCount),
    behaviors: payload.behaviors != null ? behaviorBucket(payload.behaviors) : undefined,
    has_byok: payload.hasByok ? 1 : 0,
    report: payload.reportGenerated !== false ? 1 : 0,
    duration_ms: payload.durationMs ?? undefined,
    os: process.platform,
    node: process.version,
  });

  try {
    const req = https.request(
      {
        hostname: ENDPOINT_HOST,
        path: ENDPOINT_PATH,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(data),
        },
        timeout: TIMEOUT_MS,
      },
      () => { } // ignore response
    );
    req.on("error", () => { }); // silent fail — never block the user
    req.on("timeout", () => req.destroy());
    req.write(data);
    req.end();
  } catch {
    // Never throw — telemetry must never affect the user experience
  }
}
