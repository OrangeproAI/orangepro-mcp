import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { opAnalyze, opBehaviorCoverageHtml, opInit, writeReports } from "../../src/local/operations.js";
import { distillProofAttempts } from "../../src/local/proofDoctor.js";
import { BY_HAND_SOURCES, byHandCounts, byHandHours, byHandSentences, type ByHandAttempt, type ByHandRun } from "../../src/local/viz/byHand.js";
import { renderSummaryReport } from "../../src/local/viz/summaryReport.js";
import { REPORT_DATA_VERSION, REPORT_RENDERER_VERSION, type ReportModel } from "../../src/local/viz/reportModel.js";
import { esc, platformLink } from "../../src/local/viz/reportTheme.js";
import { proofRunFixture } from "./support/proofRunFixture.js";

const deps = { clock: () => "2026-11-16T00:00:00Z", env: {} as NodeJS.ProcessEnv };
const NOUN = { singular: "function", plural: "functions" };

function modelIn(html: string): ReportModel {
  const m = /<script type="application\/json" id="report-data">([\s\S]*?)<\/script>/.exec(html);
  if (!m) throw new Error("no report data in the page");
  return JSON.parse(m[1]!);
}

/** Visible text only: tags, the embedded data and the scripts removed. */
function textOf(html: string): string {
  return html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
}

// Every kind of attempt one start run can hold, with the count each one should land in.
const ATTEMPTS: ByHandAttempt[] = [
  { target_symbol: "f1", test_path: "orangepro_generated/f1.test.js", test_source: "written", classification: "proven" }, // written + proven
  { target_symbol: "f2", test_path: "orangepro_generated/f2.test.js", test_source: "written", classification: "non_killing", mutant_status: "associated_survived" }, // written, never "found"
  { target_symbol: "f3", test_path: "orangepro_generated/f3.test.js", test_source: "written", classification: "gen_failed" }, // a draft to finish
  { target_symbol: "f4", test_path: "orangepro_generated/f4.test.js", test_source: "written", classification: "needs_setup", category: "timeout" } as ByHandAttempt, // a draft to finish
  { target_symbol: "f5", test_path: "test/f5.test.js", test_source: "found", classification: "proven" }, // proven
  { target_symbol: "f6", test_path: "test/f6.test.js", test_source: "found", classification: "non_killing", mutant_status: "associated_survived" }, // doesn't catch a break
  { target_symbol: "f6", test_path: "test/f6.test.js", test_source: "found", classification: "non_killing", mutant_status: "associated_survived" }, // the same pair again: still one
  { target_symbol: "f9", test_path: "test/f9.test.js", test_source: "found", classification: "non_killing", mutant_status: "non_killing" }, // failed off its assertion: not confirmed
  { target_symbol: "f10", test_path: "test/f10.test.js", test_source: "found", classification: "needs_setup" }, // could not run: nothing
  { target_symbol: "f7", test_path: "test/f7.test.js", classification: "non_killing", mutant_status: "associated_survived" }, // an old record: read as found
  { target_symbol: "f8", test_path: "test/f8.test.js", classification: "proven" }, // an old record, proven
  { target_symbol: "f11", test_path: "", classification: "needs_setup", deduped: true } // never re-run: ignored
];
const RUN: ByHandRun = { attempts: ATTEMPTS, drafts: 30, staticOnly: false };

describe("item 48: the By hand counts", () => {
  it("counts each item from its own source, once", () => {
    // written: f1, f2; drafts: 30 + f3 + f4; proven: f1, f5, f8; weak: f6, f7
    expect(byHandCounts(RUN)).toEqual({ written: 2, drafts: 32, proven: 3, weak: 2, minutes: 2 * 10 + 32 * 5 + 3 * 5 + 2 * 15, staticOnly: false });
  });

  it("static-only: drafts are drafts to finish, nothing is written-and-passing or proven", () => {
    expect(byHandCounts({ attempts: [], drafts: 40, staticOnly: true })).toEqual({ written: 0, drafts: 40, proven: 0, weak: 0, minutes: 200, staticOnly: true });
    const forced = byHandCounts({ ...RUN, staticOnly: true });
    expect(forced.written).toBe(0);
    expect(forced.proven).toBe(0);
  });

  it("hours to one decimal, never 0.0 when something counts", () => {
    expect(byHandHours(225)).toBe("3.8");
    expect(byHandHours(1)).toBe("0.1");
    expect(byHandHours(60)).toBe("1.0");
  });

  it("prints the owner's sentences, the assumptions and the sources", () => {
    const s = byHandSentences({ run: byHandCounts(RUN), notCounted: { functions: 40, testFiles: 12 } }, NOUN);
    expect(s).toEqual([
      "Done by this run: 2 tests written and passing, 32 drafts to finish, 3 functions proven, 2 tests found that don't catch a break. By hand, about 3.8 engineer-hours.",
      "Assumes 10 minutes per test written and passing, 5 per draft to finish, 5 per function proven and 15 per test found that doesn't catch a break.",
      "Estimates from published studies of developers writing tests (Fraser et al. 2015; Petrović et al. 2018; Schuler & Zeller 2013); tests that go through a real request usually take longer.",
      "Not counted: mapping 40 functions to 12 test files and ranking them."
    ]);
    expect(s[2]).toBe(BY_HAND_SOURCES);
    for (const line of s) {
      expect(line.toLowerCase()).not.toContain("unit test");
      expect(line.toLowerCase()).not.toContain("saved");
    }
  });

  it("hides zero items, and singular counts read as one", () => {
    const one = byHandSentences({ run: { written: 1, drafts: 0, proven: 1, weak: 1, minutes: 30, staticOnly: false }, notCounted: { functions: 1, testFiles: 1 } }, NOUN);
    expect(one[0]).toBe("Done by this run: 1 test written and passing, 1 function proven, 1 test found that doesn't catch a break. By hand, about 0.5 engineer-hours.");
    expect(one[1]).toBe("Assumes 10 minutes per test written and passing, 5 per function proven and 15 per test found that doesn't catch a break.");
    expect(one[3]).toBe("Not counted: mapping 1 function to 1 test file and ranking them.");
    const drafts = byHandSentences({ run: { written: 0, drafts: 3, proven: 0, weak: 0, minutes: 15, staticOnly: true }, notCounted: { functions: 9, testFiles: 2 } }, NOUN);
    expect(drafts[0]).toBe("Done by this run: 3 drafts to finish. By hand, about 0.3 engineer-hours.");
    expect(drafts[1]).toBe("Assumes 5 minutes per draft to finish.");
  });

  it("all zero, or a report another command wrote: only the Not counted line", () => {
    const notCounted = ["Not counted: mapping 9 functions to 2 test files and ranking them."];
    expect(byHandSentences({ run: { written: 0, drafts: 0, proven: 0, weak: 0, minutes: 0, staticOnly: false }, notCounted: { functions: 9, testFiles: 2 } }, NOUN)).toEqual(notCounted);
    expect(byHandSentences({ run: null, notCounted: { functions: 9, testFiles: 2 } }, NOUN)).toEqual(notCounted);
  });

  it("the proof-attempts file keeps written or found, and an old record has neither", () => {
    const graph = { manifest: { generated_at: "g" }, git: {}, artifact_identity: undefined } as never;
    const base = { target_symbol: "f", test_path: "t", classification: "proven" as const, language: "javascript" };
    const file = distillProofAttempts({ attempted: 2, proven: 2, attempts: [{ ...base, test_source: "written" }, { ...base }], skipped: [], needs_setup: [] } as never, { generatedAt: "now", graph });
    expect(file.attempts[0]!.test_source).toBe("written");
    expect("test_source" in file.attempts[1]!).toBe(false);
  });
});

function reportsFor(repo: string, byHand?: ByHandRun): { summary: string; detailed: string; model: ReportModel } {
  const out = opBehaviorCoverageHtml(repo, ".orangepro/behavior-coverage.html", undefined, { persistBaseline: false, ...(byHand ? { byHand } : {}) } as never);
  const detailed = readFileSync(out.behavior_coverage_path, "utf8");
  return { detailed, summary: readFileSync(out.short_report_path!, "utf8"), model: modelIn(detailed) };
}

function fixtureRepo(): string {
  const f = proofRunFixture();
  writeFileSync(join(f.repo, "package.json"), JSON.stringify({ name: "round", version: "1.0.0", main: "lib/round.js" }));
  opInit(f.repo, deps);
  opAnalyze(f.repo, { source: f.repo }, deps);
  return f.repo;
}

describe("item 48: the reports", () => {
  it("bumps both versions", () => {
    expect(REPORT_DATA_VERSION).toBe(5);
    expect(REPORT_RENDERER_VERSION).toBe("r16.0");
  });

  it("summary: the platform card sits directly above the footer, with the link from the one constant", () => {
    const { summary } = reportsFor(fixtureRepo());
    const card = `<section class="card cta" aria-labelledby="cta-h">
  <h2 id="cta-h">From functions to workflows</h2>
  <p>This report checks functions one at a time. The OrangePro platform connects them to your requirements and past bugs, so it can show which critical workflows a change puts at risk.</p>
  <p><a class="ctabtn" href="${esc(platformLink("summary"))}" target="_blank" rel="noopener noreferrer">See the platform →</a></p>
</section>
</main>
<footer`;
    expect(summary).toContain(card);
    expect(platformLink("summary")).toBe("https://orangepro.ai/?utm_source=mcp_report&utm_medium=summary");
    expect(summary).toMatch(/\.ctabtn\{display:inline-block;background:#E0561B;color:#fff;font-weight:700;font-size:19px;/);
  });

  it("detailed: one bar fixed to the bottom; Give feedback only when the footer has it", () => {
    const repo = fixtureRepo();
    const on = reportsFor(repo).detailed;
    const bars = on.match(/<nav class="platbar"[\s\S]*?<\/nav>/g) ?? [];
    expect(bars).toHaveLength(1);
    expect(textOf(bars[0]!).trim()).toBe("OrangePro platform · See the platform → · Give feedback");
    expect(bars[0]).toContain(`href="${esc(platformLink("detailed"))}"`);
    expect(platformLink("detailed")).toBe("https://orangepro.ai/?utm_source=mcp_report&utm_medium=detailed");
    expect(on).toMatch(/\.platbar\{position:fixed;left:0;right:0;bottom:0;/);
    const previous = process.env.ORANGEPRO_FEEDBACK_URL;
    process.env.ORANGEPRO_FEEDBACK_URL = "off";
    try {
      const off = reportsFor(repo).detailed;
      expect(textOf(off.match(/<nav class="platbar"[\s\S]*?<\/nav>/)![0]).trim()).toBe("OrangePro platform · See the platform →");
      expect(off).not.toContain("Give feedback");
    } finally {
      if (previous === undefined) delete process.env.ORANGEPRO_FEEDBACK_URL;
      else process.env.ORANGEPRO_FEEDBACK_URL = previous;
    }
  });

  it("summary: start's counts are shown and saved; any other writer shows only the Not counted line", () => {
    const repo = fixtureRepo();
    const fromStart = reportsFor(repo, RUN);
    expect(fromStart.model.byHand.run).toEqual(byHandCounts(RUN));
    const c = fromStart.model.counts;
    expect(fromStart.model.byHand.notCounted).toEqual({ functions: c.mapped, testFiles: c.testFiles });
    for (const line of byHandSentences(fromStart.model.byHand, fromStart.model.noun)) expect(fromStart.summary).toContain(esc(line));
    expect(fromStart.summary).toContain("By hand, about 3.8 engineer-hours.");

    const other = reportsFor(repo);
    expect(other.model.byHand.run).toBeNull();
    const block = other.summary.match(/<section class="byhand"[\s\S]*?<\/section>/)![0];
    expect(textOf(block).trim()).toBe(`Not counted: mapping ${c.mapped} ${c.mapped === 1 ? "function" : "functions"} to ${c.testFiles} ${c.testFiles === 1 ? "test file" : "test files"} and ranking them.`);
  });

  it("never uses the banned words, and the same data renders the same bytes", () => {
    const repo = fixtureRepo();
    const r = reportsFor(repo, RUN);
    for (const page of [r.summary, r.detailed]) {
      const t = textOf(page);
      for (const banned of ["Unlock", "View all on Platform", "CI gate"]) expect(t).not.toContain(banned);
    }
    const block = textOf(r.summary.match(/<section class="byhand"[\s\S]*?<\/section>/)![0]).toLowerCase();
    expect(block).not.toContain("unit test");
    expect(block).not.toContain("saved");
    expect(r.summary).toContain("This looks wrong");
    // Same data, same bytes: the saved model renders the page that was written.
    expect(renderSummaryReport(r.model)).toBe(r.summary);
    const dir = mkdtempSync(join(tmpdir(), "opro-i48-"));
    writeReports(r.model, join(dir, "a.html"), join(dir, "a-short.html"), join(dir, "a.csv"));
    writeReports(JSON.parse(JSON.stringify(r.model)) as ReportModel, join(dir, "b.html"), join(dir, "b-short.html"), join(dir, "b.csv"));
    expect(readFileSync(join(dir, "a.html"), "utf8")).toBe(readFileSync(join(dir, "b.html"), "utf8"));
    expect(readFileSync(join(dir, "a-short.html"), "utf8")).toBe(readFileSync(join(dir, "b-short.html"), "utf8"));
  });

  it("the platform address with its tracking parameters is spelled in one place only", () => {
    const root = join(__dirname, "../../src/local");
    const hits: string[] = [];
    const walk = (dir: string): void => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && readFileSync(p, "utf8").includes("utm_source")) hits.push(p.slice(root.length + 1));
      }
    };
    walk(root);
    expect(hits).toEqual(["viz/reportTheme.ts"]);
  });
});
