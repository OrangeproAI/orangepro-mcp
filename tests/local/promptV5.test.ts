import { describe, expect, it } from "vitest";

import {
  buildBatchGenerationSystemPromptV5,
  buildBatchGenerationUserPromptV5,
  buildPlanningRepairSystemPromptV5,
  buildPlanningSystemPromptV5,
  parseBatchGeneratedTests,
  parsePlannedScenarios,
  parsePlannedScenariosStrict
} from "../../src/local/generate/promptV5.js";

const VALID_SCENARIO = {
  id: 1,
  title: "rejects empty carts",
  concern: "boundary_limits",
  technique: "boundary_value_analysis",
  rationale: "",
  assertion_targets: ["throws on empty cart"],
  complexity: "basic",
  risk_rank: 1
};

describe("prompt v5", () => {
  it("forces planning and repair to return a raw array", () => {
    const prompt = buildPlanningSystemPromptV5();
    expect(prompt).toContain("Return a raw JSON array only");
    expect(prompt).toContain("return [] exactly");
    expect(prompt).toContain("first character of your response must be [");
    expect(prompt).toContain("technique must be exactly one of");
    expect(prompt).toContain("boundary_value_analysis");

    const repair = buildPlanningRepairSystemPromptV5();
    expect(repair).toContain("output [] exactly");
    expect(repair).toContain("first character must be [");
  });

  it("includes the mock-subject rejection rule in the batch system prompt", () => {
    const prompt = buildBatchGenerationSystemPromptV5();
    expect(prompt).toContain("Never mock, stub, or spy on the behavior-under-test itself");
    expect(prompt).not.toContain("Unlock with OrangePro Platform");
  });

  it("injects only techniques used by the selected scenario batch", () => {
    const prompt = buildBatchGenerationUserPromptV5({
      behavior_title: "OrdersService.create",
      actors: [],
      framework: "vitest",
      test_layer: "integration",
      code_context: ["OrdersService.create"],
      source_excerpts: ["export class OrdersService {}"],
      existing_tests: [],
      subject_imports: ["import { OrdersService } from './orders';"],
      weak_context: [],
      scenarios: [
        {
          id: 2,
          title: "rejects empty carts",
          concern: "boundary_limits",
          technique: "boundary_value_analysis",
          rationale: "empty carts are high risk",
          assertion_targets: ["throws on empty cart"],
          complexity: "basic",
          risk_rank: 1
        }
      ]
    });
    expect(prompt).toContain("HOW: Test at exact boundaries");
    expect(prompt).not.toContain("Simulate infrastructure failure");
  });

  it("parses planned scenarios by risk order and caps caller-side", () => {
    const parsed = parsePlannedScenarios(
      JSON.stringify([
        {
          id: 2,
          title: "low",
          concern: "contract",
          technique: "contract_verification",
          rationale: "",
          assertion_targets: [],
          complexity: "basic",
          risk_rank: 5
        },
        {
          id: 1,
          title: "high",
          concern: "failure_recovery",
          technique: "rollback_recovery",
          rationale: "",
          assertion_targets: ["state is rolled back"],
          complexity: "advanced",
          risk_rank: 1
        }
      ]),
      1
    );
    expect(parsed.map((s) => s.title)).toEqual(["high"]);
  });

  it("(a) parses planning output wrapped in a ```json markdown fence", () => {
    const raw = "```json\n" + JSON.stringify([VALID_SCENARIO]) + "\n```";
    const result = parsePlannedScenariosStrict(raw, 20);
    expect(result.scenarios.map((s) => s.title)).toEqual(["rejects empty carts"]);
    expect(result.dropped).toBe(0);
  });

  it("(b) extracts the first JSON array when the model wraps it in prose", () => {
    const raw = `Sure — here is the plan:\n${JSON.stringify([VALID_SCENARIO])}\nLet me know if you need more.`;
    const result = parsePlannedScenariosStrict(raw, 20);
    expect(result.scenarios).toHaveLength(1);
    expect(result.scenarios[0].assertion_targets).toEqual(["throws on empty cart"]);
  });

  it("(e) rejects invalid concern / technique / assertion_target with counted reasons", () => {
    const raw = JSON.stringify([
      VALID_SCENARIO,
      { ...VALID_SCENARIO, id: 2, concern: "security_privacy" }, // unknown concern
      { ...VALID_SCENARIO, id: 3, technique: "made_up_technique" }, // unknown technique
      { ...VALID_SCENARIO, id: 4, assertion_targets: [] }, // empty assertion_targets
      { ...VALID_SCENARIO, id: 5, complexity: "extreme" } // invalid complexity
    ]);
    const result = parsePlannedScenariosStrict(raw, 20);
    expect(result.scenarios.map((s) => s.id)).toEqual([1]);
    expect(result.dropped).toBe(4);
    expect(result.dropSummary.join(" | ")).toMatch(/unknown concern/);
    expect(result.dropSummary.join(" | ")).toMatch(/unknown technique/);
    expect(result.dropSummary.join(" | ")).toMatch(/empty assertion_targets/);
    expect(result.dropSummary.join(" | ")).toMatch(/invalid complexity/);
  });

  it("throws on hard parse failure (no JSON array) but treats an empty array as valid", () => {
    expect(() => parsePlannedScenariosStrict("not json at all {", 20)).toThrow();
    expect(parsePlannedScenariosStrict("[]", 20)).toEqual({ scenarios: [], dropped: 0, dropSummary: [] });
    // Back-compat wrapper returns the validated array.
    expect(parsePlannedScenarios(JSON.stringify([VALID_SCENARIO]))).toHaveLength(1);
  });

  it("splits batch output by scenario delimiters", () => {
    const parsed = parseBatchGeneratedTests(
      [
        "// ═══ SCENARIO 1 ═══",
        "it('a', () => expect(1).toBe(1));",
        "// ═══ SCENARIO 2 ═══",
        "it('b', () => expect(2).toBe(2));"
      ].join("\n")
    );
    expect(parsed).toEqual([
      { scenario_id: 1, body: "it('a', () => expect(1).toBe(1));" },
      { scenario_id: 2, body: "it('b', () => expect(2).toBe(2));" }
    ]);
  });
});
