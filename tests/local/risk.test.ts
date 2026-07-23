import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCandidateEdge, makeEdge, makeNode } from "../../src/local/graph/factories.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, LocalGraph } from "../../src/local/graph/ontology.js";
import { inspectRiskInputHealth, rankRiskGaps } from "../../src/local/score/risk.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function graph(root = ""): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "risk", root, root_hash: "sha256:x", source_upload_policy: "metadata_only" },
    created_at: "",
    updated_at: "",
    sources: [],
    nodes: [],
    edges: [],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "", git: null, files: {} }
  };
}

function symbol(id: string, title: string, file: string, eligible = true): LocalGraph["nodes"][number] {
  return makeNode({
    kind: "CodeSymbol",
    external_id: id,
    title,
    properties: { file },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "src", source_ref: file },
    denominator_eligible: eligible,
    denominator_reason: eligible ? "Exported symbol — countable behavior surface." : "Non-product symbol."
  });
}

function testCase(id: string): LocalGraph["nodes"][number] {
  return makeNode({
    kind: "TestCase",
    external_id: id,
    title: id,
    properties: { file: id.replace(/^test:/, "") },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "test", source_ref: id.replace(/^test:/, "") }
  });
}

function edge(from: string, to: string, relationship_type: "CALLS" | "IMPORTS" | "TESTED_BY" | "COVERS"): LocalGraph["edges"][number] {
  return makeEdge({
    from_external_id: from,
    to_external_id: to,
    relationship_type,
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "graph", source_ref: "graph" }
  });
}

function candidate(from: string, to: string, relationship_type: "MAY_BE_TESTED_BY" | "MAY_COVER" | "MAY_RELATE_TO"): LocalGraph["candidate_edges"][number] {
  return makeCandidateEdge({
    from_external_id: from,
    to_external_id: to,
    relationship_type,
    evidence_strength: "candidate",
    reason: "test candidate",
    confidence: 0.5,
    provenance: { source_scope_id: "graph", source_ref: "graph" }
  });
}

// Mirrors `candidate()` but with the AI-lane shape: evidence_strength "weak" + review_status
// "ai_suggested" (what src/local/aiGraph/links.ts emits). Used to assert AI guesses never count as
// a real "associated" test signal in the risk ranking (#105 invariant: AI never poses as evidence).
function aiCandidate(from: string, to: string, relationship_type: "MAY_BE_TESTED_BY" | "MAY_COVER" | "MAY_RELATE_TO"): LocalGraph["candidate_edges"][number] {
  const edge = makeCandidateEdge({
    from_external_id: from,
    to_external_id: to,
    relationship_type,
    evidence_strength: "weak",
    reason: "ai suggested",
    confidence: 0.5,
    provenance: { source_scope_id: "ai", source_ref: "ai" }
  });
  edge.review_status = "ai_suggested";
  return edge;
}

describe("rankRiskGaps", () => {
  it("ranks only unconfirmed denominator symbols and treats risk as prioritization", () => {
    const g = graph();
    g.nodes = [
      symbol("sym:src/api/users.ts#handleUser", "handleUser", "src/api/users.ts"),
      symbol("sym:src/core/save.ts#saveUser", "saveUser", "src/core/save.ts"),
      symbol("sym:src/core/caller.ts#caller", "caller", "src/core/caller.ts"),
      symbol("sym:src/core/confirmed.ts#confirmed", "confirmed", "src/core/confirmed.ts"),
      symbol("sym:src/test/helpers.ts#helper", "helper", "src/test/helpers.ts", false),
      testCase("test:confirmed.test.ts")
    ];
    g.edges = [
      edge("sym:src/core/caller.ts#caller", "sym:src/core/save.ts#saveUser", "CALLS"),
      edge("src/web/page.ts", "src/api/users.ts", "IMPORTS"),
      edge("sym:src/core/confirmed.ts#confirmed", "test:confirmed.test.ts", "TESTED_BY"),
      edge("sym:src/core/caller.ts#caller", "sym:src/test/helpers.ts#helper", "CALLS")
    ];

    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: "" });
    // ORS = P × I × D. handleUser (entry point, high impact) and caller (fan-out, high probability)
    // both outrank saveUser. Confirmed and non-eligible symbols are excluded.
    expect(ranked.map((r) => r.id)).toEqual(["sym:src/api/users.ts#handleUser", "sym:src/core/caller.ts#caller", "sym:src/core/save.ts#saveUser"]);
    expect(ranked[0]).toMatchObject({ entry_point: true, incoming_refs: 1, git_churn: 0 });
    expect(ranked[0].reasons).toContain("near an API/route/handler entry point");
    expect(ranked[0].reasons[0]).toMatch(/^ORS \d+(\.\d+)? ≈ P\d+ × I\d+ × D\d+$/);
    expect(ranked[0].detection_difficulty).toBe(10);
    expect(ranked.some((r) => r.id.includes("confirmed"))).toBe(false);
    expect(ranked.some((r) => r.id.includes("helper"))).toBe(false);
  });

  it("derives detection difficulty from proof/association tier, not symbol extraction strength", () => {
    const g = graph();
    g.nodes = [
      symbol("sym:src/api/orders.ts#POST", "POST", "src/api/orders.ts"),
      symbol("sym:src/api/payments.ts#POST", "POST", "src/api/payments.ts"),
      testCase("test:payments.test.ts")
    ];
    // Analyzer extraction may be hard evidence, but that is not proof or association.
    g.nodes[0].evidence_strength = "hard";
    g.nodes[1].evidence_strength = "hard";
    g.candidate_edges = [candidate("sym:src/api/payments.ts#POST", "test:payments.test.ts", "MAY_BE_TESTED_BY")];

    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: "" });
    const byId = new Map(ranked.map((r) => [r.id, r]));

    expect(byId.get("sym:src/api/orders.ts#POST")?.detection_difficulty).toBe(10);
    expect(byId.get("sym:src/api/orders.ts#POST")?.integration_signal).toBe("none");
    // Epistemic fix (Jul 17): an unconfirmed lexical/Jaccard candidate is a LEAD,
    // not evidence. It gets its own tier (D=8), never the associated tier (D=5) —
    // only a hard TESTED_BY/COVERS edge from a real TestCase earns "associated".
    expect(byId.get("sym:src/api/payments.ts#POST")?.detection_difficulty).toBe(8);
    expect(byId.get("sym:src/api/payments.ts#POST")?.integration_signal).toBe("candidate");
  });

  // REGRESSION (#147 review): the proven set (confirmedBehaviorIds) filters evidence_strength==="hard",
  // but associatedBehaviorIds filters neither review_status nor evidence_strength — so an AI-lane edge
  // (MAY_RELATE_TO / weak / ai_suggested) leaks into the "associated" D-tier and halves a behavior's
  // risk (5 vs 10), de-prioritizing it in "what to test first" based on an UNVERIFIED AI guess. That
  // violates the #105 invariant (AI never poses as evidence).
  it("does NOT treat an AI-suggested candidate edge as an 'associated' test signal", () => {
    const g = graph();
    g.nodes = [
      symbol("sym:src/api/payments.ts#POST", "POST", "src/api/payments.ts"),
      testCase("test:payments.test.ts")
    ];
    g.nodes[0].evidence_strength = "hard";
    g.candidate_edges = [aiCandidate("sym:src/api/payments.ts#POST", "test:payments.test.ts", "MAY_RELATE_TO")];

    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: "" });
    const byId = new Map(ranked.map((r) => [r.id, r]));

    expect(byId.get("sym:src/api/payments.ts#POST")?.detection_difficulty).toBe(10);
    expect(byId.get("sym:src/api/payments.ts#POST")?.integration_signal).toBe("none");
  });

  it("ranking titles come from the symbol, never the process", () => {
    const g = graph();
    g.nodes = [
      symbol("sym:src/api/orders.ts#handleOrder", "handleOrder", "src/api/orders.ts"),
      symbol("sym:src/core/save.ts#saveOrder", "saveOrder", "src/core/save.ts"),
      symbol("sym:src/core/caller.ts#caller", "caller", "src/core/caller.ts")
    ];
    g.edges = [
      edge("sym:src/core/caller.ts#caller", "sym:src/core/save.ts#saveOrder", "CALLS"),
      edge("src/web/page.ts", "src/api/orders.ts", "IMPORTS")
    ];
    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: "" });

    expect(ranked.length).toBeGreaterThan(0);
    for (const r of ranked) {
      expect(r.title).not.toBe(process.title);
      expect(r.title).not.toContain("/bin/node");
      expect(r.title.length).toBeGreaterThan(0);
    }
    expect(ranked.map((r) => r.title)).toContain("handleOrder");
  });

  it("keeps the legacy linear formula available behind an explicit option", () => {
    const g = graph();
    g.nodes = [
      symbol("sym:src/api/users.ts#handleUser", "handleUser", "src/api/users.ts"),
      symbol("sym:src/core/save.ts#saveUser", "saveUser", "src/core/save.ts"),
      symbol("sym:src/core/caller.ts#caller", "caller", "src/core/caller.ts")
    ];
    g.edges = [
      edge("sym:src/core/caller.ts#caller", "sym:src/core/save.ts#saveUser", "CALLS"),
      edge("src/web/page.ts", "src/api/users.ts", "IMPORTS")
    ];

    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: "", legacy: true });

    expect(ranked.map((r) => r.id)).toEqual(["sym:src/api/users.ts#handleUser", "sym:src/core/save.ts#saveUser", "sym:src/core/caller.ts#caller"]);
    expect(ranked.map((r) => r.title)).toEqual(["handleUser", "saveUser", "caller"]);
    expect(ranked.every((r) => r.title !== process.title && !r.title.includes("/bin/node"))).toBe(true);
    expect(ranked[0].risk_score).toBeGreaterThan(ranked[1].risk_score);
    expect(ranked[0].probability).toBeUndefined();
    expect(ranked[0].reasons.join(" ")).not.toContain("ORS");
  });

  it("uses recent git churn when a repository root is available", () => {
    const root = mkdtempSync(join(tmpdir(), "opro-risk-"));
    dirs.push(root);
    mkdirSync(join(root, "src/api"), { recursive: true });
    writeFileSync(join(root, "src/api/orders.ts"), "export function handleOrder() {\n  return 1;\n}\n");
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "OrangePro", GIT_AUTHOR_EMAIL: "opro@example.com", GIT_COMMITTER_NAME: "OrangePro", GIT_COMMITTER_EMAIL: "opro@example.com" }
    });
    writeFileSync(join(root, "src/api/orders.ts"), "export function handleOrder() {\n  return 2;\n}\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "change order"], {
      cwd: root,
      stdio: "ignore",
      env: { ...process.env, GIT_AUTHOR_NAME: "OrangePro", GIT_AUTHOR_EMAIL: "opro@example.com", GIT_COMMITTER_NAME: "OrangePro", GIT_COMMITTER_EMAIL: "opro@example.com" }
    });

    const g = graph(root);
    g.nodes = [symbol("sym:src/api/orders.ts#handleOrder", "handleOrder", "src/api/orders.ts")];

    const [gap] = rankRiskGaps(g, { limit: 1 });
    expect(gap.git_churn).toBeGreaterThan(0);
    expect(gap.reasons.join(" ")).toContain("git churn");
    expect(gap.churn_available).toBe(true);

    const health = inspectRiskInputHealth(root);
    expect(health.history).toBe("full");
    expect(health.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(health.commitDate).toBeTruthy();
    expect(health.churnWindow).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    execFileSync("git", ["config", "remote.origin.promisor", "true"], { cwd: root, stdio: "ignore" });
    const partial = inspectRiskInputHealth(root);
    expect(partial.history).toBe("partial");
    expect(partial.churnAvailable).toBe(false);
    expect(partial.reason).toContain("partial-clone");
  });
});

describe("risk report trust safeguards", () => {
  it("does not infer payment sensitivity from CapturePanic", () => {
    const g = graph("/definitely/not/a/git/repo");
    g.nodes = [symbol("sym:internal/common/panic.go#CapturePanic", "CapturePanic", "internal/common/panic.go")];

    const [gap] = rankRiskGaps(g, { limit: 1 });
    expect(gap.data_sensitivity).toBe(1);
    expect(gap.churn_available).toBe(false);
    expect(gap.reasons.join(" ")).toContain("provisional static-only ranking");
    expect(gap.reasons.join(" ")).toContain("structurally disconnected, score dampened");
  });

  it("keeps capture payment operations payment-sensitive", () => {
    const g = graph("/definitely/not/a/git/repo");
    g.nodes = [symbol("sym:src/payments/capture.ts#capturePayment", "capturePayment", "src/payments/capture.ts")];

    const [gap] = rankRiskGaps(g, { limit: 1 });
    expect(gap.data_sensitivity).toBe(10);
  });

  it("uses whole semantic tokens for sensitivity without author/tokenizer false positives", () => {
    const g = graph("/definitely/not/a/git/repo");
    g.nodes = [
      symbol("sym:src/text.ts#tokenizeAuthor", "tokenizeAuthor", "src/text.ts"),
      symbol("sym:src/payments.ts#requestPayout", "requestPayout", "src/payments.ts")
    ];

    const gaps = rankRiskGaps(g, { limit: 2 });
    expect(gaps.find((gap) => gap.title === "tokenizeAuthor")?.data_sensitivity).toBe(1);
    expect(gaps.find((gap) => gap.title === "requestPayout")?.data_sensitivity).toBe(10);
  });

  it("can enforce one portfolio slot per normalized title", () => {
    const g = graph("/definitely/not/a/git/repo");
    g.nodes = [
      symbol("sym:src/a.ts#Invoke", "Invoke", "src/a.ts"),
      symbol("sym:src/b.ts#Invoke", "Invoke", "src/b.ts"),
      symbol("sym:src/c.ts#Execute", "Execute", "src/c.ts")
    ];

    const gaps = rankRiskGaps(g, { limit: 3, maxPerFile: 3, maxPerTitle: 1 });
    expect(gaps.map((gap) => gap.title)).toEqual(expect.arrayContaining(["Invoke", "Execute"]));
    expect(gaps.filter((gap) => gap.title === "Invoke")).toHaveLength(1);
  });
});
