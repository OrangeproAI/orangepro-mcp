import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, existsSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  opInit,
  opAnalyze,
  opDoctor,
  opGaps,
  opGenerate,
  opExplain,
  opChanged,
  opUpdate,
  opStart
} from "../../src/local/operations.js";
import { redactSecrets, containsSecret } from "../../src/local/util/redact.js";
import { rankPriorityGaps } from "../../src/local/score/risk.js";
import type { ModelCompletionRequest, ModelProvider } from "../../src/local/types.js";

// Generation defaults to opt-in deterministic stand-in for offline determinism.
const deps = { clock: () => "2026-06-07T00:00:00Z", env: { ORANGEPRO_ALLOW_DETERMINISTIC: "1" } as NodeJS.ProcessEnv };
const dirs: string[] = [];

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "oplocal-ops-"));
  dirs.push(d);
  return d;
}

function scaffold(root: string): void {
  mkdirSync(join(root, "src/payments"), { recursive: true });
  mkdirSync(join(root, "tests/payments"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
  writeFileSync(join(root, "src/payments/card.ts"), "export function saveCard(n: string) { return n; }\n");
  writeFileSync(
    join(root, "tests/payments/card.test.ts"),
    'import { it, expect } from "vitest";\nit("saves a card", () => { expect(1).toBe(1); });\n'
  );
  writeFileSync(
    join(root, "payments-template.csv"),
    [
      "behavior_name,description,acceptance_criteria,actor_or_role,priority_or_risk,source_ref",
      '"Save a card","Customer saves a card","Card is validated; Saved card appears",buyer,high,PAY-1'
    ].join("\n")
  );
}

function scaffoldRiskTargets(root: string, count = 7): void {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "risk-fixture", devDependencies: { vitest: "^3" } }));
  writeFileSync(
    join(root, "src/risk.ts"),
    Array.from({ length: count }, (_, i) => `export function behavior${i}(value: string) { return value + "${i}"; }`).join("\n") + "\n"
  );
}

class StartV5Provider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-v5";
  planningCalls = 0;
  generationCalls = 0;

  async complete(req: ModelCompletionRequest): Promise<string> {
    if (req.user.includes("BEHAVIOR_CANDIDATES:")) {
      const behaviorId = /"id":\s*"([^"]+)"/.exec(req.user)?.[1] ?? "REQ-missing";
      const symbolId = /"id":\s*"(sym:[^"]+)"/.exec(req.user)?.[1] ?? "sym:src/risk.ts#behavior0";
      return JSON.stringify({ links: [{ behavior_id: behaviorId, symbol_id: symbolId, confidence: 0.7, rationale: "closed-set fixture link" }] });
    }

    const fn =
      /^BEHAVIOR:\s*([A-Za-z0-9_]+)/m.exec(req.user)?.[1] ??
      /src\/risk\.ts:([A-Za-z0-9_]+)/.exec(req.user)?.[1] ??
      /ASSERT:\s*\n\s*-\s*([A-Za-z0-9_]+)/.exec(req.user)?.[1] ??
      "behavior0";
    if (req.user.includes("Find missing test scenarios")) {
      this.planningCalls++;
      return JSON.stringify([
        {
          id: 1,
          title: `${fn} preserves observable output`,
          concern: "contract",
          technique: "contract_verification",
          rationale: "exercise the top risk symbol through a real assertion",
          assertion_targets: [fn],
          complexity: "basic",
          risk_rank: 1
        },
        {
          id: 2,
          title: `${fn} handles the riskiest boundary`,
          concern: "boundary_limits",
          technique: "boundary_value_analysis",
          rationale: "exercise the second most critical uncovered case",
          assertion_targets: [fn],
          complexity: "basic",
          risk_rank: 2
        }
      ]);
    }

    if (req.user.includes("═══ SCENARIOS")) {
      this.generationCalls++;
      const first = [
        "// ═══ SCENARIO 1 ═══",
        "import { expect, it } from \"vitest\";",
        `import { ${fn} } from "../src/risk";`,
        "",
        `it("${fn} preserves observable output", () => {`,
        `  expect(${fn}("value")).toBe("value${fn.replace("behavior", "")}");`,
        "});"
      ];
      if (!req.user.includes("SCENARIO 2")) return first.join("\n");
      return [
        ...first,
        "// ═══ SCENARIO 2 ═══",
        "import { expect, it } from \"vitest\";",
        `import { ${fn} } from "../src/risk";`,
        "",
        `it("${fn} handles the riskiest boundary", () => {`,
        `  expect(${fn}("")).toBe("${fn.replace("behavior", "")}");`,
        "});"
      ].join("\n");
    }

    return "[]";
  }
}

class OneScenarioAtATimeProvider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-v5-one-at-a-time";
  planningCalls = 0;

  async complete(req: ModelCompletionRequest): Promise<string> {
    if (!req.user.includes("Find missing test scenarios")) return "";
    this.planningCalls++;
    const fn = /^BEHAVIOR:\s*([A-Za-z0-9_]+)/m.exec(req.user)?.[1] ?? "behavior0";
    const second = req.user.includes(`${fn} first critical scenario`);
    return JSON.stringify([
      {
        id: 1,
        title: `${fn} ${second ? "second" : "first"} critical scenario`,
        concern: second ? "boundary_limits" : "contract",
        technique: second ? "boundary_value_analysis" : "contract_verification",
        rationale: "one accepted scenario per bounded planning call",
        assertion_targets: [fn],
        complexity: "basic",
        risk_rank: 1
      }
    ]);
  }
}

class EmptyFirstPlanningProvider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-v5-empty-first";
  planningCalls = 0;
  private readonly attempts = new Map<string, number>();
  private readonly delegate = new StartV5Provider();

  async complete(req: ModelCompletionRequest): Promise<string> {
    if (!req.user.includes("Find missing test scenarios")) return this.delegate.complete(req);
    this.planningCalls++;
    const fn = /^BEHAVIOR:\s*([A-Za-z0-9_]+)/m.exec(req.user)?.[1] ?? "behavior0";
    const attempt = (this.attempts.get(fn) ?? 0) + 1;
    this.attempts.set(fn, attempt);
    return attempt === 1 ? "[]" : this.delegate.complete(req);
  }
}

class AlwaysEmptyPlanningProvider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-v5-always-empty";
  planningCalls = 0;

  async complete(req: ModelCompletionRequest): Promise<string> {
    if (req.user.includes("Find missing test scenarios")) this.planningCalls++;
    return "[]";
  }
}

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

describe("operation-level coverage", () => {
  it("opDoctor returns prioritized recommendations and status", () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    const doctor = opDoctor(root);
    expect(doctor.recommendations.length).toBeGreaterThan(0);
    expect(typeof doctor.status).toBe("string");
    expect(doctor.recommendations[0].priority).toBe(1);
  });

  it("opGaps returns gaps for behaviors lacking test evidence", () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    const gaps = opGaps(root, { limit: 10 });
    expect(gaps.total_behaviors).toBeGreaterThan(0);
    expect(Array.isArray(gaps.gaps)).toBe(true);
    // The template REQ has acceptance criteria but no linked test -> a gap.
    expect(gaps.gaps.some((g) => g.has_acceptance_criteria && g.test_evidence !== "covered")).toBe(true);
    expect(gaps.top_risk_gaps?.length).toBeGreaterThan(0);
    expect(gaps.top_risk_gaps?.[0]).toMatchObject({
      external_id: expect.stringMatching(/^sym:/),
      risk_score: expect.any(Number),
      incoming_refs: expect.any(Number),
      git_churn: expect.any(Number),
      entry_point: expect.any(Boolean)
    });
    expect(gaps.risk_model?.note).toContain("does not change");
  });

  it("opExplain resolves a generated test's grounding", async () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    const gen = await opGenerate(root, { limit: 1 }, deps);
    expect(gen.generated_tests.length).toBeGreaterThan(0);
    const explain = opExplain(root, gen.generated_tests[0].id);
    expect(explain.title).toBe(gen.generated_tests[0].title);
    expect(explain.grounded_by.length).toBeGreaterThan(0);
  });

  it("opGenerate refreshes behavior-coverage.html so generated tests appear from the real path", async () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    // Target a concrete CodeSymbol (Codex's repro shape) so the generated test
    // carries target_symbol_external_id and must surface on its risk card.
    const gen = await opGenerate(root, { limit: 1, target_ids: ["sym:src/payments/card.ts#saveCard"] }, deps);
    expect(gen.generated_tests.length).toBeGreaterThan(0);

    // The blocker bar: the report must reflect the persisted generated tests.
    const htmlPath = join(root, ".orangepro", "behavior-coverage.html");
    expect(existsSync(htmlPath)).toBe(true);
    const html = readFileSync(htmlPath, "utf8");
    expect(html).toContain(`"generatedTotal":${gen.generated_tests.length}`);
    // Title AND body of the targeted test appear in the embedded report data.
    expect(html).toContain(gen.generated_tests[0].title.slice(0, 20));
    const bodyFragment = gen.generated_tests[0].body.split("\n").find((l) => l.trim().length > 8) ?? "";
    expect(bodyFragment.length).toBeGreaterThan(8);
    expect(html).toContain(JSON.stringify(bodyFragment).slice(1, -1).slice(0, 30));
  });

  it("opAnalyze preserves generated tests for unchanged targets and drops them after source changes", async () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    const generated = await opGenerate(root, {
      limit: 1,
      target_ids: ["sym:src/payments/card.ts#saveCard"]
    }, deps);
    expect(generated.generated_tests).toHaveLength(1);
    expect(generated.generated_tests[0].target_fingerprint).toMatch(/^sha256:/);

    opAnalyze(root, { source: root }, deps);
    const unchanged = JSON.parse(readFileSync(join(root, ".orangepro", "graph.json"), "utf8"));
    expect(unchanged.generated_tests).toEqual(generated.generated_tests);
    expect(unchanged.generation_runs).toHaveLength(1);
    expect(unchanged.generation_runs[0].generated_test_ids).toEqual([generated.generated_tests[0].id]);

    writeFileSync(join(root, "src/payments/card.ts"), "export function saveCard(n: string) { return n.trim(); }\n");
    opAnalyze(root, { source: root }, deps);
    const changed = JSON.parse(readFileSync(join(root, ".orangepro", "graph.json"), "utf8"));
    expect(changed.generated_tests).toEqual([]);
    expect(changed.generation_runs).toEqual([]);
  });

  it("opStart with a provider writes generated tests into the behavior report independently of the proof budget", async () => {
    const root = temp();
    opInit(root, deps);
    scaffoldRiskTargets(root, 7);
    const provider = new StartV5Provider();
    const res = await opStart(
      root,
      { source: root, aiFlows: false, proofLimit: 1, generateLimit: 7, promptVersion: "v5" },
      {
        ...deps,
        env: {},
        aiProvider: provider,
        dynamicProofRunner: () => ({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ status: "associated_survived", proven: false, reason: "stubbed for start generation test" })
        })
      }
    );

    const graph = opGaps(root, { limit: 20 });
    expect(graph.top_risk_gaps?.length).toBeGreaterThanOrEqual(7);
    expect(res.warnings.some((w) => w.includes("provider returned no accepted tests")), res.warnings.join("\n")).toBe(false);
    expect(res.auto_prove.attempted).toBeLessThanOrEqual(1);
    expect(provider.planningCalls).toBe(7);
    expect(provider.generationCalls).toBe(7);
    expect(res.generation).toMatchObject({
      status: "completed",
      generated: 14,
      runnable: 14,
      drafts: 0,
      requested: 7
    });

    const html = readFileSync(res.behavior_coverage_path ?? "", "utf8");
    expect(html).toContain('"generatedTotal":14');
    expect(html).toContain('"shownCount":14');
    expect(html).toContain("behavior0 preserves observable output");
    expect(html).toContain("behavior6 preserves observable output");
    expect(html).toContain('"generationOutcome":{"status":"completed"');

    const firstGraph = JSON.parse(readFileSync(join(root, ".orangepro", "graph.json"), "utf8"));
    expect(firstGraph.generation_runs).toHaveLength(7);
    expect(firstGraph.generation_runs.every((run: { generated_test_ids: string[] }) => run.generated_test_ids.length === 2)).toBe(true);
    const firstIds = firstGraph.generated_tests.map((test: { id: string }) => test.id);
    const rerun = await opStart(
      root,
      { source: root, aiFlows: false, proofLimit: 1, generateLimit: 7, promptVersion: "v5" },
      {
        ...deps,
        env: {},
        aiProvider: new StartV5Provider(),
        dynamicProofRunner: () => ({
          exitCode: 0,
          stderr: "",
          stdout: JSON.stringify({ status: "associated_survived", proven: false, reason: "stubbed for persistence test" })
        })
      }
    );
    const secondGraph = JSON.parse(readFileSync(join(root, ".orangepro", "graph.json"), "utf8"));
    expect(rerun.generation.status).toBe("no_targets");
    expect(secondGraph.generated_tests.map((test: { id: string }) => test.id)).toEqual(firstIds);
    expect(secondGraph.generated_tests).toHaveLength(14);
  });

  it("opStart tops up partially generated current risk flows to two tests each", async () => {
    const root = temp();
    opInit(root, deps);
    scaffoldRiskTargets(root, 24);
    opAnalyze(root, { source: root }, deps);

    const analyzedGraph = JSON.parse(readFileSync(join(root, ".orangepro", "graph.json"), "utf8"));
    const rankedIds = rankPriorityGaps(analyzedGraph, { repoRoot: root, limit: 24 }).map((gap) => gap.id);
    expect(rankedIds).toHaveLength(24);

    const seedProvider = new StartV5Provider();
    const currentTopCounts = [
      2,
      ...Array<number>(8).fill(1),
      ...Array<number>(8).fill(2),
      ...Array<number>(3).fill(0)
    ];
    for (const [index, count] of currentTopCounts.entries()) {
      if (count === 0) continue;
      await opGenerate(
        root,
        { target_ids: [rankedIds[index]], limit: count, prompt_version: "v5" },
        { ...deps, env: {}, aiProvider: seedProvider }
      );
    }
    for (const targetId of rankedIds.slice(20, 22)) {
      await opGenerate(
        root,
        { target_ids: [targetId], limit: 2, prompt_version: "v5" },
        { ...deps, env: {}, aiProvider: seedProvider }
      );
    }

    const seededGraph = JSON.parse(readFileSync(join(root, ".orangepro", "graph.json"), "utf8"));
    expect(seededGraph.generated_tests).toHaveLength(30);
    const seededHtml = readFileSync(join(root, ".orangepro", "behavior-coverage.html"), "utf8");
    expect(seededHtml).toContain('"generatedTotal":30');
    expect(Number(/"shownCount":(\d+)/.exec(seededHtml)?.[1])).toBe(26);

    const topUpProvider = new StartV5Provider();
    const res = await opStart(
      root,
      { source: root, aiFlows: false, proofLimit: 0, generateLimit: 20, promptVersion: "v5" },
      { ...deps, env: {}, aiProvider: topUpProvider }
    );

    expect(res.generation).toMatchObject({
      status: "completed",
      requested: 11,
      generated: 14
    });
    const finalGraph = JSON.parse(readFileSync(join(root, ".orangepro", "graph.json"), "utf8"));
    expect(finalGraph.generated_tests).toHaveLength(44);
    for (const targetId of rankedIds.slice(0, 20)) {
      expect(finalGraph.generated_tests.filter(
        (test: { target_symbol_external_id?: string }) => test.target_symbol_external_id === targetId
      )).toHaveLength(2);
    }
    const finalHtml = readFileSync(res.behavior_coverage_path ?? "", "utf8");
    expect(finalHtml).toContain('"generatedTotal":44');
    expect(finalHtml).toContain('"shownCount":40');

    const persistedIds = finalGraph.generated_tests.map((test: { id: string }) => test.id);
    const rerunProvider = new StartV5Provider();
    const rerun = await opStart(
      root,
      { source: root, aiFlows: false, proofLimit: 0, generateLimit: 20, promptVersion: "v5" },
      { ...deps, env: {}, aiProvider: rerunProvider }
    );
    expect(rerun.generation).toMatchObject({ status: "no_targets", requested: 20, generated: 0 });
    expect(rerunProvider.planningCalls).toBe(0);
    const rerunGraph = JSON.parse(readFileSync(join(root, ".orangepro", "graph.json"), "utf8"));
    expect(rerunGraph.generated_tests.map((test: { id: string }) => test.id)).toEqual(persistedIds);
    const rerunHtml = readFileSync(rerun.behavior_coverage_path ?? "", "utf8");
    expect(rerunHtml).toContain('"generatedTotal":44');
    expect(rerunHtml).toContain('"shownCount":40');
  }, 15_000);

  it("opStart makes one bounded follow-up when the provider returns only one scenario", async () => {
    const root = temp();
    opInit(root, deps);
    scaffoldRiskTargets(root, 2);
    const provider = new OneScenarioAtATimeProvider();

    const res = await opStart(
      root,
      { source: root, aiFlows: false, proofLimit: 0, generateLimit: 2, promptVersion: "v5" },
      { ...deps, env: {}, aiProvider: provider }
    );

    expect(provider.planningCalls).toBe(4);
    expect(res.generation).toMatchObject({
      status: "completed_with_blockers",
      requested: 2,
      generated: 4,
      drafts: 4
    });
    const graph = JSON.parse(readFileSync(join(root, ".orangepro", "graph.json"), "utf8"));
    expect(graph.generated_tests).toHaveLength(4);
    const titleSet = new Set(graph.generated_tests.map((test: { title: string }) => test.title));
    expect(titleSet.size).toBe(4);
    const html = readFileSync(res.behavior_coverage_path ?? "", "utf8");
    expect(html).toContain('"generatedTotal":4');
    expect(html).toContain('"shownCount":4');
  });

  it("opStart retries a priority flow when its first planning call returns no accepted scenario", async () => {
    const root = temp();
    opInit(root, deps);
    scaffoldRiskTargets(root, 2);
    const provider = new EmptyFirstPlanningProvider();

    const res = await opStart(
      root,
      { source: root, aiFlows: false, proofLimit: 0, generateLimit: 2, promptVersion: "v5" },
      { ...deps, env: {}, aiProvider: provider }
    );

    expect(provider.planningCalls).toBe(4);
    expect(res.generation).toMatchObject({ generated: 4 });
    const graph = JSON.parse(readFileSync(join(root, ".orangepro", "graph.json"), "utf8"));
    expect(graph.generated_tests).toHaveLength(4);
    expect(new Set(graph.generated_tests.map((test: { target_symbol_external_id?: string }) => test.target_symbol_external_id)).size).toBe(2);
  });

  it("opStart preserves two manual test intents when both planning attempts fail", async () => {
    const root = temp();
    opInit(root, deps);
    scaffoldRiskTargets(root, 2);
    const provider = new AlwaysEmptyPlanningProvider();

    const res = await opStart(
      root,
      { source: root, aiFlows: false, proofLimit: 0, generateLimit: 2, promptVersion: "v5" },
      { ...deps, env: {}, aiProvider: provider }
    );

    expect(provider.planningCalls).toBe(4);
    expect(res.generation).toMatchObject({ status: "completed_with_blockers", requested: 2, generated: 4, drafts: 4 });
    expect(res.generation.reason).toBeUndefined();
    const graph = JSON.parse(readFileSync(join(root, ".orangepro", "graph.json"), "utf8"));
    expect(graph.generated_tests).toHaveLength(4);
    expect(graph.generated_tests.every((test: { runnable?: boolean }) => test.runnable === false)).toBe(true);
    expect(graph.generated_tests.every((test: { unresolved_reason?: string }) =>
      test.unresolved_reason?.includes("planning returned no missing scenarios")
    )).toBe(true);
    const diagnostics = JSON.parse(readFileSync(join(root, ".orangepro", "generation-diagnostics.json"), "utf8"));
    expect(diagnostics).toMatchObject({
      schema_version: 1,
      expected_flows: 2,
      expected_tests_per_flow: 2,
      persisted_test_intents_this_run: 4,
      model_planned_tests_this_run: 0,
      manual_fallbacks_this_run: 4
    });
    expect(res.generation_diagnostics_path).toBe(join(root, ".orangepro", "generation-diagnostics.json"));
    expect(diagnostics.flows).toHaveLength(2);
    expect(diagnostics.flows.every((flow: { attempts: unknown[]; final_tests: number; remaining_shortfall: number }) =>
      flow.attempts.length === 2 && flow.final_tests === 2 && flow.remaining_shortfall === 0
    )).toBe(true);
    expect(diagnostics.flows.every((flow: { attempts: Array<{ model_planned_tests: number; manual_fallbacks: number; missing_evidence: unknown[] }> }) =>
      flow.attempts[1]?.model_planned_tests === 0 &&
      flow.attempts[1]?.manual_fallbacks === 2 &&
      flow.attempts[1]?.missing_evidence.length > 0
    )).toBe(true);
    expect(JSON.stringify(diagnostics)).not.toContain("Find missing test scenarios");
    const html = readFileSync(res.behavior_coverage_path ?? "", "utf8");
    expect(html).toContain('"shownCount":4');
  });

  it("opStart reports the exact no-provider terminal generation reason", async () => {
    const root = temp();
    opInit(root, { ...deps, env: {} });
    scaffoldRiskTargets(root, 2);
    const res = await opStart(root, { source: root, aiFlows: false, proofLimit: 1, generateLimit: 2 }, { ...deps, env: {} });

    expect(res.generation.status).toBe("no_provider");
    expect(res.generation.generated).toBe(0);
    expect(res.generation.reason).toContain("No model provider configured");
    expect(res.generation.reason).toContain('provider="deterministic"');
    const html = readFileSync(res.behavior_coverage_path ?? "", "utf8");
    expect(html).toContain('"generationOutcome":{"status":"no_provider"');
    expect(html).toContain("No model provider configured");
  });

  it("opStart deterministic mode uses the compatible scaffold and emits drafts", async () => {
    const root = temp();
    opInit(root, deps);
    scaffoldRiskTargets(root, 2);
    const res = await opStart(
      root,
      { source: root, aiFlows: false, provider: "deterministic", proofLimit: 1, generateLimit: 2 },
      { ...deps, env: {} }
    );

    expect(res.generation.status).not.toBe("no_results");
    expect(res.generation.generated).toBeGreaterThan(0);
    expect(res.warnings.some((warning) => warning.includes("Planning output contained no JSON array"))).toBe(false);
  });

  it("opExplain throws for an unknown test id", () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    expect(() => opExplain(root, "does-not-exist")).toThrow();
  });

  it("opGenerate surfaces VALIDATED grounding evidence per test + a run-level summary", async () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    const gen = await opGenerate(root, { limit: 1 }, deps);
    expect(gen.generated_tests.length).toBeGreaterThan(0);

    // Every test gets a matching validated-evidence record.
    expect(gen.evidence).toHaveLength(gen.generated_tests.length);
    expect(gen.evidence_summary.tests).toBe(gen.generated_tests.length);

    const ev = gen.evidence[0];
    expect(ev.generated_test_id).toBe(gen.generated_tests[0].id);
    // The template Requirement is hard evidence -> this is real proof.
    expect(ev.validated_count).toBeGreaterThan(0);
    expect(ev.has_proof).toBe(true);
    // Every cited entity in this fixture resolves to a real graph node.
    expect(ev.invalid_count).toBe(0);
    expect(ev.evidence.every((c) => c.validated)).toBe(true);
    expect(ev.evidence.some((c) => c.evidence_strength === "hard" || c.evidence_strength === "reviewed")).toBe(true);

    // Run-level roll-up agrees: proof coverage, no broken/unverifiable citations,
    // and therefore NO "provenance unverified" warning.
    expect(gen.evidence_summary.tests_with_proof).toBeGreaterThan(0);
    expect(gen.evidence_summary.invalid_citations).toBe(0);
    expect(gen.evidence_summary.tests_without_validated_evidence).toBe(0);
    expect(gen.warnings.some((w) => w.includes("provenance unverified"))).toBe(false);
  });
});

describe("raw_prompt baseline path", () => {
  it("produces a test with no grounding source refs and no weak disclosure", async () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    const raw = await opGenerate(root, { limit: 1, input_mode: "raw_prompt" }, deps);
    expect(raw.generated_tests.length).toBeGreaterThan(0);
    const t = raw.generated_tests[0];
    expect(t.grounding.source_refs).toEqual([]);
    expect(t.grounding.weak_relationships_used).toEqual([]);
    expect(t.weak_evidence_used).toBe(false);
  });
});

describe("opChanged with git", () => {
  it("reports the changed source file and affected behaviors", () => {
    const root = temp();
    execFileSync("git", ["init", "-q"], { cwd: root });
    scaffold(root);
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.email=t@t.co", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    writeFileSync(join(root, "src/payments/card.ts"), "export function saveCard(n: string) { return n + '!'; }\n");
    const changed = opChanged(root, "HEAD");
    expect(changed.changed_files).toContain("src/payments/card.ts");
    // Tool artifacts must be filtered out.
    expect(changed.changed_files.some((f) => f.startsWith(".orangepro/"))).toBe(false);
    expect(changed.recommended_actions.length).toBeGreaterThan(0);
  });
});

describe("incremental update keeps the graph edge-consistent", () => {
  it("leaves no dangling edges after a source file is removed", () => {
    const root = temp();
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);
    unlinkSync(join(root, "tests/payments/card.test.ts"));
    opUpdate(root, {}, deps);
    const graphPath = join(root, ".orangepro", "graph.json");
    expect(existsSync(graphPath)).toBe(true);
    const graph = JSON.parse(readFileSync(graphPath, "utf8"));
    const ids = new Set(graph.nodes.map((n: { external_id: string }) => n.external_id));
    for (const e of graph.edges) {
      expect(ids.has(e.from_external_id) && ids.has(e.to_external_id)).toBe(true);
    }
    for (const e of graph.candidate_edges) {
      expect(ids.has(e.from_external_id) && ids.has(e.to_external_id)).toBe(true);
    }
  });
});

describe("redactSecrets", () => {
  it("redacts common secret shapes and detects them", () => {
    const openai = "sk-" + "A".repeat(40);
    expect(redactSecrets(`key=${openai}`)).not.toContain(openai);
    expect(containsSecret(openai)).toBe(true);
    const pem = "-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----";
    expect(redactSecrets(pem)).toContain("<redacted:private-key>");
    expect(containsSecret("nothing sensitive here")).toBe(false);
  });
});
