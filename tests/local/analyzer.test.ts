import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { languageOf, roleOf, isTestFile, testLayerOf } from "../../src/local/analyze/classify.js";
import { detectFrameworksFromManifest, detectFromPackageJson, frameworkFromConfig } from "../../src/local/analyze/frameworks.js";
import { extractSymbols, extractTestNames } from "../../src/local/analyze/symbols.js";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
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
});
