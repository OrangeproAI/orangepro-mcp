import { describe, it, expect } from "vitest";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import ts from "typescript";
import {
  gatherContext,
  generateTests,
  sanitizeGeneratedBody,
  stripCodeFence,
  hasExecutableContent,
  stripRedactedStatements,
  synthesizeImports
} from "../../src/local/generate/generator.js";
import { buildGroundedUserPrompt, buildSystemPrompt, type GenerationContext } from "../../src/local/generate/prompt.js";
import { parsePlannedScenarios } from "../../src/local/generate/promptV5.js";
import { buildJudgeContext } from "../../src/local/generate/compareJudge.js";
import { DeterministicProvider } from "../../src/local/generate/providers.js";
import { runnableRunHintsFor } from "../../src/local/generate/runHints.js";
import type { ModelProvider, ModelCompletionRequest } from "../../src/local/types.js";
import { makeNode, makeEdge, makeCandidateEdge } from "../../src/local/graph/factories.js";
import {
  LOCAL_GRAPH_SCHEMA_VERSION,
  LocalGraph,
  GraphNode,
  GraphEdge,
  CandidateEdge
} from "../../src/local/graph/ontology.js";

const CLOCK = () => "2026-06-07T00:00:00Z";

function provenance(sourceRef: string) {
  return { source_scope_id: "scope-1", source_ref: sourceRef, detector: "test-fixture" };
}

interface GraphParts {
  nodes?: GraphNode[];
  edges?: GraphEdge[];
  candidate_edges?: CandidateEdge[];
  workspaceRoot?: string;
}

function makeGraph(parts: GraphParts): LocalGraph {
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: {
      name: "fixture",
      root: parts.workspaceRoot ?? "/tmp/fixture",
      root_hash: "roothash",
      source_upload_policy: "metadata_only"
    },
    created_at: "2026-06-07T00:00:00Z",
    updated_at: "2026-06-07T00:00:00Z",
    sources: [],
    nodes: parts.nodes ?? [],
    edges: parts.edges ?? [],
    candidate_edges: parts.candidate_edges ?? [],
    generation_runs: [],
    generated_tests: [],
    manifest: {
      generated_at: "2026-06-07T00:00:00Z",
      git: null,
      files: {}
    }
  };
}

// A well-grounded Requirement: AcceptanceCriterion + HAS_ACCEPTANCE_CRITERION
// + a related File node reachable via IMPLEMENTED_IN.
function wellGroundedGraph(): LocalGraph {
  const requirement = makeNode({
    kind: "Requirement",
    external_id: "REQ-001",
    title: "Card payment is captured on confirm",
    properties: { priority: "high", area: "payments" },
    evidence_strength: "hard",
    review_status: "local_reviewed",
    confidence: 1,
    provenance: provenance("payments-template.csv#row=2")
  });
  const ac = makeNode({
    kind: "AcceptanceCriterion",
    external_id: "AC-001",
    title: "A successful capture returns a transaction id",
    properties: { text: "A successful capture returns a transaction id" },
    evidence_strength: "hard",
    review_status: "local_reviewed",
    confidence: 1,
    provenance: provenance("payments-template.csv#row=2")
  });
  const file = makeNode({
    kind: "File",
    external_id: "src/payments/card.ts",
    title: "card.ts",
    properties: { role: "code", file: "src/payments/card.ts" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: provenance("src/payments/card.ts")
  });

  const hasAc = makeEdge({
    from_external_id: "REQ-001",
    to_external_id: "AC-001",
    relationship_type: "HAS_ACCEPTANCE_CRITERION",
    evidence_strength: "hard",
    review_status: "local_reviewed",
    provenance: provenance("payments-template.csv#row=2")
  });
  const implementedIn = makeEdge({
    from_external_id: "REQ-001",
    to_external_id: "src/payments/card.ts",
    relationship_type: "IMPLEMENTED_IN",
    evidence_strength: "hard",
    review_status: "auto_detected",
    provenance: provenance("src/payments/card.ts")
  });

  return makeGraph({
    nodes: [requirement, ac, file],
    edges: [hasAc, implementedIn]
  });
}

describe("generateTests — well-grounded behavior", () => {
  it("generates v5 batched tests with prompt lineage and no paywall fields", async () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/orders.py#create_order",
      title: "create_order",
      properties: { file: "src/orders.py", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/orders.py"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/orders.py",
      title: "orders.py",
      properties: { role: "code", language: "python", file: "src/orders.py" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/orders.py")
    });
    const seen: ModelCompletionRequest[] = [];
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "v5-batch",
      complete: async (req) => {
        seen.push(req);
        if (req.system.includes("test gap identification")) {
          return JSON.stringify([
            {
              id: 2,
              title: "validates contract shape",
              concern: "contract",
              technique: "contract_verification",
              rationale: "contract risk",
              assertion_targets: ["returns an order id"],
              complexity: "basic",
              risk_rank: 2
            },
            {
              id: 1,
              title: "rejects empty input",
              concern: "boundary_limits",
              technique: "boundary_value_analysis",
              rationale: "empty input",
              assertion_targets: ["rejects empty input"],
              complexity: "basic",
              risk_rank: 1
            }
          ]);
        }
        return [
          "// ═══ SCENARIO 1 ═══",
          "def test_create_order_rejects_empty_input():",
          "    assert True",
          "",
          "// ═══ SCENARIO 2 ═══",
          "def test_create_order_contract_shape():",
          "    assert True"
        ].join("\n");
      }
    };
    const result = await generateTests(
      makeGraph({ nodes: [symbol, file] }),
      { target_ids: [symbol.external_id], limit: 2, prompt_version: "v5" },
      provider,
      (rel) => (rel === "src/orders.py" ? "def create_order(payload):\n    return {'id': 'o_1'}\n" : null),
      CLOCK
    );

    expect(result.run?.prompt_version).toBe("orangepro.local.testgen.v5");
    expect(result.generated_tests).toHaveLength(2);
    expect(result.generated_tests.every((t) => t.prompt_version === "orangepro.local.testgen.v5")).toBe(true);
    expect(result.generated_tests.every((t) => t.runnable === true)).toBe(true);
    expect(JSON.stringify(result)).not.toContain("Unlock with OrangePro Platform");
    expect(seen.some((req) => req.system.includes("Never mock, stub, or spy on the behavior-under-test itself"))).toBe(true);
    expect(seen.some((req) => req.user.includes("HOW: Test at exact boundaries"))).toBe(true);
  });

  it("retries v5 scenarios individually when batch generation fails", async () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/orders.py#reserve_inventory",
      title: "reserve_inventory",
      properties: { file: "src/orders.py", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/orders.py"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/orders.py",
      title: "orders.py",
      properties: { role: "code", language: "python", file: "src/orders.py" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/orders.py")
    });
    let batchAttempts = 0;
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "v5-fallback",
      complete: async (req) => {
        if (req.system.includes("test gap identification")) {
          return JSON.stringify([
            {
              id: 1,
              title: "handles zero inventory",
              concern: "boundary_limits",
              technique: "boundary_value_analysis",
              rationale: "",
              assertion_targets: ["zero is rejected"],
              complexity: "basic",
              risk_rank: 1
            },
            {
              id: 2,
              title: "is idempotent",
              concern: "concurrency_ordering",
              technique: "idempotency_check",
              rationale: "",
              assertion_targets: ["second call is stable"],
              complexity: "basic",
              risk_rank: 2
            }
          ]);
        }
        if (req.user.includes("SCENARIO 1") && req.user.includes("SCENARIO 2")) {
          batchAttempts++;
          throw new Error("batch failed");
        }
        const id = req.user.includes("SCENARIO 2") ? 2 : 1;
        return [`// ═══ SCENARIO ${id} ═══`, `def test_retry_${id}():`, `    assert "${id === 2 ? "idempotent" : "zero"}"`].join("\n");
      }
    };
    const result = await generateTests(
      makeGraph({ nodes: [symbol, file] }),
      { target_ids: [symbol.external_id], limit: 2, prompt_version: "v5" },
      provider,
      (rel) => (rel === "src/orders.py" ? "def reserve_inventory(item):\n    return True\n" : null),
      CLOCK
    );

    expect(batchAttempts).toBe(1);
    expect(result.generated_tests).toHaveLength(2);
    expect(result.warnings.some((w) => w.includes("retrying scenarios individually"))).toBe(true);
  });

  it("validates v5 scenario concern values before bucket assignment", () => {
    const scenarios = parsePlannedScenarios(
      JSON.stringify([
        {
          id: 1,
          title: "tries to spoof a security bucket",
          concern: "authorization_safety",
          technique: "permission_matrix",
          rationale: "",
          assertion_targets: ["unauthorized user is rejected"],
          complexity: "basic",
          risk_rank: 1
        },
        {
          id: 2,
          title: "invalid concern is ignored",
          concern: "security_privacy",
          technique: "permission_matrix",
          rationale: "",
          assertion_targets: ["unauthorized user is rejected"],
          complexity: "basic",
          risk_rank: 2
        }
      ])
    );

    expect(scenarios.map((s) => s.id)).toEqual([1]);
  });

  it("drops v5 tests with unknown, duplicate, or missing scenario ids instead of positional remapping", async () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/orders.py#ship_order",
      title: "ship_order",
      properties: { file: "src/orders.py", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/orders.py"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/orders.py",
      title: "orders.py",
      properties: { role: "code", language: "python", file: "src/orders.py" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/orders.py")
    });
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "v5-bad-delimiters",
      complete: async (req) => {
        if (req.system.includes("test gap identification")) {
          return JSON.stringify([
            {
              id: 1,
              title: "ships paid order",
              concern: "state_lifecycle",
              technique: "state_transition",
              rationale: "",
              assertion_targets: ["paid order ships"],
              complexity: "basic",
              risk_rank: 1
            },
            {
              id: 2,
              title: "rejects unpaid order",
              concern: "boundary_limits",
              technique: "boundary_value_analysis",
              rationale: "",
              assertion_targets: ["unpaid order rejected"],
              complexity: "basic",
              risk_rank: 2
            }
          ]);
        }
        return [
          "def test_missing_delimiter():",
          "    assert 'paid order ships'",
          "",
          "// ═══ SCENARIO 99 ═══",
          "def test_unknown_id():",
          "    assert 'paid order ships'",
          "",
          "// ═══ SCENARIO 1 ═══",
          "def test_paid_order_ships():",
          "    assert 'paid order ships'",
          "",
          "// ═══ SCENARIO 1 ═══",
          "def test_duplicate_paid_order_ships():",
          "    assert 'paid order ships'",
          "",
          "// ═══ SCENARIO 2 ═══",
          "def test_unpaid_order_rejected():",
          "    assert 'unpaid order rejected'"
        ].join("\n");
      }
    };
    const result = await generateTests(
      makeGraph({ nodes: [symbol, file] }),
      { target_ids: [symbol.external_id], limit: 3, prompt_version: "v5" },
      provider,
      (rel) => (rel === "src/orders.py" ? "def ship_order(order):\n    return order\n" : null),
      CLOCK
    );

    expect(result.generated_tests.map((t) => t.title)).toEqual([
      "ship_order — ships paid order",
      "ship_order — rejects unpaid order"
    ]);
    expect(result.warnings.join("\n")).toContain("unknown scenario id 99");
    expect(result.warnings.join("\n")).toContain("Dropped duplicate v5 generated test");
  });

  it("drops v5 generated bodies that do not align with the planned assertion target", async () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/orders.py#refund_order",
      title: "refund_order",
      properties: { file: "src/orders.py", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/orders.py"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/orders.py",
      title: "orders.py",
      properties: { role: "code", language: "python", file: "src/orders.py" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/orders.py")
    });
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "v5-misaligned",
      complete: async (req) => {
        if (req.system.includes("test gap identification")) {
          return JSON.stringify([
            {
              id: 1,
              title: "refund keeps ledger balanced",
              concern: "data_integrity",
              technique: "data_flow_analysis",
              rationale: "",
              assertion_targets: ["ledger balance changes"],
              complexity: "basic",
              risk_rank: 1
            }
          ]);
        }
        return ["// ═══ SCENARIO 1 ═══", "def test_unrelated_smoke():", "    assert True"].join("\n");
      }
    };
    const result = await generateTests(
      makeGraph({ nodes: [symbol, file] }),
      { target_ids: [symbol.external_id], limit: 1, prompt_version: "v5" },
      provider,
      (rel) => (rel === "src/orders.py" ? "def refund_order(order):\n    return order\n" : null),
      CLOCK
    );

    expect(result.generated_tests).toEqual([]);
    expect(result.missing_evidence[0]?.reason).toContain("did not align");
  });

  it("drops non-runnable v5 generations instead of counting them", async () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/orders.py#cancel_order",
      title: "cancel_order",
      properties: { file: "src/orders.py", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/orders.py"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/orders.py",
      title: "orders.py",
      properties: { role: "code", language: "python", file: "src/orders.py" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/orders.py")
    });
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "v5-empty",
      complete: async (req) => {
        if (req.system.includes("test gap identification")) {
          return JSON.stringify([
            {
              id: 1,
              title: "rejects missing order",
              concern: "contract",
              technique: "contract_verification",
              rationale: "",
              assertion_targets: ["throws"],
              complexity: "basic",
              risk_rank: 1
            }
          ]);
        }
        return "// ═══ SCENARIO 1 ═══\n# no executable assertion";
      }
    };
    const result = await generateTests(
      makeGraph({ nodes: [symbol, file] }),
      { target_ids: [symbol.external_id], limit: 1, prompt_version: "v5" },
      provider,
      (rel) => (rel === "src/orders.py" ? "def cancel_order(order_id):\n    return True\n" : null),
      CLOCK
    );

    expect(result.generated_tests).toEqual([]);
    expect(result.run).toBeNull();
    expect(result.missing_evidence[0]?.reason).toContain("no executable code");
  });

  it("produces at least one grounded test and a deterministic GenerationRun", async () => {
    const graph = wellGroundedGraph();
    const result = await generateTests(
      graph,
      { target_ids: ["REQ-001"] },
      new DeterministicProvider(),
      () => null,
      CLOCK
    );

    expect(result.generated_tests.length).toBeGreaterThanOrEqual(1);
    expect(result.missing_evidence).toHaveLength(0);

    const test = result.generated_tests[0];
    // Grounding must include the requirement as an anchoring entity.
    expect(test.grounding.entity_ids).toContain("REQ-001");
    // The related file resolved via IMPLEMENTED_IN should also be grounding.
    expect(test.grounding.entity_ids).toContain("src/payments/card.ts");
    // Body should reference the behavior under test (deterministic scaffold).
    expect(test.body).toContain("Card payment is captured on confirm");
    // No weak evidence was used in a fully-grounded case.
    expect(test.weak_evidence_used).toBe(false);

    // The run records the prompt strategy + deterministic provider.
    expect(result.run).not.toBeNull();
    expect(result.run?.model_provider).toBe("deterministic");
    expect(result.run?.prompt_version).toBe("orangepro.local.testgen.v2");
    expect(result.run?.model_name).toBe("orangepro-local-deterministic-v0");
    expect(result.run?.generated_test_ids).toContain(test.id);
  });

  it("chooses Go format for a behavior grounded in Go code, even without a JS framework", async () => {
    const behavior = makeNode({
      kind: "UserFlow",
      external_id: "flow:go-active-help",
      title: "Active help output is rendered",
      properties: { area: "cli", example_behaviors: ["active help renders"] },
      evidence_strength: "candidate",
      review_status: "auto_detected",
      confidence: 0.6,
      provenance: provenance("active_help_test.go")
    });
    const file = makeNode({
      kind: "File",
      external_id: "active_help.go",
      title: "active_help.go",
      properties: { role: "code", language: "go", file: "active_help.go" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("active_help.go")
    });
    const graph = makeGraph({
      nodes: [behavior, file],
      edges: [
        makeEdge({
          from_external_id: behavior.external_id,
          to_external_id: file.external_id,
          relationship_type: "IMPLEMENTED_IN",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: provenance("active_help.go")
        })
      ]
    });
    const result = await generateTests(
      graph,
      { target_ids: [behavior.external_id], limit: 1 },
      new DeterministicProvider(),
      (rel) => (rel === "active_help.go" ? "package cobra\n" : null),
      CLOCK
    );
    const test = result.generated_tests[0];
    expect(test.framework_hint).toBe("go");
    expect(test.body).toContain("package cobra");
    expect(test.body).toContain('import "testing"');
    expect(test.body).toContain("func TestActiveHelpOutputIsRendered");
    expect(test.runnable).toBe(true);
  });

  it("adds missing Go testing import before marking a model body runnable", async () => {
    const behavior = makeNode({
      kind: "UserFlow",
      external_id: "flow:go-active-help",
      title: "Active help output is rendered",
      properties: { area: "cli", example_behaviors: ["active help renders"] },
      evidence_strength: "candidate",
      review_status: "auto_detected",
      confidence: 0.6,
      provenance: provenance("active_help_test.go")
    });
    const file = makeNode({
      kind: "File",
      external_id: "active_help.go",
      title: "active_help.go",
      properties: { role: "code", language: "go", file: "active_help.go" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("active_help.go")
    });
    const graph = makeGraph({
      nodes: [behavior, file],
      edges: [
        makeEdge({
          from_external_id: behavior.external_id,
          to_external_id: file.external_id,
          relationship_type: "IMPLEMENTED_IN",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: provenance("active_help.go")
        })
      ]
    });
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "missing-go-import",
      complete: async () => [
        "package main",
        "",
        "func TestActiveHelpOutputIsRendered(t *testing.T) {",
        "  if false {",
        "    t.Errorf(\"expected active help output\")",
        "  }",
        "}"
      ].join("\n")
    };
    const result = await generateTests(
      graph,
      { target_ids: [behavior.external_id], limit: 1 },
      provider,
      (rel) => (rel === "active_help.go" ? "package cobra\n" : null),
      CLOCK
    );
    const test = result.generated_tests[0];
    expect(test.body).toContain("package cobra");
    expect(test.body).toContain('import "testing"');
    expect(test.runnable).toBe(true);
  });

  it("rewrites model-supplied wrong Go package names to the target package", async () => {
    const behavior = makeNode({
      kind: "UserFlow",
      external_id: "flow:mux-middleware",
      title: "Middleware wraps a handler",
      properties: { area: "router", example_behaviors: ["middleware wraps handler"] },
      evidence_strength: "candidate",
      review_status: "auto_detected",
      confidence: 0.6,
      provenance: provenance("middleware_test.go")
    });
    const file = makeNode({
      kind: "File",
      external_id: "middleware.go",
      title: "middleware.go",
      properties: { role: "code", language: "go", file: "middleware.go" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("middleware.go")
    });
    const graph = makeGraph({
      nodes: [behavior, file],
      edges: [
        makeEdge({
          from_external_id: behavior.external_id,
          to_external_id: file.external_id,
          relationship_type: "IMPLEMENTED_IN",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: provenance("middleware.go")
        })
      ]
    });
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "wrong-go-package",
      complete: async () => [
        "package middleware",
        "",
        "import \"testing\"",
        "",
        "func TestMiddlewareWrapsHandler(t *testing.T) {",
        "  if false {",
        "    t.Errorf(\"expected middleware to wrap handler\")",
        "  }",
        "}"
      ].join("\n")
    };
    const result = await generateTests(
      graph,
      { target_ids: [behavior.external_id], limit: 1 },
      provider,
      (rel) => (rel === "middleware.go" ? "package mux\n" : null),
      CLOCK
    );
    const test = result.generated_tests[0];
    expect(test.body).toContain("package mux");
    expect(test.body).not.toContain("package middleware");
    expect(test.runnable).toBe(true);
  });

  it("marks Go tests that do not compile in the target package as drafts", async () => {
    const root = mkdtempSync(join(tmpdir(), "opro-go-compile-"));
    const originalPath = process.env.PATH;
    try {
      const fakeBin = join(root, "bin");
      mkdirSync(fakeBin);
      const fakeGo = join(fakeBin, "go");
      writeFileSync(
        fakeGo,
        [
          "#!/usr/bin/env sh",
          "echo './orangepro_compile_test.go:7:7: undefined: HandlerFunc' >&2",
          "exit 1"
        ].join("\n")
      );
      chmodSync(fakeGo, 0o755);
      process.env.PATH = `${fakeBin}${delimiter}${originalPath ?? ""}`;

      writeFileSync(join(root, "go.mod"), "module example.com/mux\n\ngo 1.23\n");
      writeFileSync(join(root, "middleware.go"), "package mux\n\ntype MiddlewareFunc func(int) int\n");
      const behavior = makeNode({
        kind: "UserFlow",
        external_id: "flow:mux-middleware",
        title: "Middleware wraps a handler",
        properties: { area: "router", example_behaviors: ["middleware wraps handler"] },
        evidence_strength: "candidate",
        review_status: "auto_detected",
        confidence: 0.6,
        provenance: provenance("middleware_test.go")
      });
      const file = makeNode({
        kind: "File",
        external_id: "middleware.go",
        title: "middleware.go",
        properties: { role: "code", language: "go", file: "middleware.go" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("middleware.go")
      });
      const graph = makeGraph({
        workspaceRoot: root,
        nodes: [behavior, file],
        edges: [
          makeEdge({
            from_external_id: behavior.external_id,
            to_external_id: file.external_id,
            relationship_type: "IMPLEMENTED_IN",
            evidence_strength: "hard",
            review_status: "auto_detected",
            provenance: provenance("middleware.go")
          })
        ]
      });
      const provider: ModelProvider = {
        providerName: "fake",
        modelName: "go-undefined-identifiers",
        complete: async () => [
          "package middleware",
          "",
          "import \"testing\"",
          "",
          "func TestMiddlewareWrapsHandler(t *testing.T) {",
          "  _ = HandlerFunc(func(ctx Context) error { return nil })",
          "  if false {",
          "    t.Errorf(\"expected middleware to wrap handler\")",
          "  }",
          "}"
        ].join("\n")
      };
      const result = await generateTests(
        graph,
        { target_ids: [behavior.external_id], limit: 1 },
        provider,
        (rel) => (rel === "middleware.go" ? readFileSync(join(root, rel), "utf8") : null),
        CLOCK
      );
      const test = result.generated_tests[0];
      expect(test.body).toContain("package mux");
      expect(test.runnable).toBe(false);
      expect(test.unresolved_reason).toContain("Go compile check failed");
      expect(test.unresolved_reason).toContain("undefined");
      expect(readFileSync(join(root, "middleware.go"), "utf8")).toContain("type MiddlewareFunc");
    } finally {
      process.env.PATH = originalPath;
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("keeps Go tests with unproven third-party imports as drafts", async () => {
    const behavior = makeNode({
      kind: "UserFlow",
      external_id: "flow:go-active-help",
      title: "Active help output is rendered",
      properties: { area: "cli", example_behaviors: ["active help renders"] },
      evidence_strength: "candidate",
      review_status: "auto_detected",
      confidence: 0.6,
      provenance: provenance("active_help_test.go")
    });
    const file = makeNode({
      kind: "File",
      external_id: "active_help.go",
      title: "active_help.go",
      properties: { role: "code", language: "go", file: "active_help.go" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("active_help.go")
    });
    const graph = makeGraph({
      nodes: [behavior, file],
      edges: [
        makeEdge({
          from_external_id: behavior.external_id,
          to_external_id: file.external_id,
          relationship_type: "IMPLEMENTED_IN",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: provenance("active_help.go")
        })
      ]
    });
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "external-go-import",
      complete: async () => [
        "package main",
        "",
        "import (",
        '  "testing"',
        '  "github.com/go-chi/chi"',
        ")",
        "",
        "func TestActiveHelpOutputIsRendered(t *testing.T) {",
        "  if false { t.Errorf(\"expected active help output\") }",
        "}"
      ].join("\n")
    };
    const result = await generateTests(
      graph,
      { target_ids: [behavior.external_id], limit: 1 },
      provider,
      (rel) => (rel === "active_help.go" ? "package cobra\n" : null),
      CLOCK
    );
    const test = result.generated_tests[0];
    expect(test.runnable).toBe(false);
    expect(test.unresolved_reason).toContain("imports module-path package");
    expect(test.unresolved_reason).toContain("same-package or stdlib-only");
    expect(runnableRunHintsFor(result.generated_tests)).toEqual([]);
  });

  it("chooses pytest for a behavior grounded in Python code before falling back to a repo-level JS framework", async () => {
    const behavior = makeNode({
      kind: "UserFlow",
      external_id: "flow:py-generator",
      title: "Python generator writes pytest data paths",
      properties: { area: "dev", example_behaviors: ["generates pytest data paths"] },
      evidence_strength: "candidate",
      review_status: "auto_detected",
      confidence: 0.6,
      provenance: provenance("dev/code-generation/gen_py_pytest_data_paths.py")
    });
    const file = makeNode({
      kind: "File",
      external_id: "dev/code-generation/gen_py_pytest_data_paths.py",
      title: "gen_py_pytest_data_paths.py",
      properties: { role: "code", language: "python", file: "dev/code-generation/gen_py_pytest_data_paths.py" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("dev/code-generation/gen_py_pytest_data_paths.py")
    });
    const vitest = makeNode({
      kind: "Framework",
      external_id: "framework:vitest",
      title: "vitest",
      properties: { category: "test", test_layer: "unit" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("package.json")
    });
    const graph = makeGraph({
      nodes: [behavior, file, vitest],
      edges: [
        makeEdge({
          from_external_id: behavior.external_id,
          to_external_id: file.external_id,
          relationship_type: "IMPLEMENTED_IN",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: provenance("dev/code-generation/gen_py_pytest_data_paths.py")
        })
      ]
    });
    const result = await generateTests(graph, { target_ids: [behavior.external_id], limit: 1 }, new DeterministicProvider(), () => null, CLOCK);
    const test = result.generated_tests[0];
    expect(test.framework_hint).toBe("pytest");
    expect(test.body).toContain("def test_python_generator_writes_pytest_data_paths");
    expect(test.body).toContain("assert True");
    expect(test.runnable).toBe(true);
  });

  it("rewrites Python src-layout imports before marking pytest output runnable", async () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/click/_compat.py#strip_ansi",
      title: "strip_ansi",
      properties: { file: "src/click/_compat.py", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/click/_compat.py"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/click/_compat.py",
      title: "_compat.py",
      properties: { role: "code", language: "python", file: "src/click/_compat.py" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/click/_compat.py")
    });
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "python-src-layout-import",
      complete: async () => [
        "import pytest",
        "from src.click._compat import strip_ansi",
        "",
        "def test_strip_ansi_removes_ansi_sequences():",
        "    assert strip_ansi('\\u001b[31mHello\\u001b[0m') == 'Hello'"
      ].join("\n")
    };
    const result = await generateTests(
      makeGraph({ nodes: [symbol, file] }),
      { target_ids: [symbol.external_id], limit: 1 },
      provider,
      (rel) => (rel === "src/click/_compat.py" ? "def strip_ansi(value):\n    return value\n" : null),
      CLOCK
    );
    const test = result.generated_tests[0];
    expect(test.body).toContain("from click._compat import strip_ansi");
    expect(test.body).not.toContain("from src.click._compat import strip_ansi");
    expect(test.framework_hint).toBe("pytest");
    expect(test.runnable).toBe(true);
    expect(runnableRunHintsFor(result.generated_tests)).toHaveLength(1);
  });

  it("marks invalid Python model output as a non-runnable draft with no run hint", async () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/service.py#process_payment",
      title: "process_payment",
      properties: { file: "src/service.py", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/service.py"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/service.py",
      title: "service.py",
      properties: { role: "code", language: "python", file: "src/service.py" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/service.py")
    });
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "bad-python",
      complete: async () => "def test_process_payment():\nassert True"
    };
    const result = await generateTests(
      makeGraph({ nodes: [symbol, file] }),
      { limit: 1 },
      provider,
      (rel) => (rel === "src/service.py" ? "def process_payment():\n    return True\n" : null),
      CLOCK
    );
    const test = result.generated_tests[0];
    expect(test.framework_hint).toBe("pytest");
    expect(test.runnable).toBe(false);
    expect(test.unresolved_reason).toMatch(/Python syntax check failed|python3 not found/);
    expect(runnableRunHintsFor(result.generated_tests)).toEqual([]);
  });

  it("marks Python bodies without a pytest-collected test entrypoint as non-runnable", async () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/service.py#process_payment",
      title: "process_payment",
      properties: { file: "src/service.py", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/service.py"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/service.py",
      title: "service.py",
      properties: { role: "code", language: "python", file: "src/service.py" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/service.py")
    });
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "top-level-python-assert",
      complete: async () => "assert True"
    };
    const result = await generateTests(
      makeGraph({ nodes: [symbol, file] }),
      { limit: 1 },
      provider,
      (rel) => (rel === "src/service.py" ? "def process_payment():\n    return True\n" : null),
      CLOCK
    );
    const test = result.generated_tests[0];
    expect(test.framework_hint).toBe("pytest");
    expect(test.runnable).toBe(false);
    expect(test.unresolved_reason).toMatch(/pytest test entrypoint not found|python3 not found/);
    expect(runnableRunHintsFor(result.generated_tests)).toEqual([]);
  });

  it("falls back to eligible Java CodeSymbols and emits JUnit format when no behavior anchors exist", async () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/main/java/org/example/OwnerController.java#OwnerController",
      title: "OwnerController",
      properties: {
        file: "src/main/java/org/example/OwnerController.java",
        symbol_kind: "class"
      },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/main/java/org/example/OwnerController.java"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/main/java/org/example/OwnerController.java",
      title: "OwnerController.java",
      properties: { role: "code", language: "java", file: "src/main/java/org/example/OwnerController.java" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/main/java/org/example/OwnerController.java")
    });
    const graph = makeGraph({ nodes: [symbol, file], edges: [] });
    const result = await generateTests(
      graph,
      { limit: 1 },
      new DeterministicProvider(),
      (rel) => (rel === "src/main/java/org/example/OwnerController.java" ? "package org.example;\nclass OwnerController {}\n" : null),
      CLOCK
    );
    const test = result.generated_tests[0];
    expect(result.warnings).toContain("No requirement/user-flow anchors found; targeting eligible code symbols instead.");
    expect(test.framework_hint).toBe("junit");
    expect(test.body).toContain("package org.example;");
    expect(test.body).toContain("import org.junit.jupiter.api.Test;");
    expect(test.body).toContain("class OwnerControllerTest");
    expect(test.body).toContain("assertTrue(true");
    expect(test.runnable).toBe(true);
  });

  it("uses JUnit 4 imports when the Maven manifest advertises JUnit 4", async () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/main/java/org/example/OwnerController.java#OwnerController",
      title: "OwnerController",
      properties: {
        file: "src/main/java/org/example/OwnerController.java",
        symbol_kind: "class"
      },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/main/java/org/example/OwnerController.java"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const framework = makeNode({
      kind: "Framework",
      external_id: "framework:junit4",
      title: "junit4",
      properties: { category: "test", test_layer: "unit" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("pom.xml")
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/main/java/org/example/OwnerController.java",
      title: "OwnerController.java",
      properties: { role: "code", language: "java", file: "src/main/java/org/example/OwnerController.java" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/main/java/org/example/OwnerController.java")
    });
    const result = await generateTests(
      makeGraph({ nodes: [symbol, framework, file], edges: [] }),
      { limit: 1 },
      new DeterministicProvider(),
      (rel) => (rel === "src/main/java/org/example/OwnerController.java" ? "package org.example;\nclass OwnerController {}\n" : null),
      CLOCK
    );
    const test = result.generated_tests[0];
    expect(test.framework_hint).toBe("junit4");
    expect(test.body).toContain("import org.junit.Test;");
    expect(test.body).toContain("import static org.junit.Assert.assertTrue;");
    expect(test.body).not.toContain("org.junit.jupiter");
    expect(test.runnable).toBe(true);
  });

  it("detects AVA from a linked top-level test and keeps root-relative imports runnable", async () => {
    const root = mkdtempSync(join(tmpdir(), "op-ava-gen-"));
    try {
      writeFileSync(join(root, "index.js"), "export function mapValues(v) { return v; }\n");
      writeFileSync(join(root, "test.js"), 'import test from "ava";\nimport { mapValues } from "./index.js";\n');
      writeFileSync(join(root, "package.json"), JSON.stringify({ name: "ava-demo", devDependencies: { ava: "^6.0.0" } }));
      const symbol = makeNode({
        kind: "CodeSymbol",
        external_id: "sym:index.js#mapValues",
        title: "mapValues",
        properties: { file: "index.js", symbol_kind: "function" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("index.js"),
        behavior_source: "code_export",
        denominator_eligible: true,
        denominator_reason: "Testable code behavior."
      });
      const sourceFile = makeNode({
        kind: "File",
        external_id: "index.js",
        title: "index.js",
        properties: { role: "code", language: "javascript", file: "index.js" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("index.js")
      });
      const testFile = makeNode({
        kind: "File",
        external_id: "test.js",
        title: "test.js",
        properties: { role: "test", language: "javascript", file: "test.js" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("test.js")
      });
      const testCase = makeNode({
        kind: "TestCase",
        external_id: "test:test.js",
        title: "test.js",
        properties: { file: "test.js", test_layer: "unit" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("test.js")
      });
      const provider: ModelProvider = {
        providerName: "fake",
        modelName: "ava-body",
        complete: async () => 'test("maps values", (t) => { t.true(true); });'
      };
      const graph = makeGraph({
        workspaceRoot: root,
        nodes: [symbol, sourceFile, testFile, testCase],
        candidate_edges: [
          makeCandidateEdge({
            from_external_id: "test.js",
            to_external_id: "index.js",
            relationship_type: "MAY_RELATE_TO",
            evidence_strength: "weak",
            reason: "package self test",
            confidence: 0.7,
            provenance: provenance("test.js")
          })
        ]
      });
      const result = await generateTests(
        graph,
        { limit: 1 },
        provider,
        (rel) => (rel === "test.js" ? readFileSync(join(root, "test.js"), "utf8") : rel === "index.js" ? readFileSync(join(root, "index.js"), "utf8") : null),
        CLOCK
      );
      const test = result.generated_tests[0];
      expect(test.framework_hint).toBe("ava");
      expect(test.body).toContain('import test from "ava";');
      expect(test.body).toContain('from "./index.js"');
      expect(test.runnable).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("Java/JUnit generation preserves a related legal header so Maven policy checks can pass", async () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/main/java/org/example/OwnerController.java#OwnerController",
      title: "OwnerController",
      properties: {
        file: "src/main/java/org/example/OwnerController.java",
        symbol_kind: "class"
      },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/main/java/org/example/OwnerController.java"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/main/java/org/example/OwnerController.java",
      title: "OwnerController.java",
      properties: { role: "code", language: "java", file: "src/main/java/org/example/OwnerController.java" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/main/java/org/example/OwnerController.java")
    });
    const graph = makeGraph({ nodes: [symbol, file], edges: [] });
    const header = [
      "/*",
      " * Licensed under the Apache License, Version 2.0.",
      " */"
    ].join("\n");
    const result = await generateTests(
      graph,
      { limit: 1 },
      new DeterministicProvider(),
      (rel) => (rel === "src/main/java/org/example/OwnerController.java" ? `${header}\npackage org.example;\nclass OwnerController {}\n` : null),
      CLOCK
    );
    const test = result.generated_tests[0];
    expect(test.body).toMatch(/^\/\*/);
    expect(test.body).toContain("Licensed under the Apache License");
    expect(test.body.indexOf("Licensed under the Apache License")).toBeLessThan(test.body.indexOf("package org.example;"));
    expect(test.body).toContain("import org.junit.jupiter.api.Test;");
  });

  it("marks Java/JUnit output with unbalanced braces as a non-runnable draft", async () => {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/main/java/org/example/OwnerController.java#OwnerController",
      title: "OwnerController",
      properties: {
        file: "src/main/java/org/example/OwnerController.java",
        symbol_kind: "class"
      },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/main/java/org/example/OwnerController.java"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/main/java/org/example/OwnerController.java",
      title: "OwnerController.java",
      properties: { role: "code", language: "java", file: "src/main/java/org/example/OwnerController.java" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/main/java/org/example/OwnerController.java")
    });
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "bad-java-braces",
      complete: async () =>
        [
          "import org.junit.jupiter.api.Test;",
          "import static org.junit.jupiter.api.Assertions.assertTrue;",
          "",
          "class OwnerControllerTest {",
          "  @Test void ownerController() {",
          "    assertTrue(true);",
          "  }"
        ].join("\n")
    };
    const result = await generateTests(
      makeGraph({ nodes: [symbol, file], edges: [] }),
      { limit: 1 },
      provider,
      (rel) => (rel === "src/main/java/org/example/OwnerController.java" ? "package org.example;\nclass OwnerController {}\n" : null),
      CLOCK
    );
    const test = result.generated_tests[0];
    expect(test.framework_hint).toBe("junit");
    expect(test.runnable).toBe(false);
    expect(test.unresolved_reason).toContain("Java test has unbalanced braces");
    expect(test.unresolved_reason).toContain("Fix:");
    expect(runnableRunHintsFor(result.generated_tests)).toEqual([]);
  });

  it("skips off-language supported targets instead of rendering them with the run framework", async () => {
    const tsFile = makeNode({
      kind: "File",
      external_id: "src/api.ts",
      title: "api.ts",
      properties: { role: "code", language: "typescript", file: "src/api.ts" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/api.ts")
    });
    const goFile = makeNode({
      kind: "File",
      external_id: "pkg/handler.go",
      title: "handler.go",
      properties: { role: "code", language: "go", file: "pkg/handler.go" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("pkg/handler.go")
    });
    const tsSymbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/api.ts#saveUser",
      title: "saveUser",
      properties: { file: "src/api.ts", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/api.ts"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const goSymbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:pkg/handler.go#Handle",
      title: "Handle",
      properties: { file: "pkg/handler.go", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("pkg/handler.go"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const graph = makeGraph({ nodes: [tsFile, goFile, tsSymbol, goSymbol] });
    const result = await generateTests(
      graph,
      { target_ids: [tsSymbol.external_id, goSymbol.external_id], limit: 2 },
      new DeterministicProvider(),
      (rel) => (rel.endsWith(".go") ? "package handler\nfunc Handle() {}\n" : rel.endsWith(".ts") ? "export function saveUser() {}\n" : null),
      CLOCK
    );

    expect(result.generated_tests).toHaveLength(1);
    expect(result.generated_tests[0].title).toContain("Handle");
    expect(result.generated_tests[0].framework_hint).toBe("go");
    expect(result.generated_tests[0].body).toMatch(/^package handler/);
    expect(result.generated_tests[0].body).not.toContain("saveUser");
    expect(result.warnings.join("\n")).toContain("supported target(s) in other languages skipped for go generation");
  });

  it("marks TS/JS tests with undeclared bare package imports as non-runnable", async () => {
    const root = mkdtempSync(join(tmpdir(), "opbare-dep-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: {} }));
      writeFileSync(join(root, "src", "api.ts"), "export function saveUser() { return true; }\n");

      const file = makeNode({
        kind: "File",
        external_id: "src/api.ts",
        title: "api.ts",
        properties: { role: "code", language: "typescript", file: "src/api.ts" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("src/api.ts")
      });
      const symbol = makeNode({
        kind: "CodeSymbol",
        external_id: "sym:src/api.ts#saveUser",
        title: "saveUser",
        properties: { file: "src/api.ts", symbol_kind: "function" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("src/api.ts"),
        behavior_source: "code_export",
        denominator_eligible: true,
        denominator_reason: "Testable code behavior."
      });
      const graph = makeGraph({ nodes: [file, symbol] });
      graph.workspace.root = root;
      const provider: ModelProvider = {
        providerName: "fake",
        modelName: "playwright-missing-dep",
        complete: async () =>
          [
            'import { test, expect } from "@playwright/test";',
            'import { saveUser } from "../src/api";',
            "",
            'test("saveUser", () => {',
            "  expect(saveUser).toBeDefined();",
            "});"
          ].join("\n")
      };

      const result = await generateTests(
        graph,
        { target_ids: [symbol.external_id], framework: "playwright", limit: 1 },
        provider,
        (rel) => (rel === "src/api.ts" ? "export function saveUser() { return true; }\n" : null),
        CLOCK
      );

      expect(result.generated_tests).toHaveLength(1);
      expect(result.generated_tests[0].runnable).toBe(false);
      expect(result.generated_tests[0].unresolved_reason).toContain("@playwright/test");
      expect(result.generated_tests[0].unresolved_reason).toContain("repo's existing test framework");
      expect(result.generated_tests[0].unresolved_reason).toContain("package.json");
      expect(runnableRunHintsFor(result.generated_tests)).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("allows TS/JS bare package imports declared by the target repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "opdeclared-dep-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { "@playwright/test": "1.0.0" } }));
      writeFileSync(join(root, "src", "api.ts"), "export function saveUser() { return true; }\n");

      const file = makeNode({
        kind: "File",
        external_id: "src/api.ts",
        title: "api.ts",
        properties: { role: "code", language: "typescript", file: "src/api.ts" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("src/api.ts")
      });
      const symbol = makeNode({
        kind: "CodeSymbol",
        external_id: "sym:src/api.ts#saveUser",
        title: "saveUser",
        properties: { file: "src/api.ts", symbol_kind: "function" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("src/api.ts"),
        behavior_source: "code_export",
        denominator_eligible: true,
        denominator_reason: "Testable code behavior."
      });
      const graph = makeGraph({ nodes: [file, symbol] });
      graph.workspace.root = root;
      const provider: ModelProvider = {
        providerName: "fake",
        modelName: "playwright-declared-dep",
        complete: async () =>
          [
            'import { test, expect } from "@playwright/test";',
            'import { saveUser } from "../src/api";',
            "",
            'test("saveUser", () => {',
            "  expect(saveUser).toBeDefined();",
            "});"
          ].join("\n")
      };

      const result = await generateTests(
        graph,
        { target_ids: [symbol.external_id], framework: "playwright", limit: 1 },
        provider,
        (rel) => (rel === "src/api.ts" ? "export function saveUser() { return true; }\n" : null),
        CLOCK
      );

      expect(result.generated_tests).toHaveLength(1);
      expect(result.generated_tests[0].runnable).toBe(true);
      expect(runnableRunHintsFor(result.generated_tests)).toHaveLength(1);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("uses the framework from linked TS/JS tests before generic repo framework nodes", async () => {
    const root = mkdtempSync(join(tmpdir(), "oprelated-framework-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ devDependencies: { "@playwright/test": "1.0.0", vitest: "1.0.0" } })
      );
      writeFileSync(join(root, "src", "api.ts"), "export function saveUser() { return true; }\n");
      writeFileSync(
        join(root, "tests", "api.test.ts"),
        'import { describe, it, expect } from "vitest";\nimport { saveUser } from "../src/api";\n'
      );

      const file = makeNode({
        kind: "File",
        external_id: "src/api.ts",
        title: "api.ts",
        properties: { role: "code", language: "typescript", file: "src/api.ts" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("src/api.ts")
      });
      const symbol = makeNode({
        kind: "CodeSymbol",
        external_id: "sym:src/api.ts#saveUser",
        title: "saveUser",
        properties: { file: "src/api.ts", symbol_kind: "function" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("src/api.ts"),
        behavior_source: "code_export",
        denominator_eligible: true,
        denominator_reason: "Testable code behavior."
      });
      const testCase = makeNode({
        kind: "TestCase",
        external_id: "test:tests/api.test.ts",
        title: "api.test.ts",
        properties: { file: "tests/api.test.ts", test_layer: "unit", test_names: ["saveUser"] },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("tests/api.test.ts")
      });
      const playwright = makeNode({
        kind: "Framework",
        external_id: "framework:playwright",
        title: "playwright",
        properties: { category: "test", test_layer: "e2e" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("package.json")
      });
      const vitest = makeNode({
        kind: "Framework",
        external_id: "framework:vitest",
        title: "vitest",
        properties: { category: "test", test_layer: "unit" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("package.json")
      });
      const graph = makeGraph({
        nodes: [file, symbol, testCase, playwright, vitest],
        candidate_edges: [
          makeCandidateEdge({
            from_external_id: symbol.external_id,
            to_external_id: testCase.external_id,
            relationship_type: "MAY_BE_TESTED_BY",
            evidence_strength: "candidate",
            reason: "linked existing test",
            confidence: 0.8
          })
        ]
      });
      graph.workspace.root = root;

      const result = await generateTests(
        graph,
        { target_ids: [symbol.external_id], limit: 1 },
        new DeterministicProvider(),
        (rel) => {
          if (rel === "src/api.ts") return "export function saveUser() { return true; }\n";
          if (rel === "tests/api.test.ts") {
            return 'import { describe, it, expect } from "vitest";\nimport { saveUser } from "../src/api";\n';
          }
          return null;
        },
        CLOCK
      );

      expect(result.generated_tests).toHaveLength(1);
      expect(result.generated_tests[0].framework_hint).toBe("vitest");
      expect(result.generated_tests[0].body).toContain("vitest");
      expect(result.generated_tests[0].body).not.toContain("@playwright/test");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("prioritizes concrete code symbols with linked tests over weak test-name-only flows", async () => {
    const root = mkdtempSync(join(tmpdir(), "opconcrete-ts-target-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "1.0.0" } }));
      writeFileSync(join(root, "src", "api.ts"), "export function saveUser() { return true; }\n");
      writeFileSync(
        join(root, "tests", "api.test.ts"),
        'import { describe, it, expect } from "vitest";\nimport { saveUser } from "../src/api";\n'
      );

      const weakFlow = makeNode({
        kind: "UserFlow",
        external_id: "flow:api",
        title: "Api behavior from test names",
        properties: { area: "src", inferred_from: "test_describe", priority: "high", example_behaviors: ["saveUser handles success"] },
        evidence_strength: "weak",
        review_status: "inferred",
        confidence: 0.35,
        provenance: provenance("tests/api.test.ts"),
        behavior_source: "test_inferred",
        denominator_eligible: false,
        denominator_reason: "Inferred from test names."
      });
      const file = makeNode({
        kind: "File",
        external_id: "src/api.ts",
        title: "api.ts",
        properties: { role: "code", language: "typescript", file: "src/api.ts" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("src/api.ts")
      });
      const symbol = makeNode({
        kind: "CodeSymbol",
        external_id: "sym:src/api.ts#saveUser",
        title: "saveUser",
        properties: { file: "src/api.ts", symbol_kind: "function" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("src/api.ts"),
        behavior_source: "code_export",
        denominator_eligible: true,
        denominator_reason: "Testable code behavior."
      });
      const testCase = makeNode({
        kind: "TestCase",
        external_id: "test:tests/api.test.ts",
        title: "api.test.ts",
        properties: { file: "tests/api.test.ts", test_layer: "unit", test_names: ["saveUser handles success"] },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("tests/api.test.ts")
      });
      const vitest = makeNode({
        kind: "Framework",
        external_id: "framework:vitest",
        title: "vitest",
        properties: { category: "test", test_layer: "unit" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("package.json")
      });
      const graph = makeGraph({
        nodes: [weakFlow, file, symbol, testCase, vitest],
        candidate_edges: [
          makeCandidateEdge({
            from_external_id: "tests/api.test.ts",
            to_external_id: "src/api.ts",
            relationship_type: "MAY_RELATE_TO",
            evidence_strength: "candidate",
            reason: "test imports source",
            confidence: 0.8
          })
        ]
      });
      graph.workspace.root = root;

      const result = await generateTests(
        graph,
        { limit: 1 },
        new DeterministicProvider(),
        (rel) => {
          if (rel === "src/api.ts") return "export function saveUser() { return true; }\n";
          if (rel === "tests/api.test.ts") {
            return 'import { describe, it, expect } from "vitest";\nimport { saveUser } from "../src/api";\n';
          }
          return null;
        },
        CLOCK
      );

      expect(result.generated_tests).toHaveLength(1);
      expect(result.warnings.join("\n")).toContain("Generation prioritized 1 concrete code symbol target");
      expect(result.generated_tests[0].title).toContain("saveUser");
      expect(result.generated_tests[0].title).not.toContain("Api behavior from test names");
      expect(result.generated_tests[0].framework_hint).toBe("vitest");
      expect(result.generated_tests[0].target_symbol_external_id).toBe("sym:src/api.ts#saveUser");
      expect(result.generated_tests[0].grounding.entity_ids).toContain("sym:src/api.ts#saveUser");
      expect(result.generated_tests[0].grounding.source_refs).toContain("tests/api.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("repairs missing TS/JS framework imports used by the model body", async () => {
    const root = mkdtempSync(join(tmpdir(), "opframework-import-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      mkdirSync(join(root, "tests"), { recursive: true });
      writeFileSync(join(root, "package.json"), JSON.stringify({ devDependencies: { vitest: "1.0.0" } }));
      writeFileSync(join(root, "src", "api.ts"), "export function saveUser() { return true; }\n");
      writeFileSync(
        join(root, "tests", "api.test.ts"),
        'import { describe, it, expect } from "vitest";\nimport { saveUser } from "../src/api";\n'
      );

      const file = makeNode({
        kind: "File",
        external_id: "src/api.ts",
        title: "api.ts",
        properties: { role: "code", language: "typescript", file: "src/api.ts" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("src/api.ts")
      });
      const symbol = makeNode({
        kind: "CodeSymbol",
        external_id: "sym:src/api.ts#saveUser",
        title: "saveUser",
        properties: { file: "src/api.ts", symbol_kind: "function" },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("src/api.ts"),
        behavior_source: "code_export",
        denominator_eligible: true,
        denominator_reason: "Testable code behavior."
      });
      const testCase = makeNode({
        kind: "TestCase",
        external_id: "test:tests/api.test.ts",
        title: "api.test.ts",
        properties: { file: "tests/api.test.ts", test_layer: "unit", test_names: ["saveUser"] },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("tests/api.test.ts")
      });
      const graph = makeGraph({
        nodes: [file, symbol, testCase],
        candidate_edges: [
          makeCandidateEdge({
            from_external_id: "tests/api.test.ts",
            to_external_id: "src/api.ts",
            relationship_type: "MAY_RELATE_TO",
            evidence_strength: "candidate",
            reason: "test imports source",
            confidence: 0.8
          })
        ]
      });
      graph.workspace.root = root;
      const provider: ModelProvider = {
        providerName: "fake",
        modelName: "missing-vi",
        complete: async () =>
          [
            'import { describe, it, expect } from "vitest";',
            'import { saveUser } from "../src/api";',
            "",
            'describe("saveUser", () => {',
            '  it("can be called", () => {',
            "    const wrapped = vi.fn(saveUser);",
            "    wrapped();",
            "    expect(wrapped).toHaveBeenCalled();",
            "  });",
            "});"
          ].join("\n")
      };

      const result = await generateTests(
        graph,
        { target_ids: [symbol.external_id], framework: "vitest", limit: 1 },
        provider,
        (rel) => {
          if (rel === "src/api.ts") return "export function saveUser() { return true; }\n";
          if (rel === "tests/api.test.ts") {
            return 'import { describe, it, expect } from "vitest";\nimport { saveUser } from "../src/api";\n';
          }
          return null;
        },
        CLOCK
      );

      expect(result.generated_tests).toHaveLength(1);
      expect(result.generated_tests[0].runnable).toBe(true);
      expect(result.generated_tests[0].body).toContain('import { describe, it, expect, vi } from "vitest";');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("stripCodeFence — real-model output cleanup", () => {
  it("extracts the code from a ```ts fence with prose around it", () => {
    const body = "Here is a focused test:\n\n```ts\ndescribe('x', () => {});\n```\n\nThis verifies the behavior.";
    const out = stripCodeFence(body);
    expect(out).toBe("describe('x', () => {});");
    expect(out).not.toContain("```");
    expect(out).not.toContain("Here is a focused test");
  });
  it("leaves un-fenced code untouched", () => {
    const body = "describe('x', () => {});";
    expect(stripCodeFence(body)).toBe(body);
  });
});

describe("generateTests — strips markdown fences from a real-ish provider", () => {
  it("writes runnable code (no fences / prose) when the model wraps output", async () => {
    const fenced: ModelProvider = {
      providerName: "openai",
      modelName: "fake",
      async complete(_req: ModelCompletionRequest): Promise<string> {
        return "Sure! Here's the test:\n```ts\ndescribe('REQ', () => { it('works', () => { expect(1).toBe(1); }); });\n```\nDone.";
      }
    };
    const result = await generateTests(wellGroundedGraph(), { target_ids: ["REQ-001"], limit: 1 }, fenced, () => null, CLOCK);
    expect(result.generated_tests).toHaveLength(1);
    const body = result.generated_tests[0].body;
    expect(body).not.toContain("```");
    expect(body).not.toContain("Sure! Here's the test");
    expect(body).not.toContain("Done.");
    expect(body).toContain("describe('REQ'");
  });
});

describe("DeterministicProvider — valid code for hostile titles/criteria", () => {
  it("emits syntactically valid JS when the title/criteria contain backslashes and quotes", async () => {
    const body = await new DeterministicProvider().complete({
      system: "",
      user: 'BEHAVIOR: Path C:\\Users\\x is "valid" \\d+\nFRAMEWORK: vitest\nACCEPTANCE CRITERIA:\n- handles \\w+ and "quotes"'
    });
    // new Function only parses (does not run), so this fails ONLY on invalid syntax.
    expect(() => new Function(body)).not.toThrow();
    expect(body).not.toContain("# Test:"); // not markdown
  });
  it("puts the behavior in a pytest comment (no docstring) so quotes/backslashes can't break it", async () => {
    const body = await new DeterministicProvider().complete({
      system: "",
      user: 'BEHAVIOR: weird """ title with \\ and "\nFRAMEWORK: pytest'
    });
    expect(body).toContain("def test_");
    expect(body).toContain("assert True");
    // The title rides on a `#` comment line (not a docstring), so embedded
    // quotes/backslashes/triple-quotes can't terminate a string or break parsing.
    const commentLine = body.split("\n").find((l) => l.trim().startsWith("#") && l.includes('"""'));
    expect(commentLine).toBeTruthy();
  });
});

describe("generateTests — too-thin behavior", () => {
  it("emits missing_evidence (not a generic test) when there is nothing to ground", async () => {
    // ONE behavior node: no acceptance criteria, no description, no code
    // context, no candidate edges, no examples.
    // Not weak/candidate strength: a weak anchor would itself count as
    // grounding. This behavior has genuinely nothing to anchor an assertion.
    const thin = makeNode({
      kind: "UserFlow",
      external_id: "FLOW-EMPTY",
      title: "Mystery flow",
      properties: { priority: "high" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("manifest")
    });
    const graph = makeGraph({ nodes: [thin] });

    const result = await generateTests(
      graph,
      { target_ids: ["FLOW-EMPTY"] },
      new DeterministicProvider(),
      () => null,
      CLOCK
    );

    expect(result.generated_tests).toHaveLength(0);
    expect(result.run).toBeNull();
    expect(result.missing_evidence).toHaveLength(1);

    const miss = result.missing_evidence[0];
    expect(miss.external_id).toBe("FLOW-EMPTY");
    expect(Array.isArray(miss.needed)).toBe(true);
    expect(miss.needed.length).toBeGreaterThan(0);
  });
});

describe("generateTests — weak evidence disclosure", () => {
  it("discloses weak/candidate relationships used to ground the test", async () => {
    // Inferred/weak behavior + a candidate edge anchoring it to a file.
    const behavior = makeNode({
      kind: "Requirement",
      external_id: "REQ-WEAK",
      title: "Inferred refund behavior",
      properties: { priority: "medium", area: "refunds" },
      evidence_strength: "weak",
      review_status: "inferred",
      confidence: 0.4,
      provenance: provenance("inferred")
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/refunds/refund.ts",
      title: "refund.ts",
      properties: { role: "code", file: "src/refunds/refund.ts" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/refunds/refund.ts")
    });
    const candidate = makeCandidateEdge({
      from_external_id: "REQ-WEAK",
      to_external_id: "src/refunds/refund.ts",
      relationship_type: "MAY_BE_TESTED_BY",
      evidence_strength: "weak",
      reason: "LLM inferred from description",
      confidence: 0.4,
      provenance: provenance("inferred")
    });

    const graph = makeGraph({
      nodes: [behavior, file],
      candidate_edges: [candidate]
    });

    const result = await generateTests(
      graph,
      { target_ids: ["REQ-WEAK"], limit: 1 },
      new DeterministicProvider(),
      () => null,
      CLOCK
    );

    expect(result.generated_tests).toHaveLength(1);
    const test = result.generated_tests[0];
    expect(test.weak_evidence_used).toBe(true);
    expect(test.grounding.weak_relationships_used.length).toBeGreaterThan(0);
    // Disclosure includes the inferred anchor and/or the candidate edge.
    const disclosed = test.grounding.weak_relationships_used.join("|");
    expect(disclosed).toContain("REQ-WEAK");
  });
});

describe("generateTests — limit clamping", () => {
  it("never generates more than 5 tests regardless of requested limit", async () => {
    const nodes: GraphNode[] = [];
    const edges: GraphEdge[] = [];
    // Six well-grounded requirements, each with its own acceptance criterion.
    for (let i = 0; i < 6; i++) {
      const reqId = `REQ-${i}`;
      const acId = `AC-${i}`;
      nodes.push(
        makeNode({
          kind: "Requirement",
          external_id: reqId,
          title: `Requirement ${i}`,
          properties: { priority: "high" },
          evidence_strength: "hard",
          review_status: "local_reviewed",
          confidence: 1,
          provenance: provenance(`template.csv#row=${i}`)
        })
      );
      nodes.push(
        makeNode({
          kind: "AcceptanceCriterion",
          external_id: acId,
          title: `Outcome ${i} is observable`,
          properties: { text: `Outcome ${i} is observable` },
          evidence_strength: "hard",
          review_status: "local_reviewed",
          confidence: 1,
          provenance: provenance(`template.csv#row=${i}`)
        })
      );
      edges.push(
        makeEdge({
          from_external_id: reqId,
          to_external_id: acId,
          relationship_type: "HAS_ACCEPTANCE_CRITERION",
          evidence_strength: "hard",
          review_status: "local_reviewed",
          provenance: provenance(`template.csv#row=${i}`)
        })
      );
    }
    const graph = makeGraph({ nodes, edges });

    const result = await generateTests(
      graph,
      { limit: 99 },
      new DeterministicProvider(),
      () => null,
      CLOCK
    );

    expect(result.generated_tests.length).toBeGreaterThanOrEqual(1);
    expect(result.generated_tests.length).toBeLessThanOrEqual(5);
  });
});

describe("empty completions are never packaged as tests", () => {
  const starved: ModelProvider = {
    providerName: "fake",
    modelName: "starved-model",
    complete: async (_req: ModelCompletionRequest) => ""
  };

  it("grounded mode: skips the test, warns, and records missing evidence", async () => {
    const res = await generateTests(wellGroundedGraph(), {}, starved, () => null, CLOCK);
    expect(res.generated_tests).toHaveLength(0);
    expect(res.run).toBeNull(); // no run recorded for zero tests
    expect(res.warnings.join("\n")).toContain("empty completion");
    expect(res.missing_evidence.length).toBeGreaterThan(0);
    expect(res.missing_evidence[0].reason).toContain("empty completion");
  });

  it("raw baseline mode: skips the test, warns, and records missing evidence", async () => {
    const res = await generateTests(
      wellGroundedGraph(),
      { input_mode: "raw_prompt" },
      starved,
      () => null,
      CLOCK
    );
    expect(res.generated_tests).toHaveLength(0);
    expect(res.warnings.join("\n")).toContain("empty completion");
    expect(res.missing_evidence.length).toBeGreaterThan(0);
    expect(res.missing_evidence[0].reason).toContain("empty completion");
  });

  it("raw mode caps ATTEMPTS at limit: a systemically-empty provider is never an unbounded spend path", async () => {
    // Many targets, small limit: skipped-empty completions must not let the loop
    // run across every target (Codex P1).
    const flows: GraphNode[] = [];
    for (let i = 0; i < 8; i++) {
      flows.push(
        makeNode({
          kind: "UserFlow",
          external_id: `flow:f${i}`,
          title: `Flow ${i}`,
          properties: { area: "core" },
          evidence_strength: "weak",
          review_status: "inferred",
          confidence: 0.35,
          provenance: provenance(`tests/f${i}.test.ts`)
        })
      );
    }
    const graph = makeGraph({ nodes: flows });
    let calls = 0;
    const countingStarved: ModelProvider = {
      providerName: "fake",
      modelName: "starved-model",
      complete: async (_req: ModelCompletionRequest) => {
        calls++;
        return "";
      }
    };
    const res = await generateTests(graph, { input_mode: "raw_prompt", limit: 2 }, countingStarved, () => null, CLOCK);
    expect(res.generated_tests).toHaveLength(0);
    expect(calls).toBe(2); // attempts capped, not successes
    expect(res.missing_evidence).toHaveLength(2);
  });
});

describe("provider errors never vaporize a run", () => {
  it("a failed call is disclosed and the run CONTINUES with the remaining targets", async () => {
    const flows: GraphNode[] = [];
    for (let i = 0; i < 3; i++) {
      flows.push(
        makeNode({
          kind: "UserFlow",
          external_id: `flow:r${i}`,
          title: `Flow ${i}`,
          properties: { area: "core" },
          evidence_strength: "weak",
          review_status: "inferred",
          confidence: 0.35,
          provenance: provenance(`tests/r${i}.test.ts`)
        })
      );
    }
    const graph = makeGraph({ nodes: flows });
    let calls = 0;
    const flaky: ModelProvider = {
      providerName: "fake",
      modelName: "flaky-model",
      complete: async (_req: ModelCompletionRequest) => {
        calls++;
        if (calls === 1) throw new Error("Model call timed out after 600s.");
        return "describe('ok', () => { it('works', () => { expect(1).toBe(1); }); });";
      }
    };
    const res = await generateTests(graph, { input_mode: "raw_prompt", limit: 3 }, flaky, () => null, CLOCK);
    expect(calls).toBe(3); // the failure did not abort the loop
    expect(res.generated_tests).toHaveLength(2); // the two later calls landed
    expect(res.warnings.join("\n")).toContain("Model call failed");
    expect(res.warnings.join("\n")).toContain("timed out after 600s");
    expect(res.missing_evidence).toHaveLength(1);
    expect(res.run).not.toBeNull(); // partial success still records a run
  });

  it("grounded mode: an always-failing provider yields zero tests + disclosures, never a throw", async () => {
    const failing: ModelProvider = {
      providerName: "fake",
      modelName: "down-model",
      complete: async () => {
        throw new Error("Model provider HTTP 503: upstream unavailable");
      }
    };
    const res = await generateTests(wellGroundedGraph(), {}, failing, () => null, CLOCK);
    expect(res.generated_tests).toHaveLength(0);
    expect(res.run).toBeNull();
    expect(res.warnings.join("\n")).toContain("Model call failed");
    expect(res.missing_evidence.length).toBeGreaterThan(0);
  });
});

describe("grounding follows resolved test->source links", () => {
  it("includes the source modules the behavior's test file imports", () => {
    const flow = makeNode({
      kind: "UserFlow",
      external_id: "flow:x",
      title: "X (inferred from tests)",
      properties: { area: "webapp", feature: "x" },
      evidence_strength: "weak",
      review_status: "inferred",
      confidence: 0.35,
      provenance: provenance("tests/x.test.ts")
    });
    const testCase = makeNode({
      kind: "TestCase",
      external_id: "test:tests/x.test.ts",
      title: "x.test.ts",
      properties: { file: "tests/x.test.ts", test_layer: "unit", test_names: ["x"] },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("tests/x.test.ts")
    });
    const srcFile = makeNode({
      kind: "File",
      external_id: "src/x.ts",
      title: "x.ts",
      properties: { role: "code", language: "typescript" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/x.ts")
    });
    const graph = makeGraph({
      nodes: [flow, testCase, srcFile],
      candidate_edges: [
        makeCandidateEdge({
          from_external_id: "flow:x",
          to_external_id: "test:tests/x.test.ts",
          relationship_type: "MAY_BE_TESTED_BY",
          evidence_strength: "weak",
          reason: "anchor",
          confidence: 0.35
        }),
        makeCandidateEdge({
          from_external_id: "tests/x.test.ts",
          to_external_id: "src/x.ts",
          relationship_type: "MAY_RELATE_TO",
          evidence_strength: "candidate",
          reason: 'Test resolved-imports this module ("../src/x.js")',
          confidence: 0.75
        })
      ]
    });
    const { entityIds, sourceRefs } = gatherContext(graph, flow, "jest", () => null);
    expect(entityIds).toContain("src/x.ts"); // the module the test actually imports
    expect(sourceRefs).toContain("src/x.ts");
    expect(entityIds).toContain("tests/x.test.ts");
  });
});

describe("prompt v2 — existing coverage, subject imports, and framework runnability", () => {
  it("renders EXISTING TESTS and SUBJECT IMPORTS sections in the grounded prompt", () => {
    const ctx = {
      behavior_external_id: "flow:x",
      behavior_title: "X behavior",
      actors: [],
      acceptance_criteria: [],
      workflow_steps: [],
      framework: "jest",
      test_layer: "unit" as const,
      code_context: ["src/x.ts"],
      source_excerpts: [],
      weak_context: [],
      existing_tests: ["should show add-to-channel option if in a team"],
      subject_imports: ["import {renderWithContext} from 'tests/react_testing_utils';"]
    };
    const prompt = buildGroundedUserPrompt(ctx, "happy_path");
    expect(prompt).toContain("EXISTING TESTS (already covered");
    expect(prompt).toContain("should show add-to-channel option if in a team");
    expect(prompt).toContain("SUBJECT IMPORTS");
    expect(prompt).toContain("import {renderWithContext} from 'tests/react_testing_utils';");
  });

  it("system prompt v2 forbids regenerating existing coverage and demands framework-specific runnable shape", () => {
    const sys = buildSystemPrompt();
    expect(sys).toContain("ALREADY exists");
    expect(sys).toContain("COMPLETE import statements");
    expect(sys).toContain("Do NOT copy SOURCE EXCERPT lines verbatim");
    expect(sys).toContain("// Bucket:");
    expect(sys).toContain("# Bucket:");
    expect(sys).toContain("same-package `_test.go`");
    expect(sys).toContain("complete `.java` file");
  });

  it("grounded prompt adds language-specific runnability rules", () => {
    const base: GenerationContext = {
      behavior_external_id: "flow:x",
      behavior_title: "X behavior",
      actors: [],
      acceptance_criteria: [],
      workflow_steps: [],
      framework: "pytest",
      test_layer: "unit",
      code_context: ["src/x.py"],
      source_excerpts: ["// file: src/x.py\ndef internal_value():\n    return 42"],
      weak_context: [],
      existing_tests: [],
      subject_imports: []
    };

    const py = buildGroundedUserPrompt(base, "happy_path");
    expect(py).toContain("Use Python comments");
    expect(py).toContain("def test_");
    expect(py).toContain("do not copy their lines verbatim");

    const go = buildGroundedUserPrompt({ ...base, framework: "go", code_context: ["svc/x.go"] }, "happy_path");
    expect(go).toContain("same-package Go test code");
    expect(go).toContain("Do not import third-party or module-path packages");

    const java = buildGroundedUserPrompt({ ...base, framework: "junit", code_context: ["src/main/java/X.java"] }, "happy_path");
    expect(java).toContain("JUnit 5 code");
    expect(java).toContain("import org.junit.jupiter.api.Test");
    expect(java).toContain("not a bare method fragment");

    const tsjs = buildGroundedUserPrompt(
      {
        ...base,
        framework: "vitest",
        code_context: ["src/api.ts"],
        subject_imports: ['import { saveUser } from "../src/api";']
      },
      "happy_path"
    );
    expect(tsjs).toContain("Emit vitest code only");
    expect(tsjs).toContain("reuse those exact repo-proven imports");
    expect(tsjs).toContain("Do not invent module paths");
  });
});

describe("redaction never breaks runnability", () => {
  it("import lines matching a source excerpt are NEVER redacted (metadata carve-out)", () => {
    const excerpt = [
      "// file: src/x.ts",
      "import {TestHelper} from 'packages/utils/test_helper';",
      "const secretSauceImplementation = computeRanking(weights);",
      "return secretSauceImplementation.score;"
    ].join("\n");
    const body = [
      "import {TestHelper} from 'packages/utils/test_helper';",
      "const secretSauceImplementation = computeRanking(weights);",
      "return secretSauceImplementation.score;",
      "it('x', () => { expect(TestHelper).toBeDefined(); });"
    ].join("\n");
    const out = sanitizeGeneratedBody(body, [excerpt]);
    expect(out.body).toContain("import {TestHelper} from 'packages/utils/test_helper';"); // survives
    expect(out.body).not.toContain("secretSauceImplementation"); // still redacted
    expect(out.redactedLines).toBe(2);
  });

  it("does not redact legitimate literal constants reproduced from API-surface context", () => {
    const excerpt = [
      "// file: src/ids.ts lines 1-2 (referenced symbol: ids)",
      "export const DEFAULT_KIND = \"furlong\";",
      "export type FurlongId = string;"
    ].join("\n");
    const body = [
      "import { DEFAULT_KIND } from './ids';",
      "it('uses repo literal', () => {",
      "  expect(DEFAULT_KIND).toBe(\"furlong\");",
      "});"
    ].join("\n");
    const out = sanitizeGeneratedBody(body, [excerpt]);
    expect(out.redactedLines).toBe(0);
    expect(out.body).toContain("DEFAULT_KIND");
    expect(out.body).toContain("\"furlong\"");
  });

  it("does not redact local test type declarations copied from grounding examples", () => {
    const excerpt = [
      "// file: alias_test.go (existing test)",
      "type MyString string",
      "type MyFloat64 float64"
    ].join("\n");
    const body = [
      "func TestResolveAlias(t *testing.T) {",
      "    type MyString string",
      "    type MyFloat64 float64",
      "    input := MyString(\"hello\")",
      "    _ = input",
      "}"
    ].join("\n");
    const out = sanitizeGeneratedBody(body, [excerpt]);
    expect(out.redactedLines).toBe(0);
    expect(out.body).toContain("type MyString string");
    expect(out.body).toContain("type MyFloat64 float64");
  });

  it("does not redact Go import specs copied from existing test context", () => {
    const excerpt = [
      "// file: alias_test.go (existing test)",
      "import (",
      "\t\"testing\"",
      "\tqt \"github.com/frankban/quicktest\"",
      ")",
      "// file: alias.go lines 1-7 (target symbol: resolveAlias)",
      "func resolveAlias(i any) (any, bool) {",
      "\treturn i, false",
      "}"
    ].join("\n");
    const body = [
      "package cast",
      "",
      "import (",
      "\t\"testing\"",
      "\tqt \"github.com/frankban/quicktest\"",
      ")",
      "",
      "func TestX(t *testing.T) { qt.Assert(t, true, qt.IsTrue) }"
    ].join("\n");
    const out = sanitizeGeneratedBody(body, [excerpt]);
    expect(out.redactedLines).toBe(0);
    expect(out.body).toContain(")");
    expect(out.body).toContain('qt "github.com/frankban/quicktest"');
  });

  it("removes redaction markers from Go import blocks so imports stay parseable", () => {
    const leaky = "internalSecretImportAlias := reflect.TypeOf(input)";
    const body = [
      "package cast",
      "",
      "import (",
      "\t\"testing\"",
      `\t${leaky}`,
      ")",
      "",
      "func TestX(t *testing.T) {}"
    ].join("\n");
    const out = sanitizeGeneratedBody(body, [`// file: alias.go\n${leaky}`]);
    expect(out.redactedLines).toBe(1);
    expect(out.body).toContain("import (\n\t\"testing\"\n)");
    expect(out.body).not.toContain("[orangepro: source excerpt redacted]");
    expect(out.body).toContain("func TestX");
  });

  it("does not redact short structural closers that happen to appear in excerpts", () => {
    const excerpt = [
      "// file: handler.test.ts lines 1-3 (existing test)",
      "expect(handler()).toEqual({",
      "  ok: true",
      "});"
    ].join("\n");
    const body = [
      "it('keeps clean syntax', () => {",
      "  expect(handler()).toEqual({",
      "    ok: true",
      "  });",
      "});"
    ].join("\n");
    const out = sanitizeGeneratedBody(body, [excerpt]);
    expect(out.redactedLines).toBe(0);
    expect(out.body).toContain("});");
  });

  it("stripRedactedStatements drops a half-redacted statement so the file parses", () => {
    const body = [
      "jest.mock('utils/utils', () => ({",
      "  // [orangepro: source excerpt redacted]",
      "  // [orangepro: source excerpt redacted]",
      "}));",
      "",
      "test('uses the util', () => { expect(1).toBe(1); });"
    ].join("\n");
    const out = stripRedactedStatements(body);
    expect(out.dropped).toBe(1);
    expect(out.body).not.toContain("jest.mock");
    expect(out.body).toContain("test('uses the util'");
    expect(() => new Function(out.body)).not.toThrow(); // parseable again
  });

  it("a marker comment ABOVE a statement (leading trivia) never condemns it", () => {
    const body = [
      "// [orangepro: source excerpt redacted]",
      "test('kept', () => { expect(2).toBe(2); });"
    ].join("\n");
    const out = stripRedactedStatements(body);
    expect(out.dropped).toBe(0);
    expect(out.body).toContain("test('kept'");
  });
});

describe("hasExecutableContent — import-only bodies are not tests", () => {
  it("TS: imports plus a removal comment do not count as executable", () => {
    const body = [
      'import { saveCard } from "./card";',
      "// [orangepro: statement removed — it echoed redacted source]"
    ].join("\n");
    expect(hasExecutableContent(body, "vitest")).toBe(false);
    expect(
      hasExecutableContent(body + '\nit("saves", () => { expect(saveCard()).toBe(true); });', "vitest")
    ).toBe(true);
  });

  it("python: import/from-only bodies (incl. multi-line parens) do not count; def test_ does", () => {
    expect(hasExecutableContent("import pytest\nfrom app.cards import save_card", "pytest")).toBe(false);
    expect(hasExecutableContent("from app.cards import (\n    save_card,\n    delete_card,\n)", "pytest")).toBe(false);
    expect(hasExecutableContent("import pytest\n\ndef test_x():\n    assert True", "pytest")).toBe(true);
  });

  it("go: package + import block only does not count; func Test does", () => {
    const goImports = 'package cards_test\n\nimport (\n\t"testing"\n\t"example.com/app/cards"\n)';
    expect(hasExecutableContent(goImports, "go")).toBe(false);
    expect(hasExecutableContent(goImports + "\n\nfunc TestSave(t *testing.T) {}", "go")).toBe(true);
  });

  it("parens inside trailing comments do not derail import-group tracking", () => {
    // python: an unbalanced '(' in a trailing comment must not open a phantom
    // group that swallows the one-line test below.
    const py = [
      "from app.cards import save_card  # fallback for save_card(legacy",
      "def test_save(): assert save_card() == 1"
    ].join("\n");
    expect(hasExecutableContent(py, "pytest")).toBe(true);
    // go: a ')' inside an in-group comment must not close the group early —
    // this body is import-only and must stay non-executable.
    const go = [
      "package cards_test",
      "",
      "import (",
      '\t"testing"',
      '\tsq "github.com/Masterminds/squirrel" // SQL builder (used by store)',
      '\t"example.com/app/cards"',
      ")"
    ].join("\n");
    expect(hasExecutableContent(go, "go")).toBe(false);
  });

  it("python: a module docstring plus imports is not executable content", () => {
    const docOnly = '"""Tests for card saving."""\nimport pytest\nfrom app.cards import save_card';
    expect(hasExecutableContent(docOnly, "pytest")).toBe(false);
    const multiline = '"""\nTests for card saving.\n"""\nimport pytest';
    expect(hasExecutableContent(multiline, "pytest")).toBe(false);
    const withTest = docOnly + "\n\ndef test_save():\n    assert save_card() == 1";
    expect(hasExecutableContent(withTest, "pytest")).toBe(true);
  });

  it("python docstrings close only on their OWN delimiter; self-closing lines keep trailing code", () => {
    // A """ inside a '''-docstring is prose, not a close — the whole body is
    // one string literal with zero executable content.
    const mismatch = "'''\nthis prose quotes \"\"\" inside a single-quoted docstring\nmore prose only\n'''";
    expect(hasExecutableContent(mismatch, "pytest")).toBe(false);
    const mismatchReverse = '"""\nquotes \'\'\' inside\n"""';
    expect(hasExecutableContent(mismatchReverse, "pytest")).toBe(false);
    // Code after a self-closing one-liner docstring is real executable content.
    expect(hasExecutableContent('"""doc""" + run_suite()', "pytest")).toBe(true);
    expect(hasExecutableContent('"""doc"""', "pytest")).toBe(false);
  });
});

describe("subject imports — reconstructed from the linked existing test file", () => {
  it("gatherContext uses symbol-targeted excerpts and referenced type definitions", () => {
    const target = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:null.go#NullUUID",
      title: "NullUUID",
      properties: { file: "null.go", symbol_kind: "class", start_line: 3, end_line: 7, area: "core" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("null.go")
    });
    const uuidType = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:uuid.go#UUID",
      title: "UUID",
      properties: { file: "uuid.go", symbol_kind: "class", start_line: 2, end_line: 2, area: "core" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("uuid.go")
    });
    const graph = makeGraph({ nodes: [target, uuidType] });
    const files: Record<string, string> = {
      "null.go": [
        "package uuid",
        "var fixtureKey = \"sk-123456789012345678901\"",
        "type NullUUID struct {",
        "    ExampleSecret string // sk-123456789012345678901",
        "    UUID UUID",
        "    Valid bool",
        "}",
        "func unrelated() {}"
      ].join("\n"),
      "uuid.go": ["package uuid", "type UUID [16]byte", "func Parse(s string) (UUID, error) { return UUID{}, nil }"].join("\n")
    };

    const { ctx } = gatherContext(graph, target, "go", (rel) => files[rel] ?? null);
    const joined = ctx.source_excerpts.join("\n---\n");

    expect(joined).toContain("target symbol: NullUUID");
    expect(joined).toContain("type NullUUID struct");
    expect(joined).toContain("referenced type: UUID");
    expect(joined).toContain("type UUID [16]byte");
    expect(joined).not.toContain("sk-123456789012345678901");
    expect(joined).toContain("<redacted:openai-key>");
    expect(joined.length).toBeLessThanOrEqual(8500);
  });

  it("slices raw lines before redaction so multiline secrets above a target do not shift symbol spans", () => {
    const target = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:secret.go#SecretBox",
      title: "SecretBox",
      properties: { file: "secret.go", symbol_kind: "class", start_line: 7, end_line: 10, area: "core" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("secret.go")
    });
    const graph = makeGraph({ nodes: [target] });
    const files: Record<string, string> = {
      "secret.go": [
        "package privategrounding",
        "const label = \"above\"",
        "-----BEGIN PRIVATE KEY-----",
        "MIIEvQIBADANBgkqhkiG9w0BAQEFAASC",
        "-----END PRIVATE KEY-----",
        "",
        "type SecretBox struct {",
        "    Value string",
        "    Valid bool",
        "}"
      ].join("\n")
    };

    const { ctx } = gatherContext(graph, target, "go", (rel) => files[rel] ?? null);
    const joined = ctx.source_excerpts.join("\n---\n");

    expect(joined).toContain("target symbol: SecretBox");
    expect(joined).toContain("type SecretBox struct");
    expect(joined).not.toContain("BEGIN PRIVATE KEY");
    expect(joined).not.toContain("END PRIVATE KEY");
  });

  it("line-preserving full-file redaction prevents multiline secret body leaks near symbol context", () => {
    const target = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:near.go#NearSecret",
      title: "NearSecret",
      properties: { file: "near.go", symbol_kind: "function", start_line: 7, end_line: 9, area: "core" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("near.go")
    });
    const leakedBody = "SHOULD_NOT_LEAK_BASE64_BODY_0123456789";
    const graph = makeGraph({ nodes: [target] });
    const files: Record<string, string> = {
      "near.go": [
        "package privategrounding",
        "const label = \"above\"",
        "-----BEGIN PRIVATE KEY-----",
        leakedBody,
        "-----END PRIVATE KEY-----",
        "",
        "func NearSecret() string {",
        "    return \"ok\"",
        "}"
      ].join("\n")
    };

    const { ctx } = gatherContext(graph, target, "go", (rel) => files[rel] ?? null);
    const joined = ctx.source_excerpts.join("\n---\n");

    expect(joined).toContain("target symbol: NearSecret");
    expect(joined).toContain("func NearSecret() string");
    expect(joined).not.toContain("BEGIN PRIVATE KEY");
    expect(joined).not.toContain(leakedBody);
    expect(joined).not.toContain("END PRIVATE KEY");
  });

  it("prioritizes same-package referenced types before graph-wide name matches hit the cap", () => {
    const target = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:model/null.go#NullUUID",
      title: "NullUUID",
      properties: { file: "model/null.go", symbol_kind: "class", start_line: 1, end_line: 3, area: "model" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("model/null.go")
    });
    const foreign = Array.from({ length: 12 }, (_, i) =>
      makeNode({
        kind: "CodeSymbol",
        external_id: `sym:pkg${i}/uuid.go#UUID`,
        title: "UUID",
        properties: { file: `pkg${i}/uuid.go`, symbol_kind: "class", start_line: 1, end_line: 1, area: `pkg${i}` },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance(`pkg${i}/uuid.go`)
      })
    );
    const samePackageType = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:model/uuid.go#UUID",
      title: "UUID",
      properties: { file: "model/uuid.go", symbol_kind: "class", start_line: 1, end_line: 1, area: "model" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("model/uuid.go")
    });
    const graph = makeGraph({ nodes: [target, ...foreign, samePackageType] });
    const files: Record<string, string> = {
      "model/null.go": "type NullUUID struct {\n    UUID UUID\n}",
      "model/uuid.go": "type UUID [16]byte",
      ...Object.fromEntries(foreign.map((_, i) => [`pkg${i}/uuid.go`, `type UUID string // wrong package ${i}`]))
    };

    const { ctx } = gatherContext(graph, target, "go", (rel) => files[rel] ?? null);
    const joined = ctx.source_excerpts.join("\n---\n");

    expect(joined).toContain("file: model/uuid.go");
    expect(joined).toContain("type UUID [16]byte");
  });

  it("uses graph edges to include referenced type definitions even when the type name is absent from the target body", () => {
    const target = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:svc/create.go#Create",
      title: "Create",
      properties: { file: "svc/create.go", symbol_kind: "function", start_line: 1, end_line: 3, area: "svc" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("svc/create.go")
    });
    const payload = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:types/payload.go#FurlongPayload",
      title: "FurlongPayload",
      properties: { file: "types/payload.go", symbol_kind: "class", start_line: 1, end_line: 3, area: "types" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("types/payload.go")
    });
    const graph = makeGraph({
      nodes: [target, payload],
      edges: [
        makeEdge({
          from_external_id: "sym:svc/create.go#Create",
          to_external_id: "sym:types/payload.go#FurlongPayload",
          relationship_type: "IMPORTS",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: provenance("svc/create.go")
        })
      ]
    });
    const files: Record<string, string> = {
      "svc/create.go": "func Create() int {\n    return 1\n}",
      "types/payload.go": "type FurlongPayload struct {\n    Name string\n}"
    };

    const { ctx } = gatherContext(graph, target, "go", (rel) => files[rel] ?? null);
    const joined = ctx.source_excerpts.join("\n---\n");

    expect(joined).toContain("referenced type: FurlongPayload");
    expect(joined).toContain("type FurlongPayload struct");
  });

  it("includes same-file associated methods when generating for a type target", () => {
    const token = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:token.go#Token",
      title: "Token",
      properties: { file: "token.go", symbol_kind: "class", start_line: 1, end_line: 4, area: "core" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("token.go")
    });
    const newToken = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:token.go#NewToken",
      title: "NewToken",
      properties: { file: "token.go", symbol_kind: "function", start_line: 6, end_line: 8, area: "core" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("token.go")
    });
    const verify = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:token.go#Verify",
      title: "Verify",
      properties: { file: "token.go", symbol_kind: "method", start_line: 10, end_line: 12, area: "core" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("token.go")
    });
    const graph = makeGraph({ nodes: [token, newToken, verify] });
    const files = {
      "token.go": [
        "type Token struct {",
        "    payload string",
        "    sig int64",
        "}",
        "",
        "func NewToken(payload string) Token {",
        "    return Token{payload: payload, sig: int64(len(payload))}",
        "}",
        "",
        "func (t Token) Verify() bool {",
        "    return t.sig == int64(len(t.payload))",
        "}"
      ].join("\n")
    };

    const { ctx } = gatherContext(graph, token, "go", (rel) => files[rel as keyof typeof files] ?? null);
    const joined = ctx.source_excerpts.join("\n---\n");

    expect(joined).toContain("associated symbol: NewToken");
    expect(joined).toContain("func NewToken");
    expect(joined).toContain("associated method: Verify");
    expect(joined).toContain("func (t Token) Verify");
    expect(joined).not.toContain("return Token{payload");
    expect(joined).not.toContain("return t.sig");
  });

  it("falls back to related file bodies for behavior targets instead of returning imports only", () => {
    const flow = makeNode({
      kind: "UserFlow",
      external_id: "flow:save-card",
      title: "Save card",
      properties: { area: "billing" },
      evidence_strength: "hard",
      review_status: "local_reviewed",
      confidence: 1,
      provenance: provenance("README.md")
    });
    const file = makeNode({
      kind: "File",
      external_id: "billing/card.go",
      title: "card.go",
      properties: { role: "code", file: "billing/card.go", area: "billing" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("billing/card.go")
    });
    const graph = makeGraph({
      nodes: [flow, file],
      edges: [
        makeEdge({
          from_external_id: "flow:save-card",
          to_external_id: "billing/card.go",
          relationship_type: "IMPLEMENTED_IN",
          evidence_strength: "hard",
          review_status: "auto_detected",
          provenance: provenance("billing/card.go")
        })
      ]
    });
    const files = {
      "billing/card.go": "package billing\n\nimport \"errors\"\n\nfunc SaveCard(id string) error {\n    if id == \"\" { return errors.New(\"missing\") }\n    return nil\n}"
    };

    const { ctx } = gatherContext(graph, flow, "go", (rel) => files[rel as keyof typeof files] ?? null);
    const joined = ctx.source_excerpts.join("\n---\n");

    expect(joined).toContain("related file");
    expect(joined).toContain("func SaveCard");
  });

  it("enforces the excerpt budget on oversized symbol bodies", () => {
    const target = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:large.go#LargeTarget",
      title: "LargeTarget",
      properties: { file: "large.go", symbol_kind: "function", start_line: 1, end_line: 420, area: "core" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("large.go")
    });
    const graph = makeGraph({ nodes: [target] });
    const largeBody = Array.from({ length: 420 }, (_, i) => `line${i} := \"${"x".repeat(40)}\"`).join("\n");

    const { ctx } = gatherContext(graph, target, "go", (rel) => (rel === "large.go" ? largeBody : null));
    const joined = ctx.source_excerpts.join("\n---\n");

    expect(joined.length).toBeLessThanOrEqual(8000);
    expect(joined).toContain("excerpt truncated to budget");
  });

  it("reserves budget for referenced types when a large class target is truncated", () => {
    const target = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/main/java/app/HugeService.java#HugeService",
      title: "HugeService",
      properties: { file: "src/main/java/app/HugeService.java", symbol_kind: "class", start_line: 1, end_line: 260, area: "app" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/main/java/app/HugeService.java")
    });
    const request = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/main/java/app/RequestOptions.java#RequestOptions",
      title: "RequestOptions",
      properties: { file: "src/main/java/app/RequestOptions.java", symbol_kind: "class", start_line: 1, end_line: 3, area: "app" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/main/java/app/RequestOptions.java")
    });
    const graph = makeGraph({ nodes: [target, request] });
    const hugeBody = [
      "class HugeService {",
      "  private RequestOptions options;",
      ...Array.from({ length: 258 }, (_, i) => `  String filler${i} = "${"x".repeat(70)}";`),
      "}"
    ].join("\n");
    const files: Record<string, string> = {
      "src/main/java/app/HugeService.java": hugeBody,
      "src/main/java/app/RequestOptions.java": "class RequestOptions {\n  String mode;\n}"
    };

    const { ctx } = gatherContext(graph, target, "junit", (rel) => files[rel] ?? null);
    const joined = ctx.source_excerpts.join("\n---\n");

    expect(joined.length).toBeLessThanOrEqual(8000);
    expect(joined).toContain("target excerpt truncated to reserve type budget");
    expect(joined).toContain("referenced type: RequestOptions");
    expect(joined).toContain("class RequestOptions");
  });

  it("gatherContext rebuilds working import lines from the test file's parse metadata", () => {
    const dir = mkdtempSync(join(tmpdir(), "opsubj-"));
    try {
      mkdirSync(join(dir, "tests"), { recursive: true });
      writeFileSync(
        join(dir, "tests", "x.test.ts"),
        [
          "import {renderWithContext} from 'tests/react_testing_utils';",
          "import ProfilePopover from 'components/profile_popover/profile_popover';",
          "import * as Utils from 'utils/utils';",
          "import type {GlobalState} from 'types/store';",
          "it('x', () => {});"
        ].join("\n")
      );
      const flow = makeNode({
        kind: "UserFlow",
        external_id: "flow:x",
        title: "X",
        properties: { area: "tests", example_behaviors: ["x"] },
        evidence_strength: "weak",
        review_status: "inferred",
        confidence: 0.35,
        provenance: provenance("tests/x.test.ts")
      });
      const tc = makeNode({
        kind: "TestCase",
        external_id: "test:tests/x.test.ts",
        title: "x.test.ts",
        properties: { file: "tests/x.test.ts", test_layer: "unit", test_names: ["x"] },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("tests/x.test.ts")
      });
      const graph = makeGraph({
        nodes: [flow, tc],
        candidate_edges: [
          makeCandidateEdge({
            from_external_id: "flow:x",
            to_external_id: "test:tests/x.test.ts",
            relationship_type: "MAY_BE_TESTED_BY",
            evidence_strength: "weak",
            reason: "anchor",
            confidence: 0.35
          })
        ]
      });
      graph.workspace.root = dir;
      const { ctx } = gatherContext(graph, flow, "jest", () => null);
      expect(ctx.subject_imports).toContain('import {renderWithContext} from "tests/react_testing_utils";');
      expect(ctx.subject_imports).toContain('import ProfilePopover from "components/profile_popover/profile_popover";');
      expect(ctx.subject_imports).toContain('import * as Utils from "utils/utils";');
      // type-only imports are not runtime subjects
      expect(ctx.subject_imports.join("\n")).not.toContain("GlobalState");
      // existing coverage moved out of weak context into its own field
      expect(ctx.existing_tests).toContain("x");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("import carve-out is PURE-import only (smuggling regression)", () => {
  const excerpt = (line: string) => `// file: src/secret.ts\n${line}`;

  it("a protected line with code AFTER the import is fully redacted", () => {
    const smuggle = `import { db } from "./db"; const SECRET_ALGO = rebalance(weights, 0.731);`;
    const out = sanitizeGeneratedBody(`${smuggle}\nit("x", () => {});`, [excerpt(smuggle)]);
    expect(out.body).not.toContain("SECRET_ALGO");
    expect(out.redactedLines).toBe(1);
  });

  it("a protected import line with a trailing comment is redacted (comments can carry source)", () => {
    const rider = `import { weights } from "./model"; // rebalance factor stays at 0.731 per ALGO-7`;
    const out = sanitizeGeneratedBody(`${rider}\nit("x", () => {});`, [excerpt(rider)]);
    expect(out.body).not.toContain("ALGO-7");
  });

  it("a pure import line matching a protected excerpt line is kept", () => {
    const pure = `import { renderWithContext } from 'tests/react_testing_utils';`;
    const out = sanitizeGeneratedBody(`${pure}\nit("x", () => {});`, [excerpt(pure)]);
    expect(out.body).toContain(pure);
    expect(out.redactedLines).toBe(0);
  });

  it("a pure export-from line is kept; a non-from export carrying code is redacted", () => {
    const reexport = `export { saveUser as storeUser } from "./defs";`;
    const kept = sanitizeGeneratedBody(`${reexport}\nit("x", () => {});`, [excerpt(reexport)]);
    expect(kept.body).toContain(reexport);
    const leaky = `export const SECRET_TABLE = buildLookupTable(0.731, MAGIC);`;
    const redacted = sanitizeGeneratedBody(`${leaky}\nit("x", () => {});`, [excerpt(leaky)]);
    expect(redacted.body).not.toContain("SECRET_TABLE");
  });

  it("python: a pure import is kept, a one-liner with trailing code is redacted", () => {
    const pyPure = `from payments.gateway import charge_card, refund_card`;
    const kept = sanitizeGeneratedBody(`${pyPure}\ndef test_x():\n    assert True`, [excerpt(pyPure)]);
    expect(kept.body).toContain(pyPure);
    const pyLeaky = `import os; os.system(build_secret_command(0.731))`;
    const redacted = sanitizeGeneratedBody(`${pyLeaky}\ndef test_x():\n    assert True`, [excerpt(pyLeaky)]);
    expect(redacted.body).not.toContain("build_secret_command");
  });

  it("python: redaction uses hash comments and preserves indentation", () => {
    const secretLine = "    result = compute_internal_customer_segment(account_id, weights)";
    const out = sanitizeGeneratedBody(
      ["def test_segment():", secretLine, "    assert True"].join("\n"),
      [excerpt(secretLine)],
      "#"
    );
    expect(out.body).toContain("    # [orangepro: source excerpt redacted]");
    expect(out.body).not.toContain("// [orangepro: source excerpt redacted]");
  });

  it("java: pure JUnit import lines are kept, but trailing code is redacted", () => {
    const javaImport = "import org.junit.jupiter.api.Test;";
    const staticImport = "import static org.junit.jupiter.api.Assertions.assertTrue;";
    const kept = sanitizeGeneratedBody(
      `${javaImport}\n${staticImport}\nclass OwnerControllerTest {}`,
      [excerpt(`${javaImport}\n${staticImport}`)]
    );
    expect(kept.body).toContain(javaImport);
    expect(kept.body).toContain(staticImport);
    expect(kept.redactedLines).toBe(0);

    const leaky = "import org.junit.jupiter.api.Test; int secret = computeInternalSeed(731);";
    const redacted = sanitizeGeneratedBody(`${leaky}\nclass OwnerControllerTest {}`, [excerpt(leaky)]);
    expect(redacted.body).not.toContain("computeInternalSeed");
  });
});

describe("review hardening — output-quality round 2", () => {
  const flowNode = (id: string, props: Record<string, unknown>): GraphNode =>
    makeNode({
      kind: "UserFlow",
      external_id: id,
      title: `${id} (inferred from tests)`,
      properties: props,
      evidence_strength: "weak",
      review_status: "inferred",
      confidence: 0.35,
      provenance: provenance("tests/x.test.ts")
    });

  it("synthesizeImports USES subject imports and NEVER guesses a module name", () => {
    const withSubject = synthesizeImports("jest", [
      'import {ProfilePopover} from "components/profile_popover/profile_popover";'
    ]);
    expect(withSubject.join("\n")).toContain("components/profile_popover/profile_popover");
    // No slug guess is ever emitted — a subject with no derivable import is handled
    // by the caller (resolver-derivation, else a non-runnable grounded draft).
    const onlyFramework = synthesizeImports("jest", []).join("\n");
    expect(onlyFramework).not.toContain("./profile-popover");
    expect(onlyFramework).toContain("@jest/globals"); // framework import still added
  });

  it("synthesizeImports keeps the framework import alongside subject imports", () => {
    // Subject imports without a framework import: ours is re-added.
    const out = synthesizeImports("vitest", ['import { saveCard } from "./card";']).join("\n");
    expect(out).toContain('from "vitest"');
    expect(out).toContain("./card");
    // Subject imports that already bind some framework names: only the missing
    // names are added (duplicate module specifiers are valid ESM; duplicate
    // local names are not).
    const covered = synthesizeImports("vitest", [
      'import { describe, it, expect } from "vitest";',
      'import { saveCard } from "./card";'
    ]).join("\n");
    expect(covered).toContain('import { vi } from "vitest";');
    expect(covered.match(/\bdescribe\b/g)).toHaveLength(1);
    // Ambient frameworks (cypress globals) get no framework line at all.
    const cy = synthesizeImports("cypress", ['import * as TIMEOUTS from "../../fixtures/timeouts";']).join("\n");
    expect(cy).not.toContain("Cypress globals");
    expect(cy).toContain("fixtures/timeouts");
  });

  it("framework import never re-declares a local a subject import already binds", () => {
    // jest + chai-style subject imports: `expect` must not be declared twice.
    const out = synthesizeImports("jest", [
      'import { expect } from "chai";',
      'import { saveCard } from "./card";'
    ]).join("\n");
    expect(out).toContain('import { describe, it, jest } from "@jest/globals";');
    expect(out.match(/\bexpect\b/g)).toHaveLength(1); // only chai's binding survives
    // Mid-migration repo: vitest framework, subject still imports from @jest/globals.
    const migrated = synthesizeImports("vitest", [
      'import { describe, it, expect } from "@jest/globals";'
    ]).join("\n");
    expect(migrated).toContain('import { vi } from "vitest";'); // only the missing name
    expect(migrated.match(/\bdescribe\b/g)).toHaveLength(1);
  });

  it("mocha's two-line bundle is decided per line, not all-or-nothing", () => {
    // Subject covers mocha but NOT chai: the chai half must still be added.
    const mocha = synthesizeImports("mocha", ['import { describe, it } from "mocha";']).join("\n");
    expect(mocha.match(/from "mocha"/g)).toHaveLength(1); // subject's own line only
    expect(mocha).toContain('import { expect } from "chai";');
  });

  it("a subject import from the framework module never suppresses still-missing names", () => {
    // vitest with globals:false (the default): the linked test imports
    // test/expect from vitest, but the generated body needs describe/it too.
    const out = synthesizeImports("vitest", [
      'import { test, expect } from "vitest";',
      'import { saveCard } from "./card";'
    ]).join("\n");
    expect(out).toContain('import { describe, it, vi } from "vitest";');
  });

  it("type-only subject imports neither satisfy nor filter the framework import", () => {
    // A type-only import binds no runtime value: the full framework import is
    // still needed, and a type-name overlap must not strip the real binding.
    const typeOnly = synthesizeImports("vitest", ['import type { Mock } from "vitest";']).join("\n");
    expect(typeOnly).toContain('import { describe, it, expect, vi } from "vitest";');
    const typeName = synthesizeImports("vitest", ['import type { describe } from "./helpers";']).join("\n");
    expect(typeName).toContain('import { describe, it, expect, vi } from "vitest";');
  });

  it("judge context lists grounded refs as VALIDATED — the judge can never call them invented", async () => {
    const graph = wellGroundedGraph();
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "simple",
      complete: async () => 'it("captures payment", () => { expect(1).toBe(1); });'
    };
    const res = await generateTests(graph, { target_ids: ["REQ-001"], limit: 1 }, provider, () => null, CLOCK);
    expect(res.generated_tests.length).toBeGreaterThan(0);
    const ctx = buildJudgeContext(graph, res.generated_tests);
    // Grounded refs are surfaced as validated-to-exist…
    expect(ctx).toContain("GROUNDED REPO FILES");
    expect(ctx).toContain("never treat these files");
    // …and the global 40-of-N sample no longer invites zeroing absent names
    // (the Mattermost dogfood judge said "ProfilePopover not present in this
    // repo" because profile_popover was outside the first-40 sample).
    expect(ctx).not.toContain("treat names outside this list as possibly invented");
    expect(ctx).toContain("NOT necessarily invented");
  });

  it("a redaction-emptied import-only body is attributed to REDACTION, with disclosure", async () => {
    const SECRET = "const WEIGHTS = proprietaryRebalance(alpha, beta, gamma);";
    const reader = (rel: string): string | null =>
      rel === "src/payments/card.ts" ? `export function rank() {\n  ${SECRET}\n  return 1;\n}\n` : null;
    const topLevelEcho: ModelProvider = {
      providerName: "fake",
      modelName: "echo-top-level",
      complete: async () => ['import { saveCard } from "./card";', SECRET].join("\n")
    };
    const res = await generateTests(
      wellGroundedGraph(),
      { target_ids: ["REQ-001"], limit: 1 },
      topLevelEcho,
      reader,
      CLOCK
    );
    expect(res.generated_tests).toHaveLength(0);
    const joined = res.warnings.join("\n");
    expect(joined).toContain("Redacted 1 echoed source-excerpt line(s)"); // privacy disclosure survives the skip
    expect(joined).toContain("Redaction removed all executable content");
    expect(joined).not.toContain("Model returned an empty completion"); // not token starvation
    expect(res.missing_evidence[0]?.needed).toContain("a completion that does not echo source excerpts");
  });

  it("redaction that leaves ONLY imports emits NO test (import-only is not a test)", async () => {
    const SECRET = "const WEIGHTS = proprietaryRebalance(alpha, beta, gamma);";
    const reader = (rel: string): string | null =>
      rel === "src/payments/card.ts" ? `export function rank() {\n  ${SECRET}\n  return 1;\n}\n` : null;
    const echoInsideOnlyTest: ModelProvider = {
      providerName: "fake",
      modelName: "echo-in-test-body",
      complete: async () =>
        ['import { saveCard } from "./card";', 'it("saves", () => {', `  ${SECRET}`, "});"].join("\n")
    };
    const res = await generateTests(
      wellGroundedGraph(),
      { target_ids: ["REQ-001"], limit: 1 },
      echoInsideOnlyTest,
      reader,
      CLOCK
    );
    expect(res.generated_tests).toHaveLength(0);
    expect(res.missing_evidence.length).toBeGreaterThan(0);
    expect(res.warnings.join("\n")).toContain("Redaction removed all executable content");
  });

  it("a half-redacted multi-line statement is fully removed and the emitted body parses (grounded run)", async () => {
    const SECRET = "const WEIGHTS = proprietaryRebalance(alpha, beta, gamma);";
    const reader = (rel: string): string | null =>
      rel === "src/payments/card.ts" ? `export function rank() {\n  ${SECRET}\n  return 1;\n}\n` : null;
    const echoing: ModelProvider = {
      providerName: "fake",
      modelName: "echo-in-mock",
      complete: async () =>
        [
          'import { vi } from "vitest";',
          'vi.mock("../src/payments/card", () => {',
          `  ${SECRET}`,
          "  return { saveCard: () => 1 };",
          "});",
          "",
          'it("works", () => { expect(1).toBe(1); });'
        ].join("\n")
    };
    const res = await generateTests(wellGroundedGraph(), { target_ids: ["REQ-001"], limit: 1 }, echoing, reader, CLOCK);
    expect(res.generated_tests).toHaveLength(1);
    const body = res.generated_tests[0].body;
    expect(body).not.toContain("proprietaryRebalance");
    expect(body).toContain("statement removed");
    expect(body).not.toMatch(/^\s*\}\)\);?\s*$/m); // no dangling fragment from the mock block
    const sf = ts.createSourceFile("x.tsx", body, ts.ScriptTarget.Latest, false, ts.ScriptKind.TSX);
    expect(sf.statements.length).toBeGreaterThan(0);
  });

  it("does not prepend synthesized imports when the model already wrote its own", async () => {
    const writesImports: ModelProvider = {
      providerName: "fake",
      modelName: "imports-included",
      complete: async () =>
        'import { describe, it, expect } from "vitest";\n\ndescribe("x", () => { it("works", () => { expect(1).toBe(1); }); });'
    };
    const res = await generateTests(wellGroundedGraph(), { target_ids: ["REQ-001"], limit: 1 }, writesImports, () => null, CLOCK);
    const body = res.generated_tests[0].body;
    expect(body).not.toContain("Imports synthesized by OrangePro");
    expect(body).not.toContain("Imports reconstructed by OrangePro");
    expect(body.match(/from "vitest"/g)).toHaveLength(1); // no duplicate declarations
  });

  it("a comments-only completion is never packaged as a test", async () => {
    const commentsOnly: ModelProvider = {
      providerName: "fake",
      modelName: "muser",
      complete: async () => "// I considered several approaches\n// but produced no code"
    };
    const res = await generateTests(wellGroundedGraph(), { target_ids: ["REQ-001"], limit: 1 }, commentsOnly, () => null, CLOCK);
    expect(res.generated_tests).toHaveLength(0);
    expect(res.warnings.join("\n")).toContain("empty completion");
  });

  it("subject imports: internal import survives the cap, quotes are escaped, pytest gets none", () => {
    const dir = mkdtempSync(join(tmpdir(), "opsubj-"));
    try {
      mkdirSync(join(dir, "tests"), { recursive: true });
      const lines: string[] = [];
      for (let i = 0; i < 11; i++) lines.push(`import { dep${i} } from "bare-package-${i}";`);
      lines.push(`import { subject } from "./we'ird-name.js";`); // LAST import, relative, quoted name
      lines.push('it("x", () => { subject(); });');
      writeFileSync(join(dir, "tests", "subj.test.ts"), lines.join("\n"));

      const flow = flowNode("flow:subj", { area: "tests" });
      const testCase = makeNode({
        kind: "TestCase",
        external_id: "test:tests/subj.test.ts",
        title: "subj.test.ts",
        properties: { file: "tests/subj.test.ts", test_layer: "unit", test_names: ["x"] },
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance: provenance("tests/subj.test.ts")
      });
      const graph = makeGraph({
        nodes: [flow, testCase],
        candidate_edges: [
          makeCandidateEdge({
            from_external_id: "flow:subj",
            to_external_id: "test:tests/subj.test.ts",
            relationship_type: "MAY_BE_TESTED_BY",
            evidence_strength: "weak",
            reason: "anchor",
            confidence: 0.35
          })
        ]
      });
      graph.workspace.root = dir;

      const jest = gatherContext(graph, flow, "jest", () => null);
      expect(jest.ctx.subject_imports.length).toBeLessThanOrEqual(10);
      // The relative SUBJECT import is sorted first, inside the cap, with the
      // quoted specifier safely JSON-escaped (double quotes).
      expect(jest.ctx.subject_imports[0]).toBe('import {subject} from "./we\'ird-name.js";');

      const pytest = gatherContext(graph, flow, "pytest", () => null);
      expect(pytest.ctx.subject_imports).toEqual([]); // TS imports never feed a python target
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an example-behaviors-only anchor still generates (not 'too thin')", async () => {
    const flow = flowNode("flow:bare", { example_behaviors: ["sorts results by status"] });
    const graph = makeGraph({ nodes: [flow] });
    // Default limit: name-only evidence justifies the REGRESSION bucket (observed
    // test names), not happy-path — same behavior as before the prompt-v1 move.
    const res = await generateTests(graph, { target_ids: ["flow:bare"] }, new DeterministicProvider(), () => null, CLOCK);
    expect(res.generated_tests.length).toBeGreaterThanOrEqual(1);
    expect(res.generated_tests[0].bucket).toBeDefined(); // evidence-justified bucket, never padding
    expect(res.missing_evidence).toHaveLength(0);
  });

  it("deterministic provider: existing-test names never bleed into acceptance criteria", async () => {
    const ctx: GenerationContext = {
      behavior_external_id: "flow:bleed",
      behavior_title: "Bleed check",
      actors: [],
      acceptance_criteria: ["returns 42 for valid input"],
      workflow_steps: [],
      framework: "vitest",
      test_layer: "unit",
      code_context: [],
      source_excerpts: [],
      weak_context: [],
      existing_tests: ["legacy scenario that already exists"],
      subject_imports: []
    };
    const user = buildGroundedUserPrompt(ctx, "happy_path");
    const body = await new DeterministicProvider().complete({ system: "", user });
    expect(body).toContain("returns 42 for valid input");
    expect(body).not.toContain("legacy scenario that already exists");
  });
});

describe("generateTests — v5 planning JSON hardening", () => {
  // Reusable python target: a symbol + its file + an in-process source reader,
  // matching the existing v5 fixtures so repaired scenarios yield runnable tests.
  function v5Fixture() {
    const symbol = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/orders.py#create_order",
      title: "create_order",
      properties: { file: "src/orders.py", symbol_kind: "function" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/orders.py"),
      behavior_source: "code_export",
      denominator_eligible: true,
      denominator_reason: "Testable code behavior."
    });
    const file = makeNode({
      kind: "File",
      external_id: "src/orders.py",
      title: "orders.py",
      properties: { role: "code", language: "python", file: "src/orders.py" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: provenance("src/orders.py")
    });
    const reader = (rel: string): string | null =>
      rel === "src/orders.py" ? "def create_order(payload):\n    return {'id': 'o_1'}\n" : null;
    return { graph: makeGraph({ nodes: [symbol, file] }), symbol, reader };
  }

  const VALID_PLAN = JSON.stringify([
    {
      id: 1,
      title: "rejects empty input",
      concern: "boundary_limits",
      technique: "boundary_value_analysis",
      rationale: "empty input",
      assertion_targets: ["rejects empty input"],
      complexity: "basic",
      risk_rank: 1
    }
  ]);
  const BATCH_BODY = ["// ═══ SCENARIO 1 ═══", "def test_create_order_rejects_empty_input():", "    assert True"].join("\n");

  const isPlanning = (req: ModelCompletionRequest) => req.system.includes("test gap identification");
  const isRepair = (req: ModelCompletionRequest) => req.system.includes("JSON repair engine");

  it("asks v5 planning and repair for deterministic JSON output", async () => {
    const requests: ModelCompletionRequest[] = [];
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "v5-prefill",
      complete: async (req) => {
        requests.push(req);
        if (isPlanning(req)) return VALID_PLAN;
        return BATCH_BODY;
      }
    };
    const { graph, symbol, reader } = v5Fixture();
    const result = await generateTests(
      graph,
      { target_ids: [symbol.external_id], limit: 1, prompt_version: "v5" },
      provider,
      reader,
      CLOCK
    );
    expect(result.generated_tests).toHaveLength(1);
    const planning = requests.find(isPlanning);
    expect(planning?.temperature).toBe(0);
    expect(planning?.maxTokens).toBeGreaterThanOrEqual(1600);
  });

  it("(c) repairs malformed planning JSON with ONE repair call, then generates", async () => {
    const calls: string[] = [];
    const requests: ModelCompletionRequest[] = [];
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "v5-repair",
      complete: async (req) => {
        requests.push(req);
        if (isPlanning(req)) {
          calls.push("plan");
          return '[{"id":1,"title":"rejects empty input","concern":"boundary_limits",'; // malformed but recoverable ARRAY (schema keys + tied-back content) → repair
        }
        if (isRepair(req)) {
          calls.push("repair");
          return VALID_PLAN;
        }
        calls.push("batch");
        return BATCH_BODY;
      }
    };
    const { graph, symbol, reader } = v5Fixture();
    const result = await generateTests(
      graph,
      { target_ids: [symbol.external_id], limit: 1, prompt_version: "v5" },
      provider,
      reader,
      CLOCK
    );
    expect(calls.filter((c) => c === "repair")).toHaveLength(1); // exactly ONE repair call
    const repair = requests.find(isRepair);
    expect(repair?.temperature).toBe(0);
    expect(repair?.maxTokens).toBeGreaterThanOrEqual(1600);
    expect(result.generated_tests).toHaveLength(1);
    expect(result.warnings.some((w) => /was malformed .* repair call recovered 1/.test(w))).toBe(true);
  });

  it("(d) fails closed with NO tests and a visible warning when repair also fails", async () => {
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "v5-repair-fail",
      complete: async (req) => {
        if (isPlanning(req)) return '[{"id":1,"title":"needs setup","concern":broken'; // recoverable array → repair runs, then also fails
        if (isRepair(req)) return "also not json }}}"; // repair fails too → fail closed
        return BATCH_BODY;
      }
    };
    const { graph, symbol, reader } = v5Fixture();
    const result = await generateTests(
      graph,
      { target_ids: [symbol.external_id], limit: 1, prompt_version: "v5" },
      provider,
      reader,
      CLOCK
    );
    expect(result.generated_tests).toHaveLength(0);
    expect(result.run).toBeNull();
    expect(result.warnings.some((w) => /malformed JSON and repair failed/.test(w) && /no test emitted/.test(w))).toBe(true);
    expect(result.missing_evidence.some((m) => /could not be repaired/.test(m.reason))).toBe(true);
  });

  it("(f) never persists the raw malformed output in the run, tests, or warnings", async () => {
    const SENTINEL = "__RAW_MALFORMED_BLOB_9F3A__";
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "v5-no-persist",
      complete: async (req) => {
        if (isPlanning(req)) return `[{"id":1,"title":"rejects empty input","x":"${SENTINEL}",`; // malformed array carrying the sentinel; content ties back to VALID_PLAN
        if (isRepair(req)) return VALID_PLAN;
        return BATCH_BODY;
      }
    };
    const { graph, symbol, reader } = v5Fixture();
    const result = await generateTests(
      graph,
      { target_ids: [symbol.external_id], limit: 1, prompt_version: "v5" },
      provider,
      reader,
      CLOCK
    );
    expect(result.generated_tests).toHaveLength(1);
    // The malformed blob is transient repair input only — it must appear nowhere in
    // the persistable run/tests, nor in the returned warnings/missing evidence.
    expect(JSON.stringify(result)).not.toContain(SENTINEL);
  });

  it("(g) total garbage with NO recoverable array → fails closed WITHOUT a repair call (no invented plan)", async () => {
    const calls: string[] = [];
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "v5-garbage",
      complete: async (req) => {
        if (isPlanning(req)) { calls.push("plan"); return "I could not find any test gaps in this behavior, sorry."; } // prose, NO array
        if (isRepair(req)) { calls.push("repair"); return VALID_PLAN; }
        return BATCH_BODY;
      }
    };
    const { graph, symbol, reader } = v5Fixture();
    const result = await generateTests(
      graph,
      { target_ids: [symbol.external_id], limit: 1, prompt_version: "v5" },
      provider,
      reader,
      CLOCK
    );
    expect(calls.filter((c) => c === "repair")).toHaveLength(0); // pre-gated: no repair call on garbage
    expect(result.generated_tests).toHaveLength(0); // fail closed
    expect(result.warnings.some((w) => /no recoverable scenario array/.test(w))).toBe(true);
  });

  it("(h) repair that INVENTS a scenario not in the original → dropped, fails closed (never generate an invented plan)", async () => {
    const provider: ModelProvider = {
      providerName: "fake",
      modelName: "v5-invent",
      complete: async (req) => {
        // Recoverable array present (pre-gate passes), but the repair returns a schema-valid scenario
        // whose content never appeared in the original malformed output → not tied back → dropped.
        if (isPlanning(req)) return '[{"id":1,"title":"validates order id",broken';
        if (isRepair(req)) {
          return JSON.stringify([
            { id: 1, title: "quantum teleportation edge case", concern: "contract", technique: "boundary_value_analysis", rationale: "x", assertion_targets: ["nonexistent zzzqqq target"], complexity: "basic", risk_rank: 1 }
          ]);
        }
        return BATCH_BODY;
      }
    };
    const { graph, symbol, reader } = v5Fixture();
    const result = await generateTests(
      graph,
      { target_ids: [symbol.external_id], limit: 1, prompt_version: "v5" },
      provider,
      reader,
      CLOCK
    );
    expect(result.generated_tests).toHaveLength(0); // invented scenario dropped → fail closed
    expect(result.warnings.some((w) => /no scenario tied to the original/.test(w))).toBe(true);
  });
});
