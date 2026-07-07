import { describe, expect, it } from "vitest";

describe("validate-generated-tests script", () => {
  it("flags a runnable framework/target-language mismatch as blocking", async () => {
    // @ts-expect-error The script is intentionally plain .mjs and has no TS declaration file.
    const { validateGeneratedTest } = await import("../../scripts/validate-generated-tests.mjs");
    const graph = {
      nodes: [
        {
          kind: "File",
          external_id: "src/api.ts",
          properties: { role: "code", language: "typescript", file: "src/api.ts" }
        },
        {
          kind: "CodeSymbol",
          external_id: "sym:src/api.ts#saveUser",
          properties: { file: "src/api.ts", symbol_kind: "function" }
        }
      ]
    };
    const test = {
      id: "t1",
      title: "saveUser",
      framework_hint: "go",
      body: "package main\n\nimport \"testing\"\n\nfunc TestSaveUser(t *testing.T) {}\n",
      runnable: true,
      grounding: { entity_ids: ["sym:src/api.ts#saveUser"], source_refs: [], weak_relationships_used: [] }
    };
    const hint = {
      generated_test_id: "t1",
      suggested_path: "orangepro_generated/save_user_test.go",
      run_command: "go test ./..."
    };

    const result = validateGeneratedTest(test, hint, graph);

    expect(result.target_language).toBe("typescript");
    expect(result.errors).toContain("Framework/target mismatch: go generated for typescript target.");
  });

  it("accepts aliased Go testing imports as valid Go test imports", async () => {
    // @ts-expect-error The script is intentionally plain .mjs and has no TS declaration file.
    const { validateGeneratedTest } = await import("../../scripts/validate-generated-tests.mjs");
    const graph = {
      nodes: [
        {
          kind: "File",
          external_id: "svc/context.go",
          properties: { role: "code", language: "go", file: "svc/context.go" }
        },
        {
          kind: "CodeSymbol",
          external_id: "sym:svc/context.go#Context",
          properties: { file: "svc/context.go", symbol_kind: "function" }
        }
      ]
    };
    const test = {
      id: "t1",
      title: "Context",
      framework_hint: "go",
      body: [
        "package svc",
        "",
        "import (",
        "  testing \"testing\"",
        ")",
        "",
        "func TestContext(t *testing.T) {",
        "  if false { t.Fatalf(\"expected context\") }",
        "}"
      ].join("\n"),
      runnable: true,
      grounding: { entity_ids: ["sym:svc/context.go#Context"], source_refs: [], weak_relationships_used: [] }
    };
    const hint = {
      generated_test_id: "t1",
      suggested_path: "svc/orangepro_generated_01_context_test.go",
      run_command: "go test ./..."
    };

    const result = validateGeneratedTest(test, hint, graph);

    expect(result.target_language).toBe("go");
    expect(result.errors).not.toContain('Static format check failed: Go test is missing import "testing".');
    expect(result.errors).toEqual([]);
  });

  it("flags runnable Java/JUnit bodies with unbalanced braces", async () => {
    // @ts-expect-error The script is intentionally plain .mjs and has no TS declaration file.
    const { validateGeneratedTest } = await import("../../scripts/validate-generated-tests.mjs");
    const graph = {
      nodes: [
        {
          kind: "File",
          external_id: "src/main/java/org/example/OwnerController.java",
          properties: { role: "code", language: "java", file: "src/main/java/org/example/OwnerController.java" }
        },
        {
          kind: "CodeSymbol",
          external_id: "sym:src/main/java/org/example/OwnerController.java#OwnerController",
          properties: { file: "src/main/java/org/example/OwnerController.java", symbol_kind: "class" }
        }
      ]
    };
    const test = {
      id: "t1",
      title: "OwnerController",
      framework_hint: "junit",
      body: [
        "package org.example;",
        "",
        "import org.junit.jupiter.api.Test;",
        "import static org.junit.jupiter.api.Assertions.assertTrue;",
        "",
        "class OwnerControllerTest {",
        "  @Test void ownerController() {",
        "    assertTrue(true);",
        "  }"
      ].join("\n"),
      runnable: true,
      grounding: {
        entity_ids: ["sym:src/main/java/org/example/OwnerController.java#OwnerController"],
        source_refs: [],
        weak_relationships_used: []
      }
    };
    const hint = {
      generated_test_id: "t1",
      suggested_path: "src/test/java/org/example/OwnerControllerTest.java",
      run_command: "./mvnw test -Dtest=OwnerControllerTest"
    };

    const result = validateGeneratedTest(test, hint, graph);

    expect(result.target_language).toBe("java");
    expect(result.errors).toContain("Static format check failed: Java test has unbalanced braces.");
  });
});
