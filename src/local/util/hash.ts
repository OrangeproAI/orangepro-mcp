import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

/** Content hash with the `sha256:` prefix used across graph + pack provenance. */
export function hashString(input: string): string {
  return "sha256:" + createHash("sha256").update(input).digest("hex");
}

export function hashBuffer(buf: Buffer): string {
  return "sha256:" + createHash("sha256").update(buf).digest("hex");
}

export function hashFile(absPath: string): string {
  return hashBuffer(readFileSync(absPath));
}

/** Short, stable, non-reversible digest for deriving node ids. */
export function shortHash(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 12);
}
