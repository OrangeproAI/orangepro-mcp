import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { opAiLinks, opInit, opRtm } from "../../src/local/operations.js";
import { generateTests } from "../../src/local/generate/generator.js";
import { DeterministicProvider } from "../../src/local/generate/providers.js";
import { makeEdge, makeNode } from "../../src/local/graph/factories.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, LocalGraph } from "../../src/local/graph/ontology.js";
import { resolveCoverage } from "../../src/local/score/coverage.js";
import type { ModelCompletionRequest, ModelProvider, ScoreResult } from "../../src/local/types.js";
import { buildVizPayload } from "../../src/local/viz/payload.js";
import { loadGraph, saveGraph, workspacePaths } from "../../src/local/workspace.js";
import type { AiLinksApplyResult, AiLinksGenerateResult, AiLinksResult } from "../../src/local/aiGraph/links.js";

const CLOCK = () => "2026-06-25T00:00:00Z";
const SCORE: ScoreResult = {
  overall: 0,
  band: "thin",
  breakdown: {
    behavior_anchors: 0,
    acceptance_criteria: 0,
    provenance: 0,
    interface_mapping: 0,
    validation_evidence: 0,
    known_regressions: 0
  },
  missing_evidence: [],
  denominator: {
    total: 0,
    code_export: 0,
    requirement_template: 0,
    markdown_requirement: 0,
    excluded_test_inferred: 0,
    excluded_boilerplate: 0,
    excluded_infra: 0,
    excluded_generated: 0,
    code_symbols_total: 0,
    unattributed: 0
  }
};

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

class JsonProvider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-ai-links";
  calls = 0;
  requests: ModelCompletionRequest[] = [];

  constructor(private readonly body: unknown) {}

  async complete(req: ModelCompletionRequest): Promise<string> {
    this.calls++;
    this.requests.push(req);
    return JSON.stringify(this.body);
  }
}

class TextProvider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-ai-links";
  calls = 0;

  constructor(private readonly body: string) {}

  async complete(): Promise<string> {
    this.calls++;
    return this.body;
  }
}

class SequenceProvider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-ai-links";
  calls = 0;
  requests: ModelCompletionRequest[] = [];

  constructor(private readonly bodies: string[]) {}

  async complete(req: ModelCompletionRequest): Promise<string> {
    this.requests.push(req);
    const body = this.bodies[Math.min(this.calls, this.bodies.length - 1)];
    this.calls++;
    return body;
  }
}

class FailsOnSecondCallProvider extends JsonProvider {
  async complete(req: ModelCompletionRequest): Promise<string> {
    if (this.calls >= 1) throw new Error("provider exploded");
    return super.complete(req);
  }
}

class RateLimitOnceProvider extends JsonProvider {
  async complete(req: ModelCompletionRequest): Promise<string> {
    if (this.calls === 0) {
      this.calls++;
      this.requests.push(req);
      throw new Error("Model provider HTTP 429: Rate limit reached. Please try again in 0.01s.");
    }
    return super.complete(req);
  }
}

class RateLimitDuringRepairProvider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-ai-links";
  calls = 0;

  async complete(): Promise<string> {
    this.calls++;
    if (this.calls === 1) return "Here are the links: not json";
    if (this.calls === 2) throw new Error("Model provider HTTP 429: Rate limit reached. Please try again in 0.01s.");
    return JSON.stringify({ links: [{ behavior_id: "REQ-1", symbol_id: "sym:src/discount.ts#applyDiscount", confidence: 0.8 }] });
  }
}

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "op-ai-links-"));
  dirs.push(dir);
  return dir;
}

function writeGraph(root: string, graph: LocalGraph): void {
  opInit(root, { clock: CLOCK, env: {} });
  saveGraph(workspacePaths(root).graphPath, graph);
}

function asGenerate(result: AiLinksResult): AiLinksGenerateResult {
  if (result.mode !== "generate") throw new Error("expected generate result");
  return result;
}

function asApply(result: AiLinksResult): AiLinksApplyResult {
  if (result.mode !== "apply") throw new Error("expected apply result");
  return result;
}

function requirement(id: string, title: string): LocalGraph["nodes"][number] {
  return makeNode({
    kind: "Requirement",
    external_id: id,
    title,
    properties: { acceptance_criteria: [title] },
    evidence_strength: "hard",
    review_status: "local_reviewed",
    confidence: 1,
    provenance: { source_scope_id: "reqs", source_ref: "requirements.md" },
    behavior_source: "markdown_requirement",
    denominator_eligible: true
  });
}

function graph(root: string): LocalGraph {
  const req = makeNode({
    kind: "Requirement",
    external_id: "REQ-1",
    title: "Checkout applies discounts",
    properties: { acceptance_criteria: ["Discount is applied over the threshold"], priority: "high" },
    evidence_strength: "hard",
    review_status: "local_reviewed",
    confidence: 1,
    provenance: { source_scope_id: "reqs", source_ref: "requirements.md" },
    behavior_source: "markdown_requirement",
    denominator_eligible: true
  });
  const covered = makeNode({
    kind: "Requirement",
    external_id: "REQ-COVERED",
    title: "Covered requirement",
    properties: { acceptance_criteria: ["Already covered"] },
    evidence_strength: "hard",
    review_status: "local_reviewed",
    confidence: 1,
    provenance: { source_scope_id: "reqs", source_ref: "requirements.md" },
    behavior_source: "markdown_requirement",
    denominator_eligible: true
  });
  const symbol = makeNode({
    kind: "CodeSymbol",
    external_id: "sym:src/discount.ts#applyDiscount",
    title: "applyDiscount",
    properties: {
      file: "src/discount.ts",
      symbol_kind: "function",
      source_body: "SECRET_BODY_SHOULD_NOT_APPEAR"
    },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "repo", source_ref: "src/discount.ts" },
    behavior_source: "code_export",
    denominator_eligible: true
  });
  const test = makeNode({
    kind: "TestCase",
    external_id: "test:src/covered.test.ts",
    title: "covered.test.ts",
    properties: { file: "src/covered.test.ts", test_layer: "unit" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "repo", source_ref: "src/covered.test.ts" }
  });
  const covers = makeEdge({
    from_external_id: "test:src/covered.test.ts",
    to_external_id: "REQ-COVERED",
    relationship_type: "COVERS",
    evidence_strength: "hard",
    review_status: "auto_detected",
    provenance: { source_scope_id: "repo", source_ref: "src/covered.test.ts" }
  });

  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "fixture", root, root_hash: "sha256:root", source_upload_policy: "metadata_only" },
    created_at: CLOCK(),
    updated_at: CLOCK(),
    sources: [],
    nodes: [req, covered, symbol, test],
    edges: [covers],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: CLOCK(), git: null, files: {} }
  };
}

describe("AI graph candidate links", () => {
  it("stages closed-set links without mutating graph.json, drops hallucinated endpoints, and keeps prompts metadata-only", async () => {
    const root = temp();
    const g = graph(root);
    writeGraph(root, g);
    const before = readFileSync(workspacePaths(root).graphPath, "utf8");
    const provider = new JsonProvider({
      links: [
        { behavior_id: "REQ-1", symbol_id: "sym:src/discount.ts#applyDiscount", confidence: 0.8, rationale: "discount metadata matches" },
        { behavior_id: "REQ-1", symbol_id: "sym:src/missing.ts#missing", confidence: 0.9, rationale: "hallucinated" }
      ]
    });

    const result = asGenerate(await opAiLinks(root, {}, { clock: CLOCK, env: {}, aiProvider: provider }));

    expect(result.links).toBe(1);
    expect(result.dropped_links).toBe(1);
    expect(readFileSync(workspacePaths(root).graphPath, "utf8")).toBe(before);
    const artifact = JSON.parse(readFileSync(result.ai_links_path, "utf8"));
    expect(artifact.links).toHaveLength(1);
    expect(artifact.dropped_links).toHaveLength(1);
    expect(JSON.stringify(artifact)).not.toContain("SECRET_BODY_SHOULD_NOT_APPEAR");
    expect(provider.requests[0].user).not.toContain("SECRET_BODY_SHOULD_NOT_APPEAR");
    expect(provider.requests[0].user).toContain("REQ-1");
    expect(provider.requests[0].user).toContain("sym:src/discount.ts#applyDiscount");
    expect(provider.requests[0].user).not.toContain("REQ-COVERED");
  });

  it("shortlists CodeSymbols per behavior and drops existing symbols outside the offered set", async () => {
    const root = temp();
    const g = graph(root);
    for (let i = 0; i < 60; i++) {
      g.nodes.push(makeNode({
        kind: "CodeSymbol",
        external_id: `sym:src/unrelated-${i}.ts#Unrelated${i}`,
        title: `Unrelated${i}`,
        properties: { file: `src/unrelated-${i}.ts`, symbol_kind: "function" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: { source_scope_id: "repo", source_ref: `src/unrelated-${i}.ts` },
        behavior_source: "code_export",
        denominator_eligible: true
      }));
    }
    g.nodes.push(makeNode({
      kind: "CodeSymbol",
      external_id: "sym:e2e-tests/discount-helper.ts#applyDiscount",
      title: "applyDiscount",
      properties: { file: "e2e-tests/discount-helper.ts", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "repo", source_ref: "e2e-tests/discount-helper.ts" },
      behavior_source: "code_export",
      denominator_eligible: false
    }));
    writeGraph(root, g);
    const provider = new JsonProvider({
      links: [
        { behavior_id: "REQ-1", symbol_id: "sym:src/discount.ts#applyDiscount", confidence: 0.8 },
        { behavior_id: "REQ-1", symbol_id: "sym:src/unrelated-59.ts#Unrelated59", confidence: 0.8 }
      ]
    });

    const result = asGenerate(await opAiLinks(root, { symbolsPerBehavior: 1 }, { clock: CLOCK, env: {}, aiProvider: provider }));

    expect(result.links).toBe(1);
    expect(result.dropped_links).toBe(1);
    expect(result.candidate_symbols).toBe(1);
    expect(result.total_symbols).toBe(61);
    expect(provider.requests[0].user).toContain("sym:src/discount.ts#applyDiscount");
    expect(provider.requests[0].user).not.toContain("sym:e2e-tests/discount-helper.ts#applyDiscount");
    expect(provider.requests[0].user).not.toContain("sym:src/unrelated-59.ts#Unrelated59");
    const artifact = JSON.parse(readFileSync(result.ai_links_path, "utf8"));
    expect(artifact.dropped_links[0].reason).toContain("provided candidate set");
  });

  it("persists completed batches when a later provider batch fails", async () => {
    const root = temp();
    const g = graph(root);
    g.nodes.push(requirement("REQ-2", "Checkout records audit trail"));
    g.nodes.push(requirement("REQ-3", "Checkout emits receipt"));
    writeGraph(root, g);
    const provider = new FailsOnSecondCallProvider({
      links: [{ behavior_id: "REQ-1", symbol_id: "sym:src/discount.ts#applyDiscount", confidence: 0.8 }]
    });

    const result = asGenerate(
      await opAiLinks(root, { maxPromptTokens: 1, maxBehaviors: 3, symbolsPerBehavior: 1 }, { clock: CLOCK, env: {}, aiProvider: provider })
    );

    expect(result.batch_count).toBeGreaterThan(1);
    expect(result.completed_batches).toBe(1);
    expect(result.links).toBe(1);
    expect(result.warnings.join("\n")).toContain("AI link batch 2");
    const artifact = JSON.parse(readFileSync(result.ai_links_path, "utf8"));
    expect(artifact.completed_batches).toBe(1);
    expect(artifact.links).toHaveLength(1);
  });

  it("splits large metadata prompts into conservative batches", async () => {
    const root = temp();
    const g = graph(root);
    const longSignature = `function applyDiscount(${Array.from({ length: 80 }, (_, i) => `arg${i}: string`).join(", ")}): DiscountResult`;
    const symbol = g.nodes.find((node) => node.external_id === "sym:src/discount.ts#applyDiscount");
    if (!symbol) throw new Error("missing fixture symbol");
    symbol.properties = { ...symbol.properties, signature: longSignature };
    for (let i = 2; i <= 8; i++) {
      g.nodes.push(requirement(`REQ-${i}`, `Checkout discount rule ${i} validates a long named customer scenario`));
    }
    writeGraph(root, g);
    const provider = new JsonProvider({ links: [] });

    const result = asGenerate(
      await opAiLinks(root, { maxPromptTokens: 1000, maxBehaviors: 8, symbolsPerBehavior: 1 }, { clock: CLOCK, env: {}, aiProvider: provider })
    );

    expect(result.batch_count).toBeGreaterThan(1);
    expect(provider.requests.length).toBe(result.batch_count);
  });

  it("backs off and retries transient provider rate limits", async () => {
    const root = temp();
    writeGraph(root, graph(root));
    const provider = new RateLimitOnceProvider({
      links: [{ behavior_id: "REQ-1", symbol_id: "sym:src/discount.ts#applyDiscount", confidence: 0.8 }]
    });

    const result = asGenerate(await opAiLinks(root, {}, { clock: CLOCK, env: {}, aiProvider: provider }));

    expect(provider.calls).toBe(2);
    expect(result.links).toBe(1);
    expect(result.completed_batches).toBe(result.batch_count);
    expect(result.warnings.join("\n")).not.toContain("AI link batch");
  });

  it("backs off when strict JSON repair is rate limited", async () => {
    const root = temp();
    writeGraph(root, graph(root));
    const provider = new RateLimitDuringRepairProvider();

    const result = asGenerate(await opAiLinks(root, {}, { clock: CLOCK, env: {}, aiProvider: provider }));

    expect(provider.calls).toBe(3);
    expect(result.links).toBe(1);
    expect(result.completed_batches).toBe(result.batch_count);
    expect(result.warnings.join("\n")).not.toContain("AI link batch");
  });

  it("reuses the links cache without another provider call", async () => {
    const root = temp();
    writeGraph(root, graph(root));
    const provider = new JsonProvider({
      links: [{ behavior_id: "REQ-1", symbol_id: "sym:src/discount.ts#applyDiscount", confidence: 0.7 }]
    });

    const first = asGenerate(await opAiLinks(root, {}, { clock: CLOCK, env: {}, aiProvider: provider }));
    const second = asGenerate(await opAiLinks(root, {}, { clock: CLOCK, env: {}, aiProvider: provider }));

    expect(first.cache_hit).toBe(false);
    expect(second.cache_hit).toBe(true);
    expect(second.cache_key).toBe(first.cache_key);
    expect(provider.calls).toBe(1);
  });

  it("applies only weak candidate edges and leaves proven coverage unchanged", async () => {
    const root = temp();
    writeGraph(root, graph(root));
    const provider = new JsonProvider({
      links: [{ behavior_id: "REQ-1", symbol_id: "sym:src/discount.ts#applyDiscount", confidence: 0.8, rationale: "discount metadata matches" }]
    });
    await opAiLinks(root, {}, { clock: CLOCK, env: {}, aiProvider: provider });
    const beforeGraph = loadGraph(workspacePaths(root).graphPath);
    const before = resolveCoverage(beforeGraph).coverage;

    const applied = asApply(await opAiLinks(root, { apply: true }, { clock: CLOCK, env: {} }));
    const afterGraph = loadGraph(workspacePaths(root).graphPath);
    const after = resolveCoverage(afterGraph).coverage;

    expect(applied.applied_links).toBe(1);
    expect(applied.ai_linked).toEqual({ links: 1, behaviors: 1, symbols: 1 });
    expect(after).toEqual(before);
    expect(afterGraph.edges).toEqual(beforeGraph.edges);
    expect(afterGraph.edges.map((e) => e.relationship_type)).not.toContain("MAY_RELATE_TO");
    expect(afterGraph.candidate_edges).toHaveLength(1);
    expect(afterGraph.candidate_edges[0]).toMatchObject({
      from_external_id: "REQ-1",
      to_external_id: "sym:src/discount.ts#applyDiscount",
      relationship_type: "MAY_RELATE_TO",
      evidence_strength: "weak",
      review_status: "ai_suggested"
    });
    expect(afterGraph.candidate_edges[0].provenance).toMatchObject({
      model_provider: "fake",
      model_name: "fake-ai-links",
      prompt_version: "orangepro.ai.links.v2",
      cache_key: applied.cache_key
    });

    const rtm = opRtm(root, { format: "json" });
    const reqRow = rtm.rows.find((row) => row.behavior_id === "REQ-1");
    const symbolRow = rtm.rows.find((row) => row.behavior_id === "sym:src/discount.ts#applyDiscount");
    expect(reqRow).toMatchObject({ status: "No integration signal", evidence_tier: "none", test_signal: "" });
    expect(symbolRow).toMatchObject({ status: "No integration signal", evidence_tier: "none", test_signal: "" });

    const viz = buildVizPayload(afterGraph, SCORE);
    expect(viz.gap.language_tiers).toEqual(expect.arrayContaining([expect.objectContaining({
      total: 1,
      proven: 0,
      associated: 0,
      unlinked: 1
    })]));
    expect(viz.gap.code_behaviors.find((row) => row.id === "sym:src/discount.ts#applyDiscount")).toMatchObject({
      evidence: "none"
    });
  });

  it("does not run without an explicit provider and leaves graph untouched", async () => {
    const root = temp();
    writeGraph(root, graph(root));
    const before = readFileSync(workspacePaths(root).graphPath, "utf8");

    await expect(opAiLinks(root, {}, { clock: CLOCK, env: {} })).rejects.toThrow(/No model provider configured/);
    await expect(
      opAiLinks(root, { provider: "deterministic" }, { clock: CLOCK, env: { ORANGEPRO_ALLOW_DETERMINISTIC: "1" } })
    ).rejects.toThrow(/No model provider configured/);

    expect(readFileSync(workspacePaths(root).graphPath, "utf8")).toBe(before);
  });

  it("treats literal null provider output as a dropped link instead of crashing", async () => {
    const root = temp();
    writeGraph(root, graph(root));
    const provider = new JsonProvider(null);

    const result = asGenerate(await opAiLinks(root, {}, { clock: CLOCK, env: {}, aiProvider: provider }));

    expect(result.links).toBe(0);
    expect(result.dropped_links).toBe(1);
    const artifact = JSON.parse(readFileSync(result.ai_links_path, "utf8"));
    expect(artifact.dropped_links[0].reason).toContain("not an object or array");
  });

  it("extracts JSON from prose provider output", async () => {
    const root = temp();
    writeGraph(root, graph(root));
    const provider = new TextProvider(
      'Here is the JSON:\n{"links":[{"behavior_id":"REQ-1","symbol_id":"sym:src/discount.ts#applyDiscount","confidence":0.8}]}'
    );

    const result = asGenerate(await opAiLinks(root, {}, { clock: CLOCK, env: {}, aiProvider: provider }));

    expect(result.links).toBe(1);
    expect(result.dropped_links).toBe(0);
  });

  it("retries a non-JSON AI-link batch with a strict JSON repair prompt", async () => {
    const root = temp();
    writeGraph(root, graph(root));
    const provider = new SequenceProvider([
      "I would connect the discount behavior to applyDiscount, but here is prose instead of JSON.",
      '{"links":[{"behavior_id":"REQ-1","symbol_id":"sym:src/discount.ts#applyDiscount","confidence":0.91,"rationale":"discount behavior maps to discount implementation"}]}'
    ]);

    const result = asGenerate(await opAiLinks(root, {}, { clock: CLOCK, env: {}, aiProvider: provider }));

    expect(provider.calls).toBe(2);
    expect(provider.requests[1].user).toContain("INVALID_RESPONSE_SNIPPET");
    expect(provider.requests[1].user).toContain("Return JSON only");
    expect(result.links).toBe(1);
    expect(result.dropped_links).toBe(0);
  });

  it("keeps a failed repair in dropped links without applying proof", async () => {
    const root = temp();
    writeGraph(root, graph(root));
    const provider = new SequenceProvider(["not json", "still not json"]);

    const result = asGenerate(await opAiLinks(root, {}, { clock: CLOCK, env: {}, aiProvider: provider }));

    expect(provider.calls).toBe(2);
    expect(result.links).toBe(0);
    expect(result.dropped_links).toBe(1);
    const artifact = JSON.parse(readFileSync(result.ai_links_path, "utf8"));
    expect(artifact.dropped_links[0].reason).toContain("after retry");
  });

  it("applied AI links surface as weak generation grounding, never proof", async () => {
    const root = temp();
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src", "discount.ts"), "export function applyDiscount(total: number) { return total > 100 ? total * 0.9 : total; }\n");
    const g = graph(root);
    writeGraph(root, g);
    const provider = new JsonProvider({
      links: [{ behavior_id: "REQ-1", symbol_id: "sym:src/discount.ts#applyDiscount", confidence: 0.8 }]
    });
    await opAiLinks(root, {}, { clock: CLOCK, env: {}, aiProvider: provider });
    await opAiLinks(root, { apply: true }, { clock: CLOCK, env: {} });
    const withAi = loadGraph(workspacePaths(root).graphPath);

    const generated = await generateTests(
      withAi,
      { target_ids: ["REQ-1"], limit: 1 },
      new DeterministicProvider(),
      (rel) => (rel === "src/discount.ts" ? readFileSync(join(root, rel), "utf8") : null),
      CLOCK
    );

    expect(generated.generated_tests).toHaveLength(1);
    expect(generated.generated_tests[0].weak_evidence_used).toBe(true);
    expect(generated.generated_tests[0].grounding.weak_relationships_used).toContain(
      "MAY_RELATE_TO:REQ-1->sym:src/discount.ts#applyDiscount"
    );
    expect(resolveCoverage(withAi).coverage.confirmed).toBe(1);
  });
});
