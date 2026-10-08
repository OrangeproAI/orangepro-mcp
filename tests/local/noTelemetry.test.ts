import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// The local tool sends nothing about a run anywhere. Model calls happen only when
// the user configures a provider key; feedback is a link the user chooses to open.
const NETWORK_REPORTING = [/telemetry\.orangepro\.ai/i, /pingTelemetry/, /\/v1\/ping\b/, /DO_NOT_TRACK/];

function shipped(dir: string): string[] {
  try {
    return readdirSync(dir).flatMap((name) => {
      const full = join(dir, name);
      if (name === "node_modules" || name === "dist") return [];
      if (statSync(full).isDirectory()) return shipped(full);
      return /\.(ts|mjs|js|json)$/.test(name) ? [full] : [];
    });
  } catch {
    return [];
  }
}

describe("no usage reporting in shipped code", () => {
  it("src/ and packages/ contain no telemetry endpoint or ping code", () => {
    const root = join(__dirname, "..", "..");
    const hits: string[] = [];
    for (const file of [...shipped(join(root, "src")), ...shipped(join(root, "packages"))]) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        if (NETWORK_REPORTING.some((re) => re.test(line))) hits.push(`${file.slice(root.length + 1)}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
