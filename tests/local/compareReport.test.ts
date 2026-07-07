import { describe, it, expect } from "vitest";
import {
  renderCompareReportMarkdown,
  renderArmTestsFile,
  renderArmTestsJson,
  cleanDraftTestBody,
  testsFileExt,
  compareTestsFramework
} from "../../src/local/generate/compareReport.js";
import type { GenerateComparison } from "../../src/local/operations.js";

const FILE_NAMES = {
  localKgTests: "compare-tests.local-kg.test.ts",
  baselineTests: "compare-tests.baseline.test.ts",
  localKgJson: "compare-tests.local-kg.json",
  baselineJson: "compare-tests.baseline.json"
};

const BODY_MARKER = "UNIQUE_BODY_MARKER_42";

function makeCmp(framework = "jest"): GenerateComparison {
  const test = (id: string, title: string, refs: string[]) => ({
    id,
    run_id: "run-1",
    title,
    test_type: "unit" as const,
    framework_hint: framework,
    body: `test("${title}", () => { expect(1).toBe(1); }); // ${BODY_MARKER}`,
    bucket: "happy_path" as const,
    grounding: { entity_ids: ["flow:checkout"], source_refs: refs, weak_relationships_used: [] },
    weak_evidence_used: false
  });
  return {
    model_provider: "openai",
    model_name: "gpt-4.1",
    system_prompt_source: "hosted_reference",
    scoring_method: "llm_judge",
    rationale: "KG cites real modules",
    baseline: { generated_tests: [test("b1", "Checkout baseline", [])], missing_evidence: [], warnings: [], run_hints: [] },
    grounded: {
      generated_tests: [test("g1", "Checkout grounded", ["src/checkout.ts", "src/cart.ts"])],
      missing_evidence: [],
      warnings: [],
      run_hints: []
    },
    scores: {
      baseline: { completeness: 20, context_awareness: 10, accuracy: 20, domain_specificity: 15 },
      grounded: { completeness: 60, context_awareness: 70, accuracy: 72, domain_specificity: 75 }
    },
    matrix: {
      baseline: { tests: 1, concrete_assertions_avg: 1, traceability_refs: 0, weak_evidence_disclosed: 0, smoke_only: 1 },
      grounded: { tests: 1, concrete_assertions_avg: 2, traceability_refs: 1, weak_evidence_disclosed: 0, smoke_only: 0 }
    },
    warnings: [],
    wrote_repo_files: false
  } as GenerateComparison;
}

describe("testsFileExt", () => {
  it("maps frameworks to sensible extensions", () => {
    expect(testsFileExt("jest")).toBe("test.ts");
    expect(testsFileExt("vitest")).toBe("test.ts");
    expect(testsFileExt("playwright")).toBe("spec.ts");
    expect(testsFileExt("pytest")).toBe("py");
    expect(testsFileExt("junit")).toBe("java");
    expect(testsFileExt("something-else")).toBe("test.txt");
  });
});

describe("renderArmTestsFile", () => {
  it("writes the Local KG arm only, with a keep-arm header + grounded bodies", () => {
    const out = renderArmTestsFile(makeCmp(), "grounded", "2026-06-08T00:00:00Z");
    expect(out).toContain("Local KG (graph-grounded) — keep these");
    expect(out).toContain("KEEP these");
    expect(out).toContain("Checkout grounded");
    expect(out).not.toContain("Checkout baseline");
    expect(out.split(BODY_MARKER).length - 1).toBe(1); // grounded arm only
    expect(out).toContain("source refs: src/checkout.ts, src/cart.ts");
    expect(compareTestsFramework(makeCmp())).toBe("jest");
  });

  it("writes the baseline arm only, marked comparison-only", () => {
    const out = renderArmTestsFile(makeCmp(), "baseline", "2026-06-08T00:00:00Z");
    expect(out).toContain("COMPARISON ONLY");
    expect(out).toContain("Checkout baseline");
    expect(out).not.toContain("Checkout grounded");
    expect(out.split(BODY_MARKER).length - 1).toBe(1); // baseline arm only
  });

  it("handles an empty arm", () => {
    const cmp = makeCmp();
    cmp.baseline.generated_tests = [];
    const out = renderArmTestsFile(cmp, "baseline", "2026-06-08T00:00:00Z");
    expect(out).toContain("(no tests generated)");
  });

  it("uses '#' comments for python", () => {
    const out = renderArmTestsFile(makeCmp("pytest"), "grounded", "2026-06-08T00:00:00Z");
    expect(out).toContain("# OrangePro Local — A/B generated tests");
    expect(out).not.toContain("// OrangePro Local");
  });

  it("renders multiple Go tests as one package with de-duplicated imports", () => {
    const cmp = makeCmp("go");
    const base = cmp.grounded.generated_tests[0];
    cmp.grounded.generated_tests = [
      {
        ...base,
        id: "g1",
        title: "First Go scenario",
        body: 'package cobra\n\nimport "testing"\n\nfunc TestFirst(t *testing.T) {\n\tt.Fatalf("x")\n}\n'
      },
      {
        ...base,
        id: "g2",
        title: "Second Go scenario",
        body: 'package cobra\n\nimport "testing"\n\nfunc TestSecond(t *testing.T) {\n\tt.Fatalf("y")\n}\n'
      }
    ];
    const out = renderArmTestsFile(cmp, "grounded", "2026-06-08T00:00:00Z");
    expect(out.match(/^package cobra$/gm)).toHaveLength(1);
    expect(out.match(/^import "testing"$/gm)).toHaveLength(1);
    expect(out).toContain("func TestFirst");
    expect(out).toContain("func TestSecond");
    expect(out).not.toContain("package main");
  });

  it("discloses when a combined Go arm spans multiple packages", () => {
    const cmp = makeCmp("go");
    const base = cmp.grounded.generated_tests[0];
    cmp.grounded.generated_tests = [
      { ...base, id: "g1", body: 'package alpha\n\nimport "testing"\n\nfunc TestA(t *testing.T) {}\n' },
      { ...base, id: "g2", body: 'package beta\n\nimport "testing"\n\nfunc TestB(t *testing.T) {}\n' }
    ];
    const out = renderArmTestsFile(cmp, "grounded", "2026-06-08T00:00:00Z");
    expect(out).toContain("MANUAL SPLIT REQUIRED");
    expect(out).toContain("package beta");
  });

  it("renders multiple Java tests with one package/import block", () => {
    const cmp = makeCmp("junit");
    const base = cmp.grounded.generated_tests[0];
    cmp.grounded.generated_tests = [
      {
        ...base,
        id: "j1",
        body: [
          "package app.owner;",
          "",
          "import org.junit.jupiter.api.Test;",
          "import static org.junit.jupiter.api.Assertions.assertTrue;",
          "",
          "class FirstTest { @Test void first() { assertTrue(true); } }"
        ].join("\n")
      },
      {
        ...base,
        id: "j2",
        body: [
          "package app.owner;",
          "",
          "import org.junit.jupiter.api.Test;",
          "import static org.junit.jupiter.api.Assertions.assertTrue;",
          "",
          "class SecondTest { @Test void second() { assertTrue(true); } }"
        ].join("\n")
      }
    ];
    const out = renderArmTestsFile(cmp, "grounded", "2026-06-08T00:00:00Z");
    expect(out.match(/^package app\.owner;$/gm)).toHaveLength(1);
    expect(out.match(/^import org\.junit\.jupiter\.api\.Test;$/gm)).toHaveLength(1);
    expect(out.match(/^import static org\.junit\.jupiter\.api\.Assertions\.assertTrue;$/gm)).toHaveLength(1);
    expect(out).toContain("class FirstTest");
    expect(out).toContain("class SecondTest");
  });
});

describe("renderArmTestsJson", () => {
  it("returns one valid JSON document with arm set + test_code present (Local KG)", () => {
    const out = renderArmTestsJson(makeCmp(), "grounded", "2026-06-08T00:00:00Z");
    const parsed = JSON.parse(out);
    expect(parsed.arm).toBe("local_kg");
    expect(parsed.model).toBe("openai/gpt-4.1");
    expect(parsed.count).toBe(1);
    expect(parsed.tests[0].title).toBe("Checkout grounded");
    expect(parsed.tests[0].test_code).toContain(BODY_MARKER);
    expect(parsed.tests[0].grounding.source_refs).toEqual(["src/checkout.ts", "src/cart.ts"]);
    expect(out.endsWith("\n")).toBe(true);
  });

  it("sets arm to prompt_only_baseline for the baseline arm", () => {
    const parsed = JSON.parse(renderArmTestsJson(makeCmp(), "baseline", "2026-06-08T00:00:00Z"));
    expect(parsed.arm).toBe("prompt_only_baseline");
    expect(parsed.tests[0].title).toBe("Checkout baseline");
  });
});

describe("cleanDraftTestBody", () => {
  it("strips redaction placeholders and leaked bucket headers, keeps real code", () => {
    const body = [
      "import { merge } from './merge';",
      "",
      "HAPPY PATH",
      "// [orangepro: source excerpt redacted]",
      "// [orangepro: source excerpt redacted]",
      "test('merges results', () => {",
      "  expect(merge([1], [2])).toEqual([1, 2]); // REAL_ASSERTION",
      "});"
    ].join("\n");
    const cleaned = cleanDraftTestBody(body);
    expect(cleaned).not.toContain("[orangepro: source excerpt redacted]");
    expect(cleaned).not.toMatch(/^HAPPY PATH$/m);
    expect(cleaned).toContain("REAL_ASSERTION");
    expect(cleaned).toContain("import { merge } from './merge';");
    // A comment that merely contains a bucket word is NOT a bare header → kept.
    expect(cleanDraftTestBody("// happy path: valid inputs succeed")).toContain("happy path: valid inputs");
  });

  it("is applied when rendering a per-arm test file", () => {
    const cmp = makeCmp();
    cmp.grounded.generated_tests[0].body = "HAPPY PATH\n// [orangepro: source excerpt redacted]\nexpect(x).toBe(1); // KEEPME";
    const out = renderArmTestsFile(cmp, "grounded", "2026-06-08T00:00:00Z");
    expect(out).not.toContain("[orangepro: source excerpt redacted]");
    expect(out).toContain("KEEPME");
  });
});

describe("renderCompareReportMarkdown (slim)", () => {
  it("links all four per-arm files and shows scores/matrix/index but NOT full bodies", () => {
    const md = renderCompareReportMarkdown(makeCmp(), "2026-06-08T00:00:00Z", FILE_NAMES);
    expect(md).toContain("[`compare-tests.local-kg.test.ts`](./compare-tests.local-kg.test.ts)");
    expect(md).toContain("[`compare-tests.baseline.test.ts`](./compare-tests.baseline.test.ts)");
    expect(md).toContain("[`compare-tests.local-kg.json`](./compare-tests.local-kg.json)");
    expect(md).toContain("[`compare-tests.baseline.json`](./compare-tests.baseline.json)");
    expect(md).toContain("## Scores (0–100)");
    expect(md).toContain("## Comparison matrix");
    expect(md).toContain("## Generated tests (index)");
    expect(md).toContain("- [Local KG] Checkout grounded {happy_path} — unit/jest, 2 source refs");
    expect(md).not.toContain(BODY_MARKER);
  });

  it("renders Local KG agent run hints when the grounded arm has them", () => {
    const cmp = makeCmp();
    cmp.grounded.run_hints = [
      {
        generated_test_id: "g1",
        title: "Checkout grounded",
        framework: "jest",
        suggested_path: "orangepro_generated/01_checkout_grounded.test.ts",
        run_command: "npx jest orangepro_generated/01_checkout_grounded.test.ts"
      }
    ];
    const md = renderCompareReportMarkdown(cmp, "2026-06-08T00:00:00Z", FILE_NAMES);
    expect(md).toContain("## Agent run hints (Local KG)");
    expect(md).toContain("orangepro_generated/01_checkout_grounded.test.ts");
    expect(md).toContain("npx jest");
  });
});

describe("renderArmTestsFile — hoisted imports + numbered banners", () => {
  it("hoists and de-duplicates imports across tests; banners make tests differentiable", () => {
    const cmp = makeCmp("jest");
    const base = cmp.grounded.generated_tests[0];
    cmp.grounded.generated_tests = [
      {
        ...base,
        id: "g1",
        title: "First scenario",
        body: "import {a} from 'pkg/a';\nimport {b} from 'pkg/b';\n\ntest('first', () => { expect(a).toBe(1); });"
      },
      {
        ...base,
        id: "g2",
        title: "Second scenario",
        body: "import {a} from 'pkg/a';\nimport {c} from 'pkg/c';\n\ntest('second', () => { expect(c).toBe(3); });"
      }
    ];
    const out = renderArmTestsFile(cmp, "grounded", "2026-06-11T00:00:00Z");
    expect(out.match(/import \{a\} from 'pkg\/a';/g)).toHaveLength(1); // de-duplicated once
    expect(out).toContain("import {b} from 'pkg/b';");
    expect(out).toContain("import {c} from 'pkg/c';");
    expect(out).toContain("TEST 1/2: First scenario");
    expect(out).toContain("TEST 2/2: Second scenario");
    // After the hoisted block, the per-test sections carry code but no import lines.
    const afterFirstBanner = out.slice(out.indexOf("TEST 1/2"));
    expect(afterFirstBanner).not.toContain("import {");
    expect(afterFirstBanner).toContain("test('first'");
    expect(afterFirstBanner).toContain("test('second'");
  });

  it("python bodies are left un-hoisted (no TS parsing of py)", () => {
    const cmp = makeCmp("pytest");
    cmp.grounded.generated_tests[0].body = "import pytest\n\ndef test_x():\n    assert True";
    const out = renderArmTestsFile(cmp, "grounded", "t");
    expect(out).toContain("import pytest");
    expect(out).toContain("TEST 1/1");
  });
});

describe("renderArmTestsFile — hoist hardening (whitespace variants + conflicts)", () => {
  it("whitespace-variant duplicates collapse to one declaration", () => {
    const cmp = makeCmp("jest");
    const [t] = cmp.grounded.generated_tests;
    cmp.grounded.generated_tests = [
      { ...t, id: "t1", body: 'import { saveCard } from "src/payments/card";\nit("a", () => { saveCard(); });' },
      { ...t, id: "t2", body: 'import   {  saveCard  }   from "src/payments/card";\nit("b", () => { saveCard(); });' }
    ];
    const out = renderArmTestsFile(cmp, "grounded", "2026-06-11T00:00:00Z");
    expect(out.match(/from "src\/payments\/card"/g)).toHaveLength(1);
  });

  it("an import whose LOCAL name collides stays with ITS test as a manual-split warning", () => {
    const cmp = makeCmp("jest");
    const [t] = cmp.grounded.generated_tests;
    cmp.grounded.generated_tests = [
      { ...t, id: "t1", body: 'import { helper } from "src/a";\nit("a", () => { helper(); });' },
      { ...t, id: "t2", body: 'import { helper } from "src/b";\nit("b", () => { helper(); });' }
    ];
    const out = renderArmTestsFile(cmp, "grounded", "2026-06-11T00:00:00Z");
    // Exactly ONE live declaration of `helper` survives (the hoisted first one).
    const live = out.split("\n").filter((l) => /^import \{ helper \}/.test(l.trim()));
    expect(live).toHaveLength(1);
    // The conflicting import is NOT silently dropped: it travels with the test
    // that needs it, commented, under an explicit manual-split warning.
    expect(out).toContain("MANUAL SPLIT REQUIRED");
    const secondBlock = out.slice(out.indexOf("TEST 2/2"));
    expect(secondBlock).toContain('import { helper } from "src/b"');
    // And the warning sits in TEST 2's block, not in the hoisted header.
    const hoistedHeader = out.slice(0, out.indexOf("TEST 1/2"));
    expect(hoistedHeader).not.toContain("src/b");
  });

  it("a REPEATED conflicting import warns on EVERY test that carries it", () => {
    const cmp = makeCmp("jest");
    const [t] = cmp.grounded.generated_tests;
    cmp.grounded.generated_tests = [
      { ...t, id: "t1", body: 'import { helper } from "src/a";\nit("a", () => { helper(); });' },
      { ...t, id: "t2", body: 'import { helper } from "src/b";\nit("b", () => { helper(); });' },
      { ...t, id: "t3", body: 'import { helper } from "src/b";\nit("c", () => { helper(); });' }
    ];
    const out = renderArmTestsFile(cmp, "grounded", "2026-06-11T00:00:00Z");
    const block2 = out.slice(out.indexOf("TEST 2/3"), out.indexOf("TEST 3/3"));
    const block3 = out.slice(out.indexOf("TEST 3/3"));
    expect(block2).toContain("MANUAL SPLIT REQUIRED");
    // The dedupe hit on t3's identical conflicting line is still a conflict for
    // t3 — it must not be silently absorbed by t2's warning.
    expect(block3).toContain("MANUAL SPLIT REQUIRED");
    expect(block3).toContain('import { helper } from "src/b"');
  });

  it("a token-spacing variant of the SAME module import is a duplicate, not a conflict", () => {
    const cmp = makeCmp("jest");
    const [t] = cmp.grounded.generated_tests;
    cmp.grounded.generated_tests = [
      { ...t, id: "t1", body: 'import { helper } from "src/a";\nit("a", () => { helper(); });' },
      { ...t, id: "t2", body: 'import {helper} from "src/a";\nit("b", () => { helper(); });' }
    ];
    const out = renderArmTestsFile(cmp, "grounded", "2026-06-11T00:00:00Z");
    expect(out).not.toContain("MANUAL SPLIT REQUIRED"); // same binding — nothing to split
    const live = out.split("\n").filter((l) => /^import \{\s*helper\s*\}/.test(l.trim()));
    expect(live).toHaveLength(1);
  });

  it("aliased imports of DIFFERENT exports from one module are a conflict, never a duplicate", () => {
    const cmp = makeCmp("jest");
    const [t] = cmp.grounded.generated_tests;
    cmp.grounded.generated_tests = [
      { ...t, id: "t1", body: 'import { saveCard as subject } from "src/payments/card";\nit("saves", () => { subject(); });' },
      { ...t, id: "t2", body: 'import { deleteCard as subject } from "src/payments/card";\nit("deletes", () => { subject(); });' }
    ];
    const out = renderArmTestsFile(cmp, "grounded", "2026-06-11T00:00:00Z");
    const block2 = out.slice(out.indexOf("TEST 2/2"));
    expect(block2).toContain("MANUAL SPLIT REQUIRED");
    expect(block2).toContain("deleteCard as subject");
  });

  it("namespace-vs-named and default-vs-named imports of the same local are conflicts", () => {
    const cmp = makeCmp("jest");
    const [t] = cmp.grounded.generated_tests;
    cmp.grounded.generated_tests = [
      { ...t, id: "t1", body: 'import * as api from "src/api";\nit("a", () => { api.get(); });' },
      { ...t, id: "t2", body: 'import { api } from "src/api";\nit("b", () => { api(); });' },
      { ...t, id: "t3", body: 'import api from "src/api";\nit("c", () => { api(); });' }
    ];
    const out = renderArmTestsFile(cmp, "grounded", "2026-06-11T00:00:00Z");
    const block2 = out.slice(out.indexOf("TEST 2/3"), out.indexOf("TEST 3/3"));
    const block3 = out.slice(out.indexOf("TEST 3/3"));
    expect(block2).toContain("MANUAL SPLIT REQUIRED");
    expect(block3).toContain("MANUAL SPLIT REQUIRED");
    // Only the namespace import is live.
    const live = out.split("\n").filter((l) => /^import .*"src\/api"/.test(l.trim()));
    expect(live).toHaveLength(1);
    expect(live[0]).toContain("* as api");
  });
});

describe("testsFileExt — JSX-aware extension (dogfood fix)", () => {
  it("returns .tsx variants when any body contains JSX; .ts otherwise", () => {
    expect(testsFileExt("jest")).toBe("test.ts");
    expect(testsFileExt("jest", ['test("x", () => { render(<ProfilePopover userId={"1"}/>); });'])).toBe("test.tsx");
    expect(testsFileExt("vitest", ["const el = <div>hi</div>;"])).toBe("test.tsx");
    expect(testsFileExt("playwright", ["const x = <Foo/>;"])).toBe("spec.tsx");
    // Generic type arguments are NOT JSX (AST detection, not a < regex).
    expect(testsFileExt("jest", ["const s: DeepPartial<GlobalState> = {};"])).toBe("test.ts");
    expect(testsFileExt("pytest", ["def test_x(): pass"])).toBe("py");
  });
});
