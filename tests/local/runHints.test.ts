import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  suggestedTestPath,
  suggestedRunCommand,
  runHintsFor,
  runnableRunHintsFor,
  AGENT_RUN_WORKFLOW,
  GENERATED_DIR
} from "../../src/local/generate/runHints.js";
import type { GeneratedTest } from "../../src/local/graph/ontology.js";

function gt(title: string, framework: string, id = "t1"): GeneratedTest {
  return {
    id,
    run_id: "run-1",
    title,
    test_type: "unit",
    framework_hint: framework,
    body: "test('x', () => {});",
    grounding: { entity_ids: [], source_refs: ["src/x.ts"], weak_relationships_used: [] },
    weak_evidence_used: false
  };
}

function gtForSymbol(title: string, framework: string, target: string, id = "t1"): GeneratedTest {
  return { ...gt(title, framework, id), target_symbol_external_id: target };
}

describe("suggestedTestPath", () => {
  it("slugs the title, numbers it, and uses the framework extension", () => {
    expect(suggestedTestPath(gt("Checkout flow!", "jest"), 0)).toBe(`${GENERATED_DIR}/01_checkout_flow.test.ts`);
    expect(suggestedTestPath(gt("Maps promise values", "ava"), 0)).toBe(`${GENERATED_DIR}/01_maps_promise_values.test.js`);
    expect(suggestedTestPath(gt("Login", "playwright"), 1)).toBe(`${GENERATED_DIR}/02_login.spec.ts`);
    expect(suggestedTestPath(gt("Pay", "pytest"), 2)).toBe(`${GENERATED_DIR}/03_pay.py`);
    expect(suggestedTestPath(gt("Active help", "go"), 3)).toBe(`${GENERATED_DIR}_04_active_help_test.go`);
  });

  it("places Go tests in the package directory instead of a new subpackage", () => {
    const root = gt("Context happy path", "go");
    root.grounding.entity_ids = ["context.go"];
    expect(suggestedTestPath(root, 0)).toBe(`${GENERATED_DIR}_01_context_happy_path_test.go`);

    const nested = gt("Middleware timeout", "go");
    nested.grounding.entity_ids = ["sym:middleware/timeout.go#Timeout"];
    expect(suggestedTestPath(nested, 1)).toBe(`middleware/${GENERATED_DIR}_02_middleware_timeout_test.go`);
  });

  it("places Java/JUnit tests under src/test/java using the body package and class", () => {
    const t = gt("Owner controller", "junit");
    t.body = [
      "package org.springframework.samples.petclinic.owner;",
      "",
      "import org.junit.jupiter.api.Test;",
      "import static org.junit.jupiter.api.Assertions.assertTrue;",
      "",
      "class OwnerControllerTest {",
      "  @Test void ownerController() { assertTrue(true); }",
      "}"
    ].join("\n");
    expect(suggestedTestPath(t, 0)).toBe(
      "src/test/java/org/springframework/samples/petclinic/owner/OwnerControllerTest.java"
    );
  });

  it("places the test NEXT TO the linked existing test so relative imports + monorepo module roots resolve", () => {
    const t = gt("Profile popover happy path", "jest");
    t.grounding.source_refs = [
      "webapp/channels/src/components/profile_popover/profile_popover.test.tsx",
      "webapp/channels/src/components/profile_popover/profile_popover.tsx"
    ];
    expect(suggestedTestPath(t, 0)).toBe(
      `webapp/channels/src/components/profile_popover/${GENERATED_DIR}_01_profile_popover_happy_path.test.tsx`
    );
    const js = gt("Fetch adapter happy path", "vitest");
    js.grounding.source_refs = ["tests/unit/adapters/fetch.test.js", "lib/adapters/fetch.js"];
    expect(suggestedTestPath(js, 0)).toBe(`tests/unit/adapters/${GENERATED_DIR}_01_fetch_adapter_happy_path.test.js`);
    const ava = gt("Top-level AVA happy path", "ava");
    ava.grounding.source_refs = ["test.js", "index.js"];
    expect(suggestedTestPath(ava, 1)).toBe(`${GENERATED_DIR}_02_top_level_ava_happy_path.test.js`);
    // pytest linked test placement works too.
    const p = gt("Pay", "pytest");
    p.grounding.source_refs = ["tests/payments/test_cards.py"];
    expect(suggestedTestPath(p, 2)).toBe(`tests/payments/${GENERATED_DIR}_03_pay.py`);
    // No linked TEST ref (source files only) → repo-root fallback.
    expect(suggestedTestPath(gt("Login", "jest"), 0)).toBe(`${GENERATED_DIR}/01_login.test.ts`);
  });

  it("uses .tsx when the body contains JSX — JSX in a .ts file is a TS error", () => {
    const t = gt("Renders popover", "jest");
    t.body = 'import React from "react";\ntest("x", () => { render(<ProfilePopover userId={"1"}/>); });';
    expect(suggestedTestPath(t, 0)).toBe(`${GENERATED_DIR}/01_renders_popover.test.tsx`);
    // A generic type argument is NOT JSX (AST detection, not a < regex).
    const g = gt("Generic", "jest");
    g.body = 'const s: DeepPartial<GlobalState> = {};\ntest("x", () => { expect(s).toBeTruthy(); });';
    expect(suggestedTestPath(g, 0)).toBe(`${GENERATED_DIR}/01_generic.test.ts`);
  });
});

describe("suggestedRunCommand", () => {
  it("maps frameworks to run commands", () => {
    expect(suggestedRunCommand("jest", "p.test.ts")).toBe("npx jest p.test.ts");
    expect(suggestedRunCommand("vitest", "p.test.ts")).toBe("npx vitest run p.test.ts");
    expect(suggestedRunCommand("playwright", "p.spec.ts")).toBe("npx playwright test p.spec.ts");
    expect(suggestedRunCommand("ava", "p.test.js")).toBe("npx ava p.test.js");
    expect(suggestedRunCommand("pytest", "p.py")).toBe("pytest p.py");
    expect(suggestedRunCommand("go", "p_test.go")).toBe("go test ./...");
    expect(suggestedRunCommand("junit", "src/test/java/app/OwnerControllerTest.java")).toBe(
      "mvn test -Dtest=OwnerControllerTest"
    );
    expect(suggestedRunCommand("mystery", "p.x")).toContain("your repo's test command");
  });

  it("prefers a repo package script that already uses the requested JS framework", () => {
    const root = mkdtempSync(join(tmpdir(), "op-runhint-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ packageManager: "pnpm@11.8.0", scripts: { "test:unit": "vitest run --pool=forks" } })
      );
      expect(suggestedRunCommand("vitest", "src/foo.test.ts", root)).toBe("pnpm run test:unit -- src/foo.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("selects generated pytest markers so repo addopts cannot deselect the only test", () => {
    const body = [
      "import pytest",
      "",
      "@pytest.mark.property",
      "def test_properties():",
      "    assert True"
    ].join("\n");

    expect(suggestedRunCommand("pytest", "tests/orangepro_generated_01_properties.py", undefined, body)).toBe(
      "pytest tests/orangepro_generated_01_properties.py -m property"
    );
  });

  it("uses the available Java build runner instead of assuming ./mvnw exists", () => {
    const root = mkdtempSync(join(tmpdir(), "op-runhint-java-"));
    try {
      writeFileSync(join(root, "pom.xml"), "<project />\n");
      expect(suggestedRunCommand("junit4", "src/test/java/app/OwnerControllerTest.java", root)).toBe(
        "mvn test -Dtest=OwnerControllerTest"
      );
      writeFileSync(join(root, "mvnw"), "#!/bin/sh\n");
      expect(suggestedRunCommand("junit5", "src/test/java/app/OwnerControllerTest.java", root)).toBe(
        "./mvnw test -Dtest=OwnerControllerTest"
      );

      const gradleRoot = join(root, "tools");
      mkdirSync(gradleRoot);
      writeFileSync(join(gradleRoot, "build.gradle"), "plugins { id 'java' }\n");
      expect(suggestedRunCommand("junit", "tools/src/test/java/app/ToolTest.java", root)).toBe(
        "gradle test --tests ToolTest"
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("avoids watch-mode JS scripts when a run-mode script is available", () => {
    const root = mkdtempSync(join(tmpdir(), "op-runhint-watch-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({
          packageManager: "pnpm@11.8.0",
          scripts: {
            "test:watch": "vitest",
            test: "vitest run",
            "test:unit": "vitest run --project unit"
          }
        })
      );
      expect(suggestedRunCommand("vitest", "tests/unit/foo.test.js", root)).toBe(
        "pnpm run test:unit -- tests/unit/foo.test.js"
      );
      expect(suggestedRunCommand("vitest", "packages/zod/foo.test.ts", root)).toBe("pnpm run test -- packages/zod/foo.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not use a bare vitest package script because it can enter watch mode", () => {
    const root = mkdtempSync(join(tmpdir(), "op-runhint-bare-vitest-"));
    try {
      writeFileSync(
        join(root, "package.json"),
        JSON.stringify({ packageManager: "pnpm@11.8.0", scripts: { test: "vitest" } })
      );
      expect(suggestedRunCommand("vitest", "src/foo.test.ts", root)).toBe("npx vitest run src/foo.test.ts");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runHintsFor", () => {
  it("returns a write path + run command per test", () => {
    const hints = runHintsFor([gt("Checkout flow", "jest", "a"), gt("Login", "jest", "b")]);
    expect(hints).toHaveLength(2);
    expect(hints[0]).toMatchObject({
      generated_test_id: "a",
      suggested_path: `${GENERATED_DIR}/01_checkout_flow.test.ts`,
      run_command: `npx jest ${GENERATED_DIR}/01_checkout_flow.test.ts`
    });
    expect(hints[1].suggested_path).toBe(`${GENERATED_DIR}/02_login.test.ts`);
  });

  it("adds structured dynamic prove and static record handoffs for CodeSymbol-targeted drafts", () => {
    const target = "sym:src/order.ts#createOrder";
    const [hint] = runHintsFor([gtForSymbol("Checkout flow", "jest", target, "a")]);

    expect(hint).toMatchObject({
      generated_test_id: "a",
      target_symbol_external_id: target,
      suggested_path: `${GENERATED_DIR}/01_checkout_flow.test.ts`,
      prove_run: {
        tool: "orangepro_prove",
        args: {
          target_symbol: target,
          test_path: `${GENERATED_DIR}/01_checkout_flow.test.ts`,
          replacement: "return null;",
          runner: "jest"
        }
      },
      record_run: {
        tool: "orangepro_record_run",
        args: {
          target_symbol: target,
          test_path: `${GENERATED_DIR}/01_checkout_flow.test.ts`
        }
      }
    });
    expect(hint.handoff_note).toBeUndefined();
  });

  it("keeps static diagnostics but omits dynamic prove handoff for non-TS/JS symbols", () => {
    const [goHint, pyHint, javaHint] = runHintsFor([
      gtForSymbol("Add flow", "go", "sym:svc/math.go#Add", "go"),
      gtForSymbol("Charge card", "pytest", "sym:svc/pay.py#charge", "py"),
      gtForSymbol("Run app", "junit", "sym:src/App.java#App.run", "java")
    ]);

    expect(goHint.target_symbol_external_id).toBe("sym:svc/math.go#Add");
    expect(goHint.prove_run).toBeUndefined();
    expect(goHint.record_run).toMatchObject({
      tool: "orangepro_record_run",
      args: {
        target_symbol: "sym:svc/math.go#Add",
        test_path: `${GENERATED_DIR}_01_add_flow_test.go`
      }
    });
    expect(pyHint.prove_run).toMatchObject({
      tool: "orangepro_prove",
      args: {
        target_symbol: "sym:svc/pay.py#charge",
        replacement: "return 0",
        runner: "pytest"
      }
    });
    expect(pyHint.record_run?.tool).toBe("orangepro_record_run");

    for (const hint of [goHint, javaHint]) {
      expect(hint.prove_run).toBeUndefined();
      expect(hint.record_run?.tool).toBe("orangepro_record_run");
      expect(hint.handoff_note).toContain("TS/JS/Python CodeSymbol targets only");
    }
  });

  it("omits proof handoffs for non-CodeSymbol drafts and explains the manual handoff", () => {
    const [hint] = runHintsFor([gt("Requirement row", "jest", "req")]);

    expect(hint.target_symbol_external_id).toBeUndefined();
    expect(hint.prove_run).toBeUndefined();
    expect(hint.record_run).toBeUndefined();
    expect(hint.handoff_note).toContain("not a code symbol");
  });

  it("does not emit proof handoffs for non-symbol target ids even if the draft carries one", () => {
    const [hint] = runHintsFor([{ ...gt("Requirement row", "jest", "req"), target_symbol_external_id: "REQ-1" }]);

    expect(hint.target_symbol_external_id).toBeUndefined();
    expect(hint.prove_run).toBeUndefined();
    expect(hint.record_run).toBeUndefined();
    expect(hint.handoff_note).toContain("not a code symbol");
  });

  it("ships an agent write -> run -> report workflow", () => {
    expect(Array.isArray(AGENT_RUN_WORKFLOW)).toBe(true);
    expect(AGENT_RUN_WORKFLOW.join(" ")).toMatch(/write/i);
    expect(AGENT_RUN_WORKFLOW.join(" ")).toMatch(/report/i);
    expect(AGENT_RUN_WORKFLOW.join(" ")).toMatch(/prove_run/i);
    expect(AGENT_RUN_WORKFLOW.join(" ")).toMatch(/orangepro_prove/i);
    expect(AGENT_RUN_WORKFLOW.join(" ")).toMatch(/record_run/i);
    expect(AGENT_RUN_WORKFLOW.join(" ")).toMatch(/python3/i);
    expect(AGENT_RUN_WORKFLOW.join(" ")).toMatch(/gofmt/i);
  });
});

describe("runnableRunHintsFor", () => {
  it("includes runnable framework code but skips JSON/XML spec bodies", () => {
    const code = gt("Runnable", "jest", "r");
    const jsonSpec: GeneratedTest = { ...gt("Spec", "jest", "s"), body: '{"test_cases":[]}' };
    const fencedJson: GeneratedTest = { ...gt("Fenced", "jest", "f"), body: '```json\n{"a":1}\n```' };
    // gpt-5/reasoning models sometimes prepend prose before the ```json fence —
    // this must still be detected as a spec (matches compareTestsExt/looksJson).
    const proseJson: GeneratedTest = { ...gt("Prose", "jest", "p"), body: 'Here are the tests:\n```json\n{"a":1}\n```' };
    const xmlSpec: GeneratedTest = { ...gt("XmlSpec", "jest", "x"), body: "<testcases></testcases>" };
    const hints = runnableRunHintsFor([code, jsonSpec, fencedJson, proseJson, xmlSpec]);
    expect(hints).toHaveLength(1);
    expect(hints[0].generated_test_id).toBe("r");
  });
});
