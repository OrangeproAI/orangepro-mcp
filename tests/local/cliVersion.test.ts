import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const VERSION = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")).version as string;
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");

describe("CLI version", () => {
  for (const flag of ["--version", "-v", "version"]) {
    it(`${flag} prints the package version and exits without starting analysis`, () => {
      const cwd = mkdtempSync(join(tmpdir(), "opro-version-"));
      const result = spawnSync(process.execPath, ["--import", TSX_LOADER, join(ROOT, "src/local/cli.ts"), flag], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, NODE_NO_WARNINGS: "1" }
      });
      expect(result.status).toBe(0);
      expect(result.stdout.trim()).toBe(VERSION);
      expect(result.stderr).toBe("");
    });
  }
});
