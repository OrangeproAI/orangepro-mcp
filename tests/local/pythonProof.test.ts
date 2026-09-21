import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";

const dirs: string[] = [];

beforeAll(async () => {
  await preloadTreeSitter(["python"]);
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-pyproof-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function hardCoverEdges(root: string): string[] {
  return analyzeRepo(root, { readContent: true })
    .edges.filter((e) => e.relationship_type === "COVERS" && e.evidence_strength === "hard")
    .map((e) => `${e.from_external_id} -> ${e.to_external_id}`)
    .sort();
}

function hardCoverEdgeDetails(root: string): Array<{ from: string; to: string; testName?: unknown }> {
  return analyzeRepo(root, { readContent: true })
    .edges.filter((e) => e.relationship_type === "COVERS" && e.evidence_strength === "hard")
    .map((e) => ({ from: e.from_external_id, to: e.to_external_id, testName: e.properties?.test_name }))
    .sort((a, b) => `${a.from}${a.to}`.localeCompare(`${b.from}${b.to}`));
}

describe("Python hard proof", () => {
  it("confirms a pytest assert that directly calls a same-package function", () => {
    const root = repo({
      "src/app/calc.py": "def add(a, b):\n    return a + b\n",
      "src/app/test_calc.py": ["def test_add():", "    assert add(1, 2) == 3"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:src/app/test_calc.py -> sym:src/app/calc.py#add"]);
  });

  it("records the exact pytest function selector on hard proof edges", () => {
    const root = repo({
      "src/app/calc.py": "def add(a, b):\n    return a + b\n",
      "src/app/test_calc.py": ["def test_add():", "    assert add(1, 2) == 3"].join("\n")
    });
    expect(hardCoverEdgeDetails(root)).toEqual([
      { from: "test:src/app/test_calc.py", to: "sym:src/app/calc.py#add", testName: "test_add" }
    ]);
  });

  it("records the exact pytest class method selector on hard proof edges", () => {
    const root = repo({
      "src/app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "src/app/test_calc.py": [
        "class TestCalculator:",
        "    def test_total(self):",
        "        assert Calculator().total() == 3"
      ].join("\n")
    });
    expect(hardCoverEdgeDetails(root)).toEqual([
      { from: "test:src/app/test_calc.py", to: "sym:src/app/calc.py#Calculator.total", testName: "TestCalculator::test_total" }
    ]);
  });

  it("confirms an exactly resolved sibling named import", () => {
    const root = repo({
      "src/app/calc.py": "def add(a, b):\n    return a + b\n",
      "src/app/test_calc.py": ["from calc import add", "", "def test_add():", "    assert add(1, 2) == 3"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:src/app/test_calc.py -> sym:src/app/calc.py#add"]);
  });

  it("confirms an explicit absolute package named import outside convention siblings", () => {
    const root = repo({
      "app/calc.py": "def add(a, b):\n    return a + b\n",
      "tests/test_calc.py": ["from app.calc import add", "", "def test_add():", "    assert add(1, 2) == 3"].join("\n")
    });
    expect(hardCoverEdgeDetails(root)).toEqual([
      { from: "test:tests/test_calc.py", to: "sym:app/calc.py#add", testName: "test_add" }
    ]);
  });

  it("confirms an explicit package-relative named import like h11 tests use", () => {
    const root = repo({
      "h11/__init__.py": "",
      "h11/_headers.py": "def normalize_and_validate(headers):\n    return [(b'foo', b'bar')]\n",
      "h11/tests/__init__.py": "",
      "h11/tests/test_headers.py": [
        "from .._headers import normalize_and_validate",
        "",
        "def test_normalize_and_validate():",
        "    assert normalize_and_validate([('foo', 'bar')]) == [(b'foo', b'bar')]"
      ].join("\n")
    });
    expect(hardCoverEdgeDetails(root)).toEqual([
      { from: "test:h11/tests/test_headers.py", to: "sym:h11/_headers.py#normalize_and_validate", testName: "test_normalize_and_validate" }
    ]);
  });

  it("confirms an explicit sibling named import even with an unrelated wildcard import", () => {
    const root = repo({
      "src/app/calc.py": "def add(a, b):\n    return a + b\n",
      "src/app/helpers.py": "def fixture():\n    return 99\n",
      "src/app/test_calc.py": ["from calc import add", "from helpers import *", "", "def test_add():", "    assert add(1, 2) == 3"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:src/app/test_calc.py -> sym:src/app/calc.py#add"]);
  });

  it("confirms an explicit sibling named import when the wildcard import appears first", () => {
    const root = repo({
      "src/app/calc.py": "def add(a, b):\n    return a + b\n",
      "src/app/helpers.py": "def fixture():\n    return 99\n",
      "src/app/test_calc.py": ["from helpers import *", "from calc import add", "", "def test_add():", "    assert add(1, 2) == 3"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:src/app/test_calc.py -> sym:src/app/calc.py#add"]);
  });

  it("confirms an exactly resolved sibling module import", () => {
    const root = repo({
      "src/app/calc.py": "def add(a, b):\n    return a + b\n",
      "src/app/test_calc.py": ["import calc", "", "def test_add():", "    assert calc.add(1, 2) == 3"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:src/app/test_calc.py -> sym:src/app/calc.py#add"]);
  });

  it("confirms a pytest assert that directly calls a same-package method", () => {
    const root = repo({
      "src/app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "src/app/test_calc.py": ["def test_total():", "    assert Calculator().total() == 3"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:src/app/test_calc.py -> sym:src/app/calc.py#Calculator.total"]);
  });

  it("associates an asserted result from one uniquely assigned imported instance", () => {
    const root = repo({
      "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "tests/test_calc.py": [
        "from app.calc import Calculator",
        "",
        "def test_total():",
        "    calculator = Calculator()",
        "    result = calculator.total()",
        "    assert result == 3"
      ].join("\n")
    });
    expect(hardCoverEdgeDetails(root)).toEqual([
      { from: "test:tests/test_calc.py", to: "sym:app/calc.py#Calculator.total", testName: "test_total" }
    ]);
  });

  it("resolves a unique named-import alias back to the production class owner", () => {
    const root = repo({
      "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "tests/test_calc.py": [
        "from app.calc import Calculator as ImportedCalculator",
        "",
        "def test_total():",
        "    calculator = ImportedCalculator()",
        "    result = calculator.total()",
        "    assert result == 3"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:tests/test_calc.py -> sym:app/calc.py#Calculator.total"]);
  });

  it("associates an awaited instance result through one exact package re-export hop", () => {
    const root = repo({
      "pkg/__init__.py": "from .router import Router\n",
      "pkg/router.py": ["class Router:", "    async def acompletion(self):", "        return 3"].join("\n"),
      "tests/test_router.py": [
        "from pkg import Router",
        "",
        "async def test_completion():",
        "    router = Router()",
        "    result = await router.acompletion()",
        "    assert result == 3"
      ].join("\n")
    });
    expect(hardCoverEdgeDetails(root)).toEqual([
      { from: "test:tests/test_router.py", to: "sym:pkg/router.py#Router.acompletion", testName: "test_completion" }
    ]);
  });

  it("does not associate assigned instances when the invocation result is unrelated to the assertion", () => {
    const root = repo({
      "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "tests/test_calc.py": [
        "from app.calc import Calculator",
        "",
        "def test_total():",
        "    calculator = Calculator()",
        "    calculator.total()",
        "    assert 1 == 1"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("fails closed on reassigned or patched Python instance receivers", () => {
    const root = repo({
      "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "tests/test_calc.py": [
        "from unittest.mock import patch",
        "from app.calc import Calculator",
        "",
        "def test_total():",
        "    calculator = Calculator()",
        "    calculator = Calculator()",
        "    with patch.object(Calculator, 'total', return_value=3):",
        "        result = calculator.total()",
        "        assert result == 3"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not associate fixture-provided receivers or tests with multiple receiver calls", () => {
    const fixtureRoot = repo({
      "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "tests/test_calc.py": [
        "from app.calc import Calculator",
        "",
        "def test_total(calculator):",
        "    assert calculator.total() == 3"
      ].join("\n")
    });
    expect(hardCoverEdges(fixtureRoot)).toEqual([]);

    const repeatedRoot = repo({
      "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "tests/test_calc.py": [
        "from app.calc import Calculator",
        "",
        "def test_total():",
        "    calculator = Calculator()",
        "    calculator.total()",
        "    result = calculator.total()",
        "    assert result == 3"
      ].join("\n")
    });
    expect(hardCoverEdges(repeatedRoot)).toEqual([]);
  });

  it("does not associate an instance method when the test contains more than one assertion", () => {
    const root = repo({
      "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "tests/test_calc.py": [
        "from app.calc import Calculator",
        "",
        "def test_total():",
        "    calculator = Calculator()",
        "    result = calculator.total()",
        "    assert result == 3",
        "    assert calculator is not None"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not associate stored results consumed through an assertion helper call", () => {
    const root = repo({
      "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "tests/test_calc.py": [
        "from app.calc import Calculator",
        "",
        "def test_total():",
        "    calculator = Calculator()",
        "    result = calculator.total()",
        "    assert normalize(result) == 3"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("requires an explicit production class import for assigned-instance Association", () => {
    const root = repo({
      "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "tests/test_calc.py": [
        "class Calculator:",
        "    def total(self):",
        "        return 999",
        "",
        "def test_total():",
        "    calculator = Calculator()",
        "    result = calculator.total()",
        "    assert result == 999"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("rejects transformed instance-method results before assertion", () => {
    const root = repo({
      "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "tests/test_calc.py": [
        "from app.calc import Calculator",
        "",
        "def test_total():",
        "    calculator = Calculator()",
        "    result = calculator.total() + 1",
        "    assert result == 4"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("rejects method replacement and more than one assigned-instance call across the test", () => {
    const replacedRoot = repo({
      "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "tests/test_calc.py": [
        "from app.calc import Calculator",
        "",
        "def test_total():",
        "    calculator = Calculator()",
        "    calculator.total = lambda: 4",
        "    result = calculator.total()",
        "    assert result == 4"
      ].join("\n")
    });
    expect(hardCoverEdges(replacedRoot)).toEqual([]);

    const twoInstancesRoot = repo({
      "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
      "tests/test_calc.py": [
        "from app.calc import Calculator",
        "",
        "def test_total():",
        "    first = Calculator()",
        "    second = Calculator()",
        "    first_result = first.total()",
        "    second.total()",
        "    assert first_result == 3"
      ].join("\n")
    });
    expect(hardCoverEdges(twoInstancesRoot)).toEqual([]);
  });

  it("rejects tracked receiver escape to setters or arbitrary helpers", () => {
    for (const mutation of [
      "setattr(calculator, 'total', lambda: 4)",
      "object.__setattr__(calculator, 'total', lambda: 4)",
      "replace(calculator)"
    ]) {
      const root = repo({
        "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
        "tests/test_calc.py": [
          "from app.calc import Calculator",
          "",
          "def test_total():",
          "    calculator = Calculator()",
          `    ${mutation}`,
          "    result = calculator.total()",
          "    assert result == 4"
        ].join("\n")
      });
      expect(hardCoverEdges(root)).toEqual([]);
    }
  });

  it("rejects any local alias of a tracked instance before assertion", () => {
    for (const mutation of [
      "alias.total = lambda: 4",
      "setattr(alias, 'total', lambda: 4)",
      "alias.__class__.total = lambda self: 4"
    ]) {
      const root = repo({
        "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
        "tests/test_calc.py": [
          "from app.calc import Calculator",
          "",
          "def test_total():",
          "    calculator = Calculator()",
          "    alias = calculator",
          `    ${mutation}`,
          "    result = calculator.total()",
          "    assert result == 4"
        ].join("\n")
      });
      expect(hardCoverEdges(root)).toEqual([]);
    }
  });

  it("rejects duplicated, chained, container, and vacuous stored-result assertions", () => {
    for (const assertion of [
      "assert (result, result) == (3, 3)",
      "assert 2 < result < 4",
      "assert result == result"
    ]) {
      const root = repo({
        "app/calc.py": ["class Calculator:", "    def total(self):", "        return 3"].join("\n"),
        "tests/test_calc.py": [
          "from app.calc import Calculator",
          "",
          "def test_total():",
          "    calculator = Calculator()",
          "    result = calculator.total()",
          `    ${assertion}`
        ].join("\n")
      });
      expect(hardCoverEdges(root)).toEqual([]);
    }
  });

  it("keeps same-named methods bound to the constructed class owner", () => {
    const root = repo({
      "app/calc.py": [
        "class Calculator:", "    def total(self):", "        return 3",
        "class Other:", "    def total(self):", "        return 4"
      ].join("\n"),
      "tests/test_calc.py": [
        "from app.calc import Other",
        "",
        "def test_total():",
        "    subject = Other()",
        "    result = subject.total()",
        "    assert result == 4"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:tests/test_calc.py -> sym:app/calc.py#Other.total"]);
  });

  it("does not confirm local helper names that shadow product functions", () => {
    const root = repo({
      "src/app/calc.py": "def add():\n    return 1\n",
      "src/app/test_calc.py": ["def test_add():", "    def add():", "        return 3", "    assert add() == 3"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm local assertion values that shadow product functions", () => {
    const root = repo({
      "src/app/calc.py": "def add():\n    return 1\n",
      "src/app/test_calc.py": ["def test_add():", "    add = lambda: 3", "    assert add() == 3"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm two-call comparisons where expected and actual are ambiguous", () => {
    const root = repo({
      "src/app/calc.py": ["def add(a, b):", "    return a + b", "def expected_sum():", "    return 3"].join("\n"),
      "src/app/test_calc.py": ["def test_add():", "    assert add(1, 2) == expected_sum()"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("confirms an explicit imported call against the imported module, not the convention sibling", () => {
    const root = repo({
      "src/app/calc.py": "def add():\n    return 1\n",
      "src/other/calc.py": "def add():\n    return 99\n",
      "tests/app/test_calc.py": ["from other.calc import add", "", "def test_add():", "    assert add() == 99"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:tests/app/test_calc.py -> sym:src/other/calc.py#add"]);
  });

  it("does not confirm unqualified calls when a wildcard import could shadow the sibling", () => {
    const root = repo({
      "src/app/calc.py": "def add():\n    return 1\n",
      "src/app/helpers.py": "def add():\n    return 99\n",
      "src/app/test_calc.py": ["from helpers import *", "", "def test_add():", "    assert add() == 99"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm aliased named imports as a different local class", () => {
    const root = repo({
      "src/app/calc.py": ["class Calculator:", "    def total(self):", "        return 3", "class Other:", "    def total(self):", "        return 4"].join("\n"),
      "src/app/test_calc.py": ["from calc import Other as Calculator", "", "def test_total():", "    assert Calculator().total() == 4"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("underlinks cross-package ambiguous Python siblings instead of choosing one", () => {
    const root = repo({
      "src/a/calc.py": "def add():\n    return 1\n",
      "src/b/calc.py": "def add():\n    return 2\n",
      "tests/test_calc.py": ["def test_add():", "    assert add() == 1"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm assertionless calls", () => {
    const root = repo({
      "src/app/calc.py": "def add(a, b):\n    return a + b\n",
      "src/app/test_calc.py": ["def test_add():", "    add(1, 2)"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });
});
