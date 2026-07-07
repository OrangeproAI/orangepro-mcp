import { describe, expect, it } from "vitest";

import { enumerateFlows } from "../../src/local/flows/flowWalker.js";
import { makeCandidateEdge, makeEdge, makeNode } from "../../src/local/graph/factories.js";
import type { CandidateEdge, GraphEdge, GraphNode } from "../../src/local/graph/ontology.js";

const provenance = { source_scope_id: "repo", source_ref: "src/app.ts", detector: "test" };

function symbol(id: string, eligible = false): GraphNode {
  return makeNode({
    kind: "CodeSymbol",
    external_id: id,
    title: id.split("#").pop() ?? id,
    properties: { file: `${id}.ts` },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance,
    denominator_eligible: eligible,
    denominator_reason: eligible ? "test behavior" : "support symbol"
  });
}

function endpoint(id: string): GraphNode {
  return makeNode({
    kind: "Endpoint",
    external_id: id,
    title: id,
    properties: { method: "GET", path: "/orders" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance,
    behavior_source: "contract_entrypoint",
    denominator_eligible: false,
    denominator_reason: "metadata-only endpoint"
  });
}

function call(from: string, to: string, strength: "hard" | "framework-derived" = "hard", resolution = "direct"): GraphEdge {
  return makeEdge({
    from_external_id: from,
    to_external_id: to,
    relationship_type: "CALLS",
    evidence_strength: strength,
    review_status: "auto_detected",
    confidence: 1,
    provenance,
    properties: { resolution }
  });
}

function implementedIn(from: string, to: string): GraphEdge {
  return makeEdge({
    from_external_id: from,
    to_external_id: to,
    relationship_type: "IMPLEMENTED_IN",
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance
  });
}

function graph(nodes: GraphNode[], edges: GraphEdge[] = [], candidate_edges: CandidateEdge[] = []) {
  return { nodes, edges, candidate_edges };
}

describe("enumerateFlows", () => {
  it("enumerates a linear behavior chain", () => {
    const result = enumerateFlows(graph([symbol("A", true), symbol("B"), symbol("C")], [call("A", "B"), call("B", "C")]));
    expect(result.total_flows).toBe(1);
    expect(result.flows[0]).toMatchObject({
      entry_point: { external_id: "A", kind: "Behavior" },
      terminal: "C",
      depth: 2,
      flow_tier: "hard: reachable"
    });
    expect(result.flows[0].hops.map((h) => [h.from, h.to])).toEqual([
      ["A", "B"],
      ["B", "C"]
    ]);
  });

  it("enumerates branches from the same behavior entry", () => {
    const result = enumerateFlows(graph([symbol("A", true), symbol("B"), symbol("C")], [call("A", "B"), call("A", "C")]));
    expect(result.total_flows).toBe(2);
    expect(result.flows.map((f) => f.terminal).sort()).toEqual(["B", "C"]);
  });

  it("terminates cycles without repeating nodes", () => {
    const result = enumerateFlows(graph([symbol("A", true), symbol("B")], [call("A", "B"), call("B", "A")]));
    expect(result.total_flows).toBe(1);
    expect(result.flows[0]).toMatchObject({ terminal: "B", depth: 1 });
  });

  it("downgrades the whole flow when any hop is framework-derived", () => {
    const result = enumerateFlows(
      graph([symbol("A", true), symbol("B"), symbol("Generated")], [call("A", "B"), call("B", "Generated", "framework-derived")])
    );
    expect(result.total_flows).toBe(1);
    expect(result.flows[0].flow_tier).toBe("framework-derived: reachable");
    expect(result.by_tier["framework-derived: reachable"]).toBe(1);
  });

  it("records max-depth truncation", () => {
    const result = enumerateFlows(graph([symbol("A", true), symbol("B"), symbol("C")], [call("A", "B"), call("B", "C")]), {
      maxDepth: 1
    });
    expect(result.total_flows).toBe(1);
    expect(result.flows[0]).toMatchObject({ terminal: "B", depth: 1, truncated: true });
    expect(result.dropped.max_depth).toBe(1);
  });

  it("records per-entry cap drops", () => {
    const result = enumerateFlows(
      graph([symbol("A", true), symbol("B"), symbol("C"), symbol("D")], [call("A", "B"), call("A", "C"), call("A", "D")]),
      { maxFlowsPerEntry: 2 }
    );
    expect(result.total_flows).toBe(2);
    expect(result.dropped.max_flows_per_entry).toBeGreaterThan(0);
  });

  it("records global-cap drops", () => {
    const result = enumerateFlows(graph([symbol("A", true), symbol("B"), symbol("X", true), symbol("Y")], [call("A", "B"), call("X", "Y")]), {
      globalCap: 1
    });
    expect(result.total_flows).toBe(1);
    expect(result.dropped.global_cap).toBeGreaterThan(0);
  });

  it("starts endpoint flows through IMPLEMENTED_IN handler edges", () => {
    const result = enumerateFlows(graph([endpoint("endpoint:get-orders"), symbol("Handler"), symbol("Service")], [
      implementedIn("endpoint:get-orders", "Handler"),
      call("Handler", "Service")
    ]));
    expect(result.total_flows).toBe(1);
    expect(result.flows[0]).toMatchObject({
      entry_point: { external_id: "endpoint:get-orders", kind: "Endpoint" },
      terminal: "Service"
    });
  });

  it("starts denominator-eligible behavior anchors without endpoint nodes", () => {
    const result = enumerateFlows(graph([symbol("Service.method", true), symbol("Repo.find")], [call("Service.method", "Repo.find")]));
    expect(result.total_flows).toBe(1);
    expect(result.flows[0].entry_point.kind).toBe("Behavior");
  });

  it("does not duplicate endpoint handlers as behavior entries", () => {
    const result = enumerateFlows(
      graph([endpoint("endpoint:post-orders"), symbol("Controller.create", true), symbol("Service.create")], [
        implementedIn("endpoint:post-orders", "Controller.create"),
        call("Controller.create", "Service.create")
      ])
    );
    expect(result.total_flows).toBe(1);
    expect(result.flows[0].entry_point).toMatchObject({ external_id: "endpoint:post-orders", kind: "Endpoint" });
  });

  it("uses first-hop behavior anchors instead of called eligible internals", () => {
    const result = enumerateFlows(
      graph([symbol("Service.create", true), symbol("Repo.save", true), symbol("Db.insert")], [
        call("Service.create", "Repo.save"),
        call("Repo.save", "Db.insert")
      ])
    );
    expect(result.total_flows).toBe(1);
    expect(result.flows[0].entry_point.external_id).toBe("Service.create");
    expect(result.flows[0].terminal).toBe("Db.insert");
  });

  it("prioritizes high-risk endpoint entries before caps are applied", () => {
    const result = enumerateFlows(
      graph(
        [
          endpoint("endpoint:get-health"),
          endpoint("endpoint:post-payments-refund"),
          symbol("HealthController.get"),
          symbol("PaymentController.refund"),
          symbol("HealthService.get"),
          symbol("PaymentService.refund")
        ],
        [
          implementedIn("endpoint:get-health", "HealthController.get"),
          implementedIn("endpoint:post-payments-refund", "PaymentController.refund"),
          call("HealthController.get", "HealthService.get"),
          call("PaymentController.refund", "PaymentService.refund")
        ]
      ),
      { globalCap: 1 }
    );
    expect(result.total_flows).toBe(1);
    expect(result.flows[0].entry_point.external_id).toBe("endpoint:post-payments-refund");
  });

  it("ignores non-CALLS edges and candidate call hints", () => {
    const imports = makeEdge({
      from_external_id: "A",
      to_external_id: "B",
      relationship_type: "IMPORTS",
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance
    });
    const mayCall = makeCandidateEdge({
      from_external_id: "A",
      to_external_id: "C",
      relationship_type: "MAY_CALL",
      evidence_strength: "candidate",
      reason: "candidate only",
      confidence: 0.8,
      provenance
    });
    const result = enumerateFlows(graph([symbol("A", true), symbol("B"), symbol("C")], [imports], [mayCall]));
    expect(result.total_flows).toBe(0);
  });

  it("does not mutate proof, denominator, or edge inputs", () => {
    const nodes = [symbol("A", true), symbol("B")];
    const edges = [
      call("A", "B"),
      makeEdge({
        from_external_id: "A",
        to_external_id: "test:a.test.ts",
        relationship_type: "TESTED_BY",
        evidence_strength: "hard",
        review_status: "auto_detected",
        confidence: 1,
        provenance
      })
    ];
    const before = JSON.stringify({ nodes, edges });

    const result = enumerateFlows(graph(nodes, edges));

    expect(JSON.stringify({ nodes, edges })).toBe(before);
    expect(result.flows.flatMap((f) => f.hops).some((h) => h.to === "test:a.test.ts")).toBe(false);
    expect(edges.filter((e) => e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS")).toHaveLength(1);
    expect(nodes.filter((n) => n.denominator_eligible === true).map((n) => n.external_id)).toEqual(["A"]);
  });
});
