import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";

const dirs: string[] = [];

beforeAll(async () => {
  await preloadTreeSitter(["go"]);
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-goproof-"));
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

/** `properties.test_name` on each hard Go COVERS edge (the auto-drive `-run` anchor source). */
function hardCoverTestNames(root: string): Array<string | undefined> {
  return analyzeRepo(root, { readContent: true })
    .edges.filter((e) => e.relationship_type === "COVERS" && e.evidence_strength === "hard")
    .map((e) => e.properties?.test_name as string | undefined);
}

/** `properties.assertion_line` on each hard Go COVERS edge (Slice 2 exact-line binding source). */
function hardCoverAssertionLines(root: string): Array<number | undefined> {
  return analyzeRepo(root, { readContent: true })
    .edges.filter((e) => e.relationship_type === "COVERS" && e.evidence_strength === "hard")
    .map((e) => e.properties?.assertion_line as number | undefined);
}

describe("Go hard proof", () => {
  it("confirms a same-package function call asserted by testing.T failure", () => {
    const root = repo({
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import \"testing\"",
        "func TestAdd(t *testing.T) {",
        "  if got := Add(1, 2); got != 3 { t.Fatalf(\"got %d\", got) }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/add_test.go -> sym:svc/add.go#Add"]);
  });

  it("confirms a repo-package qualified function call from an external Go test package", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc_test",
        "import (",
        "  \"testing\"",
        "  \"example.com/repo/svc\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  if got := svc.Add(1, 2); got != 3 { t.Errorf(\"got %d\", got) }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/add_test.go -> sym:svc/add.go#Add"]);
  });

  it("confirms calls passed to imported assert/require helpers", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\nfunc Validate() error { return nil }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  \"github.com/stretchr/testify/assert\"",
        "  \"github.com/stretchr/testify/require\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  assert.Equal(t, 3, Add(1, 2))",
        "  require.NoError(t, Validate())",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([
      "test:svc/add_test.go -> sym:svc/add.go#Add",
      "test:svc/add_test.go -> sym:svc/add.go#Validate"
    ]);
  });

  it("confirms calls passed to canonical dot-imported testify assertions", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\nfunc Validate() error { return nil }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  . \"github.com/stretchr/testify/assert\"",
        "  . \"github.com/stretchr/testify/require\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  Equal(t, 3, Add(1, 2))",
        "  NoError(t, Validate())",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([
      "test:svc/add_test.go -> sym:svc/add.go#Add",
      "test:svc/add_test.go -> sym:svc/add.go#Validate"
    ]);
  });

  it("does not confirm dot-imported non-testify assertion helpers", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  . \"example.com/repo/internal/assert\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  Equal(t, 3, Add(1, 2))",
        "}"
      ].join("\n"),
      "internal/assert/assert.go": "package assert\nimport \"testing\"\nfunc Equal(t *testing.T, expected, actual any) {}\n"
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm local functions that shadow dot-imported testify assertions", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  . \"github.com/stretchr/testify/assert\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  Equal := func(t *testing.T, expected, actual any) {}",
        "  Equal(t, 3, Add(1, 2))",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm dot-imported testify assertions unless the first argument is testing.T", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  . \"github.com/stretchr/testify/assert\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  ctx := 1",
        "  Equal(ctx, 3, Add(1, 2))",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm calls passed to non-testify assert-like packages", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  fakeassert \"example.com/repo/internal/assert\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  fakeassert.Equal(1, 2, Add(1, 2))",
        "}"
      ].join("\n"),
      "internal/assert/assert.go": "package assert\nfunc Equal(args ...any) {}\n"
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm non-testify assert-like packages with a real testing.T argument", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  fakeassert \"example.com/repo/internal/assert\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  fakeassert.Equal(t, 3, Add(1, 2))",
        "}"
      ].join("\n"),
      "internal/assert/assert.go": "package assert\nimport \"testing\"\nfunc Equal(t *testing.T, expected, actual any) {}\n"
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm spoofed testify import paths", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  \"evil.com/stretchr/testify/assert\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  assert.Equal(t, 3, Add(1, 2))",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("confirms testify v2 assertion helpers", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  \"github.com/stretchr/testify/v2/assert\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  assert.Equal(t, 3, Add(1, 2))",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/add_test.go -> sym:svc/add.go#Add"]);
  });

  it("does not confirm testify assertions unless the first argument is testing.T", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Validate() error { return nil }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  \"github.com/stretchr/testify/require\"",
        ")",
        "func TestValidate(t *testing.T) {",
        "  ctx := 1",
        "  require.NoError(ctx, Validate())",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm helper calls used as expected assertion values", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\nfunc Expected() int { return 3 }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  \"github.com/stretchr/testify/assert\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  assert.Equal(t, Expected(), Add(1, 2))",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/add_test.go -> sym:svc/add.go#Add"]);
  });

  it("underlinks nested product calls in asserted expressions", () => {
    const root = repo({
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\nfunc Wrap(v int) int { return v }\n",
      "svc/add_test.go": [
        "package svc",
        "import \"testing\"",
        "func TestAdd(t *testing.T) {",
        "  if got := Wrap(Add(1, 2)); got != 3 { t.Fatalf(\"got %d\", got) }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm unasserted Go calls", () => {
    const root = repo({
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import \"testing\"",
        "func TestAdd(t *testing.T) {",
        "  _ = Add(1, 2)",
        "  t.Log(\"setup only\")",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm free calls from an external _test package", () => {
    const root = repo({
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc_test",
        "import \"testing\"",
        "func TestAdd(t *testing.T) {",
        "  if got := Add(1, 2); got != 3 { t.Fatalf(\"got %d\", got) }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("underlinks ambiguous same-package symbols instead of choosing one", () => {
    const root = repo({
      "svc/add_a.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_b.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import \"testing\"",
        "func TestAdd(t *testing.T) {",
        "  if got := Add(1, 2); got != 3 { t.Fatalf(\"got %d\", got) }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("resolves qualified Go proofs inside the nearest owning module", () => {
    const root = repo({
      "go.mod": "module root.example/repo\n\ngo 1.22\n",
      "sub/go.mod": "module sub.example/repo\n\ngo 1.22\n",
      "sub/svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "sub/svc/add_test.go": [
        "package svc_test",
        "import (",
        "  \"testing\"",
        "  \"sub.example/repo/svc\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  if got := svc.Add(1, 2); got != 3 { t.Fatalf(\"got %d\", got) }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:sub/svc/add_test.go -> sym:sub/svc/add.go#Add"]);
  });

  it("does not resolve parent-module imports through a nested different module", () => {
    const root = repo({
      "go.mod": "module root.example/repo\n\ngo 1.22\n",
      "sub/go.mod": "module child.example/other\n\ngo 1.22\n",
      "sub/svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "cmd/run_test.go": [
        "package cmd",
        "import (",
        "  \"testing\"",
        "  \"root.example/repo/sub/svc\"",
        ")",
        "func TestRun(t *testing.T) {",
        "  if got := svc.Add(1, 2); got != 3 { t.Fatalf(\"got %d\", got) }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("keeps qualified Go proofs inside a nested module that extends the parent path", () => {
    const root = repo({
      "go.mod": "module root.example/repo\n\ngo 1.22\n",
      "sub/go.mod": "module root.example/repo/sub\n\ngo 1.22\n",
      "sub/svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "sub/svc/add_test.go": [
        "package svc_test",
        "import (",
        "  \"testing\"",
        "  \"root.example/repo/sub/svc\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  if got := svc.Add(1, 2); got != 3 { t.Fatalf(\"got %d\", got) }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:sub/svc/add_test.go -> sym:sub/svc/add.go#Add"]);
  });

  it("does not resolve qualified Go proofs across duplicate module-name subtrees", () => {
    const root = repo({
      "go.mod": "module shared.example/repo\n\ngo 1.22\n",
      "a/add.go": "package a\nfunc Add(a, b int) int { return a + b }\n",
      "sub/go.mod": "module shared.example/repo\n\ngo 1.22\n",
      "sub/foo_test.go": [
        "package sub_test",
        "import (",
        "  \"testing\"",
        "  \"shared.example/repo/a\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  if got := a.Add(1, 2); got != 3 { t.Fatalf(\"got %d\", got) }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm a local binding that shadows the production function", () => {
    const root = repo({
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import \"testing\"",
        "func TestAdd(t *testing.T) {",
        "  Add := func(a, b int) int { return 3 }",
        "  if got := Add(1, 2); got != 3 { t.Fatalf(\"got %d\", got) }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("confirms testify assertions inside subtests with renamed testing.T parameters", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  \"github.com/stretchr/testify/assert\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  t.Run(\"case\", func(st *testing.T) {",
        "    assert.Equal(st, 3, Add(1, 2))",
        "  })",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/add_test.go -> sym:svc/add.go#Add"]);
  });

  it("carries a literal-named subtest onto the edge test_name (TestX/sub)", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      // Renamed subtest param (`st`) so the assertion is attributed to the subtest scope,
      // not the parent — this is the shape that carries the literal sub-name onto the edge.
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  \"github.com/stretchr/testify/assert\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  t.Run(\"basic\", func(st *testing.T) {",
        "    assert.Equal(st, 3, Add(1, 2))",
        "  })",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/add_test.go -> sym:svc/add.go#Add"]);
    expect(hardCoverTestNames(root)).toEqual(["TestAdd/basic"]);
    // Slice 2: the assertion's 1-based source line (the `assert.Equal` on line 8).
    expect(hardCoverAssertionLines(root)).toEqual([8]);
  });

  it("carries the t.Errorf line (not the if-guard line) for a testing_fail proof", () => {
    const root = repo({
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      // Line 3 = `if` guard; line 4 = the `t.Errorf` call Go reports in the failing frame.
      "svc/add_test.go": [
        "package svc",
        "import \"testing\"",
        "func TestAdd(t *testing.T) { if got := Add(1, 2); got != 3 {",
        "  t.Errorf(\"got %d\", got)",
        "} }"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/add_test.go -> sym:svc/add.go#Add"]);
    expect(hardCoverAssertionLines(root)).toEqual([4]);
  });

  it("falls back to the bare parent for a RUNTIME subtest name (never invents a child)", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  \"github.com/stretchr/testify/assert\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  for _, tc := range []struct{ Name string }{{Name: \"a\"}} {",
        "    t.Run(tc.Name, func(st *testing.T) {",
        "      assert.Equal(st, 3, Add(1, 2))",
        "    })",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/add_test.go -> sym:svc/add.go#Add"]);
    // Runtime `tc.Name` (not a string literal) → no sub segment; the edge keeps the bare
    // parent even though the assertion runs in the subtest scope. Never invents a child.
    expect(hardCoverTestNames(root)).toEqual(["TestAdd"]);
  });

  it("falls back to the bare parent when a literal subtest name needs Go -run sanitization", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  \"github.com/stretchr/testify/assert\"",
        ")",
        "func TestAdd(t *testing.T) {",
        "  t.Run(\"basic case\", func(st *testing.T) {",
        "    assert.Equal(st, 3, Add(1, 2))",
        "  })",
        "}"
      ].join("\n")
    });
    // Space in the literal ⇒ Go would rewrite it in the `-run` path; we refuse to guess a
    // sanitized segment and keep the bare parent (safe: exact-match oracle refuses, no false-prove).
    expect(hardCoverTestNames(root)).toEqual(["TestAdd"]);
  });

  it("confirms calls passed to canonical testify suite assertions", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/calc.go": [
        "package svc",
        "func Add(a, b int) int { return a + b }",
        "func Mul(a, b int) int { return a * b }",
        "func Sub(a, b int) int { return a - b }",
        "func Validate() error { return nil }"
      ].join("\n"),
      "svc/calc_test.go": [
        "package svc",
        "import suitepkg \"github.com/stretchr/testify/suite\"",
        "type CalcSuite struct { suitepkg.Suite }",
        "func (s *CalcSuite) TestCalc() {",
        "  s.Equal(3, Add(1, 2))",
        "  s.Require().Equal(6, Mul(2, 3))",
        "  s.Assert().Equal(1, Sub(3, 2))",
        "  s.Require().NoError(Validate())",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([
      "test:svc/calc_test.go -> sym:svc/calc.go#Add",
      "test:svc/calc_test.go -> sym:svc/calc.go#Mul",
      "test:svc/calc_test.go -> sym:svc/calc.go#Sub",
      "test:svc/calc_test.go -> sym:svc/calc.go#Validate"
    ]);
  });

  it("does not confirm homemade suite-like assertion methods", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "type NotSuite struct{}",
        "func (n *NotSuite) Equal(expected, actual any) {}",
        "func (n *NotSuite) TestAdd() {",
        "  n.Equal(3, Add(1, 2))",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm suite-like methods that embed a non-canonical Suite type", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import fake \"example.com/repo/internal/suite\"",
        "type CalcSuite struct { fake.Suite }",
        "func (s *CalcSuite) TestAdd() {",
        "  s.Equal(3, Add(1, 2))",
        "}"
      ].join("\n"),
      "internal/suite/suite.go": "package suite\ntype Suite struct{}\nfunc (s *Suite) Equal(expected, actual any) {}\n"
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm spoofed testify suite import paths", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import \"evil.com/stretchr/testify/suite\"",
        "type CalcSuite struct { suite.Suite }",
        "func (s *CalcSuite) TestAdd() {",
        "  s.Equal(3, Add(1, 2))",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("does not confirm suite calls used as expected assertion values", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\nfunc Expected() int { return 3 }\n",
      "svc/add_test.go": [
        "package svc",
        "import \"github.com/stretchr/testify/suite\"",
        "type CalcSuite struct { suite.Suite }",
        "func (s *CalcSuite) TestAdd() {",
        "  s.Equal(Expected(), Add(1, 2))",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/add_test.go -> sym:svc/add.go#Add"]);
  });

  it("does not confirm suite Require chains to non-assertion methods", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/add.go": "package svc\nfunc Add(a, b int) int { return a + b }\n",
      "svc/add_test.go": [
        "package svc",
        "import \"github.com/stretchr/testify/suite\"",
        "type CalcSuite struct { suite.Suite }",
        "func (s *CalcSuite) TestAdd() {",
        "  s.Require().Eventually(func() bool { return Add(1, 2) == 3 })",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });
});
