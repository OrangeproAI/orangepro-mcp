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

  // ── Block-level short-var dataflow (ONE hop, same block): the dominant real-Go
  //    idiom `got, err := F(...)` as a standalone statement, checked by a LATER
  //    if-fail or testify assert on a declared name. Metadata-only widening —
  //    the oracle still re-verifies every edge before anything is Proven. ──
  it("confirms a standalone short-var call checked by a later t.Errorf if-guard", () => {
    const root = repo({
      "svc/calc.go": "package svc\nfunc Compute(a int) int { return a * 2 }\n",
      "svc/calc_test.go": [
        "package svc",
        'import "testing"',
        "func TestCompute(t *testing.T) {",
        "  got := Compute(2)",
        "  if got != 4 {",
        '    t.Errorf("got %d", got)',
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/calc_test.go -> sym:svc/calc.go#Compute"]);
    expect(hardCoverTestNames(root)).toEqual(["TestCompute"]);
    // Exactly one witnessing check → its t.Errorf line is bound for the oracle's line gate.
    expect(hardCoverAssertionLines(root)).toEqual([6]);
  });

  it("confirms the got,err := F(...) idiom with separate err/value checks (single edge)", () => {
    const root = repo({
      "svc/parse.go": "package svc\nfunc ParseChecked(s string) (string, error) { return s, nil }\n",
      "svc/parse_test.go": [
        "package svc",
        'import "testing"',
        "func TestParseChecked(t *testing.T) {",
        '  got, err := ParseChecked("ab1")',
        "  if err != nil {",
        '    t.Fatalf("err %v", err)',
        "  }",
        '  if got != "ab1" {',
        '    t.Errorf("got %s", got)',
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/parse_test.go -> sym:svc/parse.go#ParseChecked"]);
    expect(hardCoverTestNames(root)).toEqual(["TestParseChecked"]);
    // TWO checks witness the call (err + value) — the line is dropped so the
    // oracle's frame-line gate can never refuse the real kill at either check.
    expect(hardCoverAssertionLines(root)).toEqual([undefined]);
  });

  it("confirms a short-var call whose declared name is a later testify assert subject", () => {
    const root = repo({
      "svc/calc.go": "package svc\nfunc Compute(a int) int { return a * 2 }\n",
      "svc/calc_test.go": [
        "package svc",
        "import (",
        '  "testing"',
        '  "github.com/stretchr/testify/require"',
        ")",
        "func TestCompute(t *testing.T) {",
        "  got := Compute(3)",
        "  require.Equal(t, 6, got)",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/calc_test.go -> sym:svc/calc.go#Compute"]);
  });

  it("confirms a short-var result compared in Equal's EXPECTED slot (symmetric equality, Mattermost idiom)", () => {
    const root = repo({
      "svc/enc.go": "package svc\nfunc URLEncode(s string) string { return s }\n",
      "svc/enc_test.go": [
        "package svc",
        "import (",
        '  "testing"',
        '  "github.com/stretchr/testify/require"',
        ")",
        "func TestURLEncode(t *testing.T) {",
        '  encoded := URLEncode("a b")',
        '  require.Equal(t, encoded, "a%20b")',
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/enc_test.go -> sym:svc/enc.go#URLEncode"]);
    expect(hardCoverTestNames(root)).toEqual(["TestURLEncode"]);
  });

  it("does not confirm a short-var call whose result is never checked", () => {
    const root = repo({
      "svc/calc.go": "package svc\nfunc Compute(a int) int { return a * 2 }\n",
      "svc/calc_test.go": [
        "package svc",
        'import "testing"',
        "func TestCompute(t *testing.T) {",
        "  got := Compute(2)",
        "  _ = got",
        '  t.Log("setup only")',
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("refuses ambiguous multi-call short-var statements (single-call discipline)", () => {
    const root = repo({
      "svc/calc.go": "package svc\nfunc Compute(a int) int { return a * 2 }\nfunc Other(a int) int { return a + 1 }\n",
      "svc/calc_test.go": [
        "package svc",
        'import "testing"',
        "func TestCompute(t *testing.T) {",
        "  a, b := Compute(1), Other(2)",
        "  if a != 2 || b != 3 {",
        '    t.Errorf("got %d %d", a, b)',
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("rebinding a name before the check credits the LATEST call only", () => {
    const root = repo({
      "svc/calc.go": "package svc\nfunc Compute(a int) int { return a * 2 }\nfunc Other(a int) int { return a + 1 }\n",
      "svc/calc_test.go": [
        "package svc",
        'import "testing"',
        "func TestCompute(t *testing.T) {",
        "  got := Compute(1)",
        "  got = 0",
        "  got2 := Other(2)",
        "  if got2 != 3 {",
        '    t.Errorf("got %d", got2)',
        "  }",
        "  _ = got",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/calc_test.go -> sym:svc/calc.go#Other"]);
  });

  // ── METHOD targets (first slice): p.M() where p := New(...) is a bare same-package
  //    constructor and M is the package's UNIQUE method name. Package-name-uniqueness
  //    makes all receiver risks (interface/embedded/collision) fail closed. ──
  it("confirms a method call p.Double() bound via p := New() (the phcparser shape)", () => {
    const root = repo({
      "svc/parser.go": [
        "package svc",
        "type Parser struct{ n int }",
        "func New(n int) *Parser { return &Parser{n: n} }",
        "func (p *Parser) Double() int { return p.n * 2 }"
      ].join("\n"),
      "svc/parser_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  \"github.com/stretchr/testify/require\"",
        ")",
        "func TestDouble(t *testing.T) {",
        "  p := New(3)",
        "  got := p.Double()",
        "  require.Equal(t, got, 6)",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/parser_test.go -> sym:svc/parser.go#Parser.Double"]);
    expect(hardCoverTestNames(root)).toEqual(["TestDouble"]);
    const dbl = analyzeRepo(root, { readContent: true }).nodes.find((n) => n.external_id === "sym:svc/parser.go#Parser.Double");
    expect(dbl?.properties.symbol_kind).toBe("method");
    expect(dbl?.properties.member_of).toBe("Parser");
  });

  it("confirms a method via the if-guard shape (got := p.M(); if got != want)", () => {
    const root = repo({
      "svc/parser.go": [
        "package svc",
        "type Parser struct{ n int }",
        "func New(n int) *Parser { return &Parser{n: n} }",
        "func (p *Parser) Double() int { return p.n * 2 }"
      ].join("\n"),
      "svc/parser_test.go": [
        "package svc",
        "import \"testing\"",
        "func TestDouble(t *testing.T) {",
        "  p := New(3)",
        "  if got := p.Double(); got != 6 {",
        "    t.Errorf(\"got %d\", got)",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual(["test:svc/parser_test.go -> sym:svc/parser.go#Parser.Double"]);
  });

  it("binds a method when the constructor has a NESTED-call argument (the real phcparser New(reader) shape)", () => {
    const root = repo({
      "svc/parser.go": [
        "package svc",
        "import \"strings\"",
        "type Parser struct{ r *strings.Reader }",
        "func New(r *strings.Reader) *Parser { return &Parser{r: r} }",
        "func (p *Parser) Len() int { return p.r.Len() }"
      ].join("\n"),
      "svc/parser_test.go": [
        "package svc",
        "import (",
        "  \"strings\"",
        "  \"testing\"",
        ")",
        "func TestLen(t *testing.T) {",
        "  p := New(strings.NewReader(\"abc\"))",
        "  if got := p.Len(); got != 3 {",
        "    t.Errorf(\"got %d\", got)",
        "  }",
        "}"
      ].join("\n")
    });
    // New(strings.NewReader(...)) — nested call in the arg must NOT block receiver-local detection.
    expect(hardCoverEdges(root)).toEqual(["test:svc/parser_test.go -> sym:svc/parser.go#Parser.Len"]);
  });

  it("in-file same-named methods mint DISTINCT receiver-qualified nodes, but the edge still refuses (collision)", () => {
    const root = repo({
      "svc/pair.go": [
        "package svc",
        "type A struct{ n int }",
        "type B struct{ n int }",
        "func NewA(n int) *A { return &A{n: n} }",
        "func (a *A) M() int { return a.n + 1 }",
        "func (b *B) M() int { return b.n + 2 }"
      ].join("\n"),
      "svc/pair_test.go": [
        "package svc",
        "import \"testing\"",
        "func TestAM(t *testing.T) {",
        "  a := NewA(1)",
        "  if got := a.M(); got != 2 {",
        "    t.Errorf(\"got %d\", got)",
        "  }",
        "}"
      ].join("\n")
    });
    // Pre-qualification the two methods collapsed to ONE symbol (wrong denominator);
    // now both nodes exist — and the proof edge still fails closed on the collision
    // (uniqueGoPackageMethod: >1 method named M in the package) until ctor pinning.
    const nodes = analyzeRepo(root, { readContent: true }).nodes;
    expect(nodes.some((n) => n.external_id === "sym:svc/pair.go#A.M")).toBe(true);
    expect(nodes.some((n) => n.external_id === "sym:svc/pair.go#B.M")).toBe(true);
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("refuses two same-named methods on different receivers across files (collision → no edge)", () => {
    const root = repo({
      "svc/a.go": "package svc\ntype A struct{}\nfunc NewA() *A { return &A{} }\nfunc (a *A) M() int { return 1 }\n",
      "svc/b.go": "package svc\ntype B struct{}\nfunc (b *B) M() int { return 2 }\n",
      "svc/a_test.go": [
        "package svc",
        "import \"testing\"",
        "func TestM(t *testing.T) {",
        "  a := NewA()",
        "  if got := a.M(); got != 1 {",
        "    t.Errorf(\"got %d\", got)",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("refuses a method whose receiver var is NOT from a bare same-package constructor", () => {
    const root = repo({
      "svc/svc.go": "package svc\ntype T struct{ n int }\nfunc (t T) M() int { return t.n }\n",
      "svc/svc_test.go": [
        "package svc",
        "import \"testing\"",
        "func TestM(t *testing.T) {",
        "  v := T{n: 1}",
        "  if got := v.M(); got != 1 {",
        "    t.Errorf(\"got %d\", got)",
        "  }",
        "}"
      ].join("\n")
    });
    // v := T{...} is a composite literal, not a bare New() call → not a receiver-local → no edge.
    expect(hardCoverEdges(root)).toEqual([]);
  });

  it("refuses a free-function call whose result feeds a method-less package (import-qualified stays package-resolved)", () => {
    const root = repo({
      "svc/svc.go": "package svc\ntype T struct{}\nfunc (t *T) M() int { return 1 }\n",
      "svc/svc_test.go": [
        "package svc",
        "import (",
        "  \"testing\"",
        "  \"strings\"",
        ")",
        "func TestM(t *testing.T) {",
        "  got := strings.Repeat(\"x\", 2)",
        "  if got != \"xx\" {",
        "    t.Errorf(\"got %s\", got)",
        "  }",
        "}"
      ].join("\n")
    });
    // strings.Repeat is an imported package func, not a same-package method → no hard edge.
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
