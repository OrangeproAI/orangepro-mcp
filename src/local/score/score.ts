import { DenominatorComposition, GraphNode, LocalGraph } from "../graph/ontology.js";
import { denominatorBehaviors, denominatorComposition, nodesByKind } from "../graph/factories.js";
import { ScoreBand, ScoreBreakdown, ScoreResult } from "../types.js";

/**
 * Graph readiness score. This is a *readiness* signal, not a proof of test-lift.
 *
 * Internal scoring weights and the exact formula live here and are NEVER
 * exported in the pack. Only the 0..1 per-dimension breakdown, the overall
 * 0..100 score, the band, and plain-language missing-evidence are exposed.
 */
const WEIGHTS: ScoreBreakdown = {
  behavior_anchors: 0.22,
  acceptance_criteria: 0.2,
  provenance: 0.15,
  interface_mapping: 0.15,
  validation_evidence: 0.18,
  known_regressions: 0.1
};

const saturate = (count: number, target: number): number => Math.max(0, Math.min(1, count / target));

function bandFor(overall: number): ScoreBand {
  if (overall >= 75) return "strong";
  if (overall >= 60) return "good";
  if (overall >= 40) return "usable";
  return "thin";
}

interface EvidenceIndex {
  hardTested: Set<string>;
  weakTested: Set<string>;
  testLinkedFiles: Set<string>;
  acOwners: Set<string>;
}

/**
 * ONE O(edges) pass instead of O(behaviors × edges): the denominator can be
 * tens of thousands of code exports (Mattermost: ~20k eligible over ~25k
 * edges), and per-behavior linear scans made `opro score` multi-second.
 */
function buildEvidenceIndex(graph: LocalGraph): EvidenceIndex {
  const hardTested = new Set<string>();
  const acOwners = new Set<string>();
  for (const e of graph.edges) {
    if (e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS") {
      hardTested.add(e.from_external_id);
      hardTested.add(e.to_external_id);
    } else if (e.relationship_type === "HAS_ACCEPTANCE_CRITERION") {
      acOwners.add(e.from_external_id);
    }
  }
  const weakTested = new Set<string>();
  const testLinkedFiles = new Set<string>();
  for (const e of graph.candidate_edges) {
    if (e.relationship_type === "MAY_BE_TESTED_BY" || e.relationship_type === "MAY_COVER") {
      weakTested.add(e.from_external_id);
      weakTested.add(e.to_external_id);
    } else if (e.relationship_type === "MAY_RELATE_TO") {
      testLinkedFiles.add(e.from_external_id);
      testLinkedFiles.add(e.to_external_id);
    }
  }
  return { hardTested, weakTested, testLinkedFiles, acOwners };
}

/**
 * Test evidence for one behavior. Code exports get honest WEAK credit when a
 * test resolved-imports their file (the Phase-2 MAY_RELATE_TO links) —
 * symbol-level confirmation is Phase 4's job; without this interim credit,
 * code-derived behaviors would be structurally uncoverable and a well-tested
 * code-only repo would score "thin" no matter what.
 */
function evidenceFor(b: GraphNode, idx: EvidenceIndex): "hard" | "weak" | "none" {
  if (idx.hardTested.has(b.external_id)) return "hard";
  if (idx.weakTested.has(b.external_id)) return "weak";
  if (b.behavior_source === "code_export") {
    const file = typeof b.properties.file === "string" ? b.properties.file : "";
    if (file && idx.testLinkedFiles.has(file)) return "weak";
  }
  return "none";
}

export function scoreGraph(graph: LocalGraph): ScoreResult {
  // Gate 3: the denominator is the SOLE basis for behavior counting here.
  // Test-inferred flows are inventoried in the composition but contribute 0.
  const behaviors = denominatorBehaviors(graph);
  const denominator = denominatorComposition(graph);
  const totalBehaviors = behaviors.length;
  const strongBehaviors = behaviors.filter((b) => b.evidence_strength === "hard" || b.evidence_strength === "reviewed");
  const weakBehaviors = behaviors.filter((b) => b.evidence_strength === "candidate" || b.evidence_strength === "weak");
  const idx = buildEvidenceIndex(graph);
  const explicitRequirements = denominator.requirement_template + denominator.markdown_requirement;

  // behavior_anchors — code exports are "hard" evidence by construction, so a
  // bare repo with six exported functions must NOT peg this at 1.0. The cap
  // SCALES with explicit requirements rather than vanishing at the first one:
  // two incidental markdown headings on a 1,400-export repo flipped this from
  // 0.5-capped to a perfect score in live dogfooding (knife-edge).
  let behaviorScore = saturate(strongBehaviors.length + weakBehaviors.length * 0.4, 6);
  behaviorScore = Math.min(behaviorScore, 0.5 + 0.5 * saturate(explicitRequirements, 8));

  // acceptance_criteria — ACs attach to REQUIREMENTS. Judging code exports for
  // lacking ACs would zero this dim on any sizeable codebase; symbol-level
  // coverage semantics arrive in Phase 4.
  const acNodes = nodesByKind(graph, "AcceptanceCriterion").length;
  const requirementBehaviors = behaviors.filter(
    (b) => b.behavior_source === "requirement_template" || b.behavior_source === "markdown_requirement"
  );
  const behaviorsWithAc = requirementBehaviors.filter((b) => idx.acOwners.has(b.external_id)).length;
  const acScore =
    requirementBehaviors.length === 0
      ? saturate(acNodes, 4) * 0.5
      : 0.7 * (behaviorsWithAc / requirementBehaviors.length) + 0.3 * saturate(acNodes, 4);

  // provenance
  const totalNodes = graph.nodes.length || 1;
  const nodesWithRef = graph.nodes.filter((n) => Boolean(n.provenance?.source_ref)).length;
  const provenanceScore = nodesWithRef / totalNodes;

  // interface_mapping
  const services = nodesByKind(graph, "Service");
  const endpoints = nodesByKind(graph, "Endpoint");
  const strongIface = [...services, ...endpoints].filter(
    (n) => n.evidence_strength === "hard" || n.evidence_strength === "reviewed"
  ).length;
  const weakIface = [...services, ...endpoints].filter(
    (n) => n.evidence_strength === "candidate" || n.evidence_strength === "weak"
  ).length;
  const ifaceEdges = graph.candidate_edges.filter((e) => e.relationship_type === "MAY_REQUIRE_INTERFACE").length;
  const interfaceScore = saturate(strongIface + weakIface * 0.4 + ifaceEdges * 0.5, 5);

  // validation_evidence
  const testCaseCount = nodesByKind(graph, "TestCase").length;
  const coveredBehaviors = behaviors.reduce((acc, b) => {
    const ev = evidenceFor(b, idx);
    return acc + (ev === "hard" ? 1 : ev === "weak" ? 0.5 : 0);
  }, 0);
  const coverageFrac = totalBehaviors === 0 ? 0 : coveredBehaviors / totalBehaviors;
  const validationScore = 0.6 * coverageFrac + 0.4 * saturate(testCaseCount, 8);

  // known_regressions
  const incidents = nodesByKind(graph, "Incident").length;
  const regressionScore = saturate(incidents, 3);

  const breakdown: ScoreBreakdown = {
    behavior_anchors: round2(behaviorScore),
    acceptance_criteria: round2(acScore),
    provenance: round2(provenanceScore),
    interface_mapping: round2(interfaceScore),
    validation_evidence: round2(validationScore),
    known_regressions: round2(regressionScore)
  };

  const overall = Math.round(
    100 *
      (WEIGHTS.behavior_anchors * breakdown.behavior_anchors +
        WEIGHTS.acceptance_criteria * breakdown.acceptance_criteria +
        WEIGHTS.provenance * breakdown.provenance +
        WEIGHTS.interface_mapping * breakdown.interface_mapping +
        WEIGHTS.validation_evidence * breakdown.validation_evidence +
        WEIGHTS.known_regressions * breakdown.known_regressions)
  );

  const missing_evidence = missingEvidence(breakdown, denominator);
  // A capped extraction means the denominator UNDERSTATES the repo's behavior
  // surface — coverage % over a truncated denominator must say so.
  if (graph.analysis?.symbol_cap_hit) {
    missing_evidence.push(
      "We hit the limit and only counted part of your code, so coverage looks lower than it really is. Raise ORANGEPRO_MAX_SYMBOLS and re-run `opro analyze .`."
    );
  }
  if (graph.analysis && graph.analysis.flows_truncated > 0) {
    missing_evidence.push(
      `${graph.analysis.flows_truncated} test file(s) exceeded the inferred-behavior cap (${graph.analysis.max_inferred_flows}) and are not counted; raise ORANGEPRO_MAX_FLOWS to include them.`
    );
  }
  return { overall, band: bandFor(overall), breakdown, missing_evidence, denominator };
}

function missingEvidence(b: ScoreBreakdown, denominator: DenominatorComposition): string[] {
  const out: string[] = [];
  if (denominator.total === 0) {
    out.push(
      denominator.excluded_test_inferred > 0
        ? `Nothing to measure coverage against: we found ${denominator.excluded_test_inferred} behavior(s) guessed from test names, but those don't count (a test can't prove its own requirement). Add a requirements list (CSV/markdown) or analyze code that has functions/classes.`
        : "Nothing to measure coverage against: no countable behaviors found. Add a requirements list (CSV/markdown) or analyze code that has functions/classes."
    );
  }
  // Keyed on the COMPOSITION, not evidence strength: code exports are "hard"
  // by construction and used to permanently suppress this nudge on the exact
  // repos it was written for (code-only, zero requirements).
  const explicit = denominator.requirement_template + denominator.markdown_requirement;
  if (denominator.total > 0 && explicit === 0) {
    out.push("Add a few written requirements (we only found code and test names so far) — a short CSV/markdown list, or acceptance criteria.");
  } else if (explicit > 0 && explicit < 5 && denominator.code_export >= explicit * 20) {
    out.push(
      `Only ${explicit} written requirement(s) for ${denominator.total} behaviors — add a requirements list so coverage reflects what the app should do, not just how much code exists.`
    );
  }
  if (b.acceptance_criteria < 0.5) out.push("Add acceptance criteria so behaviors can be tested with concrete checks.");
  if (b.interface_mapping < 0.4) out.push("Add API/screen/service mapping (OpenAPI or route docs) for more specific tests.");
  if (b.validation_evidence < 0.4) out.push("Link existing tests or add manual QA steps so we can tell what's already covered.");
  if (b.known_regressions < 0.2) out.push("Add known bugs/incidents to enable targeted regression tests.");
  if (b.provenance < 0.6) out.push("Add source links so each behavior can be traced back to real code.");
  return out;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
