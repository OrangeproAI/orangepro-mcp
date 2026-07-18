import { afterEach, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { buildRtm, renderRtmCsv, renderRtmMarkdown } from "../../src/local/rtm.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, type LocalGraph } from "../../src/local/graph/ontology.js";
import { makeCandidateEdge, makeEdge, makeNode } from "../../src/local/graph/factories.js";
import { LEDGER_SCHEMA_VERSION, targetFingerprint, type Ledger } from "../../src/local/ledger.js";
import { opAnalyze, opDynamicProof, opInit, opRtm } from "../../src/local/operations.js";

const emptyLedger = (): Ledger => ({ schema_version: LEDGER_SCHEMA_VERSION, records: [] });
const dirs: string[] = [];
const deps = { clock: () => "2026-06-24T00:00:00Z", env: {} as NodeJS.ProcessEnv };

afterEach(() => {
  while (dirs.length) {
    const dir = dirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t.io", "-c", "user.name=t", ...args], {
    cwd,
    stdio: [ "ignore", "ignore", "ignore" ]
  });
}

function gitWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-rtm-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }), "utf8");
  writeFileSync(join(root, "src", "card.ts"), "export function saveCard(){ return 1 }\n", "utf8");
  writeFileSync(join(root, "src", "pay.ts"), "export function chargeCard(){ return 1 }\n", "utf8");
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  opInit(root, deps);
  opAnalyze(root, { source: root }, deps);
  return root;
}

function graph(mathHash = "sha256:math-v1"): LocalGraph {
  const scope = {
    source_scope_id: "scope:repo",
    source_system: "repo",
    source_type: "local_checkout",
    display_name: "repo",
    content_hash: "hash",
    metadata: {}
  };
  const test = makeNode({
    kind: "TestCase",
    external_id: "test:svc/math_test.go",
    title: "TestAdd",
    properties: { test_layer: "unit" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: scope.source_scope_id, source_ref: "svc/math_test.go" }
  });
  const add = makeNode({
    kind: "CodeSymbol",
    external_id: "sym:svc/math.go#Add",
    title: "Add",
    properties: { file: "svc/math.go" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: scope.source_scope_id, source_ref: "svc/math.go" },
    behavior_source: "code_export",
    denominator_eligible: true
  });
  const validate = makeNode({
    kind: "CodeSymbol",
    external_id: "sym:svc/math.go#Validate",
    title: "ValidateInput",
    properties: { file: "svc/math.go" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: scope.source_scope_id, source_ref: "svc/math.go" },
    behavior_source: "code_export",
    denominator_eligible: true
  });
  const sub = makeNode({
    kind: "CodeSymbol",
    external_id: "sym:svc/math.go#Sub",
    title: "Sub",
    properties: { file: "svc/math.go" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: scope.source_scope_id, source_ref: "svc/math.go" },
    behavior_source: "code_export",
    denominator_eligible: true
  });
  const req = makeNode({
    kind: "Requirement",
    external_id: "REQ-1",
    title: "Calculator returns sums",
    properties: {},
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: scope.source_scope_id, source_ref: "docs/req.md" },
    behavior_source: "markdown_requirement",
    denominator_eligible: true
  });
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "repo", root: ".", root_hash: "hash", source_upload_policy: "metadata_only" },
    created_at: "2026-06-24T00:00:00Z",
    updated_at: "2026-06-24T00:00:00Z",
    sources: [scope],
    nodes: [test, add, validate, sub, req],
    edges: [
      makeEdge({
        from_external_id: test.external_id,
        to_external_id: add.external_id,
        relationship_type: "COVERS",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: { source_scope_id: scope.source_scope_id, source_ref: "svc/math_test.go" }
      }),
      makeEdge({
        from_external_id: req.external_id,
        to_external_id: test.external_id,
        relationship_type: "TESTED_BY",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: { source_scope_id: scope.source_scope_id, source_ref: "docs/req.md" }
      })
    ],
    candidate_edges: [
      makeCandidateEdge({
        from_external_id: validate.external_id,
        to_external_id: test.external_id,
        relationship_type: "MAY_COVER",
        evidence_strength: "candidate",
        reason: "fixture association",
        confidence: 0.4,
        provenance: { source_scope_id: scope.source_scope_id, source_ref: "svc/math_test.go" }
      })
    ],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "2026-06-24T00:00:00Z", files: { "svc/math.go": { hash: mathHash, size: 32, kind: "code" } }, git: { dirty: false } }
  };
}

function dynamicProofRecord(target_symbol = "sym:svc/math.go#Add", g: LocalGraph = graph()): Ledger["records"][number] {
  return {
    run_id: "run:dynamic",
    target_symbol,
    pre_edges: [],
    new_edges: [],
    closed: true,
    status: "reproven",
    target_fingerprint: targetFingerprint(g, target_symbol),
    dynamic_proof: {
      proof_kind: "dynamic_targeted",
      baseline_green: true,
      mutant_failed_assertion: true,
      target_not_mocked: true,
      sentinel: "return-json",
      runner: "vitest",
      test_path: "svc/math_test.go"
    },
    ts: "2026-06-24T00:00:00Z",
    pre_edge_count: 0
  };
}

describe("RTM builder", () => {
  it("keeps static hard test edges associated until a dynamic proof certificate exists", () => {
    const g = graph();
    const rtm = buildRtm(g, emptyLedger());

    expect(rtm.summary).toMatchObject({
      total: 4,
      proven: 0,
      associated: 2,
      candidate: 1,
      no_link: 1
    });
    expect(rtm.rows.map((r) => [r.behavior_id, r.status])).toEqual([
      ["sym:svc/math.go#Sub", "No integration signal"],
      ["sym:svc/math.go#Validate", "Candidate signal (unconfirmed)"],
      ["REQ-1", "Associated signal"],
      ["sym:svc/math.go#Add", "Associated signal"]
    ]);
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Add")?.test_signal).toContain("static candidate:");

    const scoped = buildRtm(g, emptyLedger(), { changedFiles: ["svc/math.go"] });
    expect(scoped.summary).toMatchObject({
      total: 3,
      proven: 0,
      associated: 1,
      candidate: 1,
      coverage_confirmed: 0,
      coverage_total: 3
    });
  });

  it("increments Proven only for dynamic targeted proof records", () => {
    const rtm = buildRtm(graph(), {
      schema_version: LEDGER_SCHEMA_VERSION,
      records: [dynamicProofRecord()]
    });

    expect(rtm.summary).toMatchObject({
      total: 4,
      proven: 1,
      associated: 1,
      candidate: 1,
      no_link: 1,
      coverage_confirmed: 1,
      coverage_total: 4
    });
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Add")).toMatchObject({
      evidence_tier: "proven",
      status: "Reproven (this run)",
      test_signal: expect.stringContaining("dynamic targeted proof")
    });
  });

  it("rejects partial dynamic proof certificates", () => {
    const partial = dynamicProofRecord();
    partial.dynamic_proof = { ...partial.dynamic_proof!, target_not_mocked: false };
    const rtm = buildRtm(graph(), {
      schema_version: LEDGER_SCHEMA_VERSION,
      records: [partial]
    });

    expect(rtm.summary.proven).toBe(0);
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Add")).toMatchObject({
      evidence_tier: "associated",
      status: "Associated signal"
    });
  });

  it("keeps Proven when a later failed prove hits the same unchanged target (best-ever-proven)", () => {
    const proof = { ...dynamicProofRecord(), run_id: "run:proof", ts: "2026-06-23T00:00:00Z" };
    // A NEWER failed re-prove for the same symbol. Under pure latest-wins this demoted the genuine
    // proof to Associated (the false-negative this change fixes); best-ever-proven keeps it Proven.
    const laterFailed = {
      ...dynamicProofRecord(),
      run_id: "run:later-failed",
      status: "unproven" as const,
      closed: false,
      dynamic_proof: undefined,
      target_fingerprint: undefined,
      ts: "2026-06-25T00:00:00Z"
    };
    const rtm = buildRtm(graph(), { schema_version: LEDGER_SCHEMA_VERSION, records: [proof, laterFailed] });
    expect(rtm.summary.proven).toBe(1);
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Add")?.evidence_tier).toBe("proven");
  });

  it("lapses Proven when the target file content hash changes (fingerprint differs)", () => {
    const proof = dynamicProofRecord("sym:svc/math.go#Add", graph("sha256:math-v1"));
    const rtm = buildRtm(graph("sha256:math-v2"), { schema_version: LEDGER_SCHEMA_VERSION, records: [proof] });
    expect(rtm.summary.proven).toBe(0);
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Add")?.status).toBe("Associated signal");
  });

  it("does not count a dynamic proof without a target_fingerprint as Proven (pre-existing ledger)", () => {
    const legacy = { ...dynamicProofRecord(), target_fingerprint: undefined };
    const rtm = buildRtm(graph(), { schema_version: LEDGER_SCHEMA_VERSION, records: [legacy] });
    expect(rtm.summary.proven).toBe(0);
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Add")?.status).toBe("Associated signal");
  });

  it("falls back to the latest record for diagnostics but never Proven when no matching proof exists", () => {
    // An older valid proof for a DIFFERENT (mismatched) fingerprint, plus a newer unproven attempt.
    const staleProof = dynamicProofRecord("sym:svc/math.go#Add", graph("sha256:other"));
    const newerUnproven = {
      ...dynamicProofRecord(),
      run_id: "run:newer-unproven",
      status: "unproven" as const,
      closed: false,
      dynamic_proof: undefined,
      target_fingerprint: undefined,
      ts: "2026-06-26T00:00:00Z"
    };
    const rtm = buildRtm(graph("sha256:math-v1"), { schema_version: LEDGER_SCHEMA_VERSION, records: [staleProof, newerUnproven] });
    const row = rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Add");
    expect(rtm.summary.proven).toBe(0);
    expect(row?.status).not.toBe("Proven");
    expect(row?.ledger_run_id).toBe("run:newer-unproven");
  });

  it("keeps isDynamicProofRecord as the sole success gate even when the fingerprint matches", () => {
    const broken = dynamicProofRecord();
    broken.dynamic_proof = { ...broken.dynamic_proof!, target_not_mocked: false };
    const rtm = buildRtm(graph(), { schema_version: LEDGER_SCHEMA_VERSION, records: [broken] });
    expect(rtm.summary.proven).toBe(0);
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Add")?.evidence_tier).toBe("associated");
  });

  it("e2e: a real dynamic proof stays Proven across a later surviving mutant on the same file, and lapses when the file changes", () => {
    const W = mkdtempSync(join(tmpdir(), "oplocal-rtm-e2e-"));
    dirs.push(W);
    writeFileSync(join(W, "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }), "utf8");
    writeFileSync(join(W, "service.ts"), "export function createOrder(id: string): string {\n  return `order-${id}`;\n}\n", "utf8");
    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    const oracle = (proven: boolean, assertionFailure: boolean) => () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        status: proven ? "proven" : "associated_survived",
        proven,
        reason: proven ? "baseline passed and mutant failed at an assertion" : "mutated target did not change the test outcome",
        runner: "vitest",
        replacementMode: "return-json",
        test: "service.test.ts",
        target: "service.ts",
        method: "createOrder",
        baseline: { exitCode: 0, timedOut: false },
        mutant: { exitCode: assertionFailure ? 1 : 0, timedOut: false, assertionFailure },
        medianProofMs: 5
      })
    });
    const proveOpts = (replacement: string, run_id: string) => ({
      target_symbol: "sym:service.ts#createOrder",
      source: W,
      test_path: "service.test.ts",
      target_path: "service.ts",
      method: "createOrder",
      replacement,
      runner: "vitest" as const,
      run_id
    });

    opDynamicProof(W, proveOpts("return null;", "run:proof"), { ...deps, dynamicProofRunner: oracle(true, true) });
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(1);

    // Re-run with a SURVIVING mutant on the same unchanged file → the earlier proof must survive.
    opDynamicProof(W, proveOpts("return `order-${id}`;", "run:survived"), { ...deps, dynamicProofRunner: oracle(false, false) });
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(1);

    // Change the target file + re-analyze → its manifest hash (hence fingerprint) changes → proof lapses.
    writeFileSync(join(W, "service.ts"), "export function createOrder(id: string): string {\n  return `ORDER-${id}`.trim();\n}\n", "utf8");
    opAnalyze(W, { source: W }, deps);
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);
  });

  it("refuses to prove a target whose file changed since analyze (stale-graph fingerprint guard)", () => {
    const W = mkdtempSync(join(tmpdir(), "oplocal-rtm-stale-before-prove-"));
    dirs.push(W);
    writeFileSync(join(W, "package.json"), JSON.stringify({ name: "fx", version: "1.0.0" }), "utf8");
    writeFileSync(join(W, "service.ts"), "export function createOrder(id: string): string {\n  return `order-${id}`;\n}\n", "utf8");
    writeFileSync(join(W, "service.test.ts"), "import { createOrder } from './service';\nif (createOrder('1') !== 'order-1') throw new Error('bad');\n", "utf8");
    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    // Source changes AFTER analyze but BEFORE prove. The oracle would run against the
    // new bytes, so the cert must not bind to the stale analyzed fingerprint → refuse.
    writeFileSync(join(W, "service.ts"), "export function createOrder(id: string): string {\n  return `ORDER-${id}`.toLowerCase();\n}\n", "utf8");

    const provenRunner = () => ({
      exitCode: 0,
      stderr: "",
      stdout: JSON.stringify({
        status: "proven",
        proven: true,
        reason: "baseline passed and mutant failed at an assertion",
        runner: "vitest",
        replacementMode: "return-json",
        test: "service.test.ts",
        target: "service.ts",
        method: "createOrder",
        baseline: { exitCode: 0, timedOut: false },
        mutant: { exitCode: 1, timedOut: false, assertionFailure: true },
        medianProofMs: 5
      })
    });

    expect(() =>
      opDynamicProof(
        W,
        {
          target_symbol: "sym:service.ts#createOrder",
          source: W,
          test_path: "service.test.ts",
          target_path: "service.ts",
          method: "createOrder",
          replacement: "return null;"
        },
        { ...deps, dynamicProofRunner: provenRunner }
      )
    ).toThrow(/changed since analyze/);

    // No cert was minted → RTM never shows a stale-graph Proven.
    expect(opRtm(W, { format: "json" }).summary.proven).toBe(0);
  });

  it("surfaces runtime-covered behaviors without promoting them to proven", () => {
    const g = graph();
    const sub = g.nodes.find((n) => n.external_id === "sym:svc/math.go#Sub");
    if (sub) sub.properties = { ...sub.properties, runtime_covered: true, runtime_coverage_formats: ["go-coverprofile"] };

    const rtm = buildRtm(g, emptyLedger());
    const row = rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Sub");

    expect(row).toMatchObject({
      evidence_tier: "runtime",
      status: "Runtime-covered",
      test_signal: "runtime coverage (go-coverprofile)",
      suggested_next_test: ""
    });
    expect(rtm.summary).toMatchObject({
      total: 4,
      proven: 0,
      runtime_covered: 1,
      associated: 2,
      candidate: 1,
      no_link: 0,
      coverage_confirmed: 0
    });
    expect(buildRtm(g, emptyLedger(), { statuses: ["runtime"] }).rows.map((r) => r.behavior_id)).toEqual(["sym:svc/math.go#Sub"]);
    expect(renderRtmMarkdown(rtm)).toContain("| Runtime-covered | 1 |");
  });

  it("does NOT propagate candidate signals through barrel imports, and never upgrades them to associated", () => {
    // Epistemic fix (Jul 17): a lexical/Jaccard candidate edge is a lead, not
    // evidence. Previously one candidate match on a barrel file marked its whole
    // import subtree "associated" — on Twenty CRM that inflated 93% of behaviors
    // into the test-signal tier. Candidates now (a) stay on the matched file only
    // and (b) surface as their own "candidate" tier.
    const g = graph();
    g.edges.push(
      makeEdge({
        from_external_id: "src/index.ts",
        to_external_id: "svc/math.go",
        relationship_type: "IMPORTS",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: { source_scope_id: "scope:repo", source_ref: "src/index.ts" }
      })
    );
    g.candidate_edges.push(
      makeCandidateEdge({
        from_external_id: "tests/basic.test.ts",
        to_external_id: "src/index.ts",
        relationship_type: "MAY_RELATE_TO",
        evidence_strength: "candidate",
        reason: "test imports package entry barrel",
        confidence: 0.4,
        provenance: { source_scope_id: "scope:repo", source_ref: "tests/basic.test.ts" }
      })
    );

    const rtm = buildRtm(g, emptyLedger());
    // The imported file's symbols must NOT inherit the barrel's candidate signal.
    const sub = rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Sub");
    expect(sub?.evidence_tier).toBe("none");
    expect(sub?.status).toBe("No integration signal");
    // Symbols in the matched file itself surface as candidate — visible, but never evidence.
    for (const row of rtm.rows.filter((r) => r.file === "src/index.ts")) {
      expect(row.evidence_tier).toBe("candidate");
      expect(row.status).toBe("Candidate signal (unconfirmed)");
    }
  });

  it("does not let AI-suggested links affect public Proven or Associated status", () => {
    const g = graph();
    g.candidate_edges.push(
      makeCandidateEdge({
        from_external_id: "sym:svc/math.go#Sub",
        to_external_id: "test:svc/math_test.go",
        relationship_type: "MAY_COVER",
        evidence_strength: "weak",
        review_status: "ai_suggested",
        reason: "AI guess",
        confidence: 0.7,
        provenance: { source_scope_id: "scope:repo", source_ref: "ai" }
      })
    );

    const rtm = buildRtm(g, emptyLedger());
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Sub")).toMatchObject({
      status: "No integration signal",
      evidence_tier: "none"
    });
    expect(rtm.summary.proven).toBe(0);
  });

  it("surfaces dynamic reproven and generated-unverifiable ledger outcomes without changing denominator totals", () => {
    const ledger: Ledger = {
      schema_version: LEDGER_SCHEMA_VERSION,
      records: [
        dynamicProofRecord(),
        {
          run_id: "run:2",
          target_symbol: "sym:svc/math.go#Sub",
          pre_edges: [],
          new_edges: [],
          closed: false,
          status: "generated_unverifiable",
          language: "python",
          ts: "2026-06-24T00:00:00Z",
          pre_edge_count: 0
        }
      ]
    };
    const rtm = buildRtm(graph(), ledger);

    expect(rtm.summary).toMatchObject({
      total: 4,
      proven: 1,
      no_link: 1,
      reproven_this_run: 1,
      generated_unverifiable: 1,
      attempted: 1,
      kept_rate: 100
    });
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Add")?.status).toBe("Reproven (this run)");
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Sub")?.status).toBe("Generated-unverifiable");
  });

  it("does not let stale or mismatched ledger rows mint proof status", () => {
    const ledger: Ledger = {
      schema_version: LEDGER_SCHEMA_VERSION,
      records: [
        {
          run_id: "run:stale",
          target_symbol: "sym:svc/math.go#Sub",
          pre_edges: [],
          new_edges: ["test:svc/math_test.go->sym:svc/math.go#Sub"],
          closed: true,
          status: "reproven",
          ts: "2026-06-24T00:00:00Z",
          pre_edge_count: 0
        },
        {
          run_id: "run:mismatch",
          target_symbol: "sym:svc/math.go#ValidateExtra",
          pre_edges: [],
          new_edges: ["test:svc/math_test.go->sym:svc/math.go#ValidateExtra"],
          closed: true,
          status: "reproven",
          ts: "2026-06-24T00:00:00Z",
          pre_edge_count: 0
        }
      ]
    };
    const rtm = buildRtm(graph(), ledger);

    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Sub")?.status).toBe("No integration signal");
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Validate")?.status).toBe("Candidate signal (unconfirmed)");
    expect(rtm.summary).toMatchObject({ reproven_this_run: 0, attempted: 1, kept_rate: 0 });
  });

  it("does not treat non-TestCase hard edges as proof", () => {
    const g = graph();
    g.edges.push(
      makeEdge({
        from_external_id: "REQ-1",
        to_external_id: "sym:svc/math.go#Sub",
        relationship_type: "COVERS",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: { source_scope_id: "scope:repo", source_ref: "docs/req.md" }
      })
    );

    const rtm = buildRtm(g, emptyLedger());
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Sub")?.status).toBe("No integration signal");
    expect(rtm.summary.proven).toBe(0);
  });

  it("renders metadata-only markdown and csv with deterministic suggestions", () => {
    const rtm = buildRtm(graph(), emptyLedger(), { statuses: ["no-link", "associated", "candidate"] });
    const md = renderRtmMarkdown(rtm);
    const csv = renderRtmCsv(rtm);

    // Validate carries only a lexical candidate edge → surfaces under its own
    // "candidate" status filter now, never under "associated".
    expect(rtm.rows.map((r) => r.status)).toEqual([
      "No integration signal",
      "Candidate signal (unconfirmed)",
      "Associated signal",
      "Associated signal"
    ]);
    expect(md).toContain("Traceability Matrix");
    expect(md).toContain("Add a validation test");
    expect(csv).toContain("behavior_id");
    expect(md).not.toContain("return a + b");
    expect(csv).not.toContain("return a + b");
  });

  it("prefix-escapes spreadsheet formula cells in CSV", () => {
    const g = graph();
    const sub = g.nodes.find((n) => n.external_id === "sym:svc/math.go#Sub");
    if (sub) sub.title = "=cmd|' /c calc'!A1";

    const csv = renderRtmCsv(buildRtm(g, emptyLedger(), { statuses: ["no-link"] }));
    expect(csv).toContain("'=cmd|' /c calc'!A1");
  });

  it("has no model/provider path in the RTM implementation", () => {
    const source = readFileSync(join(process.cwd(), "src/local/rtm.ts"), "utf8");
    expect(source).not.toMatch(/buildProvider|ModelProvider|OPENAI|ANTHROPIC|OLLAMA|complete\(/);
  });

  it("opRtm writes metadata-only reports and scopes rows to a real diff", () => {
    const root = gitWorkspace();
    writeFileSync(join(root, "src", "card.ts"), "export function saveCard(){ return 2 }\n", "utf8");

    const res = opRtm(root, { baseRef: "HEAD", format: "md", outputPath: "trace.md" });
    const md = readFileSync(res.rtm_path, "utf8");

    expect(res.scope).toMatchObject({ status: "ok", base_ref: "HEAD" });
    expect(res.rows.map((r) => r.behavior_id)).toContain("sym:src/card.ts#saveCard");
    expect(res.rows.map((r) => r.behavior_id)).not.toContain("sym:src/pay.ts#chargeCard");
    expect(md).toContain("Traceability Matrix");
    expect(md).not.toContain("return 2");
  });

  it("writes RTM output to a path outside the workspace (consistent with export --out)", () => {
    const root = gitWorkspace();
    const outDir = mkdtempSync(join(tmpdir(), "oplocal-rtmout-"));
    const outside = join(outDir, "rtm.md");
    expect(() => opRtm(root, { outputPath: outside })).not.toThrow();
    expect(readFileSync(outside, "utf8").length).toBeGreaterThan(0);
    rmSync(outDir, { recursive: true, force: true });
  });
});

describe("RTM display-union (off-denominator proven symbols)", () => {
  // A CodeSymbol living in the SAME file as `Add` (so targetFingerprint resolves from the
  // manifest) but NOT denominator-eligible → it is never a denominator row. A valid current
  // proof cert for it must union into `summary.proven` without touching the denominator math.
  function graphWithOffDenominatorSymbol(mathHash = "sha256:math-v1"): LocalGraph {
    const g = graph(mathHash);
    const off = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:svc/math.go#Print",
      title: "Print",
      properties: { file: "svc/math.go" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "scope:repo", source_ref: "svc/math.go" },
      behavior_source: "code_export",
      denominator_eligible: false
    });
    return { ...g, nodes: [...g.nodes, off] };
  }

  it("unions a current valid off-denominator proof into summary.proven but NOT into total/coverage_total", () => {
    const g = graphWithOffDenominatorSymbol();
    const proof = dynamicProofRecord("sym:svc/math.go#Print", g);
    const rtm = buildRtm(g, { schema_version: LEDGER_SCHEMA_VERSION, records: [proof] });

    // denominator (total/coverage_total) is unchanged vs the base graph (4 eligible behaviors)…
    expect(rtm.summary).toMatchObject({ total: 4, coverage_total: 4, coverage_confirmed: 0, coverage_pct: 0 });
    // …but the off-denominator proof IS counted in the honest "Dynamically Proven" headline.
    expect(rtm.summary.proven).toBe(1);
    const off = rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Print");
    expect(off).toMatchObject({ off_denominator: true, evidence_tier: "proven" });
    // The denominator symbols themselves are not proven here.
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Add")?.off_denominator).toBeUndefined();
    // Headline markdown is honest about the split.
    const md = renderRtmMarkdown(rtm);
    expect(md).toContain("off-denominator");
  });

  it("does NOT union a STALE off-denominator cert (fingerprint mismatch) — not proven, not counted (load-bearing)", () => {
    // Cert minted against math-v1; graph is now math-v2 → fingerprint differs → not proven.
    const staleProof = dynamicProofRecord("sym:svc/math.go#Print", graphWithOffDenominatorSymbol("sha256:math-v1"));
    const rtm = buildRtm(graphWithOffDenominatorSymbol("sha256:math-v2"), {
      schema_version: LEDGER_SCHEMA_VERSION,
      records: [staleProof]
    });
    expect(rtm.summary.proven).toBe(0);
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Print")).toBeUndefined();
    expect(rtm.summary).toMatchObject({ total: 4, coverage_total: 4 });
  });

  it("does NOT union a partial/invalid off-denominator cert (fails isDynamicProofRecord)", () => {
    const g = graphWithOffDenominatorSymbol();
    const partial = dynamicProofRecord("sym:svc/math.go#Print", g);
    partial.dynamic_proof = { ...partial.dynamic_proof!, target_not_mocked: false };
    const rtm = buildRtm(g, { schema_version: LEDGER_SCHEMA_VERSION, records: [partial] });
    expect(rtm.summary.proven).toBe(0);
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Print")).toBeUndefined();
  });

  it("a static edge to an off-denominator symbol with NO cert stays out of proven and out of the denominator", () => {
    const g = graphWithOffDenominatorSymbol();
    // Add a hard COVERS edge from the existing test to the off-denominator symbol (static only).
    const withEdge: LocalGraph = {
      ...g,
      edges: [
        ...g.edges,
        makeEdge({
          from_external_id: "test:svc/math_test.go",
          to_external_id: "sym:svc/math.go#Print",
          relationship_type: "COVERS",
          evidence_strength: "hard",
          review_status: "auto_detected",
          confidence: 1,
          provenance: { source_scope_id: "scope:repo", source_ref: "svc/math_test.go" }
        })
      ]
    };
    const rtm = buildRtm(withEdge, emptyLedger());
    expect(rtm.summary).toMatchObject({ total: 4, proven: 0, coverage_total: 4 });
    // A static edge alone never surfaces the off-denominator symbol as a row (no cert).
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Print")).toBeUndefined();
  });

  it("the base denominator count is unchanged by the union path (deterministic)", () => {
    const base = buildRtm(graph(), emptyLedger());
    const withOff = buildRtm(graphWithOffDenominatorSymbol(), emptyLedger());
    expect(withOff.summary.total).toBe(base.summary.total);
    expect(withOff.summary.coverage_total).toBe(base.summary.coverage_total);
  });

  it("an ON-denominator proof still counts in both proven AND the denominator ratio (unchanged behavior)", () => {
    const g = graphWithOffDenominatorSymbol();
    // Prove the denominator symbol Add AND the off-denominator symbol Print.
    const rtm = buildRtm(g, {
      schema_version: LEDGER_SCHEMA_VERSION,
      records: [dynamicProofRecord("sym:svc/math.go#Add", g), dynamicProofRecord("sym:svc/math.go#Print", g)]
    });
    expect(rtm.summary.proven).toBe(2); // 1 on-denominator + 1 off-denominator
    expect(rtm.summary.coverage_confirmed).toBe(1); // only the on-denominator proof
    expect(rtm.summary.coverage_total).toBe(4);
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Add")?.off_denominator).toBeUndefined();
    expect(rtm.rows.find((r) => r.behavior_id === "sym:svc/math.go#Print")?.off_denominator).toBe(true);
  });
});
