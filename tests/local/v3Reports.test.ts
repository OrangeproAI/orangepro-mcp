import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { workflowYaml } from "../../src/local/actionsInstall.js";
import { repositoryName, summaryHtml } from "../../src/local/exportTests.js";
import { opAnalyze, opBehaviorCoverageHtml, opInit } from "../../src/local/operations.js";
import type { ReportModel } from "../../src/local/viz/reportModel.js";
import { EXPORT_RUN, proofRunFixture } from "./support/proofRunFixture.js";

const deps = { clock: () => "2026-11-08T00:00:00Z", env: {} as NodeJS.ProcessEnv };

function modelIn(html: string): ReportModel {
  const m = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("no report data in the page");
  return JSON.parse(m[1]!);
}

function reportsFor(repo: string): { model: ReportModel; summary: string } {
  const out = opBehaviorCoverageHtml(repo, ".orangepro/behavior-coverage.html", undefined, { persistBaseline: false });
  return { model: modelIn(readFileSync(out.behavior_coverage_path, "utf8")), summary: readFileSync(out.short_report_path!, "utf8") };
}

describe("V3 reports: a verified gap is the row's patch status, never a tier", () => {
  it("adds the patch status to the row and the summary; tiers, verbs and counts stay as they were", () => {
    const f = proofRunFixture();
    writeFileSync(join(f.repo, "package.json"), JSON.stringify({ name: "round", version: "1.0.0", main: "lib/round.js" }));
    opInit(f.repo, deps);
    opAnalyze(f.repo, { source: f.repo }, deps);
    const withRuns = reportsFor(f.repo);
    renameSync(f.runs, `${f.runs}-aside`);
    const without = reportsFor(f.repo);
    renameSync(`${f.runs}-aside`, f.runs);

    expect(without.model.patches).toBeUndefined();
    expect(withRuns.model.patches?.line).toBe("1 verified test patch, not merged.");
    expect(withRuns.model.patches?.rows[0]).toMatchObject({ id: "sym:lib/round.js#round", label: "Verified test patch (not merged)", page: `proof-runs/${EXPORT_RUN}/summary.html` });
    // The five tier counts, Proven and every row's evidence and verb are untouched.
    expect(withRuns.model.counts).toEqual(without.model.counts);
    expect(withRuns.model.top).toEqual(without.model.top);
    const strip = (m: ReportModel) => m.worklist.map(({ patch: _p, ...rest }) => rest);
    expect(strip(withRuns.model)).toEqual(strip(without.model));
    const row = withRuns.model.worklist.find((w) => w.id === "sym:lib/round.js#round");
    if (row) expect(row.patch?.label).toBe("Verified test patch (not merged)");
    expect(withRuns.summary).toContain("<b>Test patches.</b> 1 verified test patch, not merged.");
    expect(withRuns.summary).toContain(`href="proof-runs/${EXPORT_RUN}/orangepro-tests.patch"`);
    expect(withRuns.model.run.proofs.find((r) => r.k === "Test patches")?.v).toContain("Verified test patch (not merged)");
  });
});

describe("V3 summary.html fixes", () => {
  it("names the repository from origin.upstream (or the fork), links it, and states the expected behavior once", () => {
    expect(repositoryName({ upstream: "https://github.com/expressjs/express", fork: null })).toBe("github.com/expressjs/express");
    expect(repositoryName({ upstream: "https://github.com/expressjs/express", fork: "https://github.com/OrangeproAI/express" })).toBe("github.com/OrangeproAI/express");
    const behavior = "When maxAge is 1,500 ms, Max-Age is 1 (whole seconds, rounded down).";
    const receipt = {
      tool: { version: "0.0.0" },
      source: { repository: "github.com/expressjs/express", merged_commit: "246f6f5aeebad1b9d6a0ea08cd96d3fe19f8f23c", previous_base: "b11122be85377375465b2aa103da43301e56f128", pr_number: 6091 },
      selection: { symbol_id: "sym:lib/response.js#res.cookie", assisted: true },
      generation: { by: "agent", agent: "a coding agent" },
      classification: { fault: "verified_gap" },
      rows: [],
      limitations: [],
      stages: []
    } as never;
    const run = { classification: { statement: "The selected tests missed it." }, oracle: { behavior, expected: "Max-Age=1 for 1,500 ms" }, fixtureBytes: Buffer.from(JSON.stringify({ origin: { upstream: "https://github.com/expressjs/express", fork: null } })) } as never;
    const html = summaryHtml(receipt, "diff", "The new test fails at its assertion.", run);
    expect(html).toContain('<a href="https://github.com/expressjs/express" target="_blank" rel="noopener noreferrer">github.com/expressjs/express</a>');
    expect(html).toContain('href="https://github.com/expressjs/express/commit/246f6f5aeebad1b9d6a0ea08cd96d3fe19f8f23c"');
    expect(html).toContain('href="https://github.com/expressjs/express/pull/6091"');
    expect(html).not.toContain("repository at");
    expect(html.split(behavior).length - 1).toBe(1);
    expect(html).toContain("What it checks: Max-Age=1 for 1,500 ms.");
  });
});

describe("V3 installer: the deliver job is opt-in and the only one that can write", () => {
  it("without deliver the workflow is as before; with it, write permissions sit in deliver only, and deliver checks out nothing", () => {
    const plain = workflowYaml({ base: "master", version: "0.2.61-demo.1", totalMinutes: 20 });
    const withDeliver = workflowYaml({ base: "master", version: "0.2.61-demo.1", totalMinutes: 20, deliver: true });
    expect(plain).not.toMatch(/deliver:|write|publish-tests/);
    const body = (t: string) => t.slice(t.indexOf("\n") + 1);
    expect(body(withDeliver).startsWith(body(plain).trimEnd())).toBe(true); // prove is unchanged; deliver is appended
    const deliver = withDeliver.slice(withDeliver.indexOf("  deliver:"));
    expect(deliver).toContain("contents: write");
    expect(deliver).toContain("pull-requests: write");
    expect(deliver).not.toContain("actions/checkout");
    expect(deliver).toContain("actions/download-artifact@9000827ccba6bdab643e8b6fd33ac0654aef8333 # v8.0.2");
    expect(deliver).toContain('publish-tests --from-actions "$RUNNER_TEMP/orangepro-in" --repo "$GITHUB_REPOSITORY" --base "master" --merged "$MERGED_SHA" --yes');
    expect(withDeliver.slice(0, withDeliver.indexOf("  deliver:"))).not.toContain("write");
  });
});
