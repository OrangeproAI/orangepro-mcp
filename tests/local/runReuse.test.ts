import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { codeKey, computeRunKey, decideReuse, inputsKey, readRunKey, writeRunKey, type RunKey } from "../../src/local/runReuse.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });

function repo(): string {
  const root = mkdtempSync(join(tmpdir(), "opro-reuse-"));
  dirs.push(root);
  const g = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  g("init", "-q");
  g("config", "user.email", "t@example.com");
  g("config", "user.name", "t");
  mkdirSync(join(root, "src"));
  writeFileSync(join(root, "src", "a.ts"), "export const a = 1;\n");
  g("add", "-A");
  g("commit", "-qm", "init");
  return root;
}

const env = { ORANGEPRO_USER_CONFIG: "/definitely/not/here.json" } as NodeJS.ProcessEnv;

describe("run key", () => {
  it("changes with an edit or a new file, but not with OrangePro's own outputs", () => {
    const root = repo();
    const clean = codeKey(root)!;
    expect(codeKey(root)!.key).toBe(clean.key);
    mkdirSync(join(root, ".orangepro"));
    writeFileSync(join(root, ".orangepro", "graph.json"), "{}");
    expect(codeKey(root)!.key).toBe(clean.key);
    writeFileSync(join(root, "src", "a.ts"), "export const a = 2;\n");
    const edited = codeKey(root)!.key;
    expect(edited).not.toBe(clean.key);
    writeFileSync(join(root, "src", "b.ts"), "export const b = 1;\n");
    expect(codeKey(root)!.key).not.toBe(edited);
  });

  it("is null outside git, so a plain folder always runs in full", () => {
    const root = mkdtempSync(join(tmpdir(), "opro-reuse-nogit-"));
    dirs.push(root);
    expect(codeKey(root)).toBeNull();
    expect(computeRunKey({ root, scanRoot: root, flags: {}, providerConfigured: false, env, analysisVersions: ["v"], renderer: "r", tool: "t" })).toBeNull();
  });

  it("changes when coverage, the ledger, a flag or the model-key presence changes", () => {
    const root = repo();
    const base = { root, scanRoot: root, flags: { ai: true }, providerConfigured: false, env };
    const k0 = inputsKey(base);
    writeFileSync(join(root, "coverage.out"), "mode: set\n");
    const k1 = inputsKey(base);
    expect(k1).not.toBe(k0);
    mkdirSync(join(root, ".orangepro"), { recursive: true });
    writeFileSync(join(root, ".orangepro", "ledger.json"), "{\"records\":[]}");
    const k2 = inputsKey(base);
    expect(k2).not.toBe(k1);
    expect(inputsKey({ ...base, flags: { ai: false } })).not.toBe(k2);
    expect(inputsKey({ ...base, providerConfigured: true })).not.toBe(k2);
    expect(inputsKey({ ...base, flags: { ai: true, unused: undefined } })).toBe(k2);
  });

  it("round-trips through .orangepro/run-key.json", () => {
    const root = repo();
    mkdirSync(join(root, ".orangepro"));
    const parts = computeRunKey({ root, scanRoot: root, flags: {}, providerConfigured: false, env, analysisVersions: ["a"], renderer: "r1", tool: "0.2.58" })!;
    const key: RunKey = { ...parts, schema: 1, generated_at: "2026-10-09T03:00:00.000Z", checked_at: "2026-10-09T03:00:00.000Z" };
    writeRunKey(join(root, ".orangepro"), key);
    expect(readRunKey(join(root, ".orangepro"))).toEqual(key);
  });
});

describe("decideReuse", () => {
  const prev: RunKey = { schema: 1, code: "c", inputs: "i", analysis: "a", renderer: "r", tool: "0.2.58", commit: "x", generated_at: "t0", checked_at: "t0" };
  const cur = { code: "c", inputs: "i", analysis: "a", renderer: "r", tool: "0.2.58", commit: "x" };
  const base = { previous: prev, current: cur, outputsPresent: true, generationPending: false };

  it("reuses only when every part matches, and re-renders when only the renderer or tool changed", () => {
    expect(decideReuse(base)).toEqual({ kind: "reuse", rerender: false, previous: prev });
    expect(decideReuse({ ...base, current: { ...cur, renderer: "r2" } })).toMatchObject({ kind: "reuse", rerender: true });
    expect(decideReuse({ ...base, current: { ...cur, tool: "0.2.59" } })).toMatchObject({ kind: "reuse", rerender: true });
  });

  it("names why a full run is needed", () => {
    expect(decideReuse({ ...base, fresh: true })).toMatchObject({ kind: "full", reason: "fresh" });
    expect(decideReuse({ ...base, current: null })).toMatchObject({ kind: "full", reason: "not_git" });
    expect(decideReuse({ ...base, previous: null })).toMatchObject({ kind: "full", reason: "first_run" });
    expect(decideReuse({ ...base, outputsPresent: false })).toMatchObject({ kind: "full", reason: "missing_outputs" });
    expect(decideReuse({ ...base, current: { ...cur, code: "c2" } })).toMatchObject({ kind: "full", reason: "code_changed" });
    expect(decideReuse({ ...base, current: { ...cur, inputs: "i2" } })).toMatchObject({ kind: "full", reason: "inputs_changed" });
    expect(decideReuse({ ...base, current: { ...cur, analysis: "a2" } })).toMatchObject({ kind: "full", reason: "analysis_changed" });
    expect(decideReuse({ ...base, generationPending: true })).toMatchObject({ kind: "full", reason: "generation_pending" });
  });
});
