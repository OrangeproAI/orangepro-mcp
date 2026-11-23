import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, afterEach, describe, expect, it } from "vitest";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { heapGuard, runConfirmer } from "../../src/local/analyze/confirm.js";
import { confirmationPartialLine } from "../../src/local/score/coverage.js";
import { sinceHtml } from "../../src/local/viz/summaryReport.js";
import type { ReportModel } from "../../src/local/viz/reportModel.js";

const dirs: string[] = [];
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});
const ENV = ["ORANGEPRO_MAX_CONFIRM_FILES", "ORANGEPRO_CONFIRM_HEAP_FRACTION", "ORANGEPRO_CONFIRM_RISK_SYMBOLS"] as const;
const saved = ENV.map((k) => process.env[k]);
afterEach(() => ENV.forEach((k, i) => (saved[i] === undefined ? delete process.env[k] : (process.env[k] = saved[i]))));

function project(count: number): string {
  const root = mkdtempSync(path.join(tmpdir(), "opro-partial-"));
  dirs.push(root);
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "p", version: "1.0.0" }));
  for (let i = 0; i < count; i++) {
    writeFileSync(path.join(root, `f${i}.ts`), `export function handle${i}(a: number): number { return a > ${i} ? a : ${i}; }\n`);
    writeFileSync(path.join(root, `f${i}.test.ts`), `import { handle${i} } from "./f${i}";\ntest("h", () => { expect(handle${i}(1)).toBe(1); });\n`);
  }
  return root;
}
const links = (g: ReturnType<typeof analyzeRepo>) => g.edges.filter((e) => e.relationship_type === "COVERS").length;

describe("test-link confirmation", () => {
  it("has no default file limit, and a complete run says nothing about partial", () => {
    delete process.env.ORANGEPRO_MAX_CONFIRM_FILES;
    const g = analyzeRepo(project(4), { readContent: true });
    expect(links(g)).toBe(4);
    expect(g.analysis.confirmed_coverage?.partial).toBeUndefined();
    expect(g.analysis.confirmed_coverage?.skipped_files_limit).toBe(0);
    expect(g.warnings.join("\n")).not.toContain("partial:");
  });

  it("an explicit limit reports N of M and keeps what it confirmed", () => {
    process.env.ORANGEPRO_MAX_CONFIRM_FILES = "2";
    const g = analyzeRepo(project(4), { readContent: true });
    const p = g.analysis.confirmed_coverage?.partial;
    expect(p).toEqual({ confirmed_functions: 1, total_functions: 4, reason: "file_limit" });
    expect(links(g)).toBe(1);
    expect(g.warnings).toContain(confirmationPartialLine(p!));
    expect(confirmationPartialLine(p!)).toContain("partial: test links confirmed for 1 of 4 functions");
  });

  it("the memory guard ends the run without a crash and says so", () => {
    process.env.ORANGEPRO_CONFIRM_HEAP_FRACTION = "0.000001";
    const g = analyzeRepo(project(3), { readContent: true });
    expect(g.analysis.confirmed_coverage?.partial).toEqual({ confirmed_functions: 0, total_functions: 3, reason: "memory" });
    expect(g.warnings.join("\n")).toContain("partial: test links confirmed for 0 of 3 functions (the run neared its memory limit)");
  });

  it("a stop part way keeps the links found before it", () => {
    const root = project(3);
    const candidates = [0, 1, 2].map((i) => ({ testRel: `f${i}.test.ts`, testAbs: path.join(root, `f${i}.test.ts`), implRel: `f${i}.ts`, implAbs: path.join(root, `f${i}.ts`) }));
    let asked = 0;
    const r = runConfirmer({
      candidates,
      symbolsByImpl: new Map(candidates.map((c, i) => [c.implRel, [`handle${i}`]])),
      existingSymIds: new Set(candidates.map((c, i) => `sym:${c.implRel}#handle${i}`)),
      anchorFile: root,
      shouldStop: () => asked++ === 2
    });
    expect(r).toMatchObject({ completed: 2, stopped: true });
    expect(r.confirmations.map((c) => c.behaviorName)).toEqual(["handle0", "handle1"]);
  });

  it("the guard stays quiet at a normal heap", () => {
    expect(heapGuard(0.999)()).toBe(false);
  });

  it("both reports share the line, and it is absent on a complete run", () => {
    const base = { since: { kind: "first", text: "First run." } } as unknown as ReportModel;
    expect(sinceHtml(base)).not.toContain("partial:");
    const text = confirmationPartialLine({ confirmed_functions: 3, total_functions: 9, reason: "memory" });
    expect(sinceHtml({ ...base, confirmationPartial: { confirmed: 3, total: 9, text } })).toContain("partial: test links confirmed for 3 of 9 functions");
  });
});
