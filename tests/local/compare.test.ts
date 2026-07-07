import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { opAnalyze, opCompare } from "../../src/local/operations.js";
import { loadGraph } from "../../src/local/workspace.js";
import { parseJudgeResponse } from "../../src/local/generate/compareJudge.js";
import { compareTestsExt } from "../../src/local/generate/compareReport.js";

function makeFixture(): string {
  const dir = mkdtempSync(join(tmpdir(), "op-cmp-fix-"));
  mkdirSync(join(dir, "src"), { recursive: true });
  // A real vitest repo declares vitest — so the generated test's framework import is
  // a known installed package, not a hallucinated one (runnable check, PLAN 6.5).
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cart", devDependencies: { vitest: "^3" } }));
  writeFileSync(join(dir, "src", "cart.ts"), "export function total(items: number[]) { return items.reduce((a, b) => a + b, 0); }\n");
  writeFileSync(
    join(dir, "src", "cart.test.ts"),
    'import { total } from "./cart";\ntest("total", () => { expect(total([1, 2])).toBe(3); });\n'
  );
  return dir;
}
const ws = (): string => mkdtempSync(join(tmpdir(), "op-cmp-ws-"));

describe("opCompare — A/B view", () => {
  it("runs both arms and scores all four dimensions (deterministic -> heuristic)", async () => {
    const root = ws();
    const analyzed = opAnalyze(root, { source: makeFixture() });
    const cmp = await opCompare(root, { provider: "deterministic", limit: 2 });

    expect(cmp.model_provider).toBe("deterministic");
    expect(cmp.scoring_method).toBe("heuristic"); // no judge for the offline stand-in
    for (const arm of [cmp.scores.baseline, cmp.scores.grounded]) {
      for (const dim of [arm.completeness, arm.context_awareness, arm.accuracy, arm.domain_specificity]) {
        expect(dim).toBeGreaterThanOrEqual(0);
        expect(dim).toBeLessThanOrEqual(100);
      }
    }
    // The Local KG arm cites provenance the prompt-only arm cannot.
    expect(cmp.matrix.grounded.traceability_refs).toBeGreaterThan(cmp.matrix.baseline.traceability_refs);
    expect(cmp.scores.grounded.context_awareness).toBeGreaterThanOrEqual(cmp.scores.baseline.context_awareness);

    // Non-persisting: compare must NOT write generation runs into the graph.
    expect(loadGraph(analyzed.graph_path).generation_runs).toHaveLength(0);

    // Agent mode: runnable (deterministic framework-code) arms carry run hints so
    // an agent can write + run the Local KG tests.
    expect(cmp.grounded.run_hints.length).toBeGreaterThan(0);
    expect(cmp.grounded.run_hints[0]).toHaveProperty("suggested_path");
    expect(cmp.grounded.run_hints[0]).toHaveProperty("run_command");
  });

  it("emits RUNNABLE framework code for BOTH arms (not specs/markdown)", async () => {
    const root = ws();
    opAnalyze(root, { source: makeFixture() });
    const cmp = await opCompare(root, { provider: "deterministic", limit: 1 });

    const bodies = [...cmp.grounded.generated_tests, ...cmp.baseline.generated_tests].map((t) => t.body);
    expect(bodies.length).toBeGreaterThan(0);
    for (const b of bodies) {
      // Real framework code — not the old Markdown pseudo-spec.
      expect(b).toMatch(/describe\(|it\(|test\(/);
      expect(b).toMatch(/expect\(|assert /);
      expect(b).not.toContain("# Test:"); // markdown heading
      expect(b).not.toContain("toSatisfy"); // old pseudo-matcher
      expect(b).not.toContain("```"); // markdown fence
    }
    // The test-cases file gets a runnable framework extension, not a JSON/XML spec.
    expect(compareTestsExt(cmp)).not.toMatch(/json|xml/);
  });

  it("returns setup guidance (no scores) when no provider is configured", async () => {
    const root = ws();
    opAnalyze(root, { source: makeFixture() });
    const cmp = await opCompare(root, {}, { clock: () => "2026-06-08T00:00:00Z", env: {} });
    expect(cmp.model_provider).toBe("none");
    expect(cmp.warnings.join(" ")).toMatch(/No model provider configured/i);
  });
});

describe("parseJudgeResponse", () => {
  it("parses fenced JSON and clamps out-of-range scores", () => {
    const r = parseJudgeResponse(
      'Here are the scores:\n```json\n{"baseline":{"completeness":150,"context_awareness":-5,"accuracy":40,"domain_specificity":30},"grounded":{"completeness":90,"context_awareness":85,"accuracy":88,"domain_specificity":80},"rationale":"KG cites real modules"}\n```'
    );
    expect(r).not.toBeNull();
    expect(r!.baseline.completeness).toBe(100); // clamped from 150
    expect(r!.baseline.context_awareness).toBe(0); // clamped from -5
    expect(r!.grounded.accuracy).toBe(88);
    expect(r!.rationale).toBe("KG cites real modules");
  });

  it("returns null on a non-JSON response", () => {
    expect(parseJudgeResponse("the model said no")).toBeNull();
  });
});
