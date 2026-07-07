import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";

const dirs: string[] = [];

beforeAll(async () => {
  await preloadTreeSitter(["java"]);
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-javaproof-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function hardProofEdges(root: string): string[] {
  return analyzeRepo(root, { readContent: true })
    .edges.filter((e) => (e.relationship_type === "COVERS" || e.relationship_type === "TESTED_BY") && e.evidence_strength === "hard")
    .map((e) => `${e.from_external_id} -${e.relationship_type}-> ${e.to_external_id}`)
    .sort();
}

/** Hard proof edges with the per-edge `test_name` metadata (the @Test method auto-drive selects). */
function hardProofEdgesWithTestName(root: string): Array<{ edge: string; test_name: unknown }> {
  return analyzeRepo(root, { readContent: true })
    .edges.filter((e) => (e.relationship_type === "COVERS" || e.relationship_type === "TESTED_BY") && e.evidence_strength === "hard")
    .map((e) => ({ edge: `${e.from_external_id} -${e.relationship_type}-> ${e.to_external_id}`, test_name: e.properties?.test_name }))
    .sort((a, b) => a.edge.localeCompare(b.edge));
}

describe("Java hard proof", () => {
  it("confirms a same-package method directly asserted by JUnit 5", () => {
    const root = repo({
      "src/main/java/com/acme/Calc.java": [
        "package com.acme;",
        "public class Calc {",
        "  public static int add(int a, int b) { return a + b; }",
        "}"
      ].join("\n"),
      "src/test/java/com/acme/CalcTest.java": [
        "package com.acme;",
        "import org.junit.jupiter.api.Test;",
        "import static org.junit.jupiter.api.Assertions.assertEquals;",
        "class CalcTest {",
        "  @Test void adds() {",
        "    assertEquals(3, Calc.add(1, 2));",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardProofEdges(root)).toEqual([
      "sym:src/main/java/com/acme/Calc.java#add -TESTED_BY-> test:src/test/java/com/acme/CalcTest.java",
      "test:src/test/java/com/acme/CalcTest.java -COVERS-> sym:src/main/java/com/acme/Calc.java#add"
    ]);
  });

  it("confirms a same-package constructor directly asserted by JUnit 4", () => {
    const root = repo({
      "src/main/java/com/acme/Widget.java": ["package com.acme;", "public class Widget {", "  public Widget() {}", "}"].join("\n"),
      "src/test/java/com/acme/WidgetTest.java": [
        "package com.acme;",
        "import org.junit.Test;",
        "import static org.junit.Assert.assertNotNull;",
        "public class WidgetTest {",
        "  @Test public void constructs() {",
        "    assertNotNull(new Widget());",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardProofEdges(root)).toEqual([
      "sym:src/main/java/com/acme/Widget.java#Widget -TESTED_BY-> test:src/test/java/com/acme/WidgetTest.java",
      "test:src/test/java/com/acme/WidgetTest.java -COVERS-> sym:src/main/java/com/acme/Widget.java#Widget"
    ]);
  });

  it("does not confirm homemade assert-like methods", () => {
    const root = repo({
      "src/main/java/com/acme/Calc.java": "package com.acme;\npublic class Calc { public static int add(int a, int b) { return a + b; } }\n",
      "src/test/java/com/acme/CalcTest.java": [
        "package com.acme;",
        "import org.junit.jupiter.api.Test;",
        "import static org.junit.jupiter.api.Assertions.assertEquals;",
        "class CalcTest {",
        "  void assertEquals(int expected, int actual) {}",
        "  @Test void adds() {",
        "    assertEquals(3, Calc.add(1, 2));",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardProofEdges(root)).toEqual([]);
  });

  it("does not confirm product calls used as expected assertion values", () => {
    const root = repo({
      "src/main/java/com/acme/Calc.java": [
        "package com.acme;",
        "public class Calc {",
        "  public static int expected() { return 3; }",
        "  public static int add(int a, int b) { return a + b; }",
        "}"
      ].join("\n"),
      "src/test/java/com/acme/CalcTest.java": [
        "package com.acme;",
        "import org.junit.jupiter.api.Test;",
        "import static org.junit.jupiter.api.Assertions.assertEquals;",
        "class CalcTest {",
        "  @Test void expectedValueOnly() {",
        "    assertEquals(Calc.expected(), 3);",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardProofEdges(root)).toEqual([]);
  });

  it("does not confirm cross-package ambiguous product calls", () => {
    const root = repo({
      "src/main/java/com/acme/left/Calc.java": "package com.acme.left;\npublic class Calc { public static int add(int a, int b) { return a + b; } }\n",
      "src/main/java/com/acme/right/Calc.java": "package com.acme.right;\npublic class Calc { public static int add(int a, int b) { return a + b; } }\n",
      "src/test/java/com/acme/CalcTest.java": [
        "package com.acme;",
        "import com.acme.left.Calc;",
        "import org.junit.jupiter.api.Test;",
        "import static org.junit.jupiter.api.Assertions.assertEquals;",
        "class CalcTest {",
        "  @Test void adds() {",
        "    assertEquals(3, Calc.add(1, 2));",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardProofEdges(root)).toEqual([]);
  });

  it("does not confirm assertionless product calls", () => {
    const root = repo({
      "src/main/java/com/acme/Calc.java": "package com.acme;\npublic class Calc { public static int add(int a, int b) { return a + b; } }\n",
      "src/test/java/com/acme/CalcTest.java": [
        "package com.acme;",
        "import org.junit.jupiter.api.Test;",
        "class CalcTest {",
        "  @Test void adds() {",
        "    Calc.add(1, 2);",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardProofEdges(root)).toEqual([]);
  });

  it("does not confirm unsupported reflection-style calls", () => {
    const root = repo({
      "src/main/java/com/acme/Widget.java": "package com.acme;\npublic class Widget { public Widget() {} }\n",
      "src/test/java/com/acme/WidgetTest.java": [
        "package com.acme;",
        "import org.junit.jupiter.api.Test;",
        "import static org.junit.jupiter.api.Assertions.assertNotNull;",
        "class WidgetTest {",
        "  @Test void constructsReflectively() throws Exception {",
        "    assertNotNull(Class.forName(\"com.acme.Widget\").getConstructor().newInstance());",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardProofEdges(root)).toEqual([]);
  });

  // Spring/Mockito unit shape: a @BeforeEach-injected FIELD is the receiver. The field's DECLARED
  // type is the receiver type (no dataflow), and the enclosing @Test method rides on the edge as
  // `test_name` so keyless auto-drive can select `mvn test -Dtest=Class#method`.
  it("confirms a field-receiver method asserted directly by JUnit, carrying the @Test method name", () => {
    const root = repo({
      "src/main/java/com/acme/Fmt.java": [
        "package com.acme;",
        "public class Fmt {",
        "  public String format(int n) { return Integer.toString(n); }",
        "}"
      ].join("\n"),
      "src/test/java/com/acme/FmtTest.java": [
        "package com.acme;",
        "import org.junit.jupiter.api.BeforeEach;",
        "import org.junit.jupiter.api.Test;",
        "import static org.junit.jupiter.api.Assertions.assertEquals;",
        "class FmtTest {",
        "  private Fmt fmt;",
        "  @BeforeEach void setup() { this.fmt = new Fmt(); }",
        "  @Test void testFormat() {",
        "    assertEquals(\"3\", this.fmt.format(3));",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardProofEdgesWithTestName(root)).toEqual([
      { edge: "sym:src/main/java/com/acme/Fmt.java#format -TESTED_BY-> test:src/test/java/com/acme/FmtTest.java", test_name: "testFormat" },
      { edge: "test:src/test/java/com/acme/FmtTest.java -COVERS-> sym:src/main/java/com/acme/Fmt.java#format", test_name: "testFormat" }
    ]);
  });

  // AssertJ + local-var dataflow: the target call result is bound to a LOCAL, then asserted via
  // `assertThat(local).isEqualTo(...)`. This is the canonical PetTypeFormatterTests.testPrint shape.
  it("confirms a field-receiver method via AssertJ on a local var, carrying the @Test method name", () => {
    const root = repo({
      "src/main/java/com/acme/Fmt.java": [
        "package com.acme;",
        "public class Fmt {",
        "  public String print(int n) { return Integer.toString(n); }",
        "}"
      ].join("\n"),
      "src/test/java/com/acme/FmtTest.java": [
        "package com.acme;",
        "import org.junit.jupiter.api.BeforeEach;",
        "import org.junit.jupiter.api.Test;",
        "import static org.assertj.core.api.Assertions.assertThat;",
        "class FmtTest {",
        "  private Fmt fmt;",
        "  @BeforeEach void setup() { this.fmt = new Fmt(); }",
        "  @Test void testPrint() {",
        "    String r = this.fmt.print(3);",
        "    assertThat(r).isEqualTo(\"3\");",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardProofEdgesWithTestName(root)).toEqual([
      { edge: "sym:src/main/java/com/acme/Fmt.java#print -TESTED_BY-> test:src/test/java/com/acme/FmtTest.java", test_name: "testPrint" },
      { edge: "test:src/test/java/com/acme/FmtTest.java -COVERS-> sym:src/main/java/com/acme/Fmt.java#print", test_name: "testPrint" }
    ]);
  });

  // LOAD-BEARING: a field whose declared type name is ambiguous across packages must NOT attribute
  // to either owner. `resolveJavaProofTarget` refuses a non-unique class → no edge, no false-Proven.
  it("does not confirm a field-receiver method when the declared type is cross-package ambiguous", () => {
    const root = repo({
      "src/main/java/com/acme/left/Fmt.java": "package com.acme.left;\npublic class Fmt { public String print(int n) { return \"\"; } }\n",
      "src/main/java/com/acme/right/Fmt.java": "package com.acme.right;\npublic class Fmt { public String print(int n) { return \"\"; } }\n",
      "src/test/java/com/acme/FmtTest.java": [
        "package com.acme;",
        "import com.acme.left.Fmt;",
        "import org.junit.jupiter.api.Test;",
        "import static org.assertj.core.api.Assertions.assertThat;",
        "class FmtTest {",
        "  private Fmt fmt;",
        "  @Test void testPrint() {",
        "    String r = this.fmt.print(3);",
        "    assertThat(r).isEqualTo(\"3\");",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardProofEdges(root)).toEqual([]);
  });

  // A field asserted whose declared type does NOT declare the called method → javaClassDeclaresMethod
  // is false → no edge (the extractor names a candidate; the analyzer refuses the wrong owner).
  it("does not confirm a field-receiver method the declared type does not declare", () => {
    const root = repo({
      "src/main/java/com/acme/Fmt.java": "package com.acme;\npublic class Fmt { public String print(int n) { return \"\"; } }\n",
      "src/test/java/com/acme/FmtTest.java": [
        "package com.acme;",
        "import org.junit.jupiter.api.Test;",
        "import static org.assertj.core.api.Assertions.assertThat;",
        "class FmtTest {",
        "  private Fmt fmt;",
        "  @Test void testFormat() {",
        "    String r = this.fmt.format(3);", // Fmt has no `format` method
        "    assertThat(r).isEqualTo(\"3\");",
        "  }",
        "}"
      ].join("\n")
    });
    expect(hardProofEdges(root)).toEqual([]);
  });
});
