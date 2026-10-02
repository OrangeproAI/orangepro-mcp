import { loadRiskConfig } from "../../src/local/score/riskConfig.js";
import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeCandidateEdge, makeEdge, makeNode } from "../../src/local/graph/factories.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, LocalGraph } from "../../src/local/graph/ontology.js";
import { configDisclosureFor, inspectRiskInputHealth, ORS_VERSION, rankPriorityGaps, rankRiskGaps } from "../../src/local/score/risk.js";
import { builtInRankExclusion } from "../../src/local/score/rankEligibility.js";

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
  it("counts 100 exact module calls without spreading file imports across sibling symbols", () => {
    const g = graph();
    const targets = ["a", "b", "c"].map((name) => symbol(`sym:src/mod.py#${name}`, name, "src/mod.py"));
    g.nodes = [...targets, ...Array.from({ length: 100 }, (_, i) => symbol(`sym:src/reader${i}.py#run`, "run", `src/reader${i}.py`))];
    for (let i = 0; i < 100; i++) {
      const reader = g.nodes[i + targets.length]!;
      g.edges.push(edge(`src/reader${i}.py`, "src/mod.py", "IMPORTS"));
      g.edges.push(edge(reader.external_id, targets[0]!.external_id, "CALLS"));
    }
    const ranks = new Map(rankRiskGaps(g, { limit: 200, repoRoot: "" }).map((r) => [r.id, r]));
    expect(targets.map((t) => ranks.get(t.external_id)?.incoming_refs)).toEqual([100, 0, 0]);
    expect(ranks.get(targets[0]!.external_id)!.risk_score).toBeGreaterThan(ranks.get(targets[1]!.external_id)!.risk_score);
  });

  it("attributes named import and non-call module attribute facts to their exact symbols only", () => {
    const g = graph();
    const targets = ["a", "b", "c"].map((name) => symbol(`sym:src/mod.py#${name}`, name, "src/mod.py"));
    g.nodes = targets;
    const named = edge("src/reader.py", "src/mod.py", "IMPORTS");
    named.properties = { symbol_imports: [targets[1]!.external_id] };
    const attribute = edge("src/another.py", "src/mod.py", "IMPORTS");
    attribute.properties = { symbol_references: { [targets[2]!.external_id]: 2 } };
    g.edges = [named, attribute];
    const ranks = new Map(rankRiskGaps(g, { limit: 10, repoRoot: "" }).map((r) => [r.id, r]));
    expect(targets.map((t) => ranks.get(t.external_id)?.incoming_refs)).toEqual([0, 1, 2]);
  });

  it("leaves TS and Go ranking units intact when Python class exclusion is present", () => {
    const g = graph();
    const py = { ...symbol("sym:src/api/holder.py#Holder", "Holder", "src/api/holder.py"), properties: { file: "src/api/holder.py", symbol_kind: "class", start_line: 1, end_line: 20, ranking_exclusion_code: "python_class_with_methods" } };
    const methods = ["one", "two"].map((name) => ({ ...symbol(`sym:src/api/holder.py#Holder.${name}`, `Holder.${name}`, "src/api/holder.py", true, "Holder"), properties: { file: "src/api/holder.py", symbol_kind: "method", member_of: "Holder", start_line: 3, end_line: 10 } }));
    const empty = { ...symbol("sym:src/api/empty.py#Empty", "Empty", "src/api/empty.py"), properties: { file: "src/api/empty.py", symbol_kind: "class", start_line: 1, end_line: 10 } };
    const tsClass = { ...symbol("sym:src/api/widget.ts#Widget", "Widget", "src/api/widget.ts"), properties: { file: "src/api/widget.ts", symbol_kind: "class", start_line: 1, end_line: 20 } };
    const goClass = { ...symbol("sym:src/api/widget.go#Widget", "Widget", "src/api/widget.go"), properties: { file: "src/api/widget.go", symbol_kind: "class", start_line: 1, end_line: 20 } };
    g.nodes = [py, ...methods, empty, tsClass, goClass];
    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: "" }).map((r) => r.id);
    expect(ranked).not.toContain(py.external_id);
    for (const node of [...methods, empty, tsClass, goClass]) expect(ranked).toContain(node.external_id);
    expect(g.nodes).toHaveLength(6);
    expect(g.nodes.every((node) => node.denominator_eligible)).toBe(true);
  });

  it("keeps an unchanged behavior stable when a peer becomes Associated", () => {
    const g = graph();
    const a = symbol("sym:src/api/a.ts#runA", "runA", "src/api/a.ts");
    const b = symbol("sym:src/api/b.ts#runB", "runB", "src/api/b.ts");
    const caller = symbol("sym:src/core/caller.ts#callA", "callA", "src/core/caller.ts");
    const test = testCase("test:b.test.ts");
    g.nodes = [a, b, caller, test];
    g.edges = [edge(caller.external_id, a.external_id, "CALLS")];

    const beforeA = rankRiskGaps(g, { limit: 10, repoRoot: "" }).find((row) => row.id === a.external_id);
    expect(beforeA).toBeDefined();

    g.edges.push(edge(b.external_id, test.external_id, "TESTED_BY"));
    const after = rankRiskGaps(g, { limit: 10, repoRoot: "" });
    const afterA = after.find((row) => row.id === a.external_id);

    expect(ORS_VERSION).toBe("orangepro.ors.stable_population.v2");
    expect(afterA?.risk_score).toBe(beforeA?.risk_score);
    expect(afterA?.probability).toBe(beforeA?.probability);
    expect(afterA?.impact).toBe(beforeA?.impact);
    expect(after.map((row) => row.id)).not.toContain(b.external_id);
  });

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
    // A file-only import cannot inflate handleUser; caller's fan-out and saveUser's
    // exact incoming call now take precedence. Confirmed/noneligible nodes stay out.
    expect(ranked.map((r) => r.id)).toEqual(["sym:src/core/caller.ts#caller", "sym:src/core/save.ts#saveUser", "sym:src/api/users.ts#handleUser"]);
    const handle = ranked.find((r) => r.title === "handleUser")!;
    expect(handle).toMatchObject({ entry_point: true, incoming_refs: 0, git_churn: 0 });
    expect(handle.reasons).toContain("near an API/route/handler entry point");
    expect(handle.reasons[0]).toMatch(/^ORS \d+(\.\d+)? ≈ P\d+ × I\d+ × D\d+$/);
    expect(handle.detection_difficulty).toBe(10);
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
    expect(gap.is_new_code).toBe(true);

    const health = inspectRiskInputHealth(root);
    expect(health.history).toBe("full");
    expect(health.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(health.commitDate).toBeTruthy();
    expect(health.churnWindow).toMatch(/^\d{4}-\d{2}-\d{2}T/);

    execFileSync("git", ["config", "remote.origin.promisor", "true"], { cwd: root, stdio: "ignore" });
    const partial = inspectRiskInputHealth(root);
    expect(partial.history).toBe("partial");
    expect(partial.churnAvailable).toBe(false);
    expect(partial.reason).toContain("partial clone");
  });

  it("attributes streamed rename churn to the current destination path", () => {
    const root = mkdtempSync(join(tmpdir(), "opro-risk-rename-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "src/old.ts"), "export function current() {\n  return 1;\n}\n");
    const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "OrangePro", GIT_AUTHOR_EMAIL: "opro@example.com", GIT_COMMITTER_NAME: "OrangePro", GIT_COMMITTER_EMAIL: "opro@example.com" };
    execFileSync("git", ["init"], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: root, stdio: "ignore", env: gitEnv });
    execFileSync("git", ["mv", "src/old.ts", "src/current.ts"], { cwd: root, stdio: "ignore" });
    writeFileSync(join(root, "src/current.ts"), "export function current() {\n  return 2;\n}\n");
    execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "rename and change"], { cwd: root, stdio: "ignore", env: gitEnv });

    const g = graph(root);
    g.nodes = [symbol("sym:src/current.ts#current", "current", "src/current.ts")];
    const [gap] = rankRiskGaps(g, { limit: 1, repoRoot: root });
    expect(gap.git_churn).toBeGreaterThan(0);
    expect(gap.churn_state).toBe("complete");
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

  it("NEGATIVE: a destructive sink behind an Associated scheduled entry gets no silence multiplier when Associated rows are requested", () => {
    const g = graph();
    const run = symbol("sym:service/worker/scanner/task.go#task.Run", "task.Run", "service/worker/scanner/task.go");
    const hf = withExt(symbol("sym:service/worker/scanner/task.go#task.handleFailures", "task.handleFailures", "service/worker/scanner/task.go"), ["t.store.DeleteRow"]);
    g.nodes = [run, hf, testCase("test:scanner_test.go")];
    g.edges = [edge(run.external_id, hf.external_id, "CALLS"), edge(run.external_id, "test:scanner_test.go", "TESTED_BY")];
    const ranked = rankRiskGaps(g, { limit: 10, repoRoot: "", includeAssociated: true });
    const r = ranked.find((x) => x.id === run.external_id)!;
    // Static invocation-backed association is D5, never Proven and never 5 × 1.25.
    expect(r.detection_tier).toBe("associated");
    expect(r.detection_difficulty).toBe(5);
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

  it("HYGIENE: e2e test-support helpers stay denominator-eligible but never take a production risk slot", () => {
    const g = graph();
    const helper = symbol(
      "sym:packages/twenty-e2e-testing/lib/requests/delete-workflow.ts#deleteWorkflow",
      "deleteWorkflow",
      "packages/twenty-e2e-testing/lib/requests/delete-workflow.ts"
    );
    const product = symbol(
      "sym:packages/server/src/testing-platform/run.ts#runTestingPlatform",
      "runTestingPlatform",
      "packages/server/src/testing-platform/run.ts"
    );
    g.nodes = [helper, product];

    expect(helper.denominator_eligible).toBe(true);
    expect(builtInRankExclusion("packages/twenty-e2e-testing/lib/requests/delete-workflow.ts")?.code).toBe("test_support_helper");
    expect(builtInRankExclusion("packages/server/src/testing-platform/run.ts")).toBeUndefined();

    const ids = rankRiskGaps(g, { limit: 10, repoRoot: "" }).map((row) => row.id);
    expect(ids).not.toContain(helper.external_id);
    expect(ids).toContain(product.external_id);
  });

  it("HYGIENE: Python class suppression is post-normalization and does not rescale peer methods", () => {
    const base = graph();
    const container = {
      ...symbol("sym:src/api/service.py#AccountService", "AccountService", "src/api/service.py"),
      properties: { file: "src/api/service.py", symbol_kind: "class", start_line: 1, end_line: 20 }
    };
    const method = {
      ...symbol("sym:src/api/service.py#AccountService.run", "AccountService.run", "src/api/service.py"),
      properties: { file: "src/api/service.py", symbol_kind: "method", member_of: "AccountService", start_line: 2, end_line: 10 }
    };
    const peer = symbol("sym:src/api/other.py#execute", "execute", "src/api/other.py");
    base.nodes = [container, method, peer];
    const suppressed = structuredClone(base);
    suppressed.nodes[0]!.properties.ranking_exclusion_reason = "python_structural_container";

    const before = rankRiskGaps(base, { limit: 10, repoRoot: "" });
    const after = rankRiskGaps(suppressed, { limit: 10, repoRoot: "" });
    expect(before.map((r) => r.id)).toContain(container.external_id);
    expect(after.map((r) => r.id)).not.toContain(container.external_id);
    for (const id of [method.external_id, peer.external_id]) {
      const a = before.find((r) => r.id === id)!;
      const b = after.find((r) => r.id === id)!;
      expect({ probability: b.probability, impact: b.impact, detection: b.detection_difficulty, score: b.risk_score })
        .toEqual({ probability: a.probability, impact: a.impact, detection: a.detection_difficulty, score: a.risk_score });
    }
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
    expect(a.config.tuning).toEqual({ irreversibility_floor: true, silence_multiplier: true, churn_window_days: 180 });
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

describe("user-level risk config defaults (~/.orangepro/config.json, overridable per repo)", () => {
  it("applies user defaults first, lets the repo file win, and hashes the merged result", () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
    const { tmpdir } = require("node:os") as typeof import("node:os");
    const { join } = require("node:path") as typeof import("node:path");
    const home = mkdtempSync(join(tmpdir(), "oprohome-"));
    writeFileSync(join(home, "config.json"), JSON.stringify({ tuning: { irreversibility_floor: false }, classification: { rank_exclude_paths: ["ui/**"] } }));
    const prev = process.env.ORANGEPRO_USER_CONFIG;
    process.env.ORANGEPRO_USER_CONFIG = join(home, "config.json");
    try {
      const a = loadRiskConfig("");
      expect(a.config.tuning.irreversibility_floor).toBe(false);
      expect(a.config.classification.rank_exclude_paths).toEqual(["ui/**"]);
      const repo = mkdtempSync(join(tmpdir(), "oprorepo-"));
      mkdirSync(join(repo, ".orangepro"));
      writeFileSync(join(repo, ".orangepro", "config.json"), JSON.stringify({ tuning: { irreversibility_floor: true } }));
      const b = loadRiskConfig(repo);
      expect(b.config.tuning.irreversibility_floor).toBe(true);
      expect(b.config.classification.rank_exclude_paths).toEqual(["ui/**"]);
      expect(a.hash).not.toBe(b.hash);
    } finally {
      if (prev === undefined) delete process.env.ORANGEPRO_USER_CONFIG; else process.env.ORANGEPRO_USER_CONFIG = prev;
    }
  });
});

describe("round three — reviewer reproductions as fixtures", () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const repoWith = (json: string): string => {
    const root = mkdtempSync(join(tmpdir(), "oprorev-"));
    mkdirSync(join(root, ".orangepro"));
    writeFileSync(join(root, ".orangepro", "config.json"), json);
    return root;
  };

  it("#1 a config with a // comment is invalid JSON: defaults apply AND a warning is produced (never silent)", () => {
    const root = repoWith('{ "tuning": { "irreversibility_floor": false // back to old behavior\n } }');
    const l = loadRiskConfig(root);
    expect(l.config.tuning.irreversibility_floor).toBe(true);
    expect(l.warnings.some((w) => /unreadable|JSON/i.test(w))).toBe(true);
    expect(configDisclosureFor(graph(root), root).warnings.length).toBeGreaterThan(0);
  });

  it("hashes and discloses a non-empty custom Python proof runner command", () => {
    const customRoot = repoWith(JSON.stringify({ tuning: { churn_window_days: 90 }, proof: { python_runner: "uv run python -m pytest -p no:warnings", attempt_limit: 17, baseline_green_target: 4 } }));
    const autoRoot = repoWith(JSON.stringify({ proof: { python_runner: "auto", attempt_limit: 17, baseline_green_target: 4 } }));
    const custom = loadRiskConfig(customRoot);
    expect(custom.config.proof).toEqual({ python_runner: "uv run python -m pytest -p no:warnings", attempt_limit: 17, baseline_green_target: 4 });
    expect(custom.hash).not.toBe(loadRiskConfig(autoRoot).hash);
    expect(configDisclosureFor(graph(customRoot), customRoot).proof).toEqual(custom.config.proof);
    expect(configDisclosureFor(graph(customRoot), customRoot).tuning).toEqual({ churn_window_days: 90 });
  });

  it("#2 a suppressed symbol is DISCLOSED with its reason, not silently dropped", () => {
    const root = repoWith(JSON.stringify({ overrides: [{ symbol: "sym:src/noise.go#noise.Run", action: "suppress", reason: "generated shim, not product behavior" }] }));
    const g = graph(root);
    g.nodes = [symbol("sym:src/noise.go#noise.Run", "noise.Run", "src/noise.go"), symbol("sym:src/real.go#Real.Do", "Real.Do", "src/real.go")];
    expect(rankRiskGaps(g, { limit: 10, repoRoot: root }).map((r) => r.id)).not.toContain("sym:src/noise.go#noise.Run");
    const d = configDisclosureFor(g, root);
    expect(d.suppressed).toEqual([{ symbol: "noise.Run", reason: "generated shim, not product behavior" }]);
    expect(d.overridesActive).toBe(1);
  });

  it.each([["payment", 10], ["auth", 9], ["pii", 8], ["none", 0]] as const)("#3 reclassify to %s sets the row's sensitivity to %i", (cls, expected) => {
    const root = repoWith(JSON.stringify({ overrides: [{ symbol: "sym:src/x.go#Svc.Do", action: "reclassify", sensitivity: cls, reason: "classified by the owning team after review" }] }));
    const g = graph(root);
    g.nodes = [symbol("sym:src/x.go#Svc.Do", "Svc.Do", "src/x.go")];
    const r = rankRiskGaps(g, { limit: 10, repoRoot: root }).find((x) => x.id === "sym:src/x.go#Svc.Do")!;
    expect(r.data_sensitivity).toBe(expected);
  });

  it("#2b every ranking-changing classification setting is disclosed, and sensitivity_ignore names the symbols it changed", () => {
    const root = repoWith(JSON.stringify({ classification: { sensitivity_ignore: ["*CapturePanic*"], test_support_paths: ["internal/testutil/**"], destructive_sinks: ["Purge*"] } }));
    const g = graph(root);
    g.nodes = [symbol("sym:common/log/panic.go#log.CapturePanic", "log.CapturePanic", "common/log/panic.go")];
    const d = configDisclosureFor(g, root);
    expect(d.classification.sensitivity_ignore).toEqual(["*CapturePanic*"]);
    expect(d.classification.test_support_paths).toEqual(["internal/testutil/**"]);
    expect(d.classification.destructive_sinks).toEqual(["Purge*"]);
    expect(d.sensitivityIgnored).toEqual(["log.CapturePanic"]);
  });

  it("#5 a destructive path ranked far below the top 200 still reaches the irreversible worklist (full-ranking search)", () => {
    const g = graph();
    const filler = Array.from({ length: 260 }, (_, i) => symbol(`sym:src/f${i}.go#F${i}.Do`, `F${i}.Do`, `src/f${i}.go`));
    const low = { ...symbol("sym:pkg/store/gc.go#gc.Sweep", "gc.Sweep", "pkg/store/gc.go"), properties: { file: "pkg/store/gc.go", external_callees: ["g.store.DeleteExpired"] } };
    g.nodes = [...filler, low];
    const all = rankRiskGaps(g, { limit: Number.MAX_SAFE_INTEGER, repoRoot: "" });
    const sinks = all.filter((r) => r.sink_callee);
    expect(sinks.map((r) => r.id)).toContain(low.external_id);
  });
});

describe("Round 7 structural ranking exclusions and constructor-chain sinks", () => {
  const repo = (files: Record<string, string>): string => {
    const root = mkdtempSync(join(tmpdir(), "opro-r7-"));
    dirs.push(root);
    for (const [file, content] of Object.entries(files)) {
      mkdirSync(join(root, file, ".."), { recursive: true });
      writeFileSync(join(root, file), content);
    }
    return root;
  };
  const classSymbol = (id: string, title: string, file: string, start: number, end: number) => ({
    ...symbol(id, title, file), properties: { file, symbol_kind: "class", start_line: start, end_line: end }
  });
  const methodSymbol = (id: string, title: string, file: string, owner: string, start: number, end: number) => ({
    ...symbol(id, title, file), properties: { file, symbol_kind: "method", member_of: owner, start_line: start, end_line: end }
  });

  it("excludes only a literal/parameter thread-local initializer, including a literal self assignment", () => {
    const root = repo({
      "src/holder.py": [
        "import threading",
        "class Holder(threading.local):",
        "    def __init__(self, value=None):",
        "        \"\"\"state\"\"\"",
        "        super().__init__()",
        "        self.user = 'hello'",
        "        self.value = value",
        "        self.empty = None",
        "class Unsafe(threading.local):",
        "    def __init__(self):",
        "        self.x = load()",
        "class Branched(threading.local):",
        "    def __init__(self, value):",
        "        if value:",
        "            self.value = value",
        "class Looped(threading.local):",
        "    def __init__(self):",
        "        for value in []:",
        "            self.value = value"
      ].join("\n")
    });
    const g = graph(root);
    g.nodes = [
      classSymbol("sym:src/holder.py#Holder", "Holder", "src/holder.py", 2, 7),
      { ...methodSymbol("sym:src/holder.py#Holder.__init__", "Holder.__init__", "src/holder.py", "Holder", 3, 7), properties: { ...methodSymbol("sym:x#x", "x", "src/holder.py", "Holder", 3, 7).properties, ranking_exclusion_reason_code: "python_trivial_thread_local_initializer" } },
      classSymbol("sym:src/holder.py#Unsafe", "Unsafe", "src/holder.py", 9, 11),
      methodSymbol("sym:src/holder.py#Unsafe.__init__", "Unsafe.__init__", "src/holder.py", "Unsafe", 10, 11),
      classSymbol("sym:src/holder.py#Branched", "Branched", "src/holder.py", 12, 15),
      methodSymbol("sym:src/holder.py#Branched.__init__", "Branched.__init__", "src/holder.py", "Branched", 13, 15),
      classSymbol("sym:src/holder.py#Looped", "Looped", "src/holder.py", 16, 19),
      methodSymbol("sym:src/holder.py#Looped.__init__", "Looped.__init__", "src/holder.py", "Looped", 17, 19)
    ];
    const ids = rankRiskGaps(g, { repoRoot: root, limit: 20 }).map((row) => row.id);
    expect(ids).not.toContain("sym:src/holder.py#Holder.__init__");
    expect(ids).toEqual(expect.arrayContaining([
      "sym:src/holder.py#Unsafe.__init__",
      "sym:src/holder.py#Branched.__init__",
      "sym:src/holder.py#Looped.__init__"
    ]));
  });

  it("excludes only stdlib enum declarations without methods", () => {
    const root = repo({
      "src/kinds.py": [
        "from enum import Enum, Flag as StdFlag",
        "import enum as enums",
        "class Color(Enum):",
        "    RED = 1",
        "    BLUE = 2",
        "    GREEN = 3",
        "class Mode(enums.IntFlag):",
        "    READ = 1",
        "    WRITE = 2",
        "    EXECUTE = 4",
        "class Behaviour(StdFlag):",
        "    X = 1",
        "    def active(self):",
        "        return True",
        "class Enum:",
        "    ONE = 1",
        "    TWO = 2",
        "    THREE = 3",
        "class UserNamed(Enum):",
        "    ONE = 1",
        "    TWO = 2",
        "    THREE = 3"
      ].join("\n")
    });
    const g = graph(root);
    g.nodes = [
      { ...classSymbol("sym:src/kinds.py#Color", "Color", "src/kinds.py", 3, 6), properties: { ...classSymbol("sym:x#x", "x", "src/kinds.py", 3, 6).properties, ranking_exclusion_reason_code: "python_stdlib_enum_declaration" } },
      { ...classSymbol("sym:src/kinds.py#Mode", "Mode", "src/kinds.py", 7, 10), properties: { ...classSymbol("sym:x#x", "x", "src/kinds.py", 7, 10).properties, ranking_exclusion_reason_code: "python_stdlib_enum_declaration" } },
      classSymbol("sym:src/kinds.py#Behaviour", "Behaviour", "src/kinds.py", 11, 14),
      classSymbol("sym:src/kinds.py#Enum", "Enum", "src/kinds.py", 15, 18),
      classSymbol("sym:src/kinds.py#UserNamed", "UserNamed", "src/kinds.py", 19, 22)
    ];
    const ids = rankRiskGaps(g, { repoRoot: root, limit: 20 }).map((row) => row.id);
    expect(ids).not.toEqual(expect.arrayContaining(["sym:src/kinds.py#Color", "sym:src/kinds.py#Mode"]));
    expect(ids).toEqual(expect.arrayContaining(["sym:src/kinds.py#Behaviour", "sym:src/kinds.py#Enum", "sym:src/kinds.py#UserNamed"]));
  });

  it("excludes only an exact external bare-parameter delegate and keeps sensitive, altered, and side-effecting wrappers", () => {
    const root = repo({
      "src/wrappers.py": [
        "import vendor_lib as vendor",
        "from vendor_objects import client",
        "def relay(value: str, count=1):",
        "    \"\"\"delegate\"\"\"",
        "    return vendor.run(value, count)",
        "def object_relay(value):",
        "    return client.run(value)",
        "def password_hash(password):",
        "    return vendor.hash(password)",
        "def altered(value):",
        "    return vendor.run(value.strip())",
        "def side_effect(value):",
        "    audit(value)",
        "    return vendor.run(value)",
        "def alias(value):",
        "    return value",
        "import vendor_lib as _backend",
        "backend = _backend",
        "def forwarded(value):",
        "    return backend.run(value)",
        "import helper_lib as _driver",
        "driver = _driver",
        "driver = _driver",
        "def duplicated_alias(value):",
        "    return driver.run(value)",
        "import service_lib as _service",
        "service = _service.client",
        "def derived_alias(value):",
        "    return service.run(value)"
      ].join("\n")
    });
    const g = graph(root);
    g.nodes = [
      { ...symbol("sym:src/wrappers.py#relay", "relay", "src/wrappers.py"), properties: { file: "src/wrappers.py", symbol_kind: "function", start_line: 3, end_line: 5, ranking_exclusion_reason_code: "python_thin_external_delegate" } },
      { ...symbol("sym:src/wrappers.py#object_relay", "object_relay", "src/wrappers.py"), properties: { file: "src/wrappers.py", symbol_kind: "function", start_line: 6, end_line: 7, ranking_exclusion_reason_code: "python_thin_external_delegate" } },
      { ...symbol("sym:src/wrappers.py#password_hash", "password_hash", "src/wrappers.py"), properties: { file: "src/wrappers.py", symbol_kind: "function", start_line: 8, end_line: 9 } },
      { ...symbol("sym:src/wrappers.py#altered", "altered", "src/wrappers.py"), properties: { file: "src/wrappers.py", symbol_kind: "function", start_line: 10, end_line: 11 } },
      { ...symbol("sym:src/wrappers.py#side_effect", "side_effect", "src/wrappers.py"), properties: { file: "src/wrappers.py", symbol_kind: "function", start_line: 12, end_line: 14 } },
      { ...symbol("sym:src/wrappers.py#alias", "alias", "src/wrappers.py"), properties: { file: "src/wrappers.py", symbol_kind: "function", start_line: 15, end_line: 16 } },
      { ...symbol("sym:src/wrappers.py#forwarded", "forwarded", "src/wrappers.py"), properties: { file: "src/wrappers.py", symbol_kind: "function", start_line: 19, end_line: 20, ranking_exclusion_reason_code: "python_thin_external_delegate" } },
      { ...symbol("sym:src/wrappers.py#duplicated_alias", "duplicated_alias", "src/wrappers.py"), properties: { file: "src/wrappers.py", symbol_kind: "function", start_line: 24, end_line: 25 } },
      { ...symbol("sym:src/wrappers.py#derived_alias", "derived_alias", "src/wrappers.py"), properties: { file: "src/wrappers.py", symbol_kind: "function", start_line: 28, end_line: 29 } }
    ];
    const ids = rankRiskGaps(g, { repoRoot: root, limit: 20 }).map((row) => row.id);
    expect(ids).not.toContain("sym:src/wrappers.py#relay");
    expect(ids).not.toContain("sym:src/wrappers.py#object_relay");
    expect(ids).not.toContain("sym:src/wrappers.py#forwarded");
    expect(ids).toEqual(expect.arrayContaining([
      "sym:src/wrappers.py#password_hash",
      "sym:src/wrappers.py#altered",
      "sym:src/wrappers.py#side_effect",
      "sym:src/wrappers.py#alias",
      "sym:src/wrappers.py#duplicated_alias",
      "sym:src/wrappers.py#derived_alias"
    ]));
  });

  it("accepts exactly one visible in-repo class constructor before a destructive terminal and rejects unsafe chains", () => {
    const g = graph();
    const repoClass = classSymbol("sym:src/commands.py#Repo", "Repo", "src/commands.py", 1, 2);
    const sameNameElsewhere = classSymbol("sym:src/other.py#Repo", "Repo", "src/other.py", 1, 2);
    const importedClass = classSymbol("sym:src/repository.py#Store", "Store", "src/repository.py", 1, 2);
    const ambiguousClass = classSymbol("sym:src/other_repository.py#Store", "Store", "src/other_repository.py", 1, 2);
    const good = { ...symbol("sym:src/commands.py#clean", "clean", "src/commands.py"), properties: { file: "src/commands.py", external_callees: ["Repo(db).view.delete"], constructor_chain_sinks: [{ callee: "Repo(db).view.delete", constructor_symbol: repoClass.external_id }] } };
    const imported = { ...symbol("sym:src/imported_command.py#clean", "clean", "src/imported_command.py"), properties: { file: "src/imported_command.py", external_callees: ["Store(db).table.removeItem"], constructor_chain_sinks: [{ callee: "Store(db).table.removeItem", constructor_symbol: importedClass.external_id }] } };
    const nested = { ...symbol("sym:src/commands.py#nested", "nested", "src/commands.py"), properties: { file: "src/commands.py", external_callees: ["make().x().delete"] } };
    const participle = { ...symbol("sym:src/commands.py#past", "past", "src/commands.py"), properties: { file: "src/commands.py", external_callees: ["Repo(db).table.deleted"] } };
    const nonPersistentRemove = { ...symbol("sym:src/commands.py#detach", "detach", "src/commands.py"), properties: { file: "src/commands.py", external_callees: ["Repo(db).view.removeItem"] } };
    const collision = { ...symbol("sym:src/wrong.py#collision", "collision", "src/wrong.py"), properties: { file: "src/wrong.py", external_callees: ["Repo(db).table.delete"] } };
    const ambiguous = { ...symbol("sym:src/ambiguous.py#clean", "clean", "src/ambiguous.py"), properties: { file: "src/ambiguous.py", external_callees: ["Store(db).table.delete"] } };
    g.nodes = [repoClass, sameNameElsewhere, importedClass, ambiguousClass, good, imported, nested, participle, nonPersistentRemove, collision, ambiguous];
    g.edges = [
      edge("src/imported_command.py", "src/repository.py", "IMPORTS"),
      edge("src/ambiguous.py", "src/repository.py", "IMPORTS"),
      edge("src/ambiguous.py", "src/other_repository.py", "IMPORTS")
    ];
    const rows = new Map(rankRiskGaps(g, { repoRoot: "", limit: 20 }).map((row) => [row.id, row]));
    expect(rows.get(good.external_id)?.sink_callee).toBe("Repo(db).view.delete");
    expect(rows.get(imported.external_id)?.sink_callee).toBe("Store(db).table.removeItem");
    expect(rows.get(nested.external_id)?.sink_callee).toBeUndefined();
    expect(rows.get(participle.external_id)?.sink_callee).toBeUndefined();
    expect(rows.get(nonPersistentRemove.external_id)?.sink_callee).toBeUndefined();
    expect(rows.get(collision.external_id)?.sink_callee).toBeUndefined();
    expect(rows.get(ambiguous.external_id)?.sink_callee).toBeUndefined();
  });
});

describe("config warnings reach EVERY ranking entry point, in both usage patterns (surface, not mechanism)", () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = require("node:fs") as typeof import("node:fs");
  const { tmpdir } = require("node:os") as typeof import("node:os");
  const { join } = require("node:path") as typeof import("node:path");
  const makeRepo = (): string => {
    const repo = mkdtempSync(join(tmpdir(), "oprosurf-"));
    mkdirSync(join(repo, "src"));
    writeFileSync(join(repo, "src", "a.ts"), "export function a(){ return 1 }\n");
    mkdirSync(join(repo, ".orangepro"));
    writeFileSync(join(repo, ".orangepro", "config.json"), '{ "tuning": { "irreversibility_floor": false // comment\n } }');
    return repo;
  };

  it("cross-directory: analyze <path> then gaps from the workspace both carry the config warning", async () => {
    const { opAnalyze, opGaps } = await import("../../src/local/operations.js");
    const repo = makeRepo();
    const ws = mkdtempSync(join(tmpdir(), "oprows-"));
    const a = opAnalyze(ws, { source: repo });
    expect(a.warnings.some((w) => /config \(repo\): unreadable/.test(w))).toBe(true);
    const g = opGaps(ws, {});
    expect((g.warnings ?? []).some((w) => /config \(repo\): unreadable/.test(w))).toBe(true);
  });

  it("in-repo: an unreadable workspace config aborts analyze with the file path and a hint, never a bare parse error", async () => {
    const { opAnalyze } = await import("../../src/local/operations.js");
    const repo = makeRepo();
    expect(() => opAnalyze(repo, {})).toThrow(/Unreadable .*config\.json.*JSON does not allow \/\/ comments/);
  });
});
