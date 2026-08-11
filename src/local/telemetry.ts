/**
 * Anonymous usage telemetry for OrangePro MCP.
 *
 * Sends one lightweight ping per run with: version, detected language,
 * file count bucket, OS, and node version. No code, no file names,
 * no repo name, no identity, no IP stored.
 *
 * Disable: set DO_NOT_TRACK=1 or ORANGEPRO_NO_TELEMETRY=1
 */

import https from "https";
import { readFileSync } from "fs";
import { resolve } from "path";

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

function fileBucket(count: number): string {
  if (count < 50) return "1-49";
  if (count < 200) return "50-199";
  if (count < 500) return "200-499";
  if (count < 1000) return "500-999";
  if (count < 5000) return "1000-4999";
  if (count < 10000) return "5000-9999";
  return "10000+";
}

export interface TelemetryPayload {
  fileCount: number;
  language: string;
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
    event: "run",
    v: getVersion(),
    lang: payload.language,
    files: fileBucket(payload.fileCount),
    os: process.platform,
    node: process.version,
    ts: new Date().toISOString(),
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
      () => {} // ignore response
    );
    req.on("error", () => {}); // silent fail — never block the user
    req.on("timeout", () => req.destroy());
    req.write(data);
    req.end();
  } catch {
    // Never throw — telemetry must never affect the user experience
  }
}
