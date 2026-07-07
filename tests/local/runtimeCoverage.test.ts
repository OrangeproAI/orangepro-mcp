import { describe, it, expect, beforeAll, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { applyRuntimeCoverage } from "../../src/local/analyze/coverage.js";
import { detectCoverageArtifacts, prepareRuntimeCoverage, suggestCoverageCommands } from "../../src/local/analyze/coverageArtifacts.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";

const dirs: string[] = [];

beforeAll(async () => {
  await preloadTreeSitter(["go", "python", "java"]);
});

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-runtime-cov-"));
  dirs.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("runtime coverage ingestion", () => {
  it("maps Go coverprofile ranges to denominator CodeSymbols without creating proof edges", () => {
    const root = repo({
      "svc/math.go": [
        "package svc",
        "func Add(a, b int) int {",
        "  return a + b",
        "}",
        "func Sub(a, b int) int {",
        "  return a - b",
        "}"
      ].join("\n"),
      "coverage.out": ["mode: set", "svc/math.go:2.24,4.2 1 1"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    const add = graph.nodes.find((n) => n.external_id === "sym:svc/math.go#Add");
    const sub = graph.nodes.find((n) => n.external_id === "sym:svc/math.go#Sub");

    expect(add?.properties.runtime_covered).toBe(true);
    expect(sub?.properties.runtime_covered).toBeUndefined();
    expect(graph.analysis.runtime_coverage).toMatchObject({
      total_eligible_symbols: 2,
      symbols_with_spans: 2,
      covered_symbols: 1,
      by_language: { go: { eligible: 2, symbols_with_spans: 2, covered: 1, covered_pct: 50 } }
    });
    expect(graph.edges.filter((e) => e.relationship_type === "COVERS" || e.relationship_type === "TESTED_BY")).toEqual([]);
  });

  it("detects generated Go coverprofiles under .orangepro/coverage", () => {
    const root = repo({
      "svc/math.go": ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n"),
      ".orangepro/coverage/go-root.coverprofile": ["mode: set", "svc/math.go:2.24,4.2 1 1"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:svc/math.go#Add")?.properties.runtime_covered).toBe(true);
    expect(graph.analysis.runtime_coverage?.artifacts).toEqual([
      { path: ".orangepro/coverage/go-root.coverprofile", format: "go-coverprofile", files: 1, covered_ranges: 1 }
    ]);
  });

  it("detects generated coverage.py XML under .orangepro/coverage", () => {
    const root = repo({
      "pkg/calc.py": ["def add(a, b):", "    return a + b", ""].join("\n"),
      ".orangepro/coverage/python-root.coverage.xml": [
        '<?xml version="1.0" ?>',
        "<coverage>",
        "  <packages><package><classes>",
        '    <class filename="pkg/calc.py"><lines>',
        '      <line number="2" hits="1"/>',
        "    </lines></class>",
        "  </classes></package></packages>",
        "</coverage>"
      ].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:pkg/calc.py#add")?.properties.runtime_covered).toBe(true);
    expect(graph.analysis.runtime_coverage?.artifacts).toEqual([
      { path: ".orangepro/coverage/python-root.coverage.xml", format: "coverage-py", files: 1, covered_ranges: 1 }
    ]);
    expect(graph.edges.filter((e) => e.relationship_type === "COVERS" || e.relationship_type === "TESTED_BY")).toEqual([]);
  });

  it("suggests module-relative Go coverage commands that write into .orangepro/coverage", () => {
    const root = repo({
      "go.mod": "module example.com/root\n\ngo 1.22\n",
      "sub/go.mod": "module example.com/sub\n\ngo 1.22\n"
    });

    expect(suggestCoverageCommands(root).filter((c) => c.language === "go")).toEqual([
      {
        language: "go",
        cwd: ".",
        command: "go test ./... -coverprofile=.orangepro/coverage/go-root.coverprofile",
        artifact_path: ".orangepro/coverage/go-root.coverprofile",
        reason: "Go has built-in coverage; no external service or key is required."
      },
      {
        language: "go",
        cwd: "sub",
        command: "go test ./... -coverprofile=../.orangepro/coverage/go-sub.coverprofile",
        artifact_path: ".orangepro/coverage/go-sub.coverprofile",
        reason: "Go has built-in coverage; no external service or key is required."
      }
    ]);
  });

  it("suggests Python coverage.py XML commands that write into .orangepro/coverage", () => {
    const root = repo({
      "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
      "pkg/pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = ['tests']\n"
    });

    expect(suggestCoverageCommands(root).filter((c) => c.language === "python")).toEqual([
      {
        language: "python",
        cwd: ".",
        command: "python3 -m pytest --cov=. --cov-report=xml:.orangepro/coverage/python-root.coverage.xml",
        artifact_path: ".orangepro/coverage/python-root.coverage.xml",
        reason: "coverage.py/pytest-cov can emit XML locally; no external service or key is required."
      }
    ]);
  });

  it("suggests nested Python coverage commands when no root pytest project is present", () => {
    const root = repo({
      "pkg/pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = ['tests']\n"
    });

    expect(suggestCoverageCommands(root).filter((c) => c.language === "python")).toEqual([
      {
        language: "python",
        cwd: "pkg",
        command: "python3 -m pytest --cov=. --cov-report=xml:../.orangepro/coverage/python-pkg.coverage.xml",
        artifact_path: ".orangepro/coverage/python-pkg.coverage.xml",
        reason: "coverage.py/pytest-cov can emit XML locally; no external service or key is required."
      }
    ]);
  });

  it("suggests Maven and Gradle JaCoCo commands for Java coverage", () => {
    const root = repo({
      "pom.xml": "<project />\n",
      "tools/build.gradle.kts": "plugins { jacoco }\n"
    });

    expect(suggestCoverageCommands(root).filter((c) => c.language === "java")).toEqual([
      {
        language: "java",
        cwd: ".",
        command: "mvn test org.jacoco:jacoco-maven-plugin:0.8.12:report",
        artifact_path: "target/site/jacoco/jacoco.xml",
        reason: "JaCoCo runs locally through Maven; no SonarQube key is required."
      },
      {
        language: "java",
        cwd: "tools",
        command: "gradle test jacocoTestReport",
        artifact_path: "tools/build/reports/jacoco/test/jacocoTestReport.xml",
        reason: "JaCoCo runs locally through Gradle; no SonarQube key is required."
      }
    ]);
  });

  it("detects nested Go coverprofiles from existing repo coverage commands", () => {
    const root = repo({
      "server/cover.out": "mode: atomic\nserver/app.go:1.1,2.1 1 1\n",
      "webapp/coverage/lcov.info": "TN:\n"
    });

    expect(detectCoverageArtifacts(root)).toContainEqual({
      path: "server/cover.out",
      language: "go",
      format: "go-coverprofile",
      ingestible: true,
      source: "existing"
    });
    expect(detectCoverageArtifacts(root)).toContainEqual({
      path: "webapp/coverage/lcov.info",
      language: "tsjs",
      format: "lcov",
      ingestible: true,
      source: "existing"
    });
  });

  it("generates Go coverage with an injectable runner", () => {
    const root = repo({
      "go.mod": "module example.com/root\n\ngo 1.22\n",
      "svc/math.go": ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n")
    });
    const calls: string[] = [];
    const result = prepareRuntimeCoverage(root, {
      generate: true,
      runner: (cwd, command, args) => {
        calls.push(`${cwd}:${command} ${args.join(" ")}`);
        writeFileSync(join(root, ".orangepro/coverage/go-root.coverprofile"), ["mode: set", "svc/math.go:2.24,4.2 1 1"].join("\n"));
        return { status: 0, stdout: "", stderr: "" };
      }
    });

    expect(calls).toHaveLength(1);
    expect(result.generated).toHaveLength(1);
    expect(result.generated[0]).toMatchObject({ language: "go", module_dir: ".", artifact_path: ".orangepro/coverage/go-root.coverprofile", ok: true });
    expect(result.generated[0].command).toContain("go test ./... -coverprofile=");
    expect(result.generated[0].command).toContain(".orangepro/coverage/go-root.coverprofile");
    expect(result.artifacts.map((a) => a.path)).toContain(".orangepro/coverage/go-root.coverprofile");
  });

  it("generates Python coverage.py XML with an injectable runner", () => {
    const root = repo({
      "pyproject.toml": "[tool.pytest.ini_options]\ntestpaths = ['tests']\n",
      "pkg/calc.py": ["def add(a, b):", "    return a + b", ""].join("\n")
    });
    const calls: string[] = [];
    const result = prepareRuntimeCoverage(root, {
      generate: true,
      runner: (cwd, command, args) => {
        calls.push(`${cwd}:${command} ${args.join(" ")}`);
        writeFileSync(
          join(root, ".orangepro/coverage/python-root.coverage.xml"),
          [
            '<?xml version="1.0" ?>',
            "<coverage>",
            "  <packages><package><classes>",
            '    <class filename="pkg/calc.py"><lines>',
            '      <line number="2" hits="1"/>',
            "    </lines></class>",
            "  </classes></package></packages>",
            "</coverage>"
          ].join("\n")
        );
        return { status: 0, stdout: "", stderr: "" };
      }
    });

    expect(calls).toEqual([`${root}:python3 -m pytest --cov=. --cov-report=xml:${join(root, ".orangepro/coverage/python-root.coverage.xml")}`]);
    expect(result.generated).toContainEqual(expect.objectContaining({
      language: "python",
      module_dir: ".",
      artifact_path: ".orangepro/coverage/python-root.coverage.xml",
      ok: true
    }));
    expect(result.artifacts).toContainEqual({
      path: ".orangepro/coverage/python-root.coverage.xml",
      language: "python",
      format: "coverage-py",
      ingestible: true,
      source: "generated"
    });
  });

  it("generates Maven JaCoCo XML with an injectable runner", () => {
    const root = repo({
      "pom.xml": "<project />\n",
      "src/main/java/com/acme/Calc.java": ["package com.acme;", "class Calc {", "  int add() { return 1; }", "}"].join("\n")
    });
    const calls: string[] = [];
    const result = prepareRuntimeCoverage(root, {
      generate: true,
      runner: (cwd, command, args) => {
        calls.push(`${cwd}:${command} ${args.join(" ")}`);
        mkdirSync(join(root, "target/site/jacoco"), { recursive: true });
        writeFileSync(
          join(root, "target/site/jacoco/jacoco.xml"),
          [
            "<report>",
            '  <package name="com/acme">',
            '    <sourcefile name="Calc.java">',
            '      <line nr="3" mi="0" ci="1" mb="0" cb="0"/>',
            "    </sourcefile>",
            "  </package>",
            "</report>"
          ].join("\n")
        );
        return { status: 0, stdout: "", stderr: "" };
      }
    });

    expect(calls).toEqual([`${root}:mvn test org.jacoco:jacoco-maven-plugin:0.8.12:report`]);
    expect(result.generated).toContainEqual(expect.objectContaining({
      language: "java",
      module_dir: ".",
      command: "mvn test org.jacoco:jacoco-maven-plugin:0.8.12:report",
      artifact_path: "target/site/jacoco/jacoco.xml",
      ok: true
    }));
    expect(result.artifacts).toContainEqual({
      path: "target/site/jacoco/jacoco.xml",
      language: "java",
      format: "jacoco",
      ingestible: true,
      source: "existing"
    });
  });

  it("reports Java coverage generation failures without creating artifacts", () => {
    const root = repo({
      "build.gradle": "plugins { id 'java'; id 'jacoco' }\n"
    });
    const result = prepareRuntimeCoverage(root, {
      generate: true,
      runner: () => ({ status: 1, stdout: "", stderr: "jacoco task unavailable" })
    });

    expect(result.generated).toHaveLength(1);
    expect(result.generated[0]).toMatchObject({
      language: "java",
      module_dir: ".",
      command: "gradle test jacocoTestReport",
      ok: false,
      reason: "jacoco task unavailable"
    });
    expect(result.artifacts).toEqual([]);
  });

  it("reports Go coverage generation failures without creating artifacts", () => {
    const root = repo({
      "go.mod": "module example.com/root\n\ngo 1.22\n",
      "svc/math.go": ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n")
    });
    const result = prepareRuntimeCoverage(root, {
      generate: true,
      runner: () => ({ status: 1, stdout: "", stderr: "database unavailable" })
    });

    expect(result.generated).toHaveLength(1);
    expect(result.generated[0]).toMatchObject({ language: "go", module_dir: ".", ok: false, reason: "database unavailable" });
    expect(result.artifacts).toEqual([]);
  });

  it("keeps partial Go coverage artifacts when tests fail after writing coverage", () => {
    const root = repo({
      "go.mod": "module example.com/root\n\ngo 1.22\n",
      "svc/math.go": ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n")
    });
    const result = prepareRuntimeCoverage(root, {
      generate: true,
      runner: () => {
        writeFileSync(join(root, ".orangepro/coverage/go-root.coverprofile"), ["mode: set", "svc/math.go:2.24,4.2 1 1"].join("\n"));
        return { status: 1, stdout: "FAIL", stderr: "smtp unavailable" };
      }
    });

    expect(result.generated).toHaveLength(1);
    expect(result.generated[0]).toMatchObject({
      language: "go",
      module_dir: ".",
      artifact_path: ".orangepro/coverage/go-root.coverprofile",
      ok: false,
      partial: true,
      reason: "smtp unavailable\nFAIL"
    });
    expect(result.artifacts.map((a) => a.path)).toContain(".orangepro/coverage/go-root.coverprofile");
  });

  it("discovers and runs nested TS/JS coverage scripts that emit lcov", () => {
    const root = repo({
      "webapp/channels/package.json": JSON.stringify({
        scripts: {
          test: "jest",
          "test-ci": "jest --ci --coverage",
          "test:watch": "jest --watch"
        },
        devDependencies: { jest: "^29.0.0" }
      }),
      "webapp/channels/package-lock.json": "{}\n"
    });
    const calls: string[] = [];
    const result = prepareRuntimeCoverage(root, {
      generate: true,
      runner: (cwd, command, args) => {
        calls.push(`${cwd}:${command} ${args.join(" ")}`);
        mkdirSync(join(root, "webapp/channels/coverage"), { recursive: true });
        writeFileSync(join(root, "webapp/channels/coverage/lcov.info"), "TN:\n");
        return { status: 0, stdout: "", stderr: "" };
      }
    });

    expect(calls).toEqual([`${join(root, "webapp/channels")}:npm run test-ci`]);
    expect(result.generated).toContainEqual(expect.objectContaining({
      language: "tsjs",
      module_dir: "webapp/channels",
      command: "npm run test-ci",
      artifact_path: "webapp/channels/coverage/lcov.info",
      ok: true
    }));
    expect(result.suggested_commands).toContainEqual(expect.objectContaining({
      language: "tsjs",
      cwd: "webapp/channels",
      command: "npm run test-ci",
      artifact_path: "webapp/channels/coverage/lcov.info"
    }));
    expect(result.artifacts).toContainEqual({
      path: "webapp/channels/coverage/lcov.info",
      language: "tsjs",
      format: "lcov",
      ingestible: true,
      source: "existing"
    });
  });

  it("does not treat generic TS/JS test-ci scripts as coverage producers", () => {
    const root = repo({
      "webapp/package.json": JSON.stringify({
        workspaces: ["platform/client"],
        scripts: { "test-ci": "npm run test-ci --workspaces --if-present" }
      }),
      "webapp/platform/client/package.json": JSON.stringify({
        scripts: { "test-ci": "jest --ci --forceExit" },
        devDependencies: { jest: "^29.0.0" }
      })
    });
    const calls: string[] = [];
    const result = prepareRuntimeCoverage(root, {
      generate: true,
      runner: (cwd, command, args) => {
        calls.push(`${cwd}:${command} ${args.join(" ")}`);
        return { status: 0, stdout: "", stderr: "" };
      }
    });

    expect(calls).toEqual([]);
    expect(result.generated).toEqual([]);
    expect(result.suggested_commands.filter((c) => c.language === "tsjs")).toEqual([]);
  });

  it("normalizes Go module-path coverage files to workspace files", () => {
    const root = repo({
      "go.mod": "module example.com/repo\n\ngo 1.22\n",
      "svc/math.go": ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n"),
      "coverage.out": ["mode: count", "example.com/repo/svc/math.go:2.24,4.2 1 3"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:svc/math.go#Add")?.properties.runtime_covered).toBe(true);
    expect(graph.analysis.runtime_coverage?.artifacts).toEqual([
      { path: "coverage.out", format: "go-coverprofile", files: 1, covered_ranges: 1 }
    ]);
  });

  it("does not deflate runtime coverage with languages that have no ingested artifact", () => {
    const root = repo({
      "svc/math.go": [
        "package svc",
        "func Add(a, b int) int {",
        "  return a + b",
        "}",
        "func Sub(a, b int) int {",
        "  return a - b",
        "}"
      ].join("\n"),
      "web/app.ts": "export function renderApp() { return 1; }\n",
      "coverage.out": ["mode: set", "svc/math.go:2.24,4.2 1 1"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:web/app.ts#renderApp")).toBeTruthy();
    expect(graph.analysis.runtime_coverage).toMatchObject({
      total_eligible_symbols: 2,
      symbols_with_spans: 2,
      covered_symbols: 1,
      covered_pct: 50,
      by_language: { go: { eligible: 2, symbols_with_spans: 2, covered: 1, covered_pct: 50 } }
    });
    expect(graph.analysis.runtime_coverage?.by_language.tsjs).toBeUndefined();
  });

  it("maps lcov line hits to TypeScript/JavaScript symbols without creating proof edges", () => {
    const root = repo({
      "src/math.ts": [
        "export function add(a: number, b: number) {",
        "  return a + b;",
        "}",
        "export function sub(a: number, b: number) {",
        "  return a - b;",
        "}"
      ].join("\n"),
      "coverage/lcov.info": ["TN:", "SF:src/math.ts", "DA:2,1", "DA:5,0", "end_of_record"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:src/math.ts#add")?.properties.runtime_covered).toBe(true);
    expect(graph.nodes.find((n) => n.external_id === "sym:src/math.ts#sub")?.properties.runtime_covered).toBeUndefined();
    expect(graph.nodes.find((n) => n.external_id === "sym:src/math.ts#add")?.properties.runtime_coverage_formats).toEqual(["lcov"]);
    expect(graph.edges.filter((e) => e.relationship_type === "COVERS" || e.relationship_type === "TESTED_BY")).toEqual([]);
    expect(graph.analysis.runtime_coverage).toMatchObject({
      artifacts: [{ path: "coverage/lcov.info", format: "lcov", files: 1, covered_ranges: 1 }],
      by_language: { tsjs: { eligible: 2, symbols_with_spans: 2, covered: 1, covered_pct: 50 } }
    });
  });

  it("maps nested lcov source paths relative to the package root", () => {
    const root = repo({
      "webapp/channels/src/app.ts": [
        "export function loadUser() {",
        "  return 1;",
        "}",
        "export function saveUser() {",
        "  return 2;",
        "}"
      ].join("\n"),
      "other/src/app.ts": [
        "export function loadUser() {",
        "  return 3;",
        "}"
      ].join("\n"),
      "webapp/channels/coverage/lcov.info": ["TN:", "SF:src/app.ts", "DA:2,1", "DA:5,0", "end_of_record"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:webapp/channels/src/app.ts#loadUser")?.properties.runtime_covered).toBe(true);
    expect(graph.nodes.find((n) => n.external_id === "sym:webapp/channels/src/app.ts#saveUser")?.properties.runtime_covered).toBeUndefined();
    expect(graph.nodes.find((n) => n.external_id === "sym:other/src/app.ts#loadUser")?.properties.runtime_covered).toBeUndefined();
    expect(graph.analysis.runtime_coverage?.artifacts).toEqual([
      { path: "webapp/channels/coverage/lcov.info", format: "lcov", files: 1, covered_ranges: 1 }
    ]);
  });

  it("maps coverage.py XML line hits to Python symbols", () => {
    const root = repo({
      "pkg/calc.py": ["def add(a, b):", "    return a + b", "", "def sub(a, b):", "    return a - b"].join("\n"),
      "coverage.xml": [
        '<?xml version="1.0" ?>',
        '<coverage>',
        "  <packages><package><classes>",
        '    <class filename="pkg/calc.py"><lines>',
        '      <line number="2" hits="3"/>',
        '      <line number="5" hits="0"/>',
        "    </lines></class>",
        "  </classes></package></packages>",
        "</coverage>"
      ].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:pkg/calc.py#add")?.properties.runtime_covered).toBe(true);
    expect(graph.nodes.find((n) => n.external_id === "sym:pkg/calc.py#sub")?.properties.runtime_covered).toBeUndefined();
    expect(graph.analysis.runtime_coverage).toMatchObject({
      artifacts: [{ path: "coverage.xml", format: "coverage-py", files: 1, covered_ranges: 1 }],
      by_language: { python: { eligible: 2, symbols_with_spans: 2, covered: 1, covered_pct: 50 } }
    });
  });

  it("maps JaCoCo XML line hits to Java symbols by unique package path", () => {
    const root = repo({
      "src/main/java/com/acme/Calc.java": [
        "package com.acme;",
        "class Calc {",
        "  int add(int a, int b) {",
        "    return a + b;",
        "  }",
        "  int sub(int a, int b) {",
        "    return a - b;",
        "  }",
        "}"
      ].join("\n"),
      "target/site/jacoco/jacoco.xml": [
        "<report>",
        '  <package name="com/acme">',
        '    <sourcefile name="Calc.java">',
        '      <line nr="4" mi="0" ci="2" mb="0" cb="0"/>',
        '      <line nr="7" mi="2" ci="0" mb="0" cb="0"/>',
        "    </sourcefile>",
        "  </package>",
        "</report>"
      ].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    const covered = graph.nodes.filter((n) => n.kind === "CodeSymbol" && n.properties.file === "src/main/java/com/acme/Calc.java" && n.properties.runtime_covered === true);
    expect(covered.map((n) => n.title)).toContain("add");
    expect(graph.nodes.find((n) => n.external_id === "sym:src/main/java/com/acme/Calc.java#sub")?.properties.runtime_covered).toBeUndefined();
    expect(graph.analysis.runtime_coverage).toMatchObject({
      artifacts: [{ path: "target/site/jacoco/jacoco.xml", format: "jacoco", files: 1, covered_ranges: 1 }],
      by_language: { java: { covered: 2 } }
    });
    expect(graph.edges.filter((e) => e.relationship_type === "COVERS" || e.relationship_type === "TESTED_BY")).toEqual([]);
  });

  it("does not credit ambiguous lcov suffix matches", () => {
    const root = repo({
      "a/pkg/calc.ts": "export function add() { return 1; }\n",
      "b/pkg/calc.ts": "export function add() { return 2; }\n",
      "coverage/lcov.info": ["TN:", "SF:pkg/calc.ts", "DA:1,1", "end_of_record"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.filter((n) => n.kind === "CodeSymbol" && n.properties.runtime_covered === true)).toEqual([]);
    expect(graph.analysis.runtime_coverage).toMatchObject({
      artifacts: [],
      skipped_artifacts: [
        {
          path: "coverage/lcov.info",
          format: "lcov",
          reason: "coverage artifact had positive ranges, but none matched scanned TypeScript/JavaScript files"
        }
      ],
      covered_symbols: 0,
      covered_pct: 0
    });
  });

  it("does not credit module-path Go coverage by suffix when go.mod is unavailable", () => {
    const root = repo({
      "svc/math.go": ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n"),
      "coverage.out": ["mode: count", "example.com/repo/svc/math.go:2.24,4.2 1 3"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:svc/math.go#Add")?.properties.runtime_covered).toBeUndefined();
    expect(graph.analysis.runtime_coverage).toMatchObject({
      artifacts: [],
      skipped_artifacts: [
        {
          path: "coverage.out",
          format: "go-coverprofile",
          reason: "coverage artifact had positive ranges, but none matched scanned Go files"
        }
      ],
      covered_symbols: 0,
      covered_pct: 0
    });
  });

  it("does not credit foreign same-tail module coverage without go.mod", () => {
    const root = repo({
      "svc/math.go": ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n"),
      "coverage.out": ["mode: count", "foreign.example/project/svc/math.go:2.24,4.2 1 3"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:svc/math.go#Add")?.properties.runtime_covered).toBeUndefined();
    expect(graph.analysis.runtime_coverage?.covered_symbols).toBe(0);
  });

  it("does not choose between duplicate module-name worktrees", () => {
    const root = repo({
      "go.mod": "module shared.example/repo\n\ngo 1.22\n",
      "svc/math.go": ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n"),
      "sub/go.mod": "module shared.example/repo\n\ngo 1.22\n",
      "sub/svc/math.go": ["package svc", "func SubAdd(a, b int) int {", "  return a + b", "}"].join("\n"),
      "coverage.out": ["mode: count", "shared.example/repo/svc/math.go:2.24,4.2 1 3"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:svc/math.go#Add")?.properties.runtime_covered).toBeUndefined();
    expect(graph.nodes.find((n) => n.external_id === "sym:sub/svc/math.go#SubAdd")?.properties.runtime_covered).toBeUndefined();
    expect(graph.analysis.runtime_coverage).toMatchObject({
      artifacts: [],
      covered_symbols: 0,
      covered_pct: 0
    });
  });

  it("normalizes distinct nested Go modules to their owning files", () => {
    const root = repo({
      "go.mod": "module root.example/repo\n\ngo 1.22\n",
      "svc/root.go": ["package svc", "func Root(a, b int) int {", "  return a + b", "}"].join("\n"),
      "sub/go.mod": "module child.example/repo\n\ngo 1.22\n",
      "sub/svc/child.go": ["package svc", "func Child(a, b int) int {", "  return a + b", "}"].join("\n"),
      "coverage.out": [
        "mode: count",
        "root.example/repo/svc/root.go:2.26,4.2 1 3",
        "child.example/repo/svc/child.go:2.27,4.2 1 2"
      ].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:svc/root.go#Root")?.properties.runtime_covered).toBe(true);
    expect(graph.nodes.find((n) => n.external_id === "sym:sub/svc/child.go#Child")?.properties.runtime_covered).toBe(true);
    expect(graph.analysis.runtime_coverage).toMatchObject({
      artifacts: [{ path: "coverage.out", format: "go-coverprofile", files: 2, covered_ranges: 2 }],
      covered_symbols: 2,
      covered_pct: 100
    });
  });

  it("does not credit a parent module-path range that descends into a nested different module", () => {
    const root = repo({
      "go.mod": "module root.example/repo\n\ngo 1.22\n",
      "sub/go.mod": "module child.example/other\n\ngo 1.22\n",
      "sub/svc/child.go": ["package svc", "func Child(a, b int) int {", "  return a + b", "}"].join("\n"),
      "coverage.out": ["mode: count", "root.example/repo/sub/svc/child.go:2.27,4.2 1 2"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:sub/svc/child.go#Child")?.properties.runtime_covered).toBeUndefined();
    expect(graph.analysis.runtime_coverage).toMatchObject({
      artifacts: [],
      covered_symbols: 0,
      covered_pct: 0
    });
  });

  it("resolves relative coverprofile paths from the artifact's module in a multi-module repo", () => {
    const root = repo({
      "go.mod": "module root.example/repo\n\ngo 1.22\n",
      "pkg/service.go": ["package pkg", "func RootService() int {", "  return 1", "}"].join("\n"),
      "sub/go.mod": "module child.example/other\n\ngo 1.22\n",
      "sub/pkg/service.go": ["package pkg", "func ChildService() int {", "  return 2", "}"].join("\n"),
      "sub/coverage.out": ["mode: count", "./pkg/service.go:2.25,4.2 1 2"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:pkg/service.go#RootService")?.properties.runtime_covered).toBeUndefined();
    expect(graph.nodes.find((n) => n.external_id === "sym:sub/pkg/service.go#ChildService")?.properties.runtime_covered).toBe(true);
    expect(graph.analysis.runtime_coverage).toMatchObject({
      artifacts: [{ path: "sub/coverage.out", format: "go-coverprofile", files: 1, covered_ranges: 1 }],
      covered_symbols: 1
    });
  });

  it("records unmatched positive Go coverage artifacts instead of dropping them silently", () => {
    const root = repo({
      "svc/math.go": ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n"),
      "coverage.out": ["mode: count", "example.com/repo/other/math.go:2.24,4.2 1 3"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.analysis.runtime_coverage).toMatchObject({
      artifacts: [],
      skipped_artifacts: [
        {
          path: "coverage.out",
          format: "go-coverprofile",
          reason: "coverage artifact had positive ranges, but none matched scanned Go files"
        }
      ],
      total_eligible_symbols: 0,
      covered_symbols: 0,
      covered_pct: 0
    });
  });

  it("keeps uncovered when covered ranges overlap no emitted symbol", () => {
    const root = repo({
      "svc/math.go": ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n"),
      "coverage.out": ["mode: set", "svc/math.go:20.1,20.2 1 1"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:svc/math.go#Add")?.properties.runtime_covered).toBeUndefined();
    expect(graph.analysis.runtime_coverage).toMatchObject({
      total_eligible_symbols: 1,
      symbols_with_spans: 1,
      covered_symbols: 0,
      covered_pct: 0
    });
  });

  it("accepts atomic mode and accumulates multiple ranges", () => {
    const root = repo({
      "svc/math.go": [
        "package svc",
        "func Add(a, b int) int {",
        "  return a + b",
        "}",
        "func Sub(a, b int) int {",
        "  return a - b",
        "}"
      ].join("\n"),
      "coverage.out": ["mode: atomic", "svc/math.go:2.24,4.2 1 1", "svc/math.go:5.24,7.2 1 1"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.analysis.runtime_coverage).toMatchObject({
      artifacts: [{ path: "coverage.out", format: "go-coverprofile", files: 1, covered_ranges: 2 }],
      total_eligible_symbols: 2,
      covered_symbols: 2,
      covered_pct: 100
    });
  });

  it("counts spanless eligible symbols but does not mark them covered", () => {
    const root = repo({
      "svc/math.go": ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n"),
      "coverage.out": ["mode: set", "svc/math.go:2.24,4.2 1 1"].join("\n")
    });
    const meta = applyRuntimeCoverage(
      root,
      [{ relPath: "coverage.out", absPath: join(root, "coverage.out"), size: 0, hash: "coverage" }],
      [
        {
          kind: "CodeSymbol",
          external_id: "sym:svc/math.go#Add",
          properties: { file: "svc/math.go" },
          denominator_eligible: true
        } as any
      ],
      new Map()
    );

    expect(meta).toMatchObject({
      total_eligible_symbols: 1,
      symbols_with_spans: 0,
      covered_symbols: 0,
      covered_pct: 0,
      by_language: { go: { eligible: 1, symbols_with_spans: 0, covered: 0, covered_pct: 0 } }
    });
  });

  it("ignores zero-count Go coverprofile ranges", () => {
    const root = repo({
      "svc/math.go": ["package svc", "func Add(a, b int) int {", "  return a + b", "}"].join("\n"),
      "coverage.out": ["mode: set", "svc/math.go:2.24,4.2 1 0"].join("\n")
    });

    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:svc/math.go#Add")?.properties.runtime_covered).toBeUndefined();
    expect(graph.analysis.runtime_coverage).toBeUndefined();
  });

  it("ingests truncated coverage.py XML without throwing or crediting coverage", () => {
    const root = repo({
      "pkg/calc.py": ["def add(a, b):", "    return a + b"].join("\n"),
      // Cut off mid-element: no closing </class>/</coverage>, so nothing matches.
      "coverage.xml": [
        '<?xml version="1.0" ?>',
        "<coverage><packages><package><classes>",
        '    <class filename="pkg/calc.py"><lines>',
        '      <line number="2" hits="3"/>'
      ].join("\n")
    });

    let graph!: ReturnType<typeof analyzeRepo>;
    expect(() => {
      graph = analyzeRepo(root, { readContent: true });
    }).not.toThrow();
    expect(graph.nodes.some((n) => n.properties.runtime_covered)).toBe(false);
    expect(graph.edges.some((e) => e.relationship_type === "COVERS" || e.relationship_type === "TESTED_BY")).toBe(false);
    expect(graph.analysis.runtime_coverage).toBeUndefined();
  });

  it("ingests malformed JaCoCo XML without throwing or crediting coverage", () => {
    const root = repo({
      "src/main/java/com/acme/Calc.java": ["package com.acme;", "class Calc {", "  int add(int a, int b) { return a + b; }", "}"].join("\n"),
      // Not well-formed XML at all — the package/sourcefile regex finds nothing.
      "target/site/jacoco/jacoco.xml": "<<< not xml >>> {garbage} <line nr=4"
    });

    let graph!: ReturnType<typeof analyzeRepo>;
    expect(() => {
      graph = analyzeRepo(root, { readContent: true });
    }).not.toThrow();
    expect(graph.nodes.some((n) => n.properties.runtime_covered)).toBe(false);
    expect(graph.edges.some((e) => e.relationship_type === "COVERS" || e.relationship_type === "TESTED_BY")).toBe(false);
    expect(graph.analysis.runtime_coverage).toBeUndefined();
  });

  it("stops generating coverage once the aggregate budget is exhausted", () => {
    const root = repo({
      "a/go.mod": "module example.com/a\n\ngo 1.22\n",
      "a/m.go": ["package a", "func A() int { return 1 }"].join("\n"),
      "b/go.mod": "module example.com/b\n\ngo 1.22\n",
      "b/m.go": ["package b", "func B() int { return 2 }"].join("\n")
    });
    let clock = 1_000;
    const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => clock);
    try {
      const calls: string[] = [];
      const result = prepareRuntimeCoverage(root, {
        generate: true,
        budgetMs: 100,
        runner: (cwd) => {
          calls.push(cwd);
          clock += 500; // the first command alone blows the 100ms budget
          return { status: 0, stdout: "", stderr: "" };
        }
      });
      // Two Go modules exist, but only the first runs before the budget trips.
      expect(calls).toHaveLength(1);
      expect(result.generated).toHaveLength(1);
      expect(result.warnings.some((w) => /budget/i.test(w))).toBe(true);
    } finally {
      nowSpy.mockRestore();
    }
  });
});
