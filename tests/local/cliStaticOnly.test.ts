import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { afterAll, describe, expect, it } from "vitest";

// Item 34, through the real CLI: a budget of 0 is 0 (it used to fall back to the default),
// and --static-only reaches the run.

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const TSX_LOADER = createRequire(import.meta.url).resolve("tsx");
const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function fixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "opro-cli-static-"));
  dirs.push(dir);
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cli-fixture", version: "1.0.0", type: "module" }));
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "price.js"), "export function applyDiscount(total, pct) {\n  if (pct > 50) throw new Error('too much');\n  return total - (total * pct) / 100;\n}\n");
  return dir;
}

function start(cwd: string, args: string[], env: NodeJS.ProcessEnv = {}): Record<string, any> {
  const result = spawnSync(process.execPath, ["--import", TSX_LOADER, join(ROOT, "src/local/cli.ts"), "start", ".", "--json", "--no-ai-flows", ...args], {
    cwd,
    encoding: "utf8",
    env: { PATH: process.env.PATH, HOME: process.env.HOME, NODE_NO_WARNINGS: "1", ORANGEPRO_FEEDBACK_PREFS: join(cwd, "prefs.json"), ...env },
    timeout: 120_000
  });
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

describe("opro start budgets and --static-only", () => {
  it("--proof-limit 0 and --generate-limit 0 mean none", () => {
    const res = start(fixture(), ["--proof-limit", "0", "--generate-limit", "0", "--provider", "deterministic"], { ORANGEPRO_ALLOW_DETERMINISTIC: "1" });
    expect(res.auto_prove.status).toBe("disabled");
    expect(res.auto_prove.reason).toContain("--proof-limit 0");
    expect(res.generation.status).toBe("disabled");
    expect(res.generation.requested).toBe(0);
  }, 120_000);

  it("--static-only turns proof off and still drafts", () => {
    const res = start(fixture(), ["--static-only", "--generate-limit", "1", "--provider", "deterministic"], { ORANGEPRO_ALLOW_DETERMINISTIC: "1" });
    expect(res.auto_prove.status).toBe("disabled");
    expect(res.auto_prove.reason).toContain("static-only");
    expect(res.generation.requested).toBe(1);
  }, 120_000);
});
