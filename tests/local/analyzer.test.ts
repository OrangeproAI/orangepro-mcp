import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { languageOf, roleOf, isTestFile, testLayerOf } from "../../src/local/analyze/classify.js";
import { detectFrameworksFromManifest, detectFromPackageJson, frameworkFromConfig } from "../../src/local/analyze/frameworks.js";
import { extractSymbols, extractTestNames } from "../../src/local/analyze/symbols.js";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { extractTreeSitterStructure, preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
import type { GraphNode } from "../../src/local/graph/ontology.js";

describe("classify", () => {
  it("roleOf maps representative paths to roles", () => {
    expect(roleOf("src/x.ts")).toBe("code");
    expect(roleOf("x.test.ts")).toBe("test");
    expect(roleOf("src/UnitTests/FooTests.cs")).toBe("test");
    expect(roleOf("src/IntegrationTests/FooTests.cs")).toBe("test");
    expect(roleOf("src/FunctionalTests/FooTests.cs")).toBe("test");
    expect(roleOf("src/AcceptanceTests/FooTests.cs")).toBe("test");
    expect(roleOf("src/AutoMapper/Licensing/LicenseAccessor.cs")).toBe("code");
    expect(roleOf("package.json")).toBe("config");
    expect(roleOf("README.md")).toBe("doc");
  });

  it("roleOf treats all *.config.{js,ts,mjs,cjs,mts,cts} variants as config", () => {
    expect(roleOf("eslint.config.mjs")).toBe("config");
    expect(roleOf("vite.config.mts")).toBe("config");
    expect(roleOf("jest.config.cjs")).toBe("config");
    expect(roleOf("playwright.config.ts")).toBe("config");
    expect(roleOf("src/configurator.ts")).toBe("code"); // not a .config. basename
  });

  it("isTestFile recognizes test paths and rejects plain code", () => {
    expect(isTestFile("src/foo.test.ts")).toBe(true);
    expect(isTestFile("tests/foo.spec.ts")).toBe(true);
    expect(isTestFile("test.js")).toBe(true);
    expect(isTestFile("packages/p-limit/test.ts")).toBe(true);
    expect(isTestFile("src/contest.js")).toBe(false);
    expect(isTestFile("src/UnitTests/FooTests.cs")).toBe(true);
    expect(isTestFile("src/UnitTests/FooTest.cs")).toBe(true);
    expect(isTestFile("src/FooTests.cs")).toBe(true);
    expect(isTestFile("src/FooTest.cs")).toBe(false);
    expect(isTestFile("src/foo.ts")).toBe(false);
    expect(isTestFile("src/Contest.cs")).toBe(false);
    expect(isTestFile("src/Contests.cs")).toBe(false);
    expect(isTestFile("src/ABTest.cs")).toBe(false);
    expect(isTestFile("src/LoadTest.cs")).toBe(false);
    expect(isTestFile("src/Latest.java")).toBe(false);
    expect(isTestFile("src/Greatest.kt")).toBe(false);
    expect(isTestFile("src/Contest.rb")).toBe(false);
    expect(isTestFile("src/EDIT.java")).toBe(false);
    expect(isTestFile("src/UNIT.java")).toBe(false);
    expect(isTestFile("src/AUDIT.java")).toBe(false);
    expect(isTestFile("src/UserTest.java")).toBe(true);
    expect(isTestFile("src/UserTest.kt")).toBe(true);
    expect(isTestFile("src/FooIT.java")).toBe(true);
    expect(isTestFile("src/user_test.rb")).toBe(true);
    expect(isTestFile("src/commands/agent/test/resume.ts")).toBe(false);
    expect(isTestFile("packages/plugin/src/commands/agent/test/run.ts")).toBe(false);
    expect(isTestFile("src/commands/agent/test/run.test.ts")).toBe(true);
    expect(isTestFile("test/commands/agent/run.ts")).toBe(true);
  });

  it("testLayerOf infers e2e from an e2e directory", () => {
    expect(testLayerOf("e2e/checkout.test.ts")).toBe("e2e");
    expect(testLayerOf("playwright/login.spec.ts")).toBe("e2e");
  });

  it("testLayerOf returns 'unknown' for a path with no layer signal (never the old 'unit' catch-all)", () => {
    // Path alone never asserts unit (Phase 4.6): the AST classifier decides unit
    // from a real in-repo import; a bare path is unknown.
    expect(testLayerOf("tests/payments/card.test.ts")).toBe("unknown");
  });

  it("languageOf maps extensions to languages", () => {
    expect(languageOf("src/x.ts")).toBe("typescript");
    expect(languageOf("src/x.js")).toBe("javascript");
    expect(languageOf("README.md")).toBe("markdown");
  });
});

describe("frameworks", () => {
  it("detectFromPackageJson returns pkg + frameworks for vitest, ava, and @playwright/test", () => {
    const content = JSON.stringify({
      name: "demo-app",
      devDependencies: {
        ava: "^6.0.0",
        vitest: "^1.0.0",
        "@playwright/test": "^1.40.0"
      }
    });
    const { pkg, frameworks } = detectFromPackageJson("package.json", content);

    expect(pkg).not.toBeNull();
    expect(pkg?.name).toBe("demo-app");
    expect(pkg?.ecosystem).toBe("npm");
    expect(pkg?.dependencies).toContain("ava");
    expect(pkg?.dependencies).toContain("vitest");
    expect(pkg?.dependencies).toContain("@playwright/test");

    const names = frameworks.map((f) => f.name);
    expect(names).toContain("ava");
    expect(names).toContain("vitest");
    // @playwright/test is normalized to "playwright".
    expect(names).toContain("playwright");

    const vitestFw = frameworks.find((f) => f.name === "vitest");
    expect(vitestFw?.category).toBe("test");
    expect(vitestFw?.evidence_ref).toBe("package.json");

    const playwrightFw = frameworks.find((f) => f.name === "playwright");
    expect(playwrightFw?.test_layer).toBe("e2e");
  });

  it("detectFromPackageJson recognizes CLI runtime frameworks without inventing a test runner", () => {
    const content = JSON.stringify({
      name: "cli-plugin",
      dependencies: {
        "@oclif/core": "^4.0.0",
        "@salesforce/sf-plugins-core": "^12.0.0",
        commander: "^12.0.0"
      },
      devDependencies: {
        "@oclif/test": "^4.0.0"
      }
    });

    const { frameworks } = detectFromPackageJson("package.json", content);
    expect(frameworks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: "oclif", category: "runtime", evidence_ref: "package.json" }),
        expect.objectContaining({ name: "Salesforce CLI", category: "runtime", evidence_ref: "package.json" }),
        expect.objectContaining({ name: "Commander", category: "runtime", evidence_ref: "package.json" })
      ])
    );
    expect(frameworks.some((fw) => fw.name === "@oclif/test" && fw.category === "test")).toBe(false);
  });

  it("detectFromPackageJson tolerates invalid JSON", () => {
    const { pkg, frameworks } = detectFromPackageJson("package.json", "{ not valid json");
    expect(pkg).toBeNull();
    expect(frameworks).toEqual([]);
  });

  it("detects JUnit 4 and JUnit 5 from Maven manifests", () => {
    expect(
      detectFrameworksFromManifest(
        "pom.xml",
        "<project><dependencies><dependency><groupId>junit</groupId><artifactId>junit</artifactId></dependency></dependencies></project>"
      ).map((f) => f.name)
    ).toContain("junit4");
    expect(
      detectFrameworksFromManifest(
        "pom.xml",
        "<project><dependencies><dependency><artifactId>junit-jupiter</artifactId></dependency></dependencies></project>"
      ).map((f) => f.name)
    ).toContain("junit5");
  });

  it("frameworkFromConfig detects playwright from its config file name", () => {
    const fw = frameworkFromConfig("playwright.config.ts");
    expect(fw).not.toBeNull();
    expect(fw?.name).toBe("playwright");
    expect(fw?.category).toBe("test");
    expect(fw?.test_layer).toBe("e2e");
    expect(fw?.evidence_ref).toBe("playwright.config.ts");
  });
});

describe("symbols", () => {
  it("extractSymbols finds exported functions and classes", () => {
    const content = [
      "export function foo() { return 1; }",
      "export class Bar {}",
      "const internal = 2;"
    ].join("\n");
    const syms = extractSymbols(content);

    const foo = syms.find((s) => s.name === "foo");
    const bar = syms.find((s) => s.name === "Bar");
    expect(foo).toBeDefined();
    expect(foo?.symbol_kind).toBe("function");
    expect(bar).toBeDefined();
    expect(bar?.symbol_kind).toBe("class");
  });

  it("extractTestNames finds describe/it titles", () => {
    const content = [
      'describe("payments", () => {',
      '  it("charges a card", () => {});',
      '  it("rejects an invalid card", () => {});',
      "});"
    ].join("\n");
    const names = extractTestNames(content);
    expect(names).toContain("payments");
    expect(names).toContain("charges a card");
    expect(names).toContain("rejects an invalid card");
  });
});

describe("analyzeRepo", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oplocal-"));
    mkdirSync(join(dir, "src", "payments"), { recursive: true });
    mkdirSync(join(dir, "tests", "payments"), { recursive: true });

    writeFileSync(
      join(dir, "src", "payments", "card.ts"),
      [
        "export function chargeCard(amount: number): boolean {",
        "  return amount > 0;",
        "}",
        "export class CardProcessor {}"
      ].join("\n")
    );

    writeFileSync(
      join(dir, "tests", "payments", "card.test.ts"),
      [
        'import { describe, it } from "vitest";',
        'describe("card", () => {',
        '  it("charges a positive amount", () => {});',
        '  it("rejects a negative amount", () => {});',
        "});"
      ].join("\n")
    );

    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "payments-fixture", devDependencies: { vitest: "^1.0.0" } }, null, 2)
    );
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("produces a fragment with File/TestCase/CodeSymbol/Framework nodes", () => {
    const fragment = analyzeRepo(dir);
    const kinds = new Set(fragment.nodes.map((n) => n.kind));

    expect(kinds.has("File")).toBe(true);
    expect(kinds.has("TestCase")).toBe(true);
    expect(kinds.has("CodeSymbol")).toBe(true);
    expect(kinds.has("Framework")).toBe(true);
  });

  it("creates report-visible Framework nodes for oclif and Salesforce CLI manifests", () => {
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify(
        {
          name: "cli-plugin",
          dependencies: {
            "@oclif/core": "^4.0.0",
            "@salesforce/sf-plugins-core": "^12.0.0"
          },
          devDependencies: {
            "@oclif/test": "^4.0.0"
          }
        },
        null,
        2
      )
    );

    const fragment = analyzeRepo(dir);
    const frameworkTitles = fragment.nodes.filter((n) => n.kind === "Framework").map((n) => n.title);
    expect(frameworkTitles).toContain("oclif");
    expect(frameworkTitles).toContain("Salesforce CLI");
  });

  it("keeps a CLI command namespace named test as product code and extracts its run method", () => {
    const commandDir = join(dir, "src", "commands", "agent", "test");
    mkdirSync(commandDir, { recursive: true });
    writeFileSync(
      join(commandDir, "resume.ts"),
      [
        "class SfCommand<T> {}",
        "export default class AgentTestResume extends SfCommand<string> {",
        "  public async run(): Promise<string> { return 'ok'; }",
        "}"
      ].join("\n")
    );

    const fragment = analyzeRepo(dir);
    const file = fragment.nodes.find((n) => n.external_id === "src/commands/agent/test/resume.ts");
    expect(file).toMatchObject({ kind: "File", properties: { role: "code" } });
    expect(fragment.nodes.some((n) => n.external_id === "sym:src/commands/agent/test/resume.ts#AgentTestResume.run")).toBe(true);
    expect(fragment.nodes.some((n) => n.external_id === "test:src/commands/agent/test/resume.ts")).toBe(false);
  });

  it("recognizes exact top-level test.js conventions as test files", () => {
    writeFileSync(join(dir, "test.js"), 'import test from "ava";\ntest("top-level ava test", (t) => { t.pass(); });\n');

    const fragment = analyzeRepo(dir);
    const topLevelTest = fragment.nodes.find((n) => n.external_id === "test.js");

    expect(fragment.analysis?.test_files).toBeGreaterThanOrEqual(2);
    expect(topLevelTest).toMatchObject({ kind: "File", properties: { role: "test" } });
    expect(fragment.nodes.some((n) => n.external_id === "test:test.js" && n.kind === "TestCase")).toBe(true);
  });

  it("routes extra tree-sitter languages through analyzer symbol extraction", async () => {
    await preloadTreeSitter(["ruby", "kotlin", "rust", "php", "csharp", "swift", "c", "cpp"]);
    writeFileSync(join(dir, "src", "payments", "worker.rb"), ["class RubyWorker", "  def save", "  end", "end"].join("\n"));
    writeFileSync(join(dir, "src", "payments", "Worker.kt"), "class KotlinWorker { fun save() {} }\n");
    writeFileSync(join(dir, "src", "payments", "lib.rs"), "struct RustWorker { id: i32 }\npub fn save() {}\n");
    writeFileSync(join(dir, "src", "payments", "worker.php"), "<?php\nclass PhpWorker { public function save() {} }\n");
    writeFileSync(join(dir, "src", "payments", "Worker.cs"), "class CSharpWorker { public void Save() {} }\n");
    writeFileSync(join(dir, "src", "payments", "Worker.swift"), "class SwiftWorker { func save() {} }\n");
    writeFileSync(join(dir, "src", "payments", "native.c"), "struct c_worker { int id; };\nint c_save() { return 1; }\n");
    writeFileSync(join(dir, "src", "payments", "native.cpp"), "class CppWorker { public: void save(); };\nvoid CppWorker::save() {}\n");

    const fragment = analyzeRepo(dir);
    const ids = new Set(fragment.nodes.filter((n) => n.kind === "CodeSymbol").map((n) => n.external_id));
    expect(ids).toContain("sym:src/payments/worker.rb#RubyWorker");
    expect(ids).toContain("sym:src/payments/Worker.kt#KotlinWorker");
    expect(ids).toContain("sym:src/payments/lib.rs#RustWorker");
    expect(ids).toContain("sym:src/payments/worker.php#PhpWorker");
    expect(ids).toContain("sym:src/payments/Worker.cs#CSharpWorker");
    expect(ids).toContain("sym:src/payments/Worker.swift#SwiftWorker");
    expect(ids).toContain("sym:src/payments/native.c#c_save");
    expect(ids).toContain("sym:src/payments/native.cpp#CppWorker");
  });

  it("includes DEFINED_IN edges from symbols/tests to their files", () => {
    const fragment = analyzeRepo(dir);
    const definedIn = fragment.edges.filter((e) => e.relationship_type === "DEFINED_IN");
    expect(definedIn.length).toBeGreaterThan(0);

    const symbol = fragment.nodes.find((n) => n.kind === "CodeSymbol" && n.title === "chargeCard");
    expect(symbol).toBeDefined();
    const symbolEdge = definedIn.find((e) => e.from_external_id === symbol!.external_id);
    expect(symbolEdge).toBeDefined();
    expect(symbolEdge!.to_external_id).toBe("src/payments/card.ts");

    const testCase = fragment.nodes.find((n) => n.kind === "TestCase");
    expect(testCase).toBeDefined();
    const testEdge = definedIn.find((e) => e.from_external_id === testCase!.external_id);
    expect(testEdge).toBeDefined();
    expect(testEdge!.to_external_id).toBe("tests/payments/card.test.ts");
  });

  it("populates file_entries for every scanned file", () => {
    const fragment = analyzeRepo(dir);
    expect(fragment.file_entries["src/payments/card.ts"]).toBeDefined();
    expect(fragment.file_entries["tests/payments/card.test.ts"]).toBeDefined();
    expect(fragment.file_entries["package.json"]).toBeDefined();

    const entry = fragment.file_entries["src/payments/card.ts"];
    expect(entry.kind).toBe("code");
    expect(typeof entry.hash).toBe("string");
    expect(entry.hash.length).toBeGreaterThan(0);
    expect(typeof entry.size).toBe("number");
  });

  it("emits a single repo SourceScope describing the local checkout", () => {
    const fragment = analyzeRepo(dir);
    expect(fragment.sources).toHaveLength(1);
    const source = fragment.sources[0];
    expect(source.source_system).toBe("repo");
    expect(source.source_type).toBe("local_checkout");
    expect(source.source_scope_id).toMatch(/^repo:/);
    expect(typeof source.content_hash).toBe("string");
  });

  it("gives every node a provenance.source_ref tied to the repo scope", () => {
    const fragment = analyzeRepo(dir);
    const scopeId = fragment.sources[0].source_scope_id;
    expect(fragment.nodes.length).toBeGreaterThan(0);
    for (const node of fragment.nodes as GraphNode[]) {
      expect(node.provenance).toBeDefined();
      expect(typeof node.provenance.source_ref).toBe("string");
      expect((node.provenance.source_ref as string).length).toBeGreaterThan(0);
      expect(node.provenance.source_scope_id).toBe(scopeId);
    }
  });

  it("captures the test names extracted from the test file", () => {
    const fragment = analyzeRepo(dir);
    const testCase = fragment.nodes.find((n) => n.kind === "TestCase");
    expect(testCase).toBeDefined();
    const testNames = testCase!.properties.test_names as string[];
    expect(testNames).toContain("card");
    expect(testNames).toContain("charges a positive amount");
  });

  it("links a test file to its source sibling via a MAY_RELATE_TO candidate edge", () => {
    const fragment = analyzeRepo(dir);
    const rel = fragment.candidate_edges.find(
      (e) => e.relationship_type === "MAY_RELATE_TO" && e.from_external_id === "tests/payments/card.test.ts"
    );
    expect(rel).toBeDefined();
    // Name heuristic only -> a weak (never-proof) edge to the source file.
    expect(rel!.to_external_id).toBe("src/payments/card.ts");
    expect(rel!.evidence_strength).toBe("weak");
    expect(rel!.confidence).toBeGreaterThan(0);
  });

  it("does not guess a source sibling when the basename stem is ambiguous", () => {
    // Two source files share the stem "util" in different dirs -> ambiguous.
    mkdirSync(join(dir, "src", "a"), { recursive: true });
    mkdirSync(join(dir, "src", "b"), { recursive: true });
    mkdirSync(join(dir, "tests", "misc"), { recursive: true });
    writeFileSync(join(dir, "src", "a", "util.ts"), "export function aUtil() { return 1; }\n");
    writeFileSync(join(dir, "src", "b", "util.ts"), "export function bUtil() { return 2; }\n");
    writeFileSync(join(dir, "tests", "misc", "util.test.ts"), 'import { it } from "vitest";\nit("x", () => {});\n');
    const fragment = analyzeRepo(dir);
    const rel = fragment.candidate_edges.find(
      (e) => e.relationship_type === "MAY_RELATE_TO" && e.from_external_id === "tests/misc/util.test.ts"
    );
    expect(rel).toBeUndefined();
  });

  it("counts entry-point-adjacent behavior surfaces, not every exported helper/component", () => {
    mkdirSync(join(dir, "src", "services"), { recursive: true });
    mkdirSync(join(dir, "src", "routes"), { recursive: true });
    mkdirSync(join(dir, "src", "components"), { recursive: true });
    mkdirSync(join(dir, "src", "lib"), { recursive: true });
    writeFileSync(
      join(dir, "src", "services", "person.service.ts"),
      [
        "export class PersonService {",
        "  findOrCreatePerson() { return 'person'; }",
        "}",
        "export function normalizePersonName(name: string) { return name.trim(); }"
      ].join("\n")
    );
    writeFileSync(join(dir, "src", "routes", "documents.route.ts"), "export function findDocuments() { return []; }\n");
    writeFileSync(join(dir, "src", "components", "HtmlPreview.tsx"), "export function HtmlPreview() { return null; }\n");
    writeFileSync(join(dir, "src", "lib", "resend.ts"), "export function getResendClient() { return {}; }\n");

    const fragment = analyzeRepo(dir);
    const byId = new Map(fragment.nodes.map((n) => [n.external_id, n]));

    expect(byId.get("sym:src/services/person.service.ts#PersonService.findOrCreatePerson")?.denominator_eligible).toBe(true);
    expect(byId.get("sym:src/routes/documents.route.ts#findDocuments")?.denominator_eligible).toBe(true);
    expect(byId.get("sym:src/services/person.service.ts#PersonService")?.denominator_eligible).toBe(false);
    expect(byId.get("sym:src/services/person.service.ts#normalizePersonName")?.denominator_eligible).toBe(false);
    expect(byId.get("sym:src/services/person.service.ts#normalizePersonName")?.properties.denominator_reason_code).toBe("not_entry_point_adjacent");
    expect(byId.get("sym:src/components/HtmlPreview.tsx#HtmlPreview")?.denominator_eligible).toBe(false);
    expect(byId.get("sym:src/lib/resend.ts#getResendClient")?.denominator_eligible).toBe(false);
    expect(byId.get("sym:src/lib/resend.ts#getResendClient")?.properties.denominator_reason_code).toBe("not_entry_point_adjacent");
  });

  it("tags e2e test-support helpers for ranking exclusion without changing denominator eligibility", () => {
    mkdirSync(join(dir, "packages", "twenty-e2e-testing", "lib", "requests"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "twenty-e2e-testing", "lib", "requests", "delete-workflow.ts"),
      "export const deleteWorkflow = () => true;\n"
    );

    const fragment = analyzeRepo(dir);
    const node = fragment.nodes.find((n) => n.external_id === "sym:packages/twenty-e2e-testing/lib/requests/delete-workflow.ts#deleteWorkflow");

    expect(node?.denominator_eligible).toBe(true);
    expect(node?.properties.ranking_exclusion_reason_code).toBe("test_support_helper");
    expect(node?.properties.ranking_exclusion_reason).toContain("excluded from the primary production priority ranking");
  });

  it("uses semantic infrastructure signals without excluding product package layouts", () => {
    mkdirSync(join(dir, "src", "services"), { recursive: true });
    mkdirSync(join(dir, "src", "models"), { recursive: true });
    mkdirSync(join(dir, "src", "tools"), { recursive: true });
    mkdirSync(join(dir, "packages", "admin", "dashboard", "src"), { recursive: true });
    mkdirSync(join(dir, "packages", "core", "js-sdk", "src"), { recursive: true });
    mkdirSync(join(dir, "packages", "core", "framework", "src", "http"), { recursive: true });
    mkdirSync(join(dir, "packages", "modules", "workflow-engine-redis", "src", "services"), { recursive: true });
    mkdirSync(join(dir, "packages", "modules", "link-modules", "src", "services"), { recursive: true });
    mkdirSync(join(dir, "www", "packages", "docs-ui", "src"), { recursive: true });
    mkdirSync(join(dir, "www", "apps", "api-reference", "app"), { recursive: true });
    mkdirSync(join(dir, "www", "apps", "api-reference", "providers"), { recursive: true });
    mkdirSync(join(dir, "packages", "design-system", "toolbox", "src"), { recursive: true });
    mkdirSync(join(dir, "packages", "admin", "admin-vite-plugin", "src", "routes"), { recursive: true });
    mkdirSync(join(dir, "packages", "medusa", "src", "commands", "db"), { recursive: true });
    writeFileSync(
      join(dir, "src", "services", "cache-provider-service.ts"),
      [
        "export class CacheProviderService {",
        "  getRegistrationIdentifier() { return 'cache'; }",
        "  retrieveProvider() { return {}; }",
        "}"
      ].join("\n")
    );
    writeFileSync(
      join(dir, "src", "services", "order-module-service.ts"),
      [
        "export class OrderModuleService {",
        "  __joinerConfig() { return {}; }",
        "  loadModules() { return []; }",
        "  createOrders() { return []; }",
        "}"
      ].join("\n")
    );
    writeFileSync(
      join(dir, "src", "services", "tax-module-service.ts"),
      [
        "export class TaxModuleService {",
        "  loadUserTaxProfile() { return {}; }",
        "  getTaxLines() { return []; }",
        "}"
      ].join("\n")
    );
    writeFileSync(
      join(dir, "src", "services", "payment-module-service.ts"),
      [
        "export class PaymentModuleService {",
        "  getPaymentStatus() { return 'captured'; }",
        "  capturePayment() { return true; }",
        "}"
      ].join("\n")
    );
    // FUNCTIONAL provider services own real behaviors and must be RETAINED — only genuine infra
    // providers (CacheProviderService) are excluded. Guards against a broad `.*Provider.*Service` rule.
    writeFileSync(
      join(dir, "src", "services", "payment-provider-service.ts"),
      [
        "export class PaymentProviderService {",
        "  capturePayment() { return true; }",
        "  refundPayment() { return true; }",
        "}"
      ].join("\n")
    );
    writeFileSync(
      join(dir, "src", "services", "tax-provider-service.ts"),
      [
        "export class TaxProviderService {",
        "  getTaxLines() { return []; }",
        "}"
      ].join("\n")
    );
    writeFileSync(join(dir, "src", "models", "address.ts"), "export function createAddressModel() { return {}; }\n");
    writeFileSync(join(dir, "src", "tools", "package.ts"), "export function getPackageManager() { return 'npm'; }\n");
    writeFileSync(join(dir, "packages", "admin", "dashboard", "src", "layout.tsx"), "export function RootLayout() { return null; }\n");
    writeFileSync(join(dir, "packages", "core", "js-sdk", "src", "client.ts"), "export function listProducts() { return []; }\n");
    writeFileSync(join(dir, "packages", "core", "framework", "src", "http", "router.ts"), "export class ApiLoader { load() { return []; } }\n");
    writeFileSync(join(dir, "packages", "modules", "workflow-engine-redis", "src", "services", "workflow-orchestrator.ts"), "export class WorkflowOrchestratorService { run() { return {}; } }\n");
    writeFileSync(join(dir, "packages", "modules", "link-modules", "src", "services", "link-module-service.ts"), "export class LinkModuleService { create() { return {}; } }\n");
    writeFileSync(join(dir, "www", "packages", "docs-ui", "src", "search.tsx"), "export function SearchProvider() { return null; }\n");
    writeFileSync(join(dir, "www", "apps", "api-reference", "app", "layout.tsx"), "export function RootLayout() { return null; }\n");
    writeFileSync(join(dir, "www", "apps", "api-reference", "providers", "search.tsx"), "export function SearchProvider() { return null; }\n");
    writeFileSync(join(dir, "packages", "design-system", "toolbox", "src", "figma.ts"), "export function Figma() { return null; }\n");
    writeFileSync(join(dir, "packages", "admin", "admin-vite-plugin", "src", "routes", "helpers.ts"), "export function generateRoutes() { return []; }\n");
    writeFileSync(join(dir, "packages", "medusa", "src", "commands", "db", "migrate.ts"), "export function runMigrationScripts() { return true; }\n");

    const fragment = analyzeRepo(dir);
    const byId = new Map(fragment.nodes.map((n) => [n.external_id, n]));

    for (const id of [
      "sym:src/services/cache-provider-service.ts#CacheProviderService.getRegistrationIdentifier",
      "sym:src/services/cache-provider-service.ts#CacheProviderService.retrieveProvider",
      "sym:src/services/order-module-service.ts#OrderModuleService.__joinerConfig",
      "sym:src/services/order-module-service.ts#OrderModuleService.loadModules",
      "sym:src/models/address.ts#createAddressModel",
      "sym:src/tools/package.ts#getPackageManager"
    ]) {
      expect(byId.get(id)?.denominator_eligible).toBe(false);
      expect(byId.get(id)?.properties.denominator_reason_code).toBe("infra_behavior_surface");
    }

    for (const id of [
      "sym:src/services/order-module-service.ts#OrderModuleService.createOrders",
      "sym:src/services/tax-module-service.ts#TaxModuleService.loadUserTaxProfile",
      "sym:src/services/tax-module-service.ts#TaxModuleService.getTaxLines",
      "sym:src/services/payment-module-service.ts#PaymentModuleService.getPaymentStatus",
      "sym:src/services/payment-module-service.ts#PaymentModuleService.capturePayment",
      "sym:src/services/payment-provider-service.ts#PaymentProviderService.capturePayment",
      "sym:src/services/payment-provider-service.ts#PaymentProviderService.refundPayment",
      "sym:src/services/tax-provider-service.ts#TaxProviderService.getTaxLines",
      "sym:packages/admin/dashboard/src/layout.tsx#RootLayout",
      "sym:packages/core/js-sdk/src/client.ts#listProducts",
      "sym:packages/core/framework/src/http/router.ts#ApiLoader.load",
      "sym:packages/modules/workflow-engine-redis/src/services/workflow-orchestrator.ts#WorkflowOrchestratorService.run",
      "sym:packages/modules/link-modules/src/services/link-module-service.ts#LinkModuleService.create",
      "sym:www/packages/docs-ui/src/search.tsx#SearchProvider",
      "sym:www/apps/api-reference/app/layout.tsx#RootLayout",
      "sym:www/apps/api-reference/providers/search.tsx#SearchProvider",
      "sym:packages/admin/admin-vite-plugin/src/routes/helpers.ts#generateRoutes",
      "sym:packages/medusa/src/commands/db/migrate.ts#runMigrationScripts"
    ]) {
      expect(byId.get(id)?.denominator_eligible).toBe(true);
    }
  });

  it("discovers backend endpoint contracts separately from the CodeSymbol denominator", () => {
    mkdirSync(join(dir, "src", "owners"), { recursive: true });
    mkdirSync(join(dir, "src", "owners", "__fixtures__"), { recursive: true });
    writeFileSync(
      join(dir, "src", "owners", "owner.controller.ts"),
      [
        'import { Controller, Get, Post } from "@nestjs/common";',
        '@Controller("owners")',
        "export class OwnerController {",
        '  @Get(":id")',
        "  async findOne() { return {}; }",
        "  @Post()",
        "  create() { return {}; }",
        "}"
      ].join("\n")
    );
    writeFileSync(
      join(dir, "src", "owners", "owner.controller.test.ts"),
      [
        "describe('owner routes', () => {",
        "  it('findOne', () => expect(true).toBe(true));",
        "});"
      ].join("\n")
    );
    writeFileSync(
      join(dir, "src", "owners", "__fixtures__", "owner.controller.ts"),
      "export class OwnerController { findOne() { return {}; } }\n"
    );

    const fragment = analyzeRepo(dir);
    const endpoints = fragment.nodes.filter((n) => n.kind === "Endpoint");

    expect(endpoints).toEqual([
      expect.objectContaining({
        title: "GET /owners/:id",
        behavior_source: "contract_entrypoint",
        denominator_eligible: false,
        properties: expect.objectContaining({
          contract_kind: "http_endpoint",
          framework: "nestjs",
          method: "GET",
          path: "/owners/:id",
          file: "src/owners/owner.controller.ts",
          handler: "findOne",
          controller: "OwnerController"
        })
      }),
      expect.objectContaining({
        title: "POST /owners",
        properties: expect.objectContaining({
          framework: "nestjs",
          method: "POST",
          path: "/owners",
          handler: "create"
        })
      })
    ]);
    expect(fragment.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from_external_id: endpoints[0].external_id,
        to_external_id: "src/owners/owner.controller.ts",
        relationship_type: "DEFINED_IN",
        evidence_strength: "hard"
      }),
      expect.objectContaining({
        from_external_id: endpoints[0].external_id,
        to_external_id: "sym:src/owners/owner.controller.ts#OwnerController.findOne",
        relationship_type: "IMPLEMENTED_IN",
        evidence_strength: "hard"
      }),
      expect.objectContaining({
        from_external_id: endpoints[1].external_id,
        to_external_id: "sym:src/owners/owner.controller.ts#OwnerController.create",
        relationship_type: "IMPLEMENTED_IN",
        evidence_strength: "hard"
      })
    ]));
    const endpointHandlerEdges = fragment.edges.filter((edge) => edge.relationship_type === "IMPLEMENTED_IN" && endpoints.some((endpoint) => endpoint.external_id === edge.from_external_id));
    expect(endpointHandlerEdges.map((edge) => edge.to_external_id).sort()).toEqual([
      "sym:src/owners/owner.controller.ts#OwnerController.create",
      "sym:src/owners/owner.controller.ts#OwnerController.findOne"
    ]);
    expect(endpointHandlerEdges.some((edge) => edge.to_external_id.includes("__fixtures__") || edge.to_external_id.startsWith("test:"))).toBe(false);
    expect(fragment.analysis?.behavior_contracts).toEqual({
      total: 2,
      by_framework: { nestjs: 2 },
      by_kind: { http_endpoint: 2 },
      handler_edges: 2
    });
  });

  it("does not attach test association candidates directly to endpoint metadata nodes", () => {
    mkdirSync(join(dir, "src", "routes"), { recursive: true });
    mkdirSync(join(dir, "tests", "routes"), { recursive: true });
    mkdirSync(join(dir, "integration-tests", "http", "__fixtures__", "feature-flag", "src", "api", "custom"), { recursive: true });
    writeFileSync(
      join(dir, "src", "routes", "orders.ts"),
      [
        "const router = { post() {} };",
        "export function createOrder() { return {}; }",
        'router.post("/orders", createOrder);'
      ].join("\n")
    );
    writeFileSync(
      join(dir, "integration-tests", "http", "__fixtures__", "feature-flag", "src", "api", "custom", "route.ts"),
      "export function POST() { return {}; }\n"
    );
    writeFileSync(
      join(dir, "tests", "routes", "orders.test.ts"),
      [
        'import { describe, it } from "vitest";',
        'import { POST } from "../../integration-tests/http/__fixtures__/feature-flag/src/api/custom/route";',
        'describe("POST /orders", () => {',
        '  it("creates an order", () => { POST(); });',
        "});"
      ].join("\n")
    );

    const fragment = analyzeRepo(dir);
    const endpoints = fragment.nodes.filter((n) => n.kind === "Endpoint");

    expect(endpoints.map((n) => n.title)).toContain("POST /orders");
    const endpoint = endpoints.find((n) => n.title === "POST /orders");
    expect(fragment.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from_external_id: endpoint?.external_id,
        to_external_id: "sym:src/routes/orders.ts#createOrder",
        relationship_type: "IMPLEMENTED_IN",
        evidence_strength: "hard"
      })
    ]));
    const endpointHandlerEdges = fragment.edges.filter((edge) => edge.relationship_type === "IMPLEMENTED_IN" && edge.from_external_id === endpoint?.external_id);
    expect(endpointHandlerEdges.map((edge) => edge.to_external_id)).toEqual(["sym:src/routes/orders.ts#createOrder"]);
    expect(endpointHandlerEdges.some((edge) => edge.to_external_id.includes("__fixtures__") || edge.to_external_id.startsWith("test:"))).toBe(false);
    expect(
      fragment.candidate_edges.some((e) =>
        endpoints.some((endpoint) => e.from_external_id === endpoint.external_id || e.to_external_id === endpoint.external_id)
      )
    ).toBe(false);
  });

  it("does not resolve imported dotted Express handlers to same-file decoy symbols", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "handlers.ts"),
      "export function createOrder() { return { real: true }; }\n"
    );
    writeFileSync(
      join(dir, "src", "express-dotted.ts"),
      [
        'import * as handlers from "./handlers";',
        "const router = { post() {} };",
        "export function createOrder() { return { decoy: true }; }",
        'router.post("/orders", handlers.createOrder);'
      ].join("\n")
    );

    const fragment = analyzeRepo(dir);
    const endpoint = fragment.nodes.find((n) => n.kind === "Endpoint" && n.title === "POST /orders");

    expect(endpoint).toEqual(expect.objectContaining({
      properties: expect.objectContaining({
        framework: "express",
        handler: "handlers.createOrder"
      })
    }));
    expect(fragment.edges.filter((edge) => edge.relationship_type === "IMPLEMENTED_IN" && edge.from_external_id === endpoint?.external_id)).toEqual([]);
  });

  it("does not resolve imported dotted Fastify handlers to same-file decoy symbols", () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "src", "handlers.ts"),
      "export function createOrder() { return { real: true }; }\n"
    );
    writeFileSync(
      join(dir, "src", "fastify-dotted.ts"),
      [
        'import * as handlers from "./handlers";',
        "const fastify = { post() {} };",
        "export function createOrder() { return { decoy: true }; }",
        'fastify.post("/orders", handlers.createOrder);'
      ].join("\n")
    );

    const fragment = analyzeRepo(dir);
    const endpoint = fragment.nodes.find((n) => n.kind === "Endpoint" && n.title === "POST /orders");

    expect(endpoint).toEqual(expect.objectContaining({
      properties: expect.objectContaining({
        framework: "fastify",
        handler: "handlers.createOrder"
      })
    }));
    expect(fragment.edges.filter((edge) => edge.relationship_type === "IMPLEMENTED_IN" && edge.from_external_id === endpoint?.external_id)).toEqual([]);
  });

  it("discovers endpoint metadata regardless of package role names", () => {
    mkdirSync(join(dir, "packages", "admin", "admin-bundler", "src", "commands"), { recursive: true });
    mkdirSync(join(dir, "packages", "medusa", "src", "commands"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "admin", "admin-bundler", "src", "commands", "serve.ts"),
      [
        "const app = { get() {} };",
        "export function sendHtml() { return ''; }",
        'app.get("/", sendHtml);'
      ].join("\n")
    );
    writeFileSync(
      join(dir, "packages", "medusa", "src", "commands", "start.ts"),
      [
        "const app = { get() {} };",
        "export function health() { return 'ok'; }",
        'app.get("/health", health);'
      ].join("\n")
    );

    const fragment = analyzeRepo(dir);

    expect(fragment.nodes.filter((n) => n.kind === "Endpoint").map((n) => n.title).sort()).toEqual(["GET /", "GET /health"]);
    expect(fragment.analysis?.behavior_contracts).toMatchObject({ total: 2, by_framework: { express: 2 } });
  });

  it("links file-route endpoint contracts to exported HTTP handler symbols", () => {
    mkdirSync(join(dir, "packages", "medusa", "src", "api", "store", "carts", "[id]", "complete"), { recursive: true });
    writeFileSync(
      join(dir, "packages", "medusa", "src", "api", "store", "carts", "[id]", "complete", "route.ts"),
      [
        "export async function POST() { return Response.json({ ok: true }); }",
        "export const GET = async () => Response.json([]);"
      ].join("\n")
    );

    const fragment = analyzeRepo(dir);
    const endpoints = fragment.nodes.filter((n) => n.kind === "Endpoint");
    const post = endpoints.find((n) => n.title === "POST /store/carts/:id/complete");
    const get = endpoints.find((n) => n.title === "GET /store/carts/:id/complete");

    expect(post).toEqual(expect.objectContaining({
      denominator_eligible: false,
      properties: expect.objectContaining({
        framework: "file_route",
        handler: "POST",
        file: "packages/medusa/src/api/store/carts/[id]/complete/route.ts"
      })
    }));
    expect(get).toEqual(expect.objectContaining({
      properties: expect.objectContaining({
        framework: "file_route",
        handler: "GET"
      })
    }));
    expect(fragment.edges).toEqual(expect.arrayContaining([
      expect.objectContaining({
        from_external_id: post?.external_id,
        to_external_id: "sym:packages/medusa/src/api/store/carts/[id]/complete/route.ts#POST",
        relationship_type: "IMPLEMENTED_IN"
      }),
      expect.objectContaining({
        from_external_id: get?.external_id,
        to_external_id: "sym:packages/medusa/src/api/store/carts/[id]/complete/route.ts#GET",
        relationship_type: "IMPLEMENTED_IN"
      })
    ]));
    expect(fragment.analysis?.behavior_contracts).toEqual({
      total: 2,
      by_framework: { file_route: 2 },
      by_kind: { http_endpoint: 2 },
      handler_edges: 2
    });
  });

  it("adds cross-file semantic Associated links from test names without minting proof", () => {
    mkdirSync(join(dir, "src", "services"), { recursive: true });
    mkdirSync(join(dir, "tests", "flows"), { recursive: true });
    writeFileSync(join(dir, "src", "services", "documents.service.ts"), "export function findDocuments(userId: string) { return [userId]; }\n");
    writeFileSync(
      join(dir, "tests", "flows", "document-flow.test.ts"),
      [
        'import { describe, it } from "vitest";',
        'describe("document flow", () => {',
        '  it("should find documents by user", () => {});',
        "});"
      ].join("\n")
    );

    const fragment = analyzeRepo(dir);
    const symId = "sym:src/services/documents.service.ts#findDocuments";
    const testId = "test:tests/flows/document-flow.test.ts";
    const semantic = fragment.candidate_edges.find(
      (e) => e.from_external_id === symId && e.to_external_id === testId && e.relationship_type === "MAY_BE_TESTED_BY"
    );

    expect(semantic).toBeDefined();
    expect(semantic?.evidence_strength).toBe("weak");
    expect(semantic?.reason).toContain("associated only, never proof");
    expect(
      fragment.edges.some(
        (e) =>
          (e.relationship_type === "COVERS" || e.relationship_type === "TESTED_BY") &&
          ((e.from_external_id === symId && e.to_external_id === testId) || (e.from_external_id === testId && e.to_external_id === symId))
      )
    ).toBe(false);
  });

  it("retains direct Python test links when a different test patches the same exact target", async () => {
    await preloadTreeSitter(["python"]);
    mkdirSync(join(dir, "src", "tasks"), { recursive: true });
    mkdirSync(join(dir, "tests", "tasks"), { recursive: true });
    writeFileSync(
      join(dir, "src", "tasks", "workers.py"),
      [
        "class Worker:",
        "    def process(self):",
        "        return 'done'",
        "class Helper:",
        "    def assist(self):",
        "        return 'help'",
        "class Dependency:",
        "    def fetch(self):",
        "        return 'data'",
        "class LocalWorker:",
        "    def process(self):",
        "        return 'local'",
        "class UniqueWorker:",
        "    def execute_unique(self):",
        "        return 'unique'",
        "class StaticWorker:",
        "    @staticmethod",
        "    def inspect():",
        "        return 'static'"
      ].join("\n")
    );
    const testSource = [
        "from unittest.mock import AsyncMock as AM, MagicMock as MM, patch as p",
        "import unittest.mock as um",
        "from src.tasks.workers import Worker, Helper, Dependency, LocalWorker, UniqueWorker, StaticWorker",
        "def test_worker_direct():",
        "    item = Worker()",
        "    assert item.process() == 'done'",
        "def test_worker_method_is_mocked_elsewhere():",
        "    with p.object(Worker, 'process'):",
        "        pass",
        "def test_helper_with_dependency_mock():",
        "    item = Helper()",
        "    assert item.assist() == 'help'",
        "def test_dependency_method_is_mocked():",
        "    Dependency.fetch = MM()",
        "def test_local_worker_direct():",
        "    local = LocalWorker()",
        "    assert local.process() == 'local'",
        "def test_local_worker_method_is_mocked_elsewhere():",
        "    local = LocalWorker()",
        "    with um.patch.object(local, 'process'):",
        "        pass",
        "def test_unique_worker_direct():",
        "    config = UniqueWorker()",
        "    assert config.execute_unique() == 'unique'",
        "def test_unique_worker_method_is_mocked_elsewhere():",
        "    mock_config = UniqueWorker()",
        "    mock_config.execute_unique = AM()",
        "def test_static_worker_direct():",
        "    assert StaticWorker.inspect() == 'static'",
        "def test_static_worker_method_is_mocked_elsewhere(monkeypatch):",
        "    monkeypatch.setattr('src.tasks.workers.StaticWorker.inspect', MM())"
      ].join("\n");
    writeFileSync(join(dir, "tests", "tasks", "test_workers.py"), testSource);

    expect(extractTreeSitterStructure(testSource, "python").pythonMockedMethods).toEqual([
      "Dependency.fetch",
      "LocalWorker.process",
      "UniqueWorker.execute_unique",
      "Worker.process",
      "src.tasks.workers.StaticWorker.inspect"
    ]);

    const fragment = analyzeRepo(dir);
    const testId = "test:tests/tasks/test_workers.py";
    const hasProofPair = (symId: string): boolean => fragment.edges.some(
      (edge) =>
        edge.relationship_type === "TESTED_BY" &&
        ((edge.from_external_id === symId && edge.to_external_id === testId) || (edge.from_external_id === testId && edge.to_external_id === symId))
    );

    expect(hasProofPair("sym:src/tasks/workers.py#Worker.process")).toBe(true);
    expect(hasProofPair("sym:src/tasks/workers.py#LocalWorker.process")).toBe(true);
    expect(hasProofPair("sym:src/tasks/workers.py#UniqueWorker.execute_unique")).toBe(true);
    expect(hasProofPair("sym:src/tasks/workers.py#StaticWorker.inspect")).toBe(true);
    // The exact Worker.process patch must not suppress a different production
    // method, nor does the exact Dependency.fetch replacement affect Helper.
    expect(hasProofPair("sym:src/tasks/workers.py#Helper.assist")).toBe(true);
  });

  it("links direct Python instances and only finite local parametrized fixture selections without bypassing target mocks", async () => {
    await preloadTreeSitter(["python"]);
    mkdirSync(join(dir, "src", "handlers"), { recursive: true });
    mkdirSync(join(dir, "tests", "handlers"), { recursive: true });
    writeFileSync(
      join(dir, "src", "handlers", "audio.py"),
      [
        "class LocalHandler:",
        "    def _has_text_content(self, response):",
        "        return bool(response)",
        "class AudioHandler:",
        "    def transform_request(self, audio):",
        "        return audio"
      ].join("\n")
    );
    writeFileSync(
      join(dir, "tests", "handlers", "test_audio.py"),
      [
        "from unittest.mock import patch",
        "import pytest",
        "from src.handlers.audio import AudioHandler, LocalHandler",
        "@pytest.fixture",
        "def bytes_case():",
        "    return b'bytes'",
        "@pytest.fixture",
        "def text_case():",
        "    return b'text'",
        "class TestLocalHandler:",
        "    def test_has_text_content(self):",
        "        handler = LocalHandler()",
        "        response = {'text': 'ok'}",
        "        assert handler._has_text_content(response)",
        "@pytest.mark.parametrize(",
        "    'fixture_name',",
        "    ['bytes_case', 'text_case'],",
        ")",
        "def test_transform_request(fixture_name, request):",
        "    handler = AudioHandler()",
        "    audio = request.getfixturevalue(fixture_name)",
        "    assert handler.transform_request(audio) == audio"
      ].join("\n")
    );
    writeFileSync(
      join(dir, "tests", "handlers", "test_audio_target_mock.py"),
      [
        "from unittest.mock import patch",
        "import pytest",
        "from src.handlers.audio import AudioHandler",
        "@pytest.fixture",
        "def patched_case():",
        "    with patch.object(AudioHandler, 'transform_request'):",
        "        yield b'patched'",
        "@pytest.mark.parametrize('fixture_name', ['patched_case'])",
        "def test_transform_request_with_target_patch(fixture_name, request):",
        "    handler = AudioHandler()",
        "    audio = request.getfixturevalue(fixture_name)",
        "    assert handler.transform_request(audio) == audio"
      ].join("\n")
    );
    writeFileSync(
      join(dir, "tests", "handlers", "test_audio_unknown_fixture.py"),
      [
        "import pytest",
        "from src.handlers.audio import AudioHandler",
        "@pytest.fixture",
        "def local_case():",
        "    return b'local'",
        "@pytest.mark.parametrize('fixture_name', ['local_case', 'external_case'])",
        "def test_with_unknown_fixture(fixture_name, request):",
        "    handler = AudioHandler()",
        "    audio = request.getfixturevalue(fixture_name)",
        "    assert handler.transform_request(audio) == audio",
        "@pytest.mark.parametrize('fixture_name', make_fixture_names())",
        "def test_with_dynamic_names(fixture_name, request):",
        "    handler = AudioHandler()",
        "    audio = request.getfixturevalue(fixture_name)",
        "    assert handler.transform_request(audio) == audio"
      ].join("\n")
    );
    writeFileSync(
      join(dir, "tests", "handlers", "test_audio_literal_unknown.py"),
      [
        "from src.handlers.audio import AudioHandler",
        "def test_with_external_fixture(request):",
        "    handler = AudioHandler()",
        "    audio = request.getfixturevalue('external_case')",
        "    assert handler.transform_request(audio) == audio"
      ].join("\n")
    );

    const fragment = analyzeRepo(dir);
    const testId = "test:tests/handlers/test_audio.py";
    const mockedTestId = "test:tests/handlers/test_audio_target_mock.py";
    const testedBy = (symbol: string): boolean => fragment.edges.some(
      (edge) => edge.relationship_type === "TESTED_BY" && edge.from_external_id === symbol && edge.to_external_id === testId
    );
    const testedByMockedTest = (symbol: string): boolean => fragment.edges.some(
      (edge) => edge.relationship_type === "TESTED_BY" && edge.from_external_id === symbol && edge.to_external_id === mockedTestId
    );

    expect(testedBy("sym:src/handlers/audio.py#LocalHandler._has_text_content")).toBe(true);
    expect(testedBy("sym:src/handlers/audio.py#AudioHandler.transform_request")).toBe(true);
    expect(testedByMockedTest("sym:src/handlers/audio.py#AudioHandler.transform_request")).toBe(false);
    expect(fragment.edges.some((edge) => edge.relationship_type === "TESTED_BY" &&
      edge.from_external_id === "sym:src/handlers/audio.py#AudioHandler.transform_request" &&
      edge.to_external_id === "test:tests/handlers/test_audio_unknown_fixture.py")).toBe(false);
    expect(fragment.edges.some((edge) => edge.relationship_type === "TESTED_BY" &&
      edge.from_external_id === "sym:src/handlers/audio.py#AudioHandler.transform_request" &&
      edge.to_external_id === "test:tests/handlers/test_audio_literal_unknown.py")).toBe(false);
  });

  it("retains only a narrow Python constructor-chain destructive callee", async () => {
    await preloadTreeSitter(["python"]);
    mkdirSync(join(dir, "src", "commands"), { recursive: true });
    mkdirSync(join(dir, "src", "models"), { recursive: true });
    writeFileSync(join(dir, "src", "models", "archive.py"), "class Archive:\n    pass\n");
    writeFileSync(join(dir, "src", "models", "other.py"), "class Archive:\n    pass\n");
    writeFileSync(join(dir, "src", "models", "__init__.py"), "from .archive import Archive\n");
    writeFileSync(
      join(dir, "src", "commands", "cleanup.py"),
      [
        "from src.models.archive import Archive as Store",
        "class LocalArchive:",
        "    pass",
        "def clear(conn):",
        "    return Store(conn).table.delete(where={})",
        "async def clear_awaited(conn):",
        "    response: Final = await Store(conn).table.delete(where={})",
        "    return response",
        "def clear_assigned(conn):",
        "    response = Store(conn).table.delete(where={})",
        "    return response",
        "def wrapped(conn):",
        "    response = wrap(Store(conn).table.delete(where={}))",
        "    return response",
        "def clear_local(conn):",
        "    return LocalArchive(conn).table.delete()",
        "def nested(conn):",
        "    return make(conn).table.delete()",
        "def extra_call(conn):",
        "    return Store(conn).table().delete()",
        "def past(conn):",
        "    return Store(conn).table.deleted()",
        "def detach(conn):",
        "    return Store(conn).view.remove_item()",
        "def conditional(conn, enabled):",
        "    if enabled:",
        "        return Store(conn).table.delete()",
        "def looped(conn, rows):",
        "    for _ in rows:",
        "        Store(conn).table.delete()",
        "def local_alias(conn):",
        "    Alias = Store",
        "    return Alias(conn).table.delete()"
      ].join("\n")
    );
    writeFileSync(join(dir, "src", "commands", "wild.py"), "from src.models.archive import *\ndef clear(conn):\n    return Archive(conn).table.delete()\n");
    writeFileSync(join(dir, "src", "commands", "reexport.py"), "from src.models import Archive\ndef clear(conn):\n    return Archive(conn).table.delete()\n");

    const fragment = analyzeRepo(dir);
    const props = (name: string, file = "src/commands/cleanup.py") => fragment.nodes.find(
      (node) => node.external_id === `sym:${file}#${name}`
    )?.properties;
    const callees = (name: string, file?: string): unknown => props(name, file)?.external_callees;
    const sinks = (name: string, file?: string): unknown => props(name, file)?.constructor_chain_sinks;

    expect(callees("clear")).toEqual(["Store(conn).table.delete"]);
    expect(sinks("clear")).toEqual([{ callee: "Store(conn).table.delete", constructor_symbol: "sym:src/models/archive.py#Archive" }]);
    expect(sinks("clear_awaited")).toEqual([{ callee: "Store(conn).table.delete", constructor_symbol: "sym:src/models/archive.py#Archive" }]);
    expect(sinks("clear_assigned")).toEqual([{ callee: "Store(conn).table.delete", constructor_symbol: "sym:src/models/archive.py#Archive" }]);
    expect(sinks("wrapped")).toBeUndefined();
    expect(sinks("clear_local")).toEqual([{ callee: "LocalArchive(conn).table.delete", constructor_symbol: "sym:src/commands/cleanup.py#LocalArchive" }]);
    expect(callees("nested")).toBeUndefined();
    expect(callees("extra_call")).toBeUndefined();
    expect(callees("past")).toBeUndefined();
    expect(callees("detach")).toBeUndefined();
    expect(callees("conditional")).toBeUndefined();
    expect(callees("looped")).toBeUndefined();
    expect(callees("local_alias")).toBeUndefined();
    expect(sinks("clear", "src/commands/wild.py")).toBeUndefined();
    expect(sinks("clear", "src/commands/reexport.py")).toBeUndefined();
  });

  it("excludes trivial constructors on ANY class and fields-only data shapes, never behavior", async () => {
    await preloadTreeSitter(["python"]);
    writeFileSync(
      join(dir, "src", "shapes.py"),
      [
        "from typing import TypedDict, NamedTuple",
        "import typing_extensions as tx",
        "from dataclasses import dataclass",
        "import dataclasses",
        "from pydantic import BaseModel, field_validator",
        "class Base:",
        "    pass",
        "class PlainHolder:",
        "    def __init__(self, a, b=2):",
        "        self.a = a",
        "        self.b = b",
        "class ForwardingError(Base):",
        "    def __init__(self, status, message):",
        "        super().__init__(status=status, message=message)",
        "class EmptyInit(Base):",
        "    def __init__(self):",
        "        pass",
        "class Computing:",
        "    def __init__(self, raw):",
        "        self.value = parse(raw)",
        "class Branching:",
        "    def __init__(self, flag):",
        "        if flag:",
        "            self.x = 1",
        "class ComputedSuper(Base):",
        "    def __init__(self, raw):",
        "        super().__init__(parse(raw))",
        "class FormattedSuper(Base):",
        "    def __init__(self, name):",
        "        super().__init__(f\"failed: {name}\")",
        "class Payload(TypedDict, total=False):",
        "    texts: list[str]",
        "    model: str | None",
        "class Point(NamedTuple):",
        "    x: int",
        "    y: int",
        "class Reader(tx.Protocol):",
        "    name: str",
        "@dataclass(frozen=True)",
        "class Settings:",
        "    \"\"\"settings\"\"\"",
        "    retries: int = 3",
        "@dataclasses.dataclass",
        "class Row:",
        "    key: str",
        "class Request(BaseModel):",
        "    user_id: str",
        "    limit: int = 10",
        "class ValidatedRequest(BaseModel):",
        "    user_id: str",
        "    @field_validator('user_id')",
        "    def check(cls, v):",
        "        return v",
        "class MethodDict(TypedDict):",
        "    a: int",
        "    def helper(self):",
        "        return 1",
        "class EncodedModel(BaseModel):",
        "    model_config = dict(json_encoders={int: lambda v: str(v)})",
        "class NotAShape:",
        "    a: int = 1",
        "@my_decorator",
        "class Decorated:",
        "    a: int"
      ].join("\n")
    );
    const fragment = analyzeRepo(dir);
    const node = (name: string) => fragment.nodes.find((n) => n.external_id === `sym:src/shapes.py#${name}`);
    const rank = (name: string): unknown => node(name)?.properties.ranking_exclusion_code;
    // Trivial constructors on classes that have nothing to do with threading.local.
    expect(rank("PlainHolder.__init__")).toBe("trivial_constructor");
    expect(rank("ForwardingError.__init__")).toBe("trivial_constructor");
    expect(rank("EmptyInit.__init__")).toBe("trivial_constructor");
    expect(node("PlainHolder.__init__")?.properties.ranking_exclusion_reason_code).toBe("python_trivial_constructor");
    // Constructors with behavior stay ranked.
    expect(rank("Computing.__init__")).toBeUndefined();
    expect(rank("Branching.__init__")).toBeUndefined();
    expect(rank("ComputedSuper.__init__")).toBeUndefined();
    expect(rank("FormattedSuper.__init__")).toBeUndefined();
    // Fields-only data shapes.
    for (const shape of ["Payload", "Point", "Reader", "Settings", "Row", "Request"]) {
      expect(rank(shape), shape).toBe("data_shape_declaration");
    }
    // A shape with a method is behavior (its methods rank); unknown bases/decorators are not shapes.
    expect(rank("ValidatedRequest")).toBe("python_class_with_methods");
    expect(rank("MethodDict")).toBe("python_class_with_methods");
    expect(rank("NotAShape")).toBeUndefined();
    expect(rank("EncodedModel")).toBeUndefined();
    expect(rank("Decorated")).toBeUndefined();
  });

  it("persists Python ranking exclusions only from exact AST shapes", async () => {
    await preloadTreeSitter(["python"]);
    mkdirSync(join(dir, "vendor_local"), { recursive: true });
    writeFileSync(join(dir, "vendor_local", "runtime.py"), "def run(value):\n    return value\n");
    writeFileSync(
      join(dir, "src", "ranking.py"),
      [
        "import threading as threads",
        "from enum import Enum, Flag as StdFlag",
        "import vendor_sdk as vendor",
        "import helper_sdk as _driver",
        "import vendor_local as local_vendor",
        "driver = _driver",
        "class Holder(threads.local):",
        "    def __init__(self, value=None):",
        "        \"\"\"state\"\"\"",
        "        super().__init__()",
        "        self.value = value",
        "        self.empty = None",
        "class Unsafe(threads.local):",
        "    def __init__(self):",
        "        self.value = load()",
        "class Color(Enum):",
        "    RED = 1",
        "class Behaviour(StdFlag):",
        "    READ = 1",
        "    def active(self):",
        "        return True",
        "def relay(value):",
        "    return vendor.run(value)",
        "def forwarded(value):",
        "    return driver.run(value)",
        "def transformed(value):",
        "    return vendor.run(value.strip())",
        "def side_effect(value):",
        "    audit(value)",
        "    return vendor.run(value)",
        "def local_namespace(value):",
        "    return local_vendor.run(value)"
      ].join("\n")
    );

    const fragment = analyzeRepo(dir);
    const code = (symbol: string): unknown => fragment.nodes.find(
      (node) => node.external_id === `sym:src/ranking.py#${symbol}`
    )?.properties.ranking_exclusion_reason_code;

    expect(code("Holder.__init__")).toBe("python_trivial_constructor");
    expect(code("Color")).toBe("python_stdlib_enum_declaration");
    expect(code("relay")).toBe("python_thin_external_delegate");
    const rankCode = (name: string): unknown => fragment.nodes.find((node) => node.external_id === `sym:src/ranking.py#${name}`)?.properties.ranking_exclusion_code;
    expect(rankCode("Holder.__init__")).toBe("trivial_constructor");
    expect(rankCode("Color")).toBe("enum_declaration");
    expect(rankCode("relay")).toBe("thin_external_delegate");
    expect(rankCode("Behaviour")).toBe("python_class_with_methods");
    expect(rankCode("Unsafe")).toBe("python_class_with_methods");
    expect(fragment.nodes.find((node) => node.external_id === "sym:src/ranking.py#Behaviour")?.properties.ranking_exclusion_reason).toContain("mapped method");
    expect(code("forwarded")).toBe("python_thin_external_delegate");
    expect(code("Unsafe.__init__")).toBeUndefined();
    expect(code("Behaviour")).toBeUndefined();
    expect(code("transformed")).toBeUndefined();
    expect(code("side_effect")).toBeUndefined();
    expect(code("local_namespace")).toBeUndefined();
  });
  it("pins named Python imports and non-call module attributes to only the referenced symbol", async () => {
    await preloadTreeSitter(["python"]);
    mkdirSync(join(dir, "src", "api"), { recursive: true });
    writeFileSync(join(dir, "src", "api", "mod.py"), [
      "def a():", "    return 1", "def b():", "    return 2", "def c():", "    return 3",
      "class Service:", "    def one(self):", "        return 1", "    def two(self):", "        return 2",
      "class Marker:", "    pass"
    ].join("\n"));
    writeFileSync(join(dir, "src", "api", "consumer.py"), [
      "import src.api.mod as module", "from src.api.mod import b", "def use():", "    module.a()", "    ref = module.c", "    b()",
      "    return ref"
    ].join("\n"));
    const fragment = analyzeRepo(dir);
    const symbols = fragment.nodes.filter((node) => node.kind === "CodeSymbol" && node.properties.file === "src/api/mod.py");
    const find = (name: string) => symbols.find((node) => node.title === name)!;
    const imp = fragment.edges.find((edge) => edge.relationship_type === "IMPORTS" && edge.from_external_id === "src/api/consumer.py" && edge.to_external_id === "src/api/mod.py")!;
    expect(imp.properties?.symbol_imports).toEqual([find("b").external_id]);
    expect(imp.properties?.symbol_references).toEqual({ [find("c").external_id]: 1 });
    expect(fragment.edges.some((edge) => edge.relationship_type === "CALLS" && edge.to_external_id === find("a").external_id)).toBe(true);
    expect(find("Service").properties.ranking_exclusion_code).toBe("python_class_with_methods");
    expect(find("Service").denominator_eligible).toBe(true);
    expect(find("Service.one").properties.ranking_exclusion_code).toBeUndefined();
    expect(find("Service.two").properties.ranking_exclusion_code).toBeUndefined();
    expect(find("Marker").properties.ranking_exclusion_code).toBeUndefined();
  });
  it("retains TS/Go symbol definitions while attaching exact TS named-import metadata", () => {
    mkdirSync(join(dir, "src", "api"), { recursive: true });
    writeFileSync(join(dir, "src", "api", "target.ts"), "export function a() { return 1; }\nexport function b() { return 2; }\n");
    writeFileSync(join(dir, "src", "api", "consumer.ts"), "import { b } from './target';\nexport function run() { return b(); }\n");
    writeFileSync(join(dir, "src", "api", "worker.go"), "package api\nfunc Execute() {}\n");
    const fragment = analyzeRepo(dir);
    const imp = fragment.edges.find((edge) => edge.relationship_type === "IMPORTS" && edge.from_external_id === "src/api/consumer.ts" && edge.to_external_id === "src/api/target.ts")!;
    expect(imp.properties?.symbol_imports).toEqual(["sym:src/api/target.ts#b"]);
    expect(fragment.nodes.some((node) => node.external_id === "sym:src/api/worker.go#Execute" && node.properties.ranking_exclusion_code === undefined)).toBe(true);
  });
});
