import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { opInit, opAnalyze } from "../../src/local/operations.js";
import { runExportCli } from "../../src/local/exportCli.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function freshWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-cliexport-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
  writeFileSync(join(root, "src", "card.ts"), "export function saveCard(){ return 1 }\n");
  const deps = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };
  opInit(root, deps);
  opAnalyze(root, { source: root }, deps);
  return root;
}

describe("export CLI dispatch (both modes)", () => {
  it("--format graph-html writes ONLY the explorer (no pack/markdown)", () => {
    const ws = freshWorkspace();
    const r = runExportCli(ws, { format: "graph-html", out: "g.html" });
    expect(r.mode).toBe("graph_html");
    expect(existsSync(join(ws, "g.html"))).toBe(true);
    expect(existsSync(join(ws, "orangepro-evidence-pack.json"))).toBe(false);
  });

  it("boolean --graph-html writes the pack + markdown + explorer (the P2 fix)", () => {
    const ws = freshWorkspace();
    const r = runExportCli(ws, { out: "pack.json", graph_html: true });
    expect(r.mode).toBe("pack");
    expect(r.valid).toBe(true);
    expect(existsSync(join(ws, "pack.json"))).toBe(true); // pack JSON
    expect(existsSync(join(ws, "pack.md"))).toBe(true); // markdown summary
    expect(existsSync(join(ws, "pack.html"))).toBe(true); // explorer alongside the pack
  });

  it("default export writes pack + markdown, no explorer", () => {
    const ws = freshWorkspace();
    const r = runExportCli(ws, { out: "pack.json" });
    expect(r.mode).toBe("pack");
    expect(existsSync(join(ws, "pack.json"))).toBe(true);
    expect(existsSync(join(ws, "pack.md"))).toBe(true);
    expect(existsSync(join(ws, "pack.html"))).toBe(false);
    expect(r.graph_html_path).toBeUndefined();
  });
});
