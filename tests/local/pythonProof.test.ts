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

describe("Python hard proof", () => {
  it("confirms a pytest assert that directly calls a same-package function", () => {
    const root = repo({
      "src/app/calc.py": "def add(a, b):\n    return a + b\n",
      "src/app/test_calc.py": ["def test_add():", "    assert add(1, 2) == 3"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:src/app/test_calc.py -> sym:src/app/calc.py#add"]);
  });

  it("confirms an exactly resolved sibling named import", () => {
    const root = repo({
      "src/app/calc.py": "def add(a, b):\n    return a + b\n",
      "src/app/test_calc.py": ["from calc import add", "", "def test_add():", "    assert add(1, 2) == 3"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:src/app/test_calc.py -> sym:src/app/calc.py#add"]);
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
    expect(hardCoverEdges(root)).toEqual(["test:src/app/test_calc.py -> sym:src/app/calc.py#total"]);
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

  it("does not confirm imported calls even when a convention sibling exists", () => {
    const root = repo({
      "src/app/calc.py": "def add():\n    return 1\n",
      "src/other/calc.py": "def add():\n    return 99\n",
      "tests/app/test_calc.py": ["from other.calc import add", "", "def test_add():", "    assert add() == 99"].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
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
