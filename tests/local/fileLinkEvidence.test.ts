import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalGraph } from "../../src/local/graph/ontology.js";
import { opStart } from "../../src/local/operations.js";
import type { RiskGap } from "../../src/local/score/risk.js";
import type { ReportModel } from "../../src/local/viz/reportModel.js";
import { buildWorklist } from "../../src/local/viz/worklist.js";

const deps = { clock: () => "2026-10-30T00:00:00Z", env: {} as NodeJS.ProcessEnv };
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "opro-file-link-"));
  dirs.push(dir);
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), text);
  }
  const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: "ignore" });
  git("init", "-q");
  git("config", "user.email", "t@example.com");
  git("config", "user.name", "t");
  git("add", "-A");
  git("commit", "-qm", "fixture");
  return dir;
}

/** The "Evidence today" and "What to do" cells of each function's first tests.csv row. */
function csvCells(csv: string): Map<string, { evidence: string; todo: string }> {
  const lines = csv.replace(/^﻿/, "").trim().split("\r\n");
  const header = lines[0]!.split(",");
  const at = (name: string) => header.indexOf(name);
  const out = new Map<string, { evidence: string; todo: string }>();
  for (const line of lines.slice(1)) {
    // These fixture rows hold no quoted commas in the columns read here.
    const cells = line.match(/("([^"]|"")*"|[^,]*)(,|$)/g)!.map((c) => c.replace(/,$/, "").replace(/^"|"$/g, "").replace(/""/g, "\""));
    const fn = cells[at("Function")]!;
    if (!out.has(fn)) out.set(fn, { evidence: cells[at("Evidence today")]!, todo: cells[at("What to do")]! });
  }
  return out;
}

describe("a test linked to the whole file", () => {
  it("says so in tests.csv and the detailed report, as the trace matrix does", async () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "billing", version: "1.0.0", devDependencies: { vitest: "3.2.7" } }),
      "src/billing/charge.ts": [
        "export class Checkout {",
        "  chargeOrder(total: number, tier: string): number {",
        "    if (tier === 'gold') return total * 0.8;",
        "    return total > 100 ? total * 0.95 : total;",
        "  }",
        "}",
        ""
      ].join("\n"),
      "src/billing/refund.ts": [
        "export function refundOrder(paid: number, used: number): number {",
        "  return used >= paid ? 0 : paid - used;",
        "}",
        ""
      ].join("\n"),
      // Imports the module but never calls chargeOrder: a file-level candidate link only.
      "test/smoke.test.ts": [
        "import { describe, expect, it } from 'vitest';",
        "import { Checkout } from '../src/billing/charge';",
        "",
        "describe('billing module', () => {",
        "  it('loads', () => { expect(typeof Checkout).toBe('function'); });",
        "});",
        ""
      ].join("\n")
    });
    await opStart(dir, { source: dir, ai: false, noAuto: true }, deps);
    const read = (name: string) => readFileSync(join(dir, ".orangepro", name), "utf8");
    const model = JSON.parse(read("report-data.json")) as ReportModel;
    const rtm = read("rtm.md");
    const cells = csvCells(read("tests.csv"));
    const row = (title: string) => model.worklist.find((w) => w.title === title);

    expect(rtm).toMatch(/\| Checkout\.chargeOrder \| sym:src\/billing\/charge\.ts#Checkout\.chargeOrder \|[^\n]*\| Candidate signal \(unconfirmed\) \|/);
    expect(rtm).toMatch(/\| refundOrder \|[^\n]*\| No integration signal \|/);

    expect(row("Checkout.chargeOrder")).toMatchObject({ evidence: "none", verb: "write", fileLink: "test/smoke.test.ts", reason: "No test calls it. test/smoke.test.ts imports its file; read it first." });
    expect(row("refundOrder")?.fileLink).toBeUndefined();
    expect(row("refundOrder")?.reason).toBe("No test points here.");

    expect(cells.get("Checkout.chargeOrder")).toEqual({ evidence: "Candidate link only, not confirmed", todo: "Write: No test calls it. test/smoke.test.ts imports its file; read it first." });
    expect(cells.get("refundOrder")).toEqual({ evidence: "No test found", todo: "Write: No test points here." });

    // Score and evidence counts do not move: the row only names the link.
    expect(model.counts.evidence.unconfirmed).toBe(1);
    expect(read("behavior-coverage.html")).toContain("\"fileLink\":\"Candidate link only, not confirmed\"");
  });

  it("leaves Go, Python and Java rows as they are", () => {
    const graph = {
      nodes: [{ kind: "CodeSymbol", external_id: "sym:pkg/task.go#Run", title: "Run", properties: { file: "pkg/task.go", start_line: 3 } }],
      edges: [],
      candidate_edges: [{ id: "c1", from_external_id: "pkg/task_test.go", to_external_id: "pkg/task.go", relationship_type: "MAY_RELATE_TO", evidence_strength: "weak", reason: "Go test file sibling", confidence: 0.9 }]
    } as unknown as LocalGraph;
    const gap = { id: "sym:pkg/task.go#Run", title: "Run", file: "pkg/task.go", risk_score: 10, detection_tier: "none", git_churn: 0, incoming_refs: 0 } as unknown as RiskGap;
    const [item] = buildWorklist(graph, { records: [] } as never, [gap], { provenIds: new Set(), churnWindowDays: 180, slotRows: 0 });
    expect(item?.fileLink).toBeUndefined();
    expect(item?.reason).toBe("No test points here.");
  });
});
