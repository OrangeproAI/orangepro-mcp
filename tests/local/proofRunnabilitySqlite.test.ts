import { afterEach, beforeAll, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { opAnalyze, opInit, opProveLoop, opRtm } from "../../src/local/operations.js";
import { EXPERIMENTAL_SQLITE_TEST_ENV } from "../../src/local/proofRunnability.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
import { loadGraph, workspacePaths } from "../../src/local/workspace.js";

const require = createRequire(import.meta.url);
const clock = () => "2026-07-03T00:00:00Z";
const NO_ENV = {} as NodeJS.ProcessEnv;

// The fixture genuinely uses node:sqlite. If this Node can't load it in-process (e.g. < 22.5,
// or 22.x/23.x where it needs the flag we can't set on THIS test process), the live proof is
// honest-skipped — the detection + injection WIRING is covered Node-independently elsewhere.
let sqliteWorksFlagless = false;
try {
  require("node:sqlite");
  sqliteWorksFlagless = true;
} catch {
  sqliteWorksFlagless = false;
}

const tempDirs: string[] = [];
beforeAll(async () => {
  await preloadTreeSitter(["typescript"]);
});
afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function makeSqliteWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), "sqlite-proof-"));
  tempDirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "sqlite-fixture", version: "1.0.0", type: "module" }, null, 2), "utf8");
  writeFileSync(
    join(dir, "store.ts"),
    [
      "import { DatabaseSync } from 'node:sqlite';",
      "export function sumViaSqlite(a: number, b: number): number {",
      "  const db = new DatabaseSync(':memory:');",
      "  const row = db.prepare('SELECT ? + ? AS total').get(a, b) as { total: number };",
      "  db.close();",
      "  return row.total;",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );
  writeFileSync(
    join(dir, "store.test.ts"),
    [
      "import { describe, expect, it } from 'vitest';",
      "import { sumViaSqlite } from './store';",
      "describe('sumViaSqlite', () => { it('adds via sqlite', () => { expect(sumViaSqlite(2, 3)).toBe(5); }); });",
      ""
    ].join("\n"),
    "utf8"
  );
  opInit(dir, { clock, env: NO_ENV });
  opAnalyze(dir, { source: dir }, { clock, env: NO_ENV });
  return dir;
}

describe("R-2 integration: node:sqlite fixture proved WITH the injected profile", () => {
  it.skipIf(!sqliteWorksFlagless)(
    "equivalent mutation SURVIVES (falseProofCount 0), killing mutation gives a genuine 0→1",
    () => {
      const W = makeSqliteWorkspace();
      const root = loadGraph(workspacePaths(W).graphPath).workspace.root;
      const target = "sym:store.ts#sumViaSqlite";
      const base = {
        target_symbol: target,
        source: root,
        test_path: "store.test.ts",
        runner: "vitest" as const,
        link_node_modules: true,
        test_env: [EXPERIMENTAL_SQLITE_TEST_ENV]
      };

      expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);

      // An equivalent-value mutation (returns the asserted 5) must SURVIVE — not a proof.
      const survive = opProveLoop(W, { ...base, replacement: "return 5;", run_id: "sqlite-equiv" }, { clock, env: NO_ENV });
      expect("record" in survive && survive.record.closed).toBe(false);
      expect(opRtm(W, { format: "json" }).summary.proven).toBe(0); // falseProofCount 0

      // The sentinel kill (returns -1) makes the assertion fail → genuine dynamic proof.
      const kill = opProveLoop(W, { ...base, replacement: "return -1;", run_id: "sqlite-kill" }, { clock, env: NO_ENV });
      expect("record" in kill && kill.record.closed).toBe(true);
      expect(opRtm(W, { format: "json" }).summary.proven).toBe(1); // 0 → 1
    },
    120_000
  );

  it("reports the runner Node's node:sqlite support so a skip is explicit", () => {
    // Documents WHY the live proof ran or skipped (Node version + flagless availability).
    expect(typeof sqliteWorksFlagless).toBe("boolean");
    // eslint-disable-next-line no-console
    console.info(`[R-2] node ${process.version}: node:sqlite flagless=${sqliteWorksFlagless} → live proof ${sqliteWorksFlagless ? "RAN" : "SKIPPED"}`);
  });
});
