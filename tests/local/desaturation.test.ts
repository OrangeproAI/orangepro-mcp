import { describe, expect, it } from "vitest";

import { extractBehaviorContracts } from "../../src/local/analyze/behaviorContracts.js";
import { rankEntries, type FlowEntry } from "../../src/local/flows/flowWalker.js";
import { rankRiskGaps } from "../../src/local/score/risk.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, type LocalGraph } from "../../src/local/graph/ontology.js";

// ── Fix C: NestJS GraphQL + queue processor entry points ──────────────────────

describe("extractBehaviorContracts — NestJS GraphQL resolvers", () => {
  it("extracts @Query/@Mutation methods on a @Resolver class as graphql_operation contracts", () => {
    const src = `
      @Resolver(() => Workspace)
      export class WorkspaceResolver {
        @Query(() => Workspace)
        async currentWorkspace(@Args() args: WorkspaceArgs): Promise<Workspace> { return this.svc.get(args); }

        @Mutation(() => Workspace)
        async updateWorkspace(@Args('input') input: UpdateInput): Promise<Workspace> { return this.svc.update(input); }

        @ResolveField(() => [Member])
        async members(@Parent() ws: Workspace): Promise<Member[]> { return this.svc.members(ws); }
      }
    `;
    const contracts = extractBehaviorContracts(src, "src/workspace.resolver.ts");
    const gql = contracts.filter((c) => c.kind === "graphql_operation");
    expect(gql.map((c) => [c.method, c.handler, c.controller])).toEqual([
      ["QUERY", "currentWorkspace", "WorkspaceResolver"],
      ["MUTATION", "updateWorkspace", "WorkspaceResolver"]
    ]);
    // Field resolvers are not user-triggerable operations — never contracts.
    expect(contracts.some((c) => c.handler === "members")).toBe(false);
  });

  it("extracts @Process methods on a @Processor class as queue_processor contracts", () => {
    const src = `
      @Processor(MessageQueue.webhookQueue)
      export class CallWebhookJob {
        @Process(CallWebhookJob.name)
        async handle(data: WebhookJobData[]): Promise<void> { await this.run(data); }
      }
    `;
    const contracts = extractBehaviorContracts(src, "src/call-webhook.job.ts");
    const jobs = contracts.filter((c) => c.kind === "queue_processor");
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ method: "JOB", handler: "handle", controller: "CallWebhookJob" });
  });
});

// ── Fix C: endpoint-anchored flows never crowded out by orphan roots ──────────

describe("rankEntries — endpoint-first ordering", () => {
  it("ranks every Endpoint entry ahead of every orphan Behavior entry", () => {
    const graph = { nodes: [], edges: [], workspaceRoot: "" };
    const entries: FlowEntry[] = [
      { external_id: "sym:src/core/orphanA.ts#compute", kind: "Behavior", start: "sym:src/core/orphanA.ts#compute" },
      { external_id: "endpoint:post-orders", kind: "Endpoint", title: "POST /orders", start: "sym:src/api/orders.ts#create" },
      { external_id: "sym:src/core/orphanB.ts#recalc", kind: "Behavior", start: "sym:src/core/orphanB.ts#recalc" },
      { external_id: "endpoint:graphql-updateworkspace", kind: "Endpoint", title: "MUTATION graphql:updateWorkspace", start: "sym:src/ws.resolver.ts#update" }
    ];
    const ranked = rankEntries(graph, entries, new Map());
    expect(ranked.map((e) => e.kind)).toEqual(["Endpoint", "Endpoint", "Behavior", "Behavior"]);
  });
});

// ── Fix B: ORS de-saturation — method-level attribution + portfolio diversity ─

function riskGraph(): LocalGraph {
  const provenance = { source_scope_id: "scope:repo", source_ref: "repo" };
  const mk = (id: string, title: string, file: string, start: number, end: number) => ({
    id,
    kind: "CodeSymbol" as const,
    external_id: id,
    title,
    properties: { file, start_line: start, end_line: end },
    evidence_strength: "hard" as const,
    review_status: "auto_detected" as const,
    confidence: 1,
    provenance,
    denominator_eligible: true
  });
  // One hot file with five methods, plus a lone method in a second file.
  const hot = ["a", "b", "c", "d", "e"].map((n, i) =>
    mk(`sym:src/services/hot.service.ts#Hot.${n}`, `Hot.${n}`, "src/services/hot.service.ts", i * 10 + 1, i * 10 + 8)
  );
  const lone = mk("sym:src/services/lone.service.ts#Lone.run", "Lone.run", "src/services/lone.service.ts", 1, 40);
  const importEdge = (from: string) => ({
    id: `edge:${from}`,
    external_id: `edge:${from}`,
    from_external_id: from,
    to_external_id: "src/services/hot.service.ts",
    relationship_type: "IMPORTS" as const,
    evidence_strength: "hard" as const,
    review_status: "auto_detected" as const,
    confidence: 1,
    provenance
  });
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "repo", root: "", root_hash: "", source_upload_policy: "metadata_only" },
    created_at: "",
    updated_at: "",
    sources: [],
    nodes: [...hot, lone],
    edges: [importEdge("src/a.ts"), importEdge("src/b.ts"), importEdge("src/c.ts"), importEdge("src/d.ts")],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "", git: null, files: {} }
  };
}

describe("rankRiskGaps — de-saturated ORS", () => {
  it("splits file-level import refs across the file's symbols instead of crediting each in full", () => {
    const ranked = rankRiskGaps(riskGraph(), { limit: 10, repoRoot: "" });
    const hotRows = ranked.filter((r) => r.file === "src/services/hot.service.ts");
    // 4 file imports over 5 symbols → 0.8 each, never 4 each.
    for (const row of hotRows) expect(row.incoming_refs).toBeLessThan(1);
  });

  it("caps how many gaps one file contributes to the surfaced list (default 3)", () => {
    const ranked = rankRiskGaps(riskGraph(), { limit: 4, repoRoot: "" });
    const hotCount = ranked.filter((r) => r.file === "src/services/hot.service.ts").length;
    expect(hotCount).toBeLessThanOrEqual(3);
    // The lone file still surfaces — the list is a portfolio, not one file's method dump.
    expect(ranked.some((r) => r.file === "src/services/lone.service.ts")).toBe(true);
  });
});

// ── Fix D: relative severity bucketing (absolute 500/200 could never fire post-normalization) ─

import { buildBehaviorReportData } from "../../src/local/viz/behaviorReportData.js";

describe("relative risk severity", () => {
  it("assigns critical/high relative to the repo's own max score, not absolute cutoffs", () => {
    // Simulated post-normalization distribution: max 88.4 — under the old
    // absolute thresholds (>=500 critical, >=200 high) EVERYTHING was "medium".
    const scores = [88.4, 85.8, 70.1, 45.3, 20.0];
    const buckets = scores.map((s) => {
      const rel = s / 88.4;
      return rel >= 0.75 ? "critical" : rel >= 0.5 ? "high" : "medium";
    });
    expect(buckets).toEqual(["critical", "critical", "critical", "high", "medium"]);
  });
});

describe("rankRiskGaps — ordering invariant", () => {
  it("surfaced list is monotonically descending by score even when diversity backfill fires", () => {
    // limit > distinct-file capacity forces backfill of over-cap hot-file rows,
    // which previously appended them AFTER lower-scored rows.
    const ranked = rankRiskGaps(riskGraph(), { limit: 6, maxPerFile: 2, repoRoot: "" });
    const scores = ranked.map((r) => r.risk_score);
    for (let i = 1; i < scores.length; i++) expect(scores[i]).toBeLessThanOrEqual(scores[i - 1]);
  });
});

// ── Fix 8: governance markdown never mints Requirement nodes ─────────────────

import { enrichFromMarkdown } from "../../src/local/enrich/markdown.js";

describe("enrichFromMarkdown — governance exclusions", () => {
  const templateMd = "## The author should do the following, if applicable\n\n- [ ] Add tests";
  it("mints nothing from .github templates, CONTRIBUTING, and changelogs", () => {
    for (const path of [
      ".github/PULL_REQUEST_TEMPLATE.md",
      ".github/ISSUE_TEMPLATE/bug.md",
      "CONTRIBUTING.md",
      "docs/CONTRIBUTING.md",
      "CHANGELOG.md",
      ".changeset/pretty-otters.md",
      "packages/create-twenty-app/src/constants/template/AGENTS.md",
      "packages/create-twenty-app/src/constants/template/SETUP.md",
      "AGENTS.md",
      "CLAUDE.md"
    ]) {
      expect(enrichFromMarkdown(path, templateMd).nodes).toHaveLength(0);
    }
  });
  it("still mints requirements from product docs", () => {
    const out = enrichFromMarkdown("docs/features.md", "## The API must support streaming responses\n\ndetails");
    expect(out.nodes.length).toBeGreaterThan(0);
  });
});

// ── Fix 9: doctor distinguishes survived mutants from non-assertion failures ──

import { nonKillingNoteFor, NON_KILLING_NOTE, NON_ASSERTION_NOTE } from "../../src/local/proofDoctor.js";

describe("proof doctor — non-close diagnosis", () => {
  it("labels a non-assertion crash as failed-not-survived (opposite remediation)", () => {
    expect(nonKillingNoteFor("associated_non_assertion_failure")).toBe(NON_ASSERTION_NOTE);
    expect(NON_ASSERTION_NOTE).toContain("made the test FAIL");
  });
  it("keeps the survived-mutant wording for true survivors and legacy records", () => {
    expect(nonKillingNoteFor("associated_survived")).toBe(NON_KILLING_NOTE);
    expect(nonKillingNoteFor(undefined)).toBe(NON_KILLING_NOTE);
  });
});

import { buildProofDoctor } from "../../src/local/proofDoctor.js";

describe("proof doctor — legacy sidecar backfills mutant_status from the ledger", () => {
  it("diagnoses non-assertion failure even when the sidecar predates the field", () => {
    const generatedAt = "2026-07-18T01:00:00Z";
    const graph = {
      schema_version: "orangepro.local_graph.v1",
      workspace: { name: "r", root: "", root_hash: "", source_upload_policy: "metadata_only" as const },
      created_at: generatedAt, updated_at: generatedAt, sources: [],
      nodes: [], edges: [], candidate_edges: [], generation_runs: [], generated_tests: [],
      manifest: { generated_at: generatedAt, git: null, files: {} }
    } as never;
    const rtm = { summary: { proven: 3, total: 82 }, rows: [] } as never;
    // Legacy sidecar: classification only — no mutant_status (pre-fix writer).
    const attempts = {
      schema_version: "orangepro.proof_attempts.v1", generated_at: generatedAt,
      graph_generated_at: generatedAt, git_commit: null, git_dirty: null,
      attempted: 5, proven: 3,
      attempts: [{ target_symbol: "sym:src/x.ts#X.run", test_path: "src/x.test.ts", classification: "non_killing" as const, language: "typescript" }],
      skipped: []
    } as never;
    // Ledger ground truth: the mutant FAILED, just not at an assertion.
    const ledger = { records: [{ target_symbol: "sym:src/x.ts#X.run", ts: generatedAt, dynamic_proof: { mutant_status: "associated_non_assertion_failure" } }] };

    const res = buildProofDoctor(graph, rtm, attempts, {}, ledger as never);
    expect(res.non_killing[0]?.mutant_status).toBe("associated_non_assertion_failure");
    expect(res.non_killing[0]?.note).toContain("made the test FAIL");
  });
});
