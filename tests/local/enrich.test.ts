import { describe, it, expect } from "vitest";
import { enrichFromCsv } from "../../src/local/enrich/csv.js";
import { enrichFromMarkdown } from "../../src/local/enrich/markdown.js";
import { enrichFromContent } from "../../src/local/enrich/index.js";
import type { GraphNode, GraphEdge } from "../../src/local/graph/ontology.js";

const CSV_HEADER =
  "behavior_name,description,acceptance_criteria,actor_or_role,priority_or_risk,source_ref";

function nodesOfKind(nodes: GraphNode[], kind: string): GraphNode[] {
  return nodes.filter((n) => n.kind === kind);
}

function edgesOfType(edges: GraphEdge[], type: string): GraphEdge[] {
  return edges.filter((e) => e.relationship_type === type);
}

describe("enrichFromCsv", () => {
  const csv = [
    CSV_HEADER,
    'Login with email,"User logs in with email and password","Valid creds succeed; Invalid creds rejected; Locked account blocked",Customer,High,JIRA-101',
    'Reset password,"User resets a forgotten password","Reset link emailed; Link expires after 24h",Admin,critical,JIRA-202'
  ].join("\n");

  const fragment = enrichFromCsv("docs/template.csv", csv);

  it("produces a manual_template SourceScope", () => {
    expect(fragment.sources).toHaveLength(1);
    const source = fragment.sources[0];
    expect(source.source_system).toBe("manual_template");
    expect(source.source_type).toBe("customer_supplied");
    expect(source.display_name).toBe("docs/template.csv");
  });

  it("creates hard, locally-reviewed Requirement nodes (one per row)", () => {
    const requirements = nodesOfKind(fragment.nodes, "Requirement");
    expect(requirements).toHaveLength(2);
    for (const req of requirements) {
      expect(req.evidence_strength).toBe("hard");
      expect(req.review_status).toBe("local_reviewed");
    }
    const titles = requirements.map((r) => r.title);
    expect(titles).toContain("Login with email");
    expect(titles).toContain("Reset password");
  });

  it("carries priority + actors onto requirement properties", () => {
    const login = nodesOfKind(fragment.nodes, "Requirement").find(
      (r) => r.title === "Login with email"
    );
    expect(login).toBeDefined();
    expect(login!.properties.priority).toBe("High");
    expect(login!.properties.actors).toEqual(["Customer"]);

    const reset = nodesOfKind(fragment.nodes, "Requirement").find(
      (r) => r.title === "Reset password"
    );
    expect(reset!.properties.priority).toBe("critical");
    expect(reset!.properties.actors).toEqual(["Admin"]);
  });

  it("splits ';'-separated acceptance_criteria into AcceptanceCriterion nodes", () => {
    const acs = nodesOfKind(fragment.nodes, "AcceptanceCriterion");
    // Row 1 has 3 AC items, row 2 has 2 -> 5 total.
    expect(acs).toHaveLength(5);
    for (const ac of acs) {
      expect(ac.evidence_strength).toBe("hard");
      expect(ac.review_status).toBe("local_reviewed");
    }
    const acTitles = acs.map((a) => a.title);
    expect(acTitles).toContain("Valid creds succeed");
    expect(acTitles).toContain("Invalid creds rejected");
    expect(acTitles).toContain("Locked account blocked");
    expect(acTitles).toContain("Reset link emailed");
    expect(acTitles).toContain("Link expires after 24h");
  });

  it("links requirements to acceptance criteria via hard HAS_ACCEPTANCE_CRITERION edges", () => {
    const hasAc = edgesOfType(fragment.edges, "HAS_ACCEPTANCE_CRITERION");
    expect(hasAc).toHaveLength(5);
    for (const edge of hasAc) {
      expect(edge.evidence_strength).toBe("hard");
      expect(edge.review_status).toBe("local_reviewed");
    }

    // Each edge must connect an existing Requirement to an existing AcceptanceCriterion.
    const reqIds = new Set(
      nodesOfKind(fragment.nodes, "Requirement").map((n) => n.external_id)
    );
    const acIds = new Set(
      nodesOfKind(fragment.nodes, "AcceptanceCriterion").map((n) => n.external_id)
    );
    for (const edge of hasAc) {
      expect(reqIds.has(edge.from_external_id)).toBe(true);
      expect(acIds.has(edge.to_external_id)).toBe(true);
    }
  });
});

describe("enrichFromMarkdown", () => {
  const md = [
    "# Project Docs",
    "",
    "## Feature: Checkout flow",
    "",
    "The user should be able to complete a purchase.",
    "",
    "## Acceptance Criteria",
    "",
    "- Cart total is correct",
    "- Payment is charged once",
    "- Receipt is emailed",
    ""
  ].join("\n");

  const fragment = enrichFromMarkdown("docs/spec.md", md);

  it("produces a markdown_docs SourceScope", () => {
    expect(fragment.sources).toHaveLength(1);
    expect(fragment.sources[0].source_system).toBe("markdown_docs");
  });

  it("creates candidate/inferred Requirement nodes from requirement-like headings", () => {
    const requirements = nodesOfKind(fragment.nodes, "Requirement");
    expect(requirements.length).toBeGreaterThanOrEqual(1);
    const checkout = requirements.find((r) =>
      String(r.title).includes("Checkout flow")
    );
    expect(checkout).toBeDefined();
    expect(checkout!.evidence_strength).toBe("candidate");
    expect(checkout!.review_status).toBe("inferred");
  });

  it("creates AcceptanceCriterion nodes from bullets under the AC section", () => {
    const acs = nodesOfKind(fragment.nodes, "AcceptanceCriterion");
    expect(acs).toHaveLength(3);
    const acTitles = acs.map((a) => a.title);
    expect(acTitles).toContain("Cart total is correct");
    expect(acTitles).toContain("Payment is charged once");
    expect(acTitles).toContain("Receipt is emailed");
  });

  it("links the requirement to its acceptance criteria via HAS_ACCEPTANCE_CRITERION", () => {
    const hasAc = edgesOfType(fragment.edges, "HAS_ACCEPTANCE_CRITERION");
    expect(hasAc).toHaveLength(3);

    const checkout = nodesOfKind(fragment.nodes, "Requirement").find((r) =>
      String(r.title).includes("Checkout flow")
    );
    const acIds = new Set(
      nodesOfKind(fragment.nodes, "AcceptanceCriterion").map((n) => n.external_id)
    );
    for (const edge of hasAc) {
      expect(edge.from_external_id).toBe(checkout!.external_id);
      expect(acIds.has(edge.to_external_id)).toBe(true);
    }
  });
});

describe("enrichFromContent dispatch", () => {
  const csv = [
    CSV_HEADER,
    "Sign up,Create an account,Email confirmed; Profile created,Visitor,Medium,REQ-1"
  ].join("\n");

  const md = ["## Feature: Logout", "", "## Acceptance Criteria", "", "- Session is cleared"].join(
    "\n"
  );

  it("routes '.csv' to the CSV enricher", () => {
    const fragment = enrichFromContent("a/behaviors.csv", csv);
    expect(fragment).not.toBeNull();
    expect(fragment!.sources[0].source_system).toBe("manual_template");
    expect(nodesOfKind(fragment!.nodes, "Requirement")).toHaveLength(1);
  });

  it("routes '.md' to the Markdown enricher", () => {
    const fragment = enrichFromContent("a/spec.md", md);
    expect(fragment).not.toBeNull();
    expect(fragment!.sources[0].source_system).toBe("markdown_docs");
  });

  it("returns null for unsupported extensions like '.png'", () => {
    expect(enrichFromContent("a/diagram.png", "binary-ish")).toBeNull();
  });
});
