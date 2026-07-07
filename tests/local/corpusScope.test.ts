import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { summarizeCorpusScope } from "../../src/local/corpusScope.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "op-scope-"));
  tempDirs.push(dir);
  return dir;
}

function writeMany(root: string, dir: string, count: number, ext = ".ts"): void {
  mkdirSync(join(root, dir), { recursive: true });
  for (let i = 0; i < count; i++) {
    writeFileSync(join(root, dir, `file-${i}${ext}`), "export const value = 1;\n", "utf8");
  }
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("corpus scope preflight", () => {
  it("flags large repos and ranks focused scopes without counting generated dirs", () => {
    const root = makeTempDir();
    writeMany(root, "webapp/channels", 7);
    writeMany(root, "server/public", 4, ".go");
    writeMany(root, "server/private", 3, ".go");
    writeMany(root, "tools", 1, ".go");
    writeMany(root, "node_modules/pkg", 20);
    writeMany(root, ".orangepro", 20);

    const scope = summarizeCorpusScope(root, { largeFileThreshold: 5, largeScopeThreshold: 6 });

    expect(scope.is_large).toBe(true);
    expect(scope.files).toBe(15);
    expect(scope.top_level.map((entry) => [entry.path, entry.files])).toEqual([
      ["server", 7],
      ["webapp", 7],
      ["tools", 1]
    ]);
    expect(scope.top_level.find((entry) => entry.path === "server")?.children).toEqual([
      { path: "server/private", files: 3 },
      { path: "server/public", files: 4 }
    ].sort((a, b) => b.files - a.files || a.path.localeCompare(b.path)));
    expect(scope.suggested_scopes.map((entry) => entry.path)).toContain("webapp");
    expect(scope.guidance.join(" ")).toContain("focused subdirectory");
  });
});
