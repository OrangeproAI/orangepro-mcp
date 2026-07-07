import { LocalGraph } from "../graph/ontology.js";
import { nodesByKind } from "../graph/factories.js";
import { DoctorRecommendation, DoctorResult, ScoreResult } from "../types.js";

/**
 * Recommend the smallest next source that would most improve generated-test
 * quality. Recommendations are ranked by expected impact; the ranking heuristic
 * itself is internal, only the human-facing actions are returned.
 */
export function doctorGraph(graph: LocalGraph, score: ScoreResult): DoctorResult {
  const b = score.breakdown;
  const candidates: Array<DoctorRecommendation & { gain: number }> = [];

  if (b.acceptance_criteria < 0.6) {
    candidates.push({
      priority: 0,
      action: "Add acceptance criteria or a small requirements template (CSV/Markdown).",
      why: "The graph has code/test context but weak business intent, so tests cannot assert expected outcomes.",
      expected_score_impact: "+10 to +20",
      gain: (0.6 - b.acceptance_criteria) * 20
    });
  }
  if (b.interface_mapping < 0.5) {
    candidates.push({
      priority: 0,
      action: "Add an OpenAPI spec or route/screen docs.",
      why: "Endpoint/screen mapping makes API and UI tests target real interfaces instead of guesses.",
      expected_score_impact: "+5 to +12",
      gain: (0.5 - b.interface_mapping) * 15
    });
  }
  if (b.known_regressions < 0.3) {
    candidates.push({
      priority: 0,
      action: "List known bugs or past incidents (even a short Markdown list).",
      why: "Known regressions let generation produce durable regression tests, not just happy-path checks.",
      expected_score_impact: "+4 to +10",
      gain: (0.3 - b.known_regressions) * 10
    });
  }
  if (b.validation_evidence < 0.5) {
    candidates.push({
      priority: 0,
      action: "Reference existing test names/links or manual QA steps.",
      why: "Validation evidence ties behaviors to real checks and improves coverage confidence.",
      expected_score_impact: "+4 to +10",
      gain: (0.5 - b.validation_evidence) * 12
    });
  }
  if (nodesByKind(graph, "Requirement").length === 0) {
    candidates.push({
      priority: 0,
      action: "Add a few explicit requirements with descriptions and actors.",
      why: "Explicit requirement anchors raise specificity well beyond code-only inference.",
      expected_score_impact: "+8 to +18",
      gain: 16
    });
  }

  candidates.sort((a, c) => c.gain - a.gain);
  const recommendations = candidates.slice(0, 4).map((rec, i): DoctorRecommendation => ({
    priority: i + 1,
    action: rec.action,
    why: rec.why,
    expected_score_impact: rec.expected_score_impact
  }));

  return {
    status: score.band,
    recommendations,
    can_continue_without_recommendations: score.overall >= 40
  };
}
