import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  AI_FLOWS_PROMPT_VERSION,
  MAX_CANDIDATE_FLOWS,
  MAX_CANDIDATE_FLOW_HOPS,
  type AiFlowsApplyResult,
  type AiFlowsGenerateResult,
  type AiFlowsResult
} from "../../src/local/flows/llmFlowDiscovery.js";
import { opAiFlows, opAnalyze, opBehaviorCoverageHtml, opStart } from "../../src/local/operations.js";
import { gatherContext } from "../../src/local/generate/generator.js";
import { buildPlanningSystemPromptV5, buildPlanningUserPromptV5 } from "../../src/local/generate/promptV5.js";
import { makeEdge, makeNode } from "../../src/local/graph/factories.js";
import {
  LOCAL_GRAPH_SCHEMA_VERSION,
  type CandidateFlowMeta,
  type CandidateFlowRejections,
  type LocalGraph
} from "../../src/local/graph/ontology.js";
import { LEDGER_SCHEMA_VERSION, targetFingerprint, type Ledger } from "../../src/local/ledger.js";
import { buildPack } from "../../src/local/pack/exporter.js";
import { buildRtm } from "../../src/local/rtm.js";
import { rankRiskGaps } from "../../src/local/score/risk.js";
import type { ModelCompletionRequest, ModelProvider, ScoreResult } from "../../src/local/types.js";
import { buildBehaviorReportData } from "../../src/local/viz/behaviorReportData.js";
import { renderBehaviorReport } from "../../src/local/viz/behaviorReportHtml.js";
import { buildVizPayload } from "../../src/local/viz/payload.js";
import { opInit } from "../../src/local/operations.js";
import { loadGraph, saveGraph, workspacePaths } from "../../src/local/workspace.js";

const CLOCK = () => "2026-07-02T00:00:00Z";
const DEPS = { clock: CLOCK, env: {} as NodeJS.ProcessEnv };
const EMPTY_LEDGER: Ledger = { schema_version: LEDGER_SCHEMA_VERSION, records: [] };
const provenance = { source_scope_id: "repo", source_ref: "src/users.controller.ts", detector: "test" };

const CONTROLLER = "sym:src/users.controller.ts#UsersController.create";
const SERVICE = "sym:src/users.service.ts#UsersService.create";
const REPO = "sym:src/users.repository.ts#UserRepository.save";
const HELPER = "sym:src/util.ts#formatName";
const ENTRY = "endpoint:post-users";
const UNKNOWN = "sym:src/evil.ts#notReal";
const MARKER = "AI_CANDIDATE_MARKER";

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

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), "op-ai-flows-"));
  dirs.push(dir);
  return dir;
}

class JsonProvider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-ai-flows";
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
  readonly modelName = "fake-ai-flows";

  constructor(private readonly body: string) {}

  async complete(): Promise<string> {
    return this.body;
  }
}

/** Reads the closed sets out of the prompt and proposes one flow from the first entry. */
class PromptFlowProvider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-ai-flows";
  requests: ModelCompletionRequest[] = [];

  async complete(req: ModelCompletionRequest): Promise<string> {
    this.requests.push(req);
    const entriesJson = req.user.split("ENTRY_POINTS:\n")[1]?.split("\n\nSYMBOLS:\n")[0] ?? "[]";
    const symbolsJson = req.user.split("SYMBOLS:\n")[1] ?? "[]";
    const entries = JSON.parse(entriesJson) as Array<{ id: string; start: string }>;
    const symbols = JSON.parse(symbolsJson) as Array<{ id: string }>;
    const flows = entries
      .map((entry) => {
        const hop = symbols.find((s) => s.id !== entry.start)?.id;
        return hop
          ? { entry_id: entry.id, hop_ids: [hop], title: "E2E order chain", rationale: "prompt-derived", confidence: 0.9 }
          : null;
      })
      .filter((f): f is NonNullable<typeof f> => f !== null)
      .slice(0, 1);
    return JSON.stringify({ flows });
  }
}

function codeSymbol(id: string, title: string, file: string): ReturnType<typeof makeNode> {
  return makeNode({
    kind: "CodeSymbol",
    external_id: id,
    title,
    properties: { file, symbol_kind: "method" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { ...provenance, source_ref: file },
    behavior_source: "code_export",
    denominator_eligible: true
  });
}

function calls(from: string, to: string): ReturnType<typeof makeEdge> {
  return makeEdge({
    from_external_id: from,
    to_external_id: to,
    relationship_type: "CALLS",
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance,
    properties: { call_via: "injected", resolution: "injected" }
  });
}

/** Typed NestJS-style fixture: POST /users → controller → service → repository,
 *  with one deterministic hard flow persisted in analysis.flows. */
function nestGraph(root: string): LocalGraph {
  const endpoint = makeNode({
    kind: "Endpoint",
    external_id: ENTRY,
    title: "POST /users",
    properties: { method: "POST", path: "/users" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance,
    behavior_source: "contract_entrypoint",
    denominator_eligible: false
  });
  const controller = codeSymbol(CONTROLLER, "UsersController.create", "src/users.controller.ts");
  controller.properties.description = "Validates the request body and delegates to the service.";
  const service = codeSymbol(SERVICE, "UsersService.create", "src/users.service.ts");
  service.properties.description = "Hashes credentials and persists the user.";
  const repo = codeSymbol(REPO, "UserRepository.save", "src/users.repository.ts");
  repo.properties.description = "Writes the user record.";
  repo.properties.source_body = "SECRET_BODY_SHOULD_NOT_APPEAR";
  const helper = codeSymbol(HELPER, "formatName", "src/util.ts");
  const test = makeNode({
    kind: "TestCase",
    external_id: "test:src/users.controller.spec.ts",
    title: "users.controller.spec.ts",
    properties: { file: "src/users.controller.spec.ts", test_layer: "integration", test_names: ["creates a user"] },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { ...provenance, source_ref: "src/users.controller.spec.ts" }
  });
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "users-api", root, root_hash: "sha256:x", source_upload_policy: "metadata_only" },
    created_at: CLOCK(),
    updated_at: CLOCK(),
    sources: [],
    nodes: [endpoint, controller, service, repo, helper, test],
    edges: [
      makeEdge({
        from_external_id: ENTRY,
        to_external_id: CONTROLLER,
        relationship_type: "IMPLEMENTED_IN",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance
      }),
      calls(CONTROLLER, SERVICE),
      calls(SERVICE, REPO),
      makeEdge({
        from_external_id: "test:src/users.controller.spec.ts",
        to_external_id: CONTROLLER,
        relationship_type: "COVERS",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance
      })
    ],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: CLOCK(), git: null, files: { "src/users.controller.ts": { hash: "sha256:users-v1", size: 64, kind: "code" } } },
    analysis: {
      test_files: 1,
      inferred_flows: 0,
      flows_truncated: 0,
      max_inferred_flows: 50000,
      symbol_cap_hit: false,
      flows: {
        method: "static_calls_weakest_link",
        total_flows: 1,
        by_tier: { "hard: reachable": 1, "framework-derived: reachable": 0 },
        truncated_flows: 0,
        dropped: { max_depth: 0, max_flows_per_entry: 0, global_cap: 0 },
        options: { max_depth: 8, max_flows_per_entry: 20, global_cap: 500 },
        flows: [
          {
            id: "flow:users",
            entry_point: { external_id: ENTRY, kind: "Endpoint", title: "POST /users" },
            hops: [
              { from: CONTROLLER, to: SERVICE, evidence_strength: "hard", resolution: "injected" },
              { from: SERVICE, to: REPO, evidence_strength: "hard", resolution: "injected" }
            ],
            terminal: REPO,
            depth: 2,
            flow_tier: "hard: reachable"
          }
        ]
      }
    }
  };
}

/** Hand-built candidate meta (as the apply phase would store it). */
function candidateMeta(): CandidateFlowMeta {
  return {
    method: "llm_closed_anchor_proposal",
    rejections: {
      proposed: 3,
      accepted: 1,
      rejected_missing_anchor: 1,
      rejected_unresolved_hop: 1,
      rejected_cycle: 0,
      rejected_over_cap: 0,
      rejected_duplicate: 0,
      rejected_malformed: 0
    },
    options: { max_flows: MAX_CANDIDATE_FLOWS, max_hops: MAX_CANDIDATE_FLOW_HOPS },
    provenance: {
      model_provider: "fake",
      model_name: "fake-ai-flows",
      prompt_version: AI_FLOWS_PROMPT_VERSION,
      cache_key: "cachekey1"
    },
    flows: [
      {
        id: "candidateflow:users",
        entry_point: { external_id: ENTRY, kind: "Endpoint", title: "POST /users" },
        hops: [
          { from: CONTROLLER, to: SERVICE, evidence_strength: "candidate", hop_status: "matches_known_edge" },
          { from: SERVICE, to: HELPER, evidence_strength: "candidate", hop_status: "unverified" }
        ],
        terminal: HELPER,
        depth: 2,
        review_status: "ai_suggested",
        confidence: 0.61,
        title: "User signup chain",
        rationale: `${MARKER} plausible signup path from endpoint metadata`,
        provenance: {
          source_scope_id: "ai:cachekey1",
          source_ref: ".orangepro/ai/flows.json",
          detector: "ai_flows",
          model_provider: "fake",
          model_name: "fake-ai-flows",
          prompt_version: AI_FLOWS_PROMPT_VERSION,
          cache_key: "cachekey1"
        }
      }
    ]
  };
}

function withCandidates(graph: LocalGraph): LocalGraph {
  const next = structuredClone(graph);
  next.analysis = { ...next.analysis!, candidate_flows: candidateMeta() };
  return next;
}

function dynamicLedger(g: LocalGraph = nestGraph("/tmp/users-api")): Ledger {
  return {
    schema_version: LEDGER_SCHEMA_VERSION,
    records: [
      {
        run_id: "run:dynamic",
        target_symbol: CONTROLLER,
        pre_edges: [],
        new_edges: [],
        closed: true,
        status: "reproven",
        target_fingerprint: targetFingerprint(g, CONTROLLER),
        dynamic_proof: {
          proof_kind: "dynamic_targeted",
          baseline_green: true,
          mutant_failed_assertion: true,
          target_not_mocked: true,
          sentinel: "return-json",
          runner: "vitest",
          test_path: "src/users.controller.spec.ts"
        },
        ts: CLOCK(),
        pre_edge_count: 0
      }
    ]
  };
}

/** Star fixture: one Behavior entry `hub` with `fanOut` one-hop callees. */
function starGraph(root: string, fanOut: number): LocalGraph {
  const hub = codeSymbol("sym:src/hub.ts#Hub.run", "Hub.run", "src/hub.ts");
  const targets = Array.from({ length: fanOut }, (_, i) =>
    codeSymbol(`sym:src/t${i}.ts#T${i}.go`, `T${i}.go`, `src/t${i}.ts`)
  );
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "star", root, root_hash: "sha256:star", source_upload_policy: "metadata_only" },
    created_at: CLOCK(),
    updated_at: CLOCK(),
    sources: [],
    nodes: [hub, ...targets],
    edges: targets.map((t) => calls("sym:src/hub.ts#Hub.run", t.external_id)),
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: CLOCK(), git: null, files: {} }
  };
}

/** Chain fixture: c0 → c1 → … → c10 (Behavior entry c0, 10 resolvable hops). */
function chainGraph(root: string): LocalGraph {
  const nodes = Array.from({ length: 11 }, (_, i) => codeSymbol(`sym:src/c${i}.ts#C${i}.step`, `C${i}.step`, `src/c${i}.ts`));
  const edges = nodes.slice(0, -1).map((n, i) => calls(n.external_id, nodes[i + 1].external_id));
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "chain", root, root_hash: "sha256:chain", source_upload_policy: "metadata_only" },
    created_at: CLOCK(),
    updated_at: CLOCK(),
    sources: [],
    nodes,
    edges,
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: CLOCK(), git: null, files: {} }
  };
}

function writeGraph(root: string, graph: LocalGraph): void {
  opInit(root, DEPS);
  saveGraph(workspacePaths(root).graphPath, graph);
}

function asGenerate(result: AiFlowsResult): AiFlowsGenerateResult {
  if (result.mode !== "generate") throw new Error("expected generate result");
  return result;
}

function asApply(result: AiFlowsResult): AiFlowsApplyResult {
  if (result.mode !== "apply") throw new Error("expected apply result");
  return result;
}

function sumRejected(r: CandidateFlowRejections): number {
  return (
    r.rejected_missing_anchor +
    r.rejected_unresolved_hop +
    r.rejected_cycle +
    r.rejected_over_cap +
    r.rejected_duplicate +
    r.rejected_malformed
  );
}

function expectInvariant(r: CandidateFlowRejections): void {
  expect(r.proposed).toBe(r.accepted + sumRejected(r));
}

async function generateAndApply(root: string, graph: LocalGraph, body: unknown): Promise<AiFlowsApplyResult> {
  writeGraph(root, graph);
  await opAiFlows(root, {}, { ...DEPS, aiProvider: new JsonProvider(body) });
  return asApply(await opAiFlows(root, { apply: true }, DEPS));
}

const VALID_FLOW = {
  entry_id: ENTRY,
  hop_ids: [SERVICE, REPO],
  title: "User signup chain",
  rationale: "endpoint + service ids suggest a signup path",
  confidence: 0.7
};

// ─────────────────────────────────────────────────────────────────────────────
// FIREWALL — candidate flows must not move ANY trust surface.
// ─────────────────────────────────────────────────────────────────────────────
describe("tier firewall — candidate flows are never evidence", () => {
  it("RTM (rows + summary incl. proven), risk ranking, and viz payload are identical with and without candidate flows", () => {
    const g1 = nestGraph("/tmp/users-api");
    const g2 = withCandidates(g1);

    expect(buildRtm(g2, EMPTY_LEDGER)).toEqual(buildRtm(g1, EMPTY_LEDGER));
    expect(rankRiskGaps(g2, { limit: 50 })).toEqual(rankRiskGaps(g1, { limit: 50 }));

    // The viz payload passes graph.analysis through VERBATIM in meta.analysis
    // (an unrendered, clearly-labeled metadata block — html.ts never reads it).
    // Pin that this labeled passthrough is the ONLY difference: every rendered
    // surface (static_flows, tier tallies, gaps, edges, meta counts) is identical.
    const p1 = buildVizPayload(g1, SCORE, EMPTY_LEDGER);
    const p2 = buildVizPayload(g2, SCORE, EMPTY_LEDGER);
    const strip = (p: ReturnType<typeof buildVizPayload>): ReturnType<typeof buildVizPayload> => {
      const clone = structuredClone(p);
      if (clone.meta.analysis) delete clone.meta.analysis.candidate_flows;
      return clone;
    };
    expect(p1.meta.analysis?.candidate_flows).toBeUndefined();
    expect(p2.meta.analysis?.candidate_flows?.flows.every((f) => f.review_status === "ai_suggested")).toBe(true);
    expect(strip(p2)).toEqual(strip(p1));
  });

  it("a dynamic proof yields the same Proven with candidate flows present as without", () => {
    const g1 = nestGraph("/tmp/users-api");
    const g2 = withCandidates(g1);
    const ledger = dynamicLedger();

    const without = buildRtm(g1, ledger);
    const withMeta = buildRtm(g2, ledger);
    expect(without.summary.proven).toBeGreaterThan(0);
    expect(withMeta.summary).toEqual(without.summary);
    expect(withMeta.rows).toEqual(without.rows);
  });

  it("report summary, pipeline strip, tier tallies, deterministic flow rows, and risks are identical with and without candidate flows", () => {
    const g1 = nestGraph("/tmp/users-api");
    const g2 = withCandidates(g1);
    const d1 = buildBehaviorReportData(g1, EMPTY_LEDGER, { repoRoot: "/tmp/users-api" });
    const d2 = buildBehaviorReportData(g2, EMPTY_LEDGER, { repoRoot: "/tmp/users-api" });

    expect(d2.summary).toEqual(d1.summary);
    expect(d2.pipeline).toEqual(d1.pipeline);
    expect(d2.behaviorGroups).toEqual(d1.behaviorGroups);
    expect(d2.behaviors).toEqual(d1.behaviors);
    expect(d2.flows).toEqual(d1.flows);
    expect(d2.risks).toEqual(d1.risks);
    // The one intended difference: the report-only candidate section.
    expect(d1.candidateFlows).toBeNull();
    expect(d2.candidateFlows).not.toBeNull();
  });

  it("apply mutates ONLY analysis.candidate_flows — edges, candidate_edges, nodes, denominator, and analysis.flows are untouched", async () => {
    const root = temp();
    const g = nestGraph(root);
    await generateAndApply(root, g, { flows: [VALID_FLOW] });

    const after = loadGraph(workspacePaths(root).graphPath);
    expect(after.edges).toEqual(g.edges);
    expect(after.candidate_edges).toEqual(g.candidate_edges);
    expect(after.nodes).toEqual(g.nodes);
    expect(after.analysis?.flows).toEqual(g.analysis?.flows);
    const meta = after.analysis?.candidate_flows;
    expect(meta).toBeDefined();
    expect(meta?.flows).toHaveLength(1);
    for (const flow of meta?.flows ?? []) {
      expect(flow.review_status).toBe("ai_suggested");
      expect(Object.keys(flow)).not.toContain("flow_tier");
      expect(flow.provenance.model_provider).toBe("fake");
      expect(flow.provenance.model_name).toBe("fake-ai-flows");
      expect(flow.provenance.prompt_version).toBe(AI_FLOWS_PROMPT_VERSION);
      expect(flow.provenance.cache_key).toBeTruthy();
      for (const hop of flow.hops) expect(hop.evidence_strength).toBe("candidate");
    }
  });

  it("generate stages the artifact without mutating graph.json", async () => {
    const root = temp();
    writeGraph(root, nestGraph(root));
    const before = readFileSync(workspacePaths(root).graphPath, "utf8");

    const res = asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: new JsonProvider({ flows: [VALID_FLOW] }) }));

    expect(res.flows).toBe(1);
    expect(existsSync(res.ai_flows_path)).toBe(true);
    expect(readFileSync(workspacePaths(root).graphPath, "utf8")).toBe(before);
  });

  it("opStart never auto-runs ai-flows", async () => {
    const root = temp();
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0" }), "utf8");
    writeFileSync(
      join(root, "service.ts"),
      ["export function createOrder(id: string): string {", "  return `order-${id}`;", "}", ""].join("\n"),
      "utf8"
    );
    const provider = new JsonProvider({ links: [] });

    await opStart(root, { source: root }, { ...DEPS, aiProvider: provider });

    expect(existsSync(join(root, ".orangepro", "ai", "flows.json"))).toBe(false);
    const graph = loadGraph(workspacePaths(root).graphPath);
    expect(graph.analysis?.candidate_flows).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Rejection accounting — one test per class + the invariant everywhere.
// ─────────────────────────────────────────────────────────────────────────────
describe("rejection accounting — proposed === accepted + Σ rejected_*", () => {
  async function generate(root: string, graph: LocalGraph, body: unknown): Promise<AiFlowsGenerateResult> {
    writeGraph(root, graph);
    return asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: new JsonProvider(body) }));
  }

  it("counts malformed entries (non-object, missing ids, empty hops)", async () => {
    const root = temp();
    const res = await generate(root, nestGraph(root), {
      flows: [42, { entry_id: ENTRY }, { entry_id: ENTRY, hop_ids: [] }, VALID_FLOW]
    });
    expect(res.rejections.rejected_malformed).toBe(3);
    expect(res.rejections.accepted).toBe(1);
    expect(res.rejections.proposed).toBe(4);
    expectInvariant(res.rejections);
  });

  it("rejects a non-entry start (missing anchor)", async () => {
    const root = temp();
    const res = await generate(root, nestGraph(root), {
      flows: [{ ...VALID_FLOW, entry_id: SERVICE, hop_ids: [REPO] }]
    });
    expect(res.rejections.rejected_missing_anchor).toBe(1);
    expect(res.rejections.accepted).toBe(0);
    expectInvariant(res.rejections);
  });

  it("rejects a flow with any unknown hop id (unresolved hop)", async () => {
    const root = temp();
    const res = await generate(root, nestGraph(root), {
      flows: [{ ...VALID_FLOW, hop_ids: [SERVICE, UNKNOWN] }]
    });
    expect(res.rejections.rejected_unresolved_hop).toBe(1);
    expect(res.rejections.accepted).toBe(0);
    expectInvariant(res.rejections);
  });

  it("rejects a hop chain that revisits a node (cycle)", async () => {
    const root = temp();
    const res = await generate(root, nestGraph(root), {
      flows: [{ ...VALID_FLOW, hop_ids: [SERVICE, CONTROLLER] }]
    });
    expect(res.rejections.rejected_cycle).toBe(1);
    expect(res.rejections.accepted).toBe(0);
    expectInvariant(res.rejections);
  });

  it("rejects a chain beyond the hop cap (over cap)", async () => {
    const root = temp();
    const g = chainGraph(root);
    const hops = Array.from({ length: MAX_CANDIDATE_FLOW_HOPS + 1 }, (_, i) => `sym:src/c${i + 1}.ts#C${i + 1}.step`);
    const res = await generate(root, g, {
      flows: [{ entry_id: "sym:src/c0.ts#C0.step", hop_ids: hops, confidence: 0.5 }]
    });
    expect(res.rejections.rejected_over_cap).toBe(1);
    expect(res.rejections.accepted).toBe(0);
    expectInvariant(res.rejections);
  });

  it("keeps at most MAX_CANDIDATE_FLOWS flows and counts the overflow (over cap)", async () => {
    const root = temp();
    const g = starGraph(root, 30);
    const flows = Array.from({ length: MAX_CANDIDATE_FLOWS + 1 }, (_, i) => ({
      entry_id: "sym:src/hub.ts#Hub.run",
      hop_ids: [`sym:src/t${i}.ts#T${i}.go`],
      confidence: 0.5
    }));
    const res = await generate(root, g, { flows });
    expect(res.rejections.accepted).toBe(MAX_CANDIDATE_FLOWS);
    expect(res.rejections.rejected_over_cap).toBe(1);
    expectInvariant(res.rejections);
  });

  it("rejects duplicates of an already-accepted flow", async () => {
    const root = temp();
    const res = await generate(root, nestGraph(root), { flows: [VALID_FLOW, { ...VALID_FLOW, confidence: 0.2 }] });
    expect(res.rejections.rejected_duplicate).toBe(1);
    expect(res.rejections.accepted).toBe(1);
    expectInvariant(res.rejections);
  });

  it("persists identical rejection counters in the artifact and surfaces them on the result", async () => {
    const root = temp();
    const res = await generate(root, nestGraph(root), {
      flows: [VALID_FLOW, { ...VALID_FLOW, hop_ids: [SERVICE, UNKNOWN] }, "junk"]
    });
    const artifact = JSON.parse(readFileSync(res.ai_flows_path, "utf8"));
    expect(artifact.rejections).toEqual(res.rejections);
    expect(res.rejections).toEqual({
      proposed: 3,
      accepted: 1,
      rejected_missing_anchor: 0,
      rejected_unresolved_hop: 1,
      rejected_cycle: 0,
      rejected_over_cap: 0,
      rejected_duplicate: 0,
      rejected_malformed: 1
    });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Apply-phase re-validation against the CURRENT graph.
// ─────────────────────────────────────────────────────────────────────────────
describe("apply re-validates against the current graph", () => {
  it("drops artifact flows whose ids no longer resolve, moving counts into the same rejection buckets", async () => {
    const root = temp();
    const g = nestGraph(root);
    writeGraph(root, g);
    await opAiFlows(root, {}, { ...DEPS, aiProvider: new JsonProvider({ flows: [VALID_FLOW] }) });

    // The repository symbol disappears before apply (stale artifact id).
    const shrunk: LocalGraph = {
      ...g,
      nodes: g.nodes.filter((n) => n.external_id !== REPO),
      edges: g.edges.filter((e) => e.from_external_id !== REPO && e.to_external_id !== REPO)
    };
    saveGraph(workspacePaths(root).graphPath, shrunk);

    const res = asApply(await opAiFlows(root, { apply: true }, DEPS));
    expect(res.applied_flows).toBe(0);
    expect(res.rejections.accepted).toBe(0);
    expect(res.rejections.rejected_unresolved_hop).toBe(1);
    expectInvariant(res.rejections);

    const after = loadGraph(workspacePaths(root).graphPath);
    expect(after.analysis?.candidate_flows?.flows).toEqual([]);
    expectInvariant(after.analysis!.candidate_flows!.rejections);
  });

  it("stores hop_status per hop (matches_known_edge vs unverified) without touching evidence_strength", async () => {
    const root = temp();
    const g = nestGraph(root);
    // Propose controller → repo directly: no known CALLS edge controller→repo.
    const res = await generateAndApply(root, g, {
      flows: [
        VALID_FLOW,
        { entry_id: ENTRY, hop_ids: [REPO], title: "shortcut", rationale: "skips the service", confidence: 0.3 }
      ]
    });
    expect(res.applied_flows).toBe(2);

    const meta = loadGraph(workspacePaths(root).graphPath).analysis?.candidate_flows;
    const known = meta?.flows.find((f) => f.terminal === REPO && f.depth === 2);
    const shortcut = meta?.flows.find((f) => f.depth === 1);
    expect(known?.hops.map((h) => h.hop_status)).toEqual(["matches_known_edge", "matches_known_edge"]);
    expect(shortcut?.hops.map((h) => h.hop_status)).toEqual(["unverified"]);
    for (const hop of [...(known?.hops ?? []), ...(shortcut?.hops ?? [])]) {
      expect(hop.evidence_strength).toBe("candidate");
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Metadata-only lane.
// ─────────────────────────────────────────────────────────────────────────────
describe("metadata-only lane", () => {
  it("never sends or stores source bodies", async () => {
    const root = temp();
    writeGraph(root, nestGraph(root));
    const provider = new JsonProvider({ flows: [VALID_FLOW] });
    const gen = asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: provider }));
    await opAiFlows(root, { apply: true }, DEPS);

    expect(provider.requests[0].user).not.toContain("SECRET_BODY_SHOULD_NOT_APPEAR");
    expect(provider.requests[0].system).not.toContain("SECRET_BODY_SHOULD_NOT_APPEAR");
    expect(readFileSync(gen.ai_flows_path, "utf8")).not.toContain("SECRET_BODY_SHOULD_NOT_APPEAR");
    const meta = loadGraph(workspacePaths(root).graphPath).analysis?.candidate_flows;
    expect(JSON.stringify(meta)).not.toContain("SECRET_BODY_SHOULD_NOT_APPEAR");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt slice — the two planning lines + deterministic-only flow_chain.
// ─────────────────────────────────────────────────────────────────────────────
describe("planning prompt absorption", () => {
  it("system prompt contains exactly the two new lines", () => {
    const prompt = buildPlanningSystemPromptV5();
    expect(prompt).toContain("Find all gaps. No cap. If evidence justifies 3, output 3. If 30, output 30.");
    expect(prompt).toContain("When FLOW CHAIN exists, prioritize gaps at service boundaries.");
  });

  it("gatherContext populates flow_chain from deterministic analysis.flows for a behavior inside a flow", () => {
    const g = nestGraph("/tmp/users-api");
    const service = g.nodes.find((n) => n.external_id === SERVICE)!;
    const { ctx } = gatherContext(g, service, "jest", () => null);

    expect(ctx.flow_chain).toBeDefined();
    expect(ctx.flow_chain?.map((s) => s.behavior_id)).toEqual([CONTROLLER, SERVICE, REPO]);
    expect(ctx.flow_chain?.map((s) => s.position)).toEqual([1, 2, 3]);
    expect(ctx.flow_chain?.[1]).toMatchObject({ service: "UsersService", method: "create" });

    const user = buildPlanningUserPromptV5(ctx);
    expect(user).toContain("FLOW CHAIN:");
    expect(user).toContain("2. UsersService.create ←");
  });

  it("leaves flow_chain undefined when no deterministic flow contains the behavior", () => {
    const g = nestGraph("/tmp/users-api");
    const helper = g.nodes.find((n) => n.external_id === HELPER)!;
    const { ctx } = gatherContext(g, helper, "jest", () => null);
    expect(ctx.flow_chain).toBeUndefined();
  });

  it("candidate flows never reach any prompt context", () => {
    const g = withCandidates(nestGraph("/tmp/users-api"));
    // Candidate-only chain: service → helper exists ONLY in candidate_flows.
    const service = g.nodes.find((n) => n.external_id === SERVICE)!;
    const { ctx } = gatherContext(g, service, "jest", () => null);

    expect(ctx.flow_chain?.map((s) => s.behavior_id)).toEqual([CONTROLLER, SERVICE, REPO]);
    expect(ctx.flow_chain?.some((s) => s.behavior_id === HELPER)).toBe(false);
    const user = buildPlanningUserPromptV5(ctx);
    expect(user).not.toContain(MARKER);
    expect(user).not.toContain("candidate");

    const helper = g.nodes.find((n) => n.external_id === HELPER)!;
    const helperCtx = gatherContext(g, helper, "jest", () => null).ctx;
    expect(helperCtx.flow_chain).toBeUndefined();
    expect(buildPlanningUserPromptV5(helperCtx)).not.toContain(MARKER);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Report data — candidate flows only in the clearly-labeled AI section.
// ─────────────────────────────────────────────────────────────────────────────
describe("behavior report — AI-suggested section", () => {
  it("exposes candidate flows only under candidateFlows with proposed → accepted and provenance", () => {
    const g = withCandidates(nestGraph("/tmp/users-api"));
    const data = buildBehaviorReportData(g, EMPTY_LEDGER, { repoRoot: "/tmp/users-api" });

    expect(data.candidateFlows).toMatchObject({
      proposed: 3,
      accepted: 1,
      model: "fake/fake-ai-flows",
      prompt_version: AI_FLOWS_PROMPT_VERSION
    });
    expect(data.candidateFlows?.flows).toHaveLength(1);
    const flow = data.candidateFlows!.flows[0];
    expect(flow.title).toBe("User signup chain");
    expect(flow.steps.map((s) => s.hop)).toEqual([null, "matches_known_edge", "unverified"]);
    // Deterministic flow rows never include the candidate-only chain.
    expect(JSON.stringify(data.flows)).not.toContain(MARKER);
    expect(data.flows.every((f) => f.flow_tier === "hard: reachable" || f.flow_tier === "framework-derived: reachable")).toBe(true);
  });

  it("renders candidate-flow dynamic content when present and omits it when absent", () => {
    const g = withCandidates(nestGraph("/tmp/users-api"));
    const html = renderBehaviorReport(buildBehaviorReportData(g, EMPTY_LEDGER, { repoRoot: "/tmp/users-api" }));
    expect(html).toContain("AI-suggested flows — plausible paths, not proven");
    expect(html).toContain("User signup chain");
    expect(html).toContain('"proposed":3');
    expect(html).toContain('"accepted":1');

    const htmlNone = renderBehaviorReport(buildBehaviorReportData(nestGraph("/tmp/users-api"), EMPTY_LEDGER, { repoRoot: "/tmp/users-api" }));
    expect(htmlNone).toContain('"candidateFlows":null');
    expect(htmlNone).not.toContain("User signup chain");
  });

  it("never embeds raw HTML from model-derived candidate strings", () => {
    const g = withCandidates(nestGraph("/tmp/users-api"));
    g.analysis!.candidate_flows!.flows[0].title = "<img src=x onerror=alert(1)>";
    const html = renderBehaviorReport(buildBehaviorReportData(g, EMPTY_LEDGER, { repoRoot: "/tmp/users-api" }));
    expect(html).not.toContain("<img src=x");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Evidence pack — candidate flows never cross the export boundary (pinned).
// ─────────────────────────────────────────────────────────────────────────────
describe("evidence pack export", () => {
  it("excludes candidate flows entirely — never presented as deterministic flows", () => {
    const g = withCandidates(nestGraph("/tmp/users-api"));
    const pack = buildPack(g, SCORE, undefined, CLOCK);
    const json = JSON.stringify(pack);
    expect(json).not.toContain("candidate_flows");
    expect(json).not.toContain("llm_closed_anchor_proposal");
    expect(json).not.toContain(MARKER);
    expect(json).not.toContain(AI_FLOWS_PROMPT_VERSION);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Persistence — applied flows must survive re-analysis (fix 1).
// ─────────────────────────────────────────────────────────────────────────────
describe("candidate flows survive re-analysis (persistence E2E)", () => {
  function writeOrdersFixture(dir: string, withCallee: boolean): void {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "fixture-app", version: "1.0.0" }), "utf8");
    writeFileSync(
      join(dir, "orders.ts"),
      withCallee
        ? [
            "export function submitOrder(id: string): string {",
            "  return persistOrder(id);",
            "}",
            "",
            "export function persistOrder(id: string): string {",
            "  return `order-${id}`;",
            "}",
            ""
          ].join("\n")
        : ["export function submitOrder(id: string): string {", "  return `order-${id}`;", "}", ""].join("\n"),
      "utf8"
    );
  }

  it("analyze → ai-flows → apply → analyze again keeps the candidate section alive end to end", async () => {
    const root = temp();
    writeOrdersFixture(root, true);
    opAnalyze(root, { source: root }, DEPS);

    const gen = asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: new PromptFlowProvider() }));
    expect(gen.flows).toBe(1);

    const applied = asApply(await opAiFlows(root, { apply: true }, DEPS));
    expect(applied.applied_flows).toBe(1);
    // apply re-renders the behavior report so applied flows are actually visible
    expect(applied.behavior_coverage_path).toBeDefined();
    expect(readFileSync(applied.behavior_coverage_path as string, "utf8")).toContain("E2E order chain");

    // Re-analysis must NOT drop the applied flows (they re-validate cleanly).
    opAnalyze(root, { source: root }, DEPS);
    const meta = loadGraph(workspacePaths(root).graphPath).analysis?.candidate_flows;
    expect(meta?.flows).toHaveLength(1);
    expect(meta?.flows[0]?.title).toBe("E2E order chain");
    expectInvariant(meta!.rejections);

    const html = opBehaviorCoverageHtml(root, ".orangepro/behavior-coverage.html").behavior_coverage_path;
    expect(readFileSync(html, "utf8")).toContain("E2E order chain");
  });

  it("re-analysis re-validates stored flows: a vanished hop moves accepted into a rejection bucket", async () => {
    const root = temp();
    writeOrdersFixture(root, true);
    opAnalyze(root, { source: root }, DEPS);
    await opAiFlows(root, {}, { ...DEPS, aiProvider: new PromptFlowProvider() });
    await opAiFlows(root, { apply: true }, DEPS);

    writeOrdersFixture(root, false); // the hop target disappears from the repo
    opAnalyze(root, { source: root }, DEPS);

    const meta = loadGraph(workspacePaths(root).graphPath).analysis?.candidate_flows;
    expect(meta?.flows).toHaveLength(0);
    expect(meta?.rejections.accepted).toBe(0);
    expect(
      (meta?.rejections.rejected_unresolved_hop ?? 0) + (meta?.rejections.rejected_missing_anchor ?? 0)
    ).toBeGreaterThan(0);
    expectInvariant(meta!.rejections);
  });

  it("re-analysis drops a malformed candidate lane instead of failing analyze", () => {
    const root = temp();
    writeOrdersFixture(root, true);
    opAnalyze(root, { source: root }, DEPS);
    const gpath = workspacePaths(root).graphPath;
    const g = loadGraph(gpath);

    // Malformed-but-parseable shape: flows is not an array (revalidation would throw).
    saveGraph(gpath, {
      ...g,
      analysis: {
        ...(g.analysis as NonNullable<typeof g.analysis>),
        candidate_flows: { method: "llm_closed_anchor_proposal", flows: "corrupted" } as never
      }
    });
    expect(() => opAnalyze(root, { source: root }, DEPS)).not.toThrow();
    expect(loadGraph(gpath).analysis?.candidate_flows).toBeUndefined();

    // Impossible accounting: accepted > proposed violates the sum invariant.
    const g2 = loadGraph(gpath);
    saveGraph(gpath, {
      ...g2,
      analysis: {
        ...(g2.analysis as NonNullable<typeof g2.analysis>),
        candidate_flows: {
          method: "llm_closed_anchor_proposal",
          rejections: {
            proposed: 1,
            accepted: 2,
            rejected_missing_anchor: 0,
            rejected_unresolved_hop: 0,
            rejected_cycle: 0,
            rejected_over_cap: 0,
            rejected_duplicate: 0,
            rejected_malformed: 0
          },
          options: { max_flows: 25, max_hops: 8 },
          provenance: { detector: "ai_flows" },
          flows: []
        } as never
      }
    });
    expect(() => opAnalyze(root, { source: root }, DEPS)).not.toThrow();
    expect(loadGraph(gpath).analysis?.candidate_flows).toBeUndefined();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Artifact is untrusted input (fix 2: schema validation / stored-XSS guard).
// ─────────────────────────────────────────────────────────────────────────────
describe("artifact schema validation", () => {
  async function stagedArtifact(root: string): Promise<string> {
    writeGraph(root, nestGraph(root));
    const res = asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: new JsonProvider({ flows: [VALID_FLOW] }) }));
    return res.ai_flows_path;
  }

  it("apply rejects an artifact whose rejection counters are not non-negative integers (stored-XSS vector)", async () => {
    const root = temp();
    const path = await stagedArtifact(root);
    const artifact = JSON.parse(readFileSync(path, "utf8"));
    artifact.rejections.proposed = "<img src=x onerror=alert(1)>";
    writeFileSync(path, JSON.stringify(artifact), "utf8");

    await expect(opAiFlows(root, { apply: true }, DEPS)).rejects.toThrow(/invalid or corrupted/);
    expect(loadGraph(workspacePaths(root).graphPath).analysis?.candidate_flows).toBeUndefined();
  });

  it("apply rejects an artifact whose flows disagree with the accepted counter", async () => {
    const root = temp();
    const path = await stagedArtifact(root);
    const artifact = JSON.parse(readFileSync(path, "utf8"));
    artifact.flows.push({ ...artifact.flows[0], title: "smuggled" }); // accepted counter stays 1
    writeFileSync(path, JSON.stringify(artifact), "utf8");

    await expect(opAiFlows(root, { apply: true }, DEPS)).rejects.toThrow(/invalid or corrupted/);
  });

  it("apply rejects an artifact whose counters violate proposed === accepted + Σ rejected_*", async () => {
    const root = temp();
    const path = await stagedArtifact(root);
    const artifact = JSON.parse(readFileSync(path, "utf8"));
    // Impossible accounting: accepted (1) already exceeds proposed (0) — the
    // "model proposed N → accepted M" honesty invariant must reject this even
    // though every counter is individually a non-negative integer and
    // flows.length still equals accepted.
    artifact.rejections.proposed = 0;
    artifact.rejections.accepted = 1;
    writeFileSync(path, JSON.stringify(artifact), "utf8");

    await expect(opAiFlows(root, { apply: true }, DEPS)).rejects.toThrow(/invalid or corrupted/);
    expect(loadGraph(workspacePaths(root).graphPath).analysis?.candidate_flows).toBeUndefined();
  });

  it("generate treats an invalid cached artifact as missing and regenerates with a warning", async () => {
    const root = temp();
    const path = await stagedArtifact(root);
    writeFileSync(path, "{ not json", "utf8");

    const res = asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: new JsonProvider({ flows: [VALID_FLOW] }) }));
    expect(res.cache_hit).toBe(false);
    expect(res.warnings.join("\n")).toContain("invalid");
    expect(JSON.parse(readFileSync(path, "utf8")).flows).toHaveLength(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Apply-time closed set = recorded shown set ∩ current graph (fix 3).
// ─────────────────────────────────────────────────────────────────────────────
describe("apply closed set", () => {
  it("refuses an artifact generated for a different workspace state (root hash mismatch)", async () => {
    const root = temp();
    const g = nestGraph(root);
    writeGraph(root, g);
    await opAiFlows(root, {}, { ...DEPS, aiProvider: new JsonProvider({ flows: [VALID_FLOW] }) });
    saveGraph(workspacePaths(root).graphPath, { ...g, workspace: { ...g.workspace, root_hash: "sha256:different" } });

    await expect(opAiFlows(root, { apply: true }, DEPS)).rejects.toThrow(/root hash mismatch/);
  });

  it("rejects hops that exist in the current graph but were never shown to the model", async () => {
    const root = temp();
    writeGraph(root, nestGraph(root));
    const gen = asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: new JsonProvider({ flows: [VALID_FLOW] }) }));
    const artifact = JSON.parse(readFileSync(gen.ai_flows_path, "utf8"));
    // REPO stays in the graph, but pretend it was never in the shown closed set.
    artifact.shown_symbol_ids = artifact.shown_symbol_ids.filter((id: string) => id !== REPO);
    writeFileSync(gen.ai_flows_path, JSON.stringify(artifact), "utf8");

    const res = asApply(await opAiFlows(root, { apply: true }, DEPS));
    expect(res.applied_flows).toBe(0);
    expect(res.rejections.rejected_unresolved_hop).toBe(1);
    expectInvariant(res.rejections);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// No sticky-zero cache + hardened parsing (fix 4).
// ─────────────────────────────────────────────────────────────────────────────
describe("no sticky-zero cache", () => {
  it("wrong-envelope JSON and prose stage nothing, warn, and are never cached — a retry re-asks the model", async () => {
    const root = temp();
    writeGraph(root, nestGraph(root));

    const wrongEnvelope = asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: new TextProvider(JSON.stringify({ data: [] })) }));
    expect(wrongEnvelope.flows).toBe(0);
    expect(wrongEnvelope.warnings.join("\n")).toContain("no parseable");
    expect(existsSync(wrongEnvelope.ai_flows_path)).toBe(false);

    const prose = asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: new TextProvider("I could not find any flows, sorry.") }));
    expect(existsSync(prose.ai_flows_path)).toBe(false);

    const good = asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: new JsonProvider({ flows: [VALID_FLOW] }) }));
    expect(good.cache_hit).toBe(false);
    expect(good.flows).toBe(1);
    expect(existsSync(good.ai_flows_path)).toBe(true);
  });

  it("extracts a JSON payload embedded in prose via the shared hardened parser", async () => {
    const root = temp();
    writeGraph(root, nestGraph(root));
    const provider = new TextProvider(`Sure! Here are the flows:\n${JSON.stringify({ flows: [VALID_FLOW] })}\nHope this helps.`);

    const res = asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: provider }));
    expect(res.flows).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Duplicate endpoint slugs get unique prompt ids (fix 5).
// ─────────────────────────────────────────────────────────────────────────────
describe("duplicate endpoint slugs", () => {
  const HANDLER_A = "sym:src/a.ts#HandlerA.handle";
  const HANDLER_B = "sym:src/b.ts#HandlerB.handle";
  const SVC_A = "sym:src/a.ts#SvcA.run";

  function dupEndpointGraph(root: string): LocalGraph {
    const endpoint = makeNode({
      kind: "Endpoint",
      external_id: "endpoint:dup",
      title: "POST /dup",
      properties: { method: "POST", path: "/dup" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance,
      behavior_source: "contract_entrypoint",
      denominator_eligible: false
    });
    const implementedIn = (to: string) =>
      makeEdge({
        from_external_id: "endpoint:dup",
        to_external_id: to,
        relationship_type: "IMPLEMENTED_IN",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance
      });
    return {
      schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
      workspace: { name: "dup", root, root_hash: "sha256:dup", source_upload_policy: "metadata_only" },
      created_at: CLOCK(),
      updated_at: CLOCK(),
      sources: [],
      nodes: [
        endpoint,
        codeSymbol(HANDLER_A, "HandlerA.handle", "src/a.ts"),
        codeSymbol(HANDLER_B, "HandlerB.handle", "src/b.ts"),
        codeSymbol(SVC_A, "SvcA.run", "src/a.ts")
      ],
      edges: [implementedIn(HANDLER_A), implementedIn(HANDLER_B), calls(HANDLER_A, SVC_A)],
      candidate_edges: [],
      generation_runs: [],
      generated_tests: [],
      manifest: { generated_at: CLOCK(), git: null, files: {} }
    };
  }

  it("shows one unique prompt id per (endpoint, handler start) and resolves hops per the right start", async () => {
    const root = temp();
    writeGraph(root, dupEndpointGraph(root));
    const provider = new JsonProvider({
      flows: [
        { entry_id: `endpoint:dup#${HANDLER_A}`, hop_ids: [SVC_A], confidence: 0.7 },
        { entry_id: `endpoint:dup#${HANDLER_B}`, hop_ids: [SVC_A], confidence: 0.7 }
      ]
    });

    const gen = asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: provider }));
    expect(provider.requests[0].user).toContain(`endpoint:dup#${HANDLER_A}`);
    expect(provider.requests[0].user).toContain(`endpoint:dup#${HANDLER_B}`);
    expect(gen.rejections.accepted).toBe(2);

    const applied = asApply(await opAiFlows(root, { apply: true }, DEPS));
    expect(applied.applied_flows).toBe(2);
    const meta = loadGraph(workspacePaths(root).graphPath).analysis?.candidate_flows;
    const fromA = meta?.flows.find((f) => f.hops[0]?.from === HANDLER_A);
    const fromB = meta?.flows.find((f) => f.hops[0]?.from === HANDLER_B);
    expect(fromA?.entry_point.external_id).toBe("endpoint:dup");
    expect(fromB?.entry_point.external_id).toBe("endpoint:dup");
    // hop_status is computed against the RIGHT handler start, never misattributed:
    expect(fromA?.hops[0]?.hop_status).toBe("matches_known_edge");
    expect(fromB?.hops[0]?.hop_status).toBe("unverified");
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Prompt anchor selection: endpoints first, neighborhood symbols (fix 6).
// ─────────────────────────────────────────────────────────────────────────────
describe("prompt anchor selection", () => {
  it("shows endpoint entries even when behavior entries exceed the prompt cap", async () => {
    const root = temp();
    // 65 isolated Behavior entries sort lexicographically before "endpoint:*" —
    // the old alphabetical slice dropped every endpoint from the prompt.
    const behaviors = Array.from({ length: 65 }, (_, i) =>
      codeSymbol(`sym:src/aaa${String(i).padStart(3, "0")}.ts#a${i}`, `a${i}`, `src/aaa${i}.ts`)
    );
    const g = nestGraph(root);
    writeGraph(root, { ...g, nodes: [...g.nodes, ...behaviors] });
    const provider = new JsonProvider({ flows: [VALID_FLOW] });

    const res = asGenerate(await opAiFlows(root, {}, { ...DEPS, aiProvider: provider }));

    const user = provider.requests[0].user;
    const entriesJson = user.split("ENTRY_POINTS:\n")[1].split("\n\nSYMBOLS:\n")[0];
    expect(entriesJson).toContain(ENTRY);
    // Symbols come from the shown entries' CALLS neighborhood, not an alphabetical slice.
    expect(user.split("SYMBOLS:\n")[1]).toContain(SERVICE);
    expect(res.rejections.accepted).toBe(1);
    expect(res.warnings.join("\n")).toContain("Entry list capped");
  });
});
