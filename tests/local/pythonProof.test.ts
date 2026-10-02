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

function staticAssociationDetails(root: string): Array<{ to: string; detector?: unknown; rule?: unknown; reason?: unknown }> {
  return analyzeRepo(root, { readContent: true })
    .edges.filter((e) => e.relationship_type === "COVERS" && e.evidence_strength === "hard" && e.properties?.static_association)
    .map((e) => {
      const association = e.properties?.static_association as Record<string, unknown>;
      return { to: e.to_external_id, detector: e.provenance.detector, rule: association.detector ? association.rule : undefined, reason: association.reason };
    })
    .sort((a, b) => a.to.localeCompare(b.to));
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

  it("associates an exact assigned-instance invocation even when a later assertion is unrelated", () => {
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
    expect(staticAssociationDetails(root).map((e) => [e.to, e.rule])).toEqual([["sym:app/calc.py#Calculator.total", "assigned_instance"]]);
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

  it("retains test_a's direct asserted invocation when unrelated test_b patches its target", () => {
    const root = repo({
      "app/service.py": "class Service:\n    def work(self):\n        return 3\n",
      "tests/test_service.py": [
        "from unittest.mock import patch", "from app.service import Service", "",
        "def test_a():", "    subject = Service()", "    assert subject.work() == 3", "",
        "def test_b():", "    with patch.object(Service, 'work', return_value=4):", "        assert Service().work() == 4"
      ].join("\n")
    });
    expect(hardCoverEdgeDetails(root)).toEqual([
      { from: "test:tests/test_service.py", to: "sym:app/service.py#Service.work", testName: "test_a" }
    ]);
  });

  it("suppresses reachable named fixtures recursively but ignores unused and different-target fixtures", () => {
    const source = [
      "import pytest", "from unittest.mock import patch", "from app.service import Service", "",
      "@pytest.fixture", "def target_patch():", "    with patch.object(Service, 'work'):", "        yield", "",
      "@pytest.fixture", "def nested(target_patch):", "    yield", "",
      "@pytest.fixture", "def unrelated_patch():", "    with patch.object(Service, 'other'):", "        yield", "",
      "def test_a(unrelated_patch):", "    assert Service().work() == 3", "",
      "def test_b(nested):", "    assert Service().work() == 3"
    ].join("\n");
    const root = repo({
      "app/service.py": "class Service:\n    def work(self):\n        return 3\n    def other(self):\n        return 4\n",
      "tests/test_service.py": source
    });
    expect(hardCoverEdgeDetails(root)).toEqual([
      { from: "test:tests/test_service.py", to: "sym:app/service.py#Service.work", testName: "test_a" }
    ]);
  });

  it("resolves explicit usefixtures and literal getfixturevalue without treating an unused fixture as active", () => {
    const root = repo({
      "app/service.py": "class Service:\n    def work(self):\n        return 3\n",
      "tests/test_service.py": [
        "import pytest", "from unittest.mock import patch", "from app.service import Service", "",
        "@pytest.fixture", "def target_patch():", "    with patch.object(Service, 'work'):", "        yield", "",
        "def test_a():", "    assert Service().work() == 3", "",
        "@pytest.mark.usefixtures('target_patch')", "def test_b():", "    assert Service().work() == 3", "",
        "def test_c(request):", "    request.getfixturevalue('target_patch')", "    assert Service().work() == 3"
      ].join("\n")
    });
    expect(hardCoverEdgeDetails(root)).toEqual([
      { from: "test:tests/test_service.py", to: "sym:app/service.py#Service.work", testName: "test_a" }
    ]);
  });

  it("suppresses decorator, class patch and module autouse fixture scope, not sibling classes", () => {
    const service = "class Service:\n    def work(self):\n        return 3\n";
    const decorated = repo({
      "app/service.py": service,
      "tests/test_service.py": [
        "from unittest.mock import patch", "from app.service import Service", "",
        "@patch.object(Service, 'work')", "class TestPatched:", "    def test_work(self):", "        assert Service().work() == 3", "",
        "class TestUnpatched:", "    def test_work(self):", "        assert Service().work() == 3"
      ].join("\n")
    });
    expect(hardCoverEdgeDetails(decorated)).toEqual([
      { from: "test:tests/test_service.py", to: "sym:app/service.py#Service.work", testName: "TestUnpatched::test_work" }
    ]);
    const methodDecorated = repo({
      "app/service.py": service,
      "tests/test_service.py": [
        "from unittest.mock import patch", "from app.service import Service", "",
        "class TestService:", "    @patch.object(Service, 'work')", "    def test_patched(self):", "        assert Service().work() == 3", "",
        "    def test_direct(self):", "        assert Service().work() == 3"
      ].join("\n")
    });
    expect(hardCoverEdgeDetails(methodDecorated)).toEqual([
      { from: "test:tests/test_service.py", to: "sym:app/service.py#Service.work", testName: "TestService::test_direct" }
    ]);
    const autouse = repo({
      "app/service.py": service,
      "tests/test_service.py": [
        "import pytest", "from unittest.mock import patch", "from app.service import Service", "",
        "@pytest.fixture(autouse=True)", "def patched():", "    with patch.object(Service, 'work'):", "        yield", "",
        "def test_a():", "    assert Service().work() == 3"
      ].join("\n")
    });
    expect(hardCoverEdges(autouse)).toEqual([]);
  });

  it("fails closed for dynamic fixture names that cannot be statically resolved", () => {
    const root = repo({
      "app/service.py": "class Service:\n    def work(self):\n        return 3\n",
      "tests/test_service.py": [
        "import pytest", "from unittest.mock import patch", "from app.service import Service", "",
        "@pytest.fixture", "def target_patch():", "    with patch.object(Service, 'work'):", "        yield", "",
        "def test_a(request, fixture_name):", "    request.getfixturevalue(fixture_name)", "    assert Service().work() == 3"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not infer an untyped fixture receiver but keeps repeated exact instance invocations associated", () => {
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
    expect(staticAssociationDetails(repeatedRoot).map((e) => [e.to, e.rule])).toEqual([
      ["sym:app/calc.py#Calculator.total", "assigned_instance"]
    ]);
  });

  it("associates an exact instance invocation when the test contains more than one assertion", () => {
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
    expect(staticAssociationDetails(root).map((e) => [e.to, e.rule])).toEqual([
      ["sym:app/calc.py#Calculator.total", "assigned_instance"]
    ]);
  });

  it("associates an exact instance invocation when its stored result is consumed through a helper", () => {
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
    expect(staticAssociationDetails(root).map((e) => [e.to, e.rule])).toEqual([
      ["sym:app/calc.py#Calculator.total", "assigned_instance"]
    ]);
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

  it("rejects exact method replacement but retains another exact assigned-instance invocation", () => {
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
    expect(staticAssociationDetails(twoInstancesRoot).map((e) => [e.to, e.rule])).toEqual([
      ["sym:app/calc.py#Calculator.total", "assigned_instance"]
    ]);
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

  it("keeps exact invocations associated regardless of proof-oriented assertion shape", () => {
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
      expect(staticAssociationDetails(root).map((e) => [e.to, e.rule])).toEqual([
        ["sym:app/calc.py#Calculator.total", "assigned_instance"]
      ]);
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

  it("associates module-qualified constructor assignment and records an Association-only rule", () => {
    const root = repo({
      "app/service.py": ["class Service:", "    def work(self):", "        return 3"].join("\n"),
      "tests/test_service.py": [
        "import app.service as service",
        "",
        "def test_work():",
        "    subject = service.Service()",
        "    result = subject.work()",
        "    assert result == 3"
      ].join("\n")
    });
    expect(staticAssociationDetails(root)).toEqual([
      {
        to: "sym:app/service.py#Service.work",
        detector: "python_static_association",
        rule: "module_assigned_instance",
        reason: "Exact static receiver origin and direct invocation; this is Association only, never dynamic Proven."
      }
    ]);
  });

  it("associates one exact pytest fixture return, yield, and typed fixture receiver", () => {
    const returnRoot = repo({
      "app/service.py": ["class Service:", "    def work(self):", "        return 3"].join("\n"),
      "tests/test_service.py": [
        "import pytest",
        "from app.service import Service",
        "",
        "@pytest.fixture",
        "def subject():",
        "    return Service()",
        "",
        "def test_work(subject):",
        "    assert subject.work() == 3"
      ].join("\n")
    });
    expect(staticAssociationDetails(returnRoot).map((e) => [e.to, e.rule])).toEqual([["sym:app/service.py#Service.work", "fixture_return"]]);

    const yieldRoot = repo({
      "app/service.py": ["class Service:", "    def work(self):", "        return 3"].join("\n"),
      "tests/test_service.py": [
        "import pytest",
        "from app.service import Service",
        "",
        "@pytest.fixture",
        "def subject():",
        "    yield Service()",
        "",
        "def test_work(subject):",
        "    assert subject.work() == 3"
      ].join("\n")
    });
    expect(staticAssociationDetails(yieldRoot).map((e) => [e.to, e.rule])).toEqual([["sym:app/service.py#Service.work", "fixture_yield"]]);

    const annotationRoot = repo({
      "app/service.py": ["class Service:", "    def work(self):", "        return 3"].join("\n"),
      "tests/test_service.py": [
        "from app.service import Service",
        "",
        "def test_work(subject: Service):",
        "    assert subject.work() == 3"
      ].join("\n")
    });
    expect(staticAssociationDetails(annotationRoot).map((e) => [e.to, e.rule])).toEqual([["sym:app/service.py#Service.work", "parameter_annotation"]]);
  });

  it("resolves unittest setup receivers through one exact in-repo base-class MRO", () => {
    const root = repo({
      "app/service.py": [
        "class BaseService:", "    def work(self):", "        return 3",
        "class Service(BaseService):", "    pass"
      ].join("\n"),
      "tests/test_service.py": [
        "import unittest",
        "from app.service import Service",
        "",
        "class ServiceTests(unittest.TestCase):",
        "    def setUp(self):",
        "        self.subject = Service()",
        "    def test_work(self):",
        "        result = self.subject.work()",
        "        assert result == 3"
      ].join("\n")
    });
    expect(staticAssociationDetails(root).map((e) => [e.to, e.rule])).toEqual([["sym:app/service.py#BaseService.work", "unittest_setup"]]);
  });

  it("keeps one local instance association when test-class setup writes unrelated state", () => {
    const root = repo({
      "app/service.py": ["class Service:", "    def work(self):", "        return 3"].join("\n"),
      "tests/test_service.py": [
        "from app.service import Service",
        "",
        "class TestService:",
        "    def setup_method(self):",
        "        self.started_at = 0",
        "",
        "    def test_work(self):",
        "        settings.enabled = True",
        "        subject = Service()",
        "        result = subject.work()",
        "        assert result == 3",
        "        assert subject is not None"
      ].join("\n")
    });
    expect(staticAssociationDetails(root).map((e) => [e.to, e.rule])).toEqual([
      ["sym:app/service.py#Service.work", "assigned_instance"]
    ]);
  });

  it("keeps an assigned receiver exact with nested unrelated constructor arguments", () => {
    const root = repo({
      "app/service.py": ["class Service:", "    def inspect(self, value):", "        return True"].join("\n"),
      "tests/test_service.py": [
        "from app.service import Service",
        "",
        "def test_inspect():",
        "    subject = Service()",
        "    response = Response(items=[Item(content=[Text(value='ok')])])",
        "    assert subject.inspect(response) is True"
      ].join("\n")
    });
    expect(staticAssociationDetails(root).map((e) => [e.to, e.rule])).toEqual([
      ["sym:app/service.py#Service.inspect", "assigned_instance"]
    ]);
  });

  it("still fails closed on aliases, receiver escape, and target mocks after unrelated setup state", () => {
    const source = (mutation: string) => [
      "from unittest.mock import patch",
      "from app.service import Service",
      "",
      "class TestService:",
      "    def setup_method(self):",
      "        self.started_at = 0",
      "",
      "    def test_work(self):",
      "        subject = Service()",
      ...mutation.split("\n").map((line) => `        ${line}`)
    ].join("\n");
    for (const mutation of [
      "alias = subject\nalias.work = lambda: 4\nresult = subject.work()\nassert result == 4",
      "publish(subject)\nresult = subject.work()\nassert result == 3",
      "with patch.object(Service, 'work', return_value=4):\n    result = subject.work()\n    assert result == 4"
    ]) {
      const root = repo({
        "app/service.py": ["class Service:", "    def work(self):", "        return 3"].join("\n"),
        "tests/test_service.py": source(mutation)
      });
      expect(hardCoverEdges(root)).toEqual([]);
    }
  });

  it("associates exact inline constructors and declared class/static methods", () => {
    const inlineRoot = repo({
      "app/service.py": ["class Service:", "    def work(self):", "        return 3"].join("\n"),
      "tests/test_service.py": ["from app.service import Service", "", "def test_work():", "    assert Service().work() == 3"].join("\n")
    });
    expect(staticAssociationDetails(inlineRoot).map((e) => [e.to, e.rule])).toEqual([["sym:app/service.py#Service.work", "inline_constructor"]]);

    const staticRoot = repo({
      "app/service.py": ["class Service:", "    @staticmethod", "    def make():", "        return 3"].join("\n"),
      "tests/test_service.py": [
        "from app.service import Service",
        "",
        "def test_make(monkeypatch):",
        "    monkeypatch.setenv('FEATURE', '1')",
        "    result = Service.make()",
        "    assert result == 3",
        "    assert isinstance(result, int)"
      ].join("\n")
    });
    expect(staticAssociationDetails(staticRoot).map((e) => [e.to, e.rule])).toEqual([["sym:app/service.py#Service.make", "class_static_method"]]);
  });

  it("keeps exact receiver shapes invocation-backed without requiring one direct assertion", () => {
    const root = repo({
      "app/service.py": [
        "class _PrivateService:",
        "    def inspect(self):",
        "        return 3",
        "class Service:",
        "    def work(self):",
        "        return 4",
        "    def dependency(self):",
        "        return 5"
      ].join("\n"),
      "tests/test_service.py": [
        "from unittest.mock import AsyncMock as AM",
        "from app.service import _PrivateService, Service",
        "",
        "def test_private_receiver():",
        "    subject = _PrivateService()",
        "    subject.inspect()",
        "",
        "def test_multiple_observations():",
        "    subject = Service()",
        "    result = subject.work()",
        "    assert result == 4",
        "    assert isinstance(result, int)",
        "",
        "def test_unrelated_dependency_replacement():",
        "    subject = Service()",
        "    subject.dependency = AM()",
        "    assert subject.work() == 4"
      ].join("\n")
    });
    expect(staticAssociationDetails(root).map((e) => [e.to, e.rule])).toEqual([
      ["sym:app/service.py#_PrivateService.inspect", "assigned_instance"],
      ["sym:app/service.py#Service.work", "assigned_instance"]
    ]);
  });

  it("uses a unique eligible method-name fallback only for a genuinely unresolved receiver with an imported owner", () => {
    const root = repo({
      "app/service.py": ["class Worker:", "    def calculate(self):", "        return 3"].join("\n"),
      "tests/test_service.py": [
        "from app.service import Worker",
        "",
        "def test_calculate():",
        "    subject = make_subject()",
        "    result = subject.calculate()",
        "    assert result == 3"
      ].join("\n")
    });
    expect(staticAssociationDetails(root)).toEqual([{
      to: "sym:app/service.py#Worker.calculate",
      detector: "unique_method_name_import",
      rule: "unique_method_name_import",
      reason: "Unresolved receiver, one unique imported in-repo method owner, one direct invocation, and one direct pytest assertion; this is Association only, never dynamic Proven."
    }]);
  });

  it("does not fall back from an exactly resolved class whose MRO lacks the invoked method", () => {
    const root = repo({
      "app/service.py": ["class Gateway:", "    pass", "class Worker:", "    def calculate(self):", "        return 3"].join("\n"),
      "tests/test_service.py": [
        "from app.service import Gateway",
        "",
        "def test_calculate():",
        "    result = Gateway().calculate()",
        "    assert result == 3"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("fails closed on patching, dynamic getattr, receiver mutation/escape, non-static class calls, and fallback ambiguity", () => {
    const base = ["class Service:", "    def work(self):", "        return 3"].join("\n");
    for (const testBody of [
      ["from unittest.mock import patch", "from app.service import Service", "", "def test_work():", "    subject = Service()", "    with patch.object(Service, 'work', return_value=3):", "        assert subject.work() == 3"],
      ["from app.service import Service", "", "def test_work():", "    subject = Service()", "    assert getattr(subject, 'work')() == 3"],
      ["from app.service import Service", "", "def test_work():", "    subject = Service()", "    items = [subject]", "    assert subject.work() == 3"],
      ["from app.service import Service", "", "def test_work():", "    subject = Service()", "    subject.count += 1", "    assert subject.work() == 3"],
      ["from app.service import Service", "", "def test_work():", "    assert Service.work() == 3"]
    ]) {
      const root = repo({ "app/service.py": base, "tests/test_service.py": testBody.join("\n") });
      expect(hardCoverEdges(root)).toEqual([]);
    }

    const ambiguousFallback = repo({
      "app/service.py": [
        "class Gateway:", "    pass",
        "class First:", "    def calculate(self):", "        return 3",
        "class Second:", "    def calculate(self):", "        return 4"
      ].join("\n"),
      "tests/test_service.py": ["from app.service import Gateway", "", "def test_calculate():", "    assert Gateway().calculate() == 3"].join("\n")
    });
    expect(hardCoverEdges(ambiguousFallback)).toEqual([]);
  });
});
