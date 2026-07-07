import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-verified-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("last_verified on hard proof edges", () => {
  it("stamps analyzer-emitted TESTED_BY/COVERS edges with the analysis timestamp", () => {
    const verifiedAt = 1_712_345_678_000;
    const root = repo({
      "src/impl.ts": "export function saveUser() { return 'ok'; }\n",
      "tests/impl.test.ts": "import { saveUser } from '../src/impl';\nit('saves user', () => { expect(saveUser()).toBe('ok'); });\n"
    });

    const frag = analyzeRepo(root, { readContent: true, now: () => verifiedAt });
    const proofEdges = frag.edges.filter((e) => e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS");

    expect(proofEdges.map((e) => e.relationship_type).sort()).toEqual(["COVERS", "TESTED_BY"]);
    expect(proofEdges.every((e) => e.evidence_strength === "hard")).toBe(true);
    expect(proofEdges.every((e) => e.last_verified === verifiedAt)).toBe(true);
  });
});
