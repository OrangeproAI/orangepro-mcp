import { describe, expect, it } from "vitest";
import {
  areaOf,
  conventionalTestFile,
  evidenceOf,
  notDraftedReason,
  parseTestPlan,
  pickTestFile,
  withheldReason,
  proveCommand,
  verbCounts,
  verbFor
} from "../../src/local/viz/worklist.js";

describe("verbFor: one verb per evidence state (R14 §1)", () => {
  it("maps every row of the pre-registered table", () => {
    expect(verbFor({ evidence: "proven", provenTest: "TestCancel" })).toEqual({ verb: "done", reason: "TestCancel fails when it breaks." });
    expect(verbFor({ evidence: "linked", proof: { status: "proven", current: false } }).verb).toBe("prove");
    expect(verbFor({ evidence: "linked", proof: { status: "proven", current: false } }).reason).toBe("The code changed since it was proven.");
    expect(verbFor({ evidence: "runtime" })).toEqual({ verb: "prove", reason: "A coverage run executes it; no test is proven to catch a break." });
    expect(verbFor({ evidence: "linked", linkedTest: "tests/test_orders.py" }).reason).toBe("tests/test_orders.py calls it; not yet proven to catch a break.");
    expect(verbFor({ evidence: "linked", proof: { status: "unrunnable", current: true, reason: "mutant did not compile" } }).reason)
      .toBe("A test calls it; not yet proven to catch a break. The last proof could not run: mutant did not compile.");
    expect(verbFor({ evidence: "unconfirmed", readFirst: "pkg/task_test.go" })).toEqual({
      verb: "check",
      reason: "Read pkg/task_test.go first: a test there may cover it, but no call was traced."
    });
    expect(verbFor({ evidence: "unconfirmed" }).reason).toBe("A test name points here, but no call was traced.");
    expect(verbFor({ evidence: "linked", proof: { status: "survived", current: true, test: "TestRun" } })).toEqual({
      verb: "write",
      reason: "TestRun runs it but does not catch a break."
    });
    expect(verbFor({ evidence: "linked", proof: { status: "non_assertion", current: true, test: "TestRun" } }).verb).toBe("write");
    expect(verbFor({ evidence: "none" })).toEqual({ verb: "write", reason: "No test points here." });
  });

  it("ignores a survived or failed proof made against older code", () => {
    expect(verbFor({ evidence: "linked", proof: { status: "survived", current: false } }).verb).toBe("prove");
    expect(verbFor({ evidence: "none", proof: { status: "non_assertion", current: false } }).verb).toBe("write");
  });

  it("derives evidence from the ranking tier, proof first", () => {
    expect(evidenceOf({ detection_tier: "runtime" }, false)).toBe("runtime");
    expect(evidenceOf({ detection_tier: "associated" }, false)).toBe("linked");
    expect(evidenceOf({ detection_tier: "candidate" }, false)).toBe("unconfirmed");
    expect(evidenceOf({ detection_tier: "none" }, false)).toBe("none");
    expect(evidenceOf({ detection_tier: "candidate" }, true)).toBe("proven");
    expect(verbCounts([{ verb: "check" }, { verb: "check" }, { verb: "write" }])).toEqual({ done: 0, prove: 0, check: 2, write: 1 });
  });
});

describe("generated test plans", () => {
  const body = [
    "Scenario: Skip delete execution on active cluster but ensure metrics/logging and no deletion invocation",
    "Steps:",
    "  1. Given an ExecutableDeleteExecutionTask with mocks where GetNamespaceInfo returns apply=true",
    "  2. And the namespace is active on cluster-A",
    "  3. When Execute() is invoked on the task",
    "  4. Then Execute() returns nil and logs the skip",
    "Test data: namespaceID=\"ns-active\", workflowID=\"wf-active\"",
    "Expected: Execute returns nil; no DeleteExecution call; ReplicationTasksSkipped is recorded",
    "Why this test: the active-cluster skip has no test."
  ].join("\n");

  it("splits Given, When and Then into import fields, with And joining the group above", () => {
    const plan = parseTestPlan(body)!;
    expect(plan.scenario).toBe("Skip delete execution on active cluster but ensure metrics/logging and no deletion invocation");
    expect(plan.preconditions).toEqual([
      "Given an ExecutableDeleteExecutionTask with mocks where GetNamespaceInfo returns apply=true",
      "And the namespace is active on cluster-A"
    ]);
    expect(plan.steps).toEqual(["When Execute() is invoked on the task"]);
    expect(plan.expected).toEqual([
      "Then Execute() returns nil and logs the skip",
      "Execute returns nil",
      "no DeleteExecution call",
      "ReplicationTasksSkipped is recorded"
    ]);
    expect(plan.testData).toBe("namespaceID=\"ns-active\", workflowID=\"wf-active\"");
    expect(plan.why).toBe("the active-cluster skip has no test.");
  });

  it("treats code as code, not a plan", () => {
    expect(parseTestPlan("func TestX(t *testing.T) { t.Fatal(\"x\") }")).toBeNull();
  });

  it("explains an empty slot in plain words", () => {
    expect(notDraftedReason(25, 20, undefined, undefined)).toBe("Tests are drafted for the 20 highest-priority functions.");
    expect(notDraftedReason(3, 20, { status: "no_provider" }, undefined)).toBe("Add a model key to draft two tests for this function.");
    expect(notDraftedReason(3, 20, { status: "completed" }, "V5 planning call failed: Model provider HTTP 429: You have no credits remaining"))
      .toBe("The model provider refused the request (no credits or rate limit).");
  });
});

describe("where things go", () => {
  it("names the conventional test file per language", () => {
    expect(conventionalTestFile("service/history/task.go")).toBe("service/history/task_test.go");
    expect(conventionalTestFile("litellm/proxy/db.py")).toBe("litellm/proxy/test_db.py");
    expect(conventionalTestFile("src/orders.service.ts")).toBe("src/orders.service.test.ts");
    expect(conventionalTestFile("src/main/java/a/B.java")).toBe("src/test/java/a/BTest.java");
  });

  it("points at the function's own test file first, then the strongest pointer", () => {
    expect(pickTestFile("svc/history/task.go", ["svc/api_test.go", "svc/history/task_test.go"])).toBe("svc/history/task_test.go");
    expect(pickTestFile("svc/history/task.go", ["tests/b/long_test.go", "tests/a_test.go"])).toBe("tests/a_test.go");
    expect(pickTestFile("svc/task.go", undefined)).toBeUndefined();
    // A shorter neighbour must not win over the file named after the source.
    expect(pickTestFile("svc/history/transfer_queue_executor.go", [
      { file: "svc/history/timer_queue_executor_test.go", confidence: 0.45 },
      { file: "svc/history/transfer_queue_executor_test.go", confidence: 0.6 }
    ])).toBe("svc/history/transfer_queue_executor_test.go");
    expect(pickTestFile("svc/history/x.go", [
      { file: "svc/history/a_test.go", confidence: 0.4 },
      { file: "svc/history/archival_test.go", confidence: 0.57 }
    ])).toBe("svc/history/archival_test.go");
    expect(pickTestFile("src/a.js", ["test/a.js"])).toBe("test/a.js");
    expect(pickTestFile("src/a.ts", ["src/__tests__/a.ts"])).toBe("src/__tests__/a.ts");
    // A fixture is not a test to read first.
    expect(pickTestFile("src/config.ts", [{ file: "tests/__fixtures__/resolver/model.ts", confidence: 0.9 }])).toBeUndefined();
    expect(pickTestFile("src/config.ts", [
      { file: "tests/__fixtures__/config.test.ts", confidence: 0.9 },
      { file: "tests/config.test.ts", confidence: 0.4 }
    ])).toBe("tests/config.test.ts");
  });

  it("never shows raw validator or provider output as the reason code was withheld", () => {
    expect(withheldReason('V5 planning call failed: Model provider HTTP 429: {"error":{"message":"You have no credits remaining"}}'))
      .toBe("Only a plan: the model provider refused the request for code (no credits or rate limit).");
    expect(withheldReason("V5 planning returned no missing scenarios. Manual fallback retained because this was the final bounded planning attempt"))
      .toBe("Only a plan: the model returned no test code for this scenario.");
    expect(withheldReason("Go compile check failed: FAIL pkg [build failed] x_test.go:50:23: undefined: workflow"))
      .toBe("The generated code referred to names that do not exist in this package.");
    expect(withheldReason("Go compile check failed: FAIL pkg [setup failed] x_test.go:13:90: expected ';', found '{'"))
      .toBe("The generated code did not pass the compile check.");
    expect(withheldReason("something internal {secret}")).toBe("The generated code did not pass validation.");
  });

  it("groups by the first two directories", () => {
    expect(areaOf("service/history/workflow/context.go")).toBe("service/history");
    expect(areaOf("chasm/component.go")).toBe("chasm");
    expect(areaOf("main.go")).toBe(".");
  });

  it("writes a prove command per language", () => {
    expect(proveCommand("sym:a.py#f", "a.py", "tests/test_a.py")).toBe("opro prove-loop --target-symbol 'sym:a.py#f' --test 'tests/test_a.py' --replacement sentinel");
    expect(proveCommand("sym:a.go#f", "a.go", undefined)).toBe("opro prove-loop --target-symbol 'sym:a.go#f' --test '<your test file>'");
    expect(proveCommand("sym:a.ts#f", "a.ts", "a.test.ts")).toContain("--replacement 'return null;'");
  });
});
