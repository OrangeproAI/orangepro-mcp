import { loadRiskConfig } from "../../src/local/score/riskConfig.js";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCandidateEdge, makeEdge, makeNode } from "../../src/local/graph/factories.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, LocalGraph } from "../../src/local/graph/ontology.js";
import { inspectRiskInputHealth, rankPriorityGaps, rankRiskGaps } from "../../src/local/score/risk.js";

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

function symbol(id: string, title: string, file: string, eligible = true, memberOf?: string): LocalGraph["nodes"][number] {
  return makeNode({
    kind: "CodeSymbol",
    external_id: id,
    title,
    properties: { file, ...(memberOf ? { member_of: memberOf } : {}) },
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

  it("suppresses a container type when all its method children are confirmed", () => {
    const g = graph();
    g.nodes = [
      symbol("sym:src/core/err.ts#staleErr", "staleErr", "src/core/err.ts"),
      symbol("sym:src/core/err.ts#staleErr.Error", "staleErr.Error", "src/core/err.ts", true, "staleErr"),
      symbol("sym:src/core/err.ts#staleErr.IsTerminal", "staleErr.IsTerminal", "src/core/err.ts", true, "staleErr"),
      symbol("sym:src/core/other.ts#half", "half", "src/core/other.ts"),
      symbol("sym:src/core/other.ts#half.Done", "half.Done", "src/core/other.ts", true, "half"),
      symbol("sym:src/core/other.ts#half.Open", "half.Open", "src/core/other.ts", true, "half"),
      testCase("test:err.test.ts"),
      testCase("test:half.test.ts")
    ];
    g.edges = [
      edge("sym:src/core/err.ts#staleErr.Error", "test:err.test.ts", "TESTED_BY"),
      edge("sym:src/core/err.ts#staleErr.IsTerminal", "test:err.test.ts", "TESTED_BY"),
      edge("sym:src/core/other.ts#half.Done", "test:half.test.ts", "TESTED_BY")
    ];
    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: "" });
    const ids = ranked.map((r) => r.id);
    expect(ids).not.toContain("sym:src/core/err.ts#staleErr");
    expect(ids).toContain("sym:src/core/other.ts#half");
    expect(ids).toContain("sym:src/core/other.ts#half.Open");
  });

  // Regression (Temporal, consts.staleStateError at rank #10): both methods were
  // Dynamically Proven, but proof lives in the ledger — not in a TESTED_BY edge —
  // and the proven methods sit outside the static denominator, so the hard-edge-only
  // container check never fired and the container outranked its own proven methods.
  it("suppresses a container whose every member_of child is proven only in the ledger", () => {
    const g = graph();
    g.nodes = [
      symbol("sym:src/core/consts.ts#staleStateError", "staleStateError", "src/core/consts.ts"),
      symbol("sym:src/core/consts.ts#staleStateError.Error", "staleStateError.Error", "src/core/consts.ts", true, "staleStateError"),
      symbol("sym:src/core/consts.ts#staleStateError.Is", "staleStateError.Is", "src/core/consts.ts", true, "staleStateError"),
      symbol("sym:src/core/partial.ts#partialError", "partialError", "src/core/partial.ts"),
      symbol("sym:src/core/partial.ts#partialError.Error", "partialError.Error", "src/core/partial.ts", true, "partialError"),
      symbol("sym:src/core/partial.ts#partialError.Is", "partialError.Is", "src/core/partial.ts", true, "partialError")
    ];
    // Zero TESTED_BY/COVERS edges anywhere: the ledger is the only proof source.
    g.edges = [];
    const provenIds = new Set([
      "sym:src/core/consts.ts#staleStateError.Error",
      "sym:src/core/consts.ts#staleStateError.Is",
      "sym:src/core/partial.ts#partialError.Error"
    ]);

    const ids = rankRiskGaps(g, { limit: 10, repoRoot: "", provenIds }).map((r) => r.id);
    expect(ids).not.toContain("sym:src/core/consts.ts#staleStateError");
    // Only one of two children proven — the container still has untested surface.
    expect(ids).toContain("sym:src/core/partial.ts#partialError");
    expect(ids).toContain("sym:src/core/partial.ts#partialError.Is");
    // Without the ledger set the old hard-edge-only check cannot see the proofs.
    expect(rankRiskGaps(g, { limit: 10, repoRoot: "" }).map((r) => r.id)).toContain("sym:src/core/consts.ts#staleStateError");
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

  it("provides one canonical diversified priority portfolio for report and generation callers", () => {
    const g = graph("/definitely/not/a/git/repo");
    g.nodes = [
      symbol("sym:src/a.ts#Invoke", "Invoke", "src/a.ts"),
      symbol("sym:src/b.ts#Invoke", "Invoke", "src/b.ts"),
      symbol("sym:src/hot.ts#one", "one", "src/hot.ts"),
      symbol("sym:src/hot.ts#two", "two", "src/hot.ts"),
      symbol("sym:src/hot.ts#three", "three", "src/hot.ts"),
      symbol("sym:src/hot.ts#four", "four", "src/hot.ts"),
      symbol("sym:src/c.ts#Execute", "Execute", "src/c.ts")
    ];

    const gaps = rankPriorityGaps(g, { limit: 7 });
    expect(gaps).toEqual(rankRiskGaps(g, { limit: 7, maxPerFile: 3, maxPerTitle: 1 }));
    expect(gaps.filter((gap) => gap.title === "Invoke")).toHaveLength(1);
    expect(gaps.map((gap) => gap.title)).toContain("Execute");
  });
});

describe("rankRiskGaps — irreversibility floor, scheduled silence, ranking hygiene (graph facts only)", () => {
  const withExt = (n: LocalGraph["nodes"][number], external_callees: string[]) => ({ ...n, properties: { ...n.properties, external_callees } });

  it("a scheduled entry that reaches a destructive EXTERNAL sink outranks an equal peer that does not", () => {
    const g = graph();
    const runA = symbol("sym:service/worker/scanner/task.go#task.Run", "task.Run", "service/worker/scanner/task.go");
    const hf = withExt(symbol("sym:service/worker/scanner/task.go#task.handleFailures", "task.handleFailures", "service/worker/scanner/task.go"), ["t.adminClient.DeleteWorkflowExecution", "t.logger.Error"]);
    const runB = symbol("sym:service/worker/report/task.go#task.Run", "task.Run", "service/worker/report/task.go");
    const fmt = withExt(symbol("sym:service/worker/report/task.go#task.format", "task.format", "service/worker/report/task.go"), ["t.logger.Info"]);
    g.nodes = [runA, hf, runB, fmt];
    g.edges = [edge(runA.external_id, hf.external_id, "CALLS"), edge(runB.external_id, fmt.external_id, "CALLS")];
    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: "" });
    const ia = ranked.findIndex((r) => r.id === runA.external_id);
    const ib = ranked.findIndex((r) => r.id === runB.external_id);
    expect(ia).toBeGreaterThanOrEqual(0);
    expect(ia).toBeLessThan(ib);
  });

  it("NEGATIVE: an in-repo method merely NAMED delete is not a sink (only external destructive callees count)", () => {
    const g = graph();
    const runA = symbol("sym:service/worker/scanner/task.go#task.Run", "task.Run", "service/worker/scanner/task.go");
    const del = symbol("sym:service/worker/scanner/tree.go#Node.delete", "Node.delete", "service/worker/scanner/tree.go");
    const runB = symbol("sym:service/worker/report/task.go#task.Run", "task.Run", "service/worker/report/task.go");
    g.nodes = [runA, del, runB];
    g.edges = [edge(runA.external_id, del.external_id, "CALLS")];
    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: "" });
    const a = ranked.find((r) => r.id === runA.external_id)!;
    const b = ranked.find((r) => r.id === runB.external_id)!;
    expect(a.impact).toBe(b.impact);
  });

  it("NEGATIVE: a destructive sink behind a PROVEN scheduled entry gets no silence multiplier", () => {
    const g = graph();
    const run = symbol("sym:service/worker/scanner/task.go#task.Run", "task.Run", "service/worker/scanner/task.go");
    const hf = withExt(symbol("sym:service/worker/scanner/task.go#task.handleFailures", "task.handleFailures", "service/worker/scanner/task.go"), ["t.store.DeleteRow"]);
    g.nodes = [run, hf, testCase("test:scanner_test.go")];
    g.edges = [edge(run.external_id, hf.external_id, "CALLS"), edge(run.external_id, "test:scanner_test.go", "TESTED_BY")];
    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: "" });
    const r = ranked.find((x) => x.id === run.external_id);
    // statically linked → detection 5, never 5 × 1.25
    expect(r === undefined || (r.detection_difficulty ?? 0) <= 5).toBe(true);
  });

  it("HYGIENE: test-support paths, declaration one-liners, and trivial accessors never take a risk slot", () => {
    const g = graph();
    const helper = symbol("sym:common/testing/testcontext/ctx.go#getOrCreateContextState", "testcontext.getOrCreateContextState", "common/testing/testcontext/ctx.go");
    const decl = { ...symbol("sym:service/history/consts/const.go#staleStateError", "consts.staleStateError", "service/history/consts/const.go"), properties: { file: "service/history/consts/const.go", symbol_kind: "class", start_line: 10, end_line: 11 } };
    const getter = { ...symbol("sym:common/ns/ns.go#Namespace.GetName", "Namespace.GetName", "common/ns/ns.go"), properties: { file: "common/ns/ns.go", symbol_kind: "method", start_line: 1, end_line: 3 } };
    const real = symbol("sym:service/history/handler.go#Handler.Invoke", "Handler.Invoke", "service/history/handler.go");
    g.nodes = [helper, decl, getter, real];
    const ids = rankRiskGaps(g, { limit: 10, repoRoot: "" }).map((r) => r.id);
    expect(ids).toContain(real.external_id);
    expect(ids).not.toContain(helper.external_id);
    expect(ids).not.toContain(decl.external_id);
    expect(ids).not.toContain(getter.external_id);
  });
});

describe("per-repo risk config (riskConfig.ts) — classification + overrides with reasons, never weights", () => {
  const withConfig = (json: unknown): string => {
    const root = mkdtempSync(join(tmpdir(), "oprocfg-"));
    mkdirSync(join(root, ".orangepro"));
    writeFileSync(join(root, ".orangepro", "config.json"), JSON.stringify(json));
    return root;
  };

  it("defaults are deterministic and the hash is stable across key order", () => {
    const a = loadRiskConfig("");
    const b = loadRiskConfig("/nonexistent/repo");
    expect(a.hash).toBe(b.hash);
    expect(a.config.tuning).toEqual({ irreversibility_floor: true, silence_multiplier: true });
  });

  it("an override WITHOUT a reason is ignored with a warning (a tuned report must never pass as clean)", () => {
    const root = withConfig({ overrides: [{ symbol: "sym:a.go#X", action: "suppress" }] });
    const l = loadRiskConfig(root);
    expect(l.config.overrides).toEqual([]);
    expect(l.warnings.some((w) => w.includes("reason"))).toBe(true);
  });

  it("suppress removes a symbol from ranking; a sensitivity_ignore glob zeroes name-derived sensitivity; the hash changes", () => {
    const root = withConfig({
      classification: { sensitivity_ignore: ["*CapturePanic*"] },
      overrides: [{ symbol: "sym:src/noise.go#noise.Run", action: "suppress", reason: "generated shim, not product behavior" }]
    });
    const g = graph(root);
    const noise = symbol("sym:src/noise.go#noise.Run", "noise.Run", "src/noise.go");
    const cap = symbol("sym:common/log/panic.go#log.CapturePanic", "log.CapturePanic", "common/log/panic.go");
    const real = symbol("sym:src/handler.go#Handler.Invoke", "Handler.Invoke", "src/handler.go");
    g.nodes = [noise, cap, real];
    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: root });
    const ids = ranked.map((r) => r.id);
    expect(ids).not.toContain(noise.external_id);
    expect(ranked.find((r) => r.id === cap.external_id)?.data_sensitivity ?? 0).toBe(0);
    expect(loadRiskConfig(root).hash).not.toBe(loadRiskConfig("").hash);
  });

  it("pin guarantees visibility beyond the limit without changing anyone's rank, and the reason is on the row", () => {
    const root = withConfig({ overrides: [{ symbol: "sym:src/z.go#Z.Run", action: "pin", reason: "ops asked to watch this until Q4 migration lands" }] });
    const g = graph(root);
    const nodes = Array.from({ length: 6 }, (_, i) => symbol(`sym:src/s${i}.go#S${i}.Do`, `S${i}.Do`, `src/s${i}.go`));
    const z = symbol("sym:src/z.go#Z.Run", "Z.Run", "src/z.go");
    g.nodes = [...nodes, z];
    const ranked = rankRiskGaps(g, { limit: 3, repoRoot: root });
    const zRow = ranked.find((r) => r.id === z.external_id);
    expect(zRow).toBeDefined();
    expect(zRow!.reasons.some((r) => r.includes("config override (pin)"))).toBe(true);
    expect(ranked.slice(0, 3).map((r) => r.id)).not.toContain(z.external_id);
  });
});

describe("round two — sink through a receiver field, body-shape hygiene, rank_exclude_paths", () => {
  const withProps = (n: LocalGraph["nodes"][number], extra: Record<string, unknown>) => ({ ...n, properties: { ...n.properties, ...extra } });

  it("a destructive callee reached through ANY receiver field is a sink (no qualifier-name vocabulary)", () => {
    const g = graph();
    const ins = symbol("sym:pkg/cqrs/cqrs.go#wrapper.InsertQueueSnapshot", "wrapper.InsertQueueSnapshot", "pkg/cqrs/cqrs.go");
    const insExt = withProps(ins, { external_callees: ["w.q.DeleteOldQueueSnapshots", "w.log.Info"] });
    const peer = withProps(symbol("sym:pkg/cqrs/other.go#wrapper.ListRuns", "wrapper.ListRuns", "pkg/cqrs/other.go"), { external_callees: ["w.q.GetRuns"] });
    g.nodes = [insExt, peer];
    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: "" });
    const a = ranked.find((r) => r.id === ins.external_id)!;
    const b = ranked.find((r) => r.id === peer.external_id)!;
    expect(a.sink_callee).toBe("w.q.DeleteOldQueueSnapshots");
    expect(b.sink_callee).toBeUndefined();
    expect(a.impact).toBeGreaterThanOrEqual(5);
  });


  it("rank_exclude_paths removes a scope from the RANKING only", () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const root = mkdtempSync(join(tmpdir(), "oprorx-"));
    mkdirSync(join(root, ".orangepro"));
    writeFileSync(join(root, ".orangepro", "config.json"), JSON.stringify({ classification: { rank_exclude_paths: ["ui/**"] } }));
    const g = graph(root);
    const ui = symbol("sym:ui/apps/dashboard/billing.tsx#InfraDashboard.getInfraPlanBillingAction", "InfraDashboard.getInfraPlanBillingAction", "ui/apps/dashboard/billing.tsx");
    const be = symbol("sym:pkg/execution/executor.go#executor.schedule", "executor.schedule", "pkg/execution/executor.go");
    g.nodes = [ui, be];
    const ids = rankRiskGaps(g, { limit: 10, repoRoot: root }).map((r) => r.id);
    expect(ids).toContain(be.external_id);
    expect(ids).not.toContain(ui.external_id);
  });
});
