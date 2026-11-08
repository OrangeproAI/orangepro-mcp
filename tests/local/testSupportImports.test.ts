import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { LocalGraph } from "../../src/local/graph/ontology.js";
import { opStart } from "../../src/local/operations.js";
import { importsTestFramework } from "../../src/local/score/rankEligibility.js";
import { rankRiskGaps } from "../../src/local/score/risk.js";
import type { ReportModel } from "../../src/local/viz/reportModel.js";

const deps = { clock: () => "2026-10-30T00:00:00Z", env: {} as NodeJS.ProcessEnv };
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });

function repo(files: Record<string, string>): string {
  const dir = mkdtempSync(join(tmpdir(), "opro-test-support-"));
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

async function run(dir: string): Promise<{ graph: LocalGraph; model: ReportModel; csv: string; summary: string; detailed: string }> {
  await opStart(dir, { source: dir, ai: false, noAuto: true }, deps);
  const read = (name: string) => readFileSync(join(dir, ".orangepro", name), "utf8");
  return {
    graph: JSON.parse(read("graph.json")) as LocalGraph,
    model: JSON.parse(read("report-data.json")) as ReportModel,
    csv: read("tests.csv"),
    summary: read("short_behavior-coverage.html"),
    detailed: read("behavior-coverage.html")
  };
}

const PRICING = [
  "export function chargeOrder(total: number, tier: string): number {",
  "  if (tier === 'gold') return total * 0.2;",
  "  if (total > 100) return total * 0.05;",
  "  return 0;",
  "}",
  ""
].join("\n");

/** A Playwright e2e repo: page objects, `test.extend` fixtures, a spec, and one product file. */
const PLAYWRIGHT_REPO: Record<string, string> = {
  "package.json": JSON.stringify({ name: "e2e-demo", version: "1.0.0", devDependencies: { "@playwright/test": "1.50.0" } }),
  "pom/BasePage.ts": [
    "import { Page, expect } from '@playwright/test';",
    "",
    "export class BasePage {",
    "  constructor(protected page: Page) {}",
    "  async getCurrentUrl(): Promise<string> {",
    "    const url = this.page.url();",
    "    return url.includes('?') ? url.split('?')[0] : url;",
    "  }",
    "  async expectTitle(title: string): Promise<void> {",
    "    await expect(this.page).toHaveTitle(title);",
    "  }",
    "}",
    ""
  ].join("\n"),
  "pom/LeavePage.ts": [
    "import { Page } from '@playwright/test';",
    "import { BasePage } from './BasePage';",
    "",
    "export class LeavePage extends BasePage {",
    "  constructor(page: Page) { super(page); }",
    "  async createLeaveRequest(days: number): Promise<string> {",
    "    if (days <= 0) throw new Error('days must be positive');",
    "    await this.page.fill('#days', String(days));",
    "    return days > 5 ? 'needs review' : 'approved';",
    "  }",
    "}",
    ""
  ].join("\n"),
  "support/test.ts": [
    "import { test as base } from '@playwright/test';",
    "import { LeavePage } from '../pom/LeavePage';",
    "",
    "export const test = base.extend<{ leavePage: LeavePage }>({",
    "  leavePage: async ({ page }, use) => { await use(new LeavePage(page)); }",
    "});",
    "",
    "export function validateLeaveDays(start: number, end: number): number {",
    "  return end >= start ? end - start + 1 : 0;",
    "}",
    ""
  ].join("\n"),
  "e2e/leave.spec.ts": [
    "import { expect } from '@playwright/test';",
    "import { test } from '../support/test';",
    "",
    "test('applies leave', async ({ leavePage }) => {",
    "  expect(await leavePage.createLeaveRequest(2)).toBe('approved');",
    "  expect(await leavePage.getCurrentUrl()).toContain('leave');",
    "});",
    ""
  ].join("\n"),
  "src/billing/charge.ts": PRICING
};

describe("test support recognized by its imports", () => {
  it("reads real imports only", () => {
    expect(importsTestFramework("import { Page } from '@playwright/test';")).toBe(true);
    expect(importsTestFramework("import type { Page } from \"@playwright/test\";")).toBe(true);
    expect(importsTestFramework("import { test } from 'playwright/test';")).toBe(true);
    expect(importsTestFramework("const { jest } = require('@jest/globals');")).toBe(true);
    expect(importsTestFramework("export { expect } from 'vitest';")).toBe(true);
    expect(importsTestFramework("const c = await import('cypress');")).toBe(true);
    expect(importsTestFramework("import http from 'k6/http';\nimport { check } from 'k6';")).toBe(true);
    expect(importsTestFramework("import { chromium } from 'playwright';")).toBe(false);
    expect(importsTestFramework("import { defineConfig } from 'vitest/config';")).toBe(false);
    expect(importsTestFramework("// import { test } from '@playwright/test';\nexport const a = 1;")).toBe(false);
    expect(importsTestFramework("export const name = \"@playwright/test\";")).toBe(false);
    expect(importsTestFramework("import { k6 } from './k6';")).toBe(false);
  });

  it("keeps page objects and fixtures mapped and counted, out of the worklist, with no other score moved", async () => {
    const dir = repo(PLAYWRIGHT_REPO);
    const { graph, model, csv, summary, detailed } = await run(dir);
    const node = (id: string) => graph.nodes.find((n) => n.external_id === id);

    const support = graph.nodes.filter((n) => n.kind === "CodeSymbol" && n.denominator_eligible === true && n.properties.ranking_exclusion_reason_code === "test_support_helper");
    const supportIds = support.map((n) => n.external_id);
    expect(supportIds).toContain("sym:pom/BasePage.ts#BasePage.getCurrentUrl");
    expect(supportIds.some((id) => id.startsWith("sym:pom/LeavePage.ts#"))).toBe(true);
    expect(node("sym:pom/BasePage.ts#BasePage.getCurrentUrl")?.properties.ranking_exclusion_reason).toContain("imports a test framework");
    expect(node("sym:src/billing/charge.ts#chargeOrder")?.properties.ranking_exclusion_reason_code).toBeUndefined();

    const ranked = model.worklist.map((w) => w.id);
    expect(ranked[0]).toBe("sym:src/billing/charge.ts#chargeOrder");
    for (const id of supportIds) expect(ranked).not.toContain(id);
    expect(csv).not.toContain("getCurrentUrl");

    // Taken out after scoring: the product function scores exactly as when the helpers compete.
    const unmarked = structuredClone(graph);
    for (const n of unmarked.nodes) delete n.properties.ranking_exclusion_reason_code;
    const all = rankRiskGaps(unmarked, { repoRoot: dir, limit: 1000, includeAssociated: true });
    const kept = rankRiskGaps(graph, { repoRoot: dir, limit: 1000, includeAssociated: true });
    expect(kept.map((g) => g.id)).toEqual(["sym:src/billing/charge.ts#chargeOrder"]);
    expect(all.find((g) => g.id === "sym:src/billing/charge.ts#chargeOrder")?.risk_score).toBe(kept[0]?.risk_score);
    expect(all.length).toBeGreaterThan(kept.length);

    const counted = graph.nodes.filter((n) => n.kind === "CodeSymbol" && n.denominator_eligible === true && !n.stale).length;
    expect(model.testSupport).toEqual({
      count: support.length,
      counted,
      text: `Most functions OrangePro counted here (${support.length} of ${counted}) are test support: page objects, fixtures and helpers that import a test framework. They stay mapped but are left out of the worklist. The application code they test may not be in this repository.`
    });
    expect(summary).toContain(`Most functions OrangePro counted here (${support.length} of ${counted}) are test support`);
    expect(detailed).toContain(`Most functions OrangePro counted here (${support.length} of ${counted}) are test support`);
  });

  it("never calls an all-test-support repository proven", async () => {
    const files = Object.fromEntries(Object.entries(PLAYWRIGHT_REPO).filter(([path]) => path !== "src/billing/charge.ts"));
    const { model, summary } = await run(repo(files));
    expect(model.worklist).toEqual([]);
    expect(model.counts.proven).toBe(0);
    expect(summary).toContain("Nothing to rank: the functions counted here are test support.");
    expect(summary).not.toContain("is proven. Nothing is left on the worklist.");
  });

  it("leaves a product file that drives plain playwright ranked, with no report line", async () => {
    const dir = repo({
      "package.json": JSON.stringify({ name: "capture", version: "1.0.0", dependencies: { playwright: "1.50.0" } }),
      "src/capture.ts": [
        "import { chromium } from 'playwright';",
        "",
        "export async function captureTitle(url: string): Promise<string> {",
        "  const browser = await chromium.launch();",
        "  const page = await browser.newPage();",
        "  await page.goto(url);",
        "  const title = (await page.title()).trim();",
        "  await browser.close();",
        "  return title.length > 0 ? title : 'untitled';",
        "}",
        ""
      ].join("\n"),
      "src/billing/charge.ts": PRICING
    });
    const { graph, model, summary } = await run(dir);
    expect(graph.nodes.find((n) => n.external_id === "sym:src/capture.ts#captureTitle")?.properties.ranking_exclusion_reason_code).toBeUndefined();
    expect(model.worklist.map((w) => w.id)).toContain("sym:src/capture.ts#captureTitle");
    expect(model.testSupport).toBeUndefined();
    expect(summary).not.toContain("are test support");
  });
});
