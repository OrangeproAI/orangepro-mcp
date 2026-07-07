import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { denominatorComposition } from "../../src/local/graph/factories.js";
import { GENERATED_CODE_REASON, NON_PRODUCT_REASON, isGeneratedCode, isNonProductPath } from "../../src/local/analyze/classify.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-infra-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}
const sym = (frag: ReturnType<typeof analyzeRepo>, id: string) => frag.nodes.find((n) => n.external_id === id);

describe("isNonProductPath — strict scope (Codex #63)", () => {
  it("matches CI, root test suites, and mock/fixture dirs anywhere", () => {
    for (const p of [
      ".github/actions/x/main.ts", // CI
      "e2e-tests/lib/file.ts", // root e2e-tests suite
      "cypress/support/x.ts", // root cypress suite
      "playwright/runner.ts", // root playwright suite
      "src/__mocks__/y.ts", // __mocks__ dir anywhere
      "server/channels/store/storetest/mocks/Store.go", // deep mocks/ dir
      "src/data/fixtures/seed.ts" // fixtures dir anywhere
    ]) {
      expect(isNonProductPath(p)).toBe(true);
    }
  });
  it("does NOT exclude product code (the Codex CRITICAL repros) or broad scripts/tools", () => {
    for (const p of [
      "src/playwright/runner.ts", // product Playwright integration — NOT a root suite
      "src/date-helper.ts", // helper-suffixed product util
      "src/app/service.ts",
      "lib/util.ts",
      "scripts/build.ts",
      "tools/gen.ts",
      "packages/core/index.ts"
    ]) {
      expect(isNonProductPath(p)).toBe(false);
    }
  });
});

describe("CI/test-infra symbols excluded from the behavior denominator (kept as nodes)", () => {
  it("marks a .github exported function ineligible with the infra reason, keeps the node", () => {
    const root = repo({
      ".github/actions/x/src/main.ts": "export function run() { return 1; }\n",
      "src/prod.ts": "export function add() { return 1; }\n"
    });
    const frag = analyzeRepo(root, { readContent: true });
    const infra = sym(frag, "sym:.github/actions/x/src/main.ts#run");
    expect(infra).toBeDefined(); // node kept
    expect(infra!.denominator_eligible).toBe(false);
    expect(infra!.denominator_reason).toBe(NON_PRODUCT_REASON);
    // product symbol still counts
    expect(sym(frag, "sym:src/prod.ts#add")!.denominator_eligible).toBe(true);
  });

  it("excludes e2e-tests/playwright helper exports from the denominator", () => {
    const root = repo({ "e2e-tests/playwright/lib/file.ts": "export function getFileData() { return 1; }\n" });
    const frag = analyzeRepo(root, { readContent: true });
    expect(sym(frag, "sym:e2e-tests/playwright/lib/file.ts#getFileData")!.denominator_eligible).toBe(false);
  });

  it("KEEPS infra class members as ineligible nodes — all counted in the total (Codex #63 HIGH)", () => {
    const root = repo({ "e2e-tests/playwright/lib/page.ts": "export class Page {\n  open() { return 1; }\n  close() { return 2; }\n}\n" });
    const frag = analyzeRepo(root, { readContent: true });
    for (const id of ["sym:e2e-tests/playwright/lib/page.ts#Page", "sym:e2e-tests/playwright/lib/page.ts#Page.open", "sym:e2e-tests/playwright/lib/page.ts#Page.close"]) {
      expect(sym(frag, id)).toBeDefined();
      expect(sym(frag, id)!.denominator_eligible).toBe(false);
    }
    const comp = denominatorComposition(frag);
    expect(comp.code_symbols_total).toBe(3);
    expect(comp.excluded_infra).toBe(3); // class + 2 methods
  });

  it("composition counts infra exclusions in their own bucket (node-derived, disjoint sum)", () => {
    const root = repo({
      "src/prod.ts": "export function add() { return 1; }\n",
      ".github/x.ts": "export function ci() { return 1; }\n",
      "e2e-tests/h.ts": "export function helper() { return 1; }\n"
    });
    const frag = analyzeRepo(root, { readContent: true });
    const comp = denominatorComposition(frag);
    expect(comp.excluded_infra).toBe(2); // ci + helper
    expect(comp.code_export).toBe(1); // only the product fn counts
    // disjoint sum: every CodeSymbol is counted or in exactly one excluded bucket
    expect(comp.code_symbols_total).toBe(comp.code_export + comp.excluded_boilerplate + comp.excluded_infra + comp.excluded_generated);
  });
});

describe("generated code symbols excluded from the behavior denominator", () => {
  it("recognizes the standard generated-code marker without matching normal comments", () => {
    expect(isGeneratedCode('// Code generated by "make pluginapi"; DO NOT EDIT.\npackage plugin\n')).toBe(true);
    expect(isGeneratedCode('// Code generated by "make store-layers"\n// DO NOT EDIT\npackage retrylayer\n')).toBe(true);
    expect(isGeneratedCode('package model\n\n// Code generated by github.com/tinylib/msgp DO NOT EDIT.\n\nimport "x"\n')).toBe(true);
    expect(isGeneratedCode("// Code generates a cache key; edits are allowed.\nexport function build() {}\n")).toBe(false);
    expect(
      isGeneratedCode('package main\n\nimport "text/template"\n\nvar tmpl = template.Must(template.New("").Parse(`// Code generated by tool. DO NOT EDIT.`))\n')
    ).toBe(false);
  });

  it("keeps generated symbols as nodes but excludes them with a generated-code reason", () => {
    const root = repo({
      "src/generated/client_rpc_generated.go": '// Code generated by "make pluginapi"; DO NOT EDIT.\npackage generated\nfunc CallPlugin() {}\n',
      "src/prod.go": "package src\nfunc RunHandWritten() {}\n"
    });
    const frag = analyzeRepo(root, { readContent: true });
    const generated = sym(frag, "sym:src/generated/client_rpc_generated.go#CallPlugin");
    expect(generated).toBeDefined();
    expect(generated!.denominator_eligible).toBe(false);
    expect(generated!.denominator_reason).toBe(GENERATED_CODE_REASON);
    expect(sym(frag, "sym:src/prod.go#RunHandWritten")!.denominator_eligible).toBe(true);
    const comp = denominatorComposition(frag);
    expect(comp.excluded_generated).toBe(1);
    expect(comp.code_export).toBe(1);
    expect(comp.code_symbols_total).toBe(comp.code_export + comp.excluded_boilerplate + comp.excluded_infra + comp.excluded_generated);
  });
});

describe("QueryBuilder query-builder plumbing excluded from the denominator (owner-level; the buildQuery leak)", () => {
  it("excludes ALL methods of a QueryBuilderService by OWNER — not just the 3 observed names", () => {
    const root = repo({
      "src/query-builder.service.ts":
        "export class QueryBuilderService {\n  buildQuery() { return 1; }\n  buildResponse() { return 2; }\n  compileExpression() { return 3; }\n  buildWhere() { return 4; }\n}\n"
    });
    const frag = analyzeRepo(root, { readContent: true });
    // buildWhere is the whack-a-mole win: the owner-level fix catches it, a 3-method whitelist would not.
    for (const m of ["buildQuery", "buildResponse", "compileExpression", "buildWhere"]) {
      const node = sym(frag, `sym:src/query-builder.service.ts#QueryBuilderService.${m}`);
      expect(node, m).toBeDefined();
      expect(node!.denominator_eligible, m).toBe(false);
      expect((node!.properties as Record<string, unknown>).denominator_reason_code, m).toBe("infra_behavior_surface");
    }
  });

  it("RETAINS functional services whose method is merely NAMED like plumbing (the owner guard)", () => {
    const root = repo({
      // PricingService.buildResponse — functional owner, plumbing-looking method name → MUST stay eligible.
      "src/pricing.service.ts": "export class PricingService {\n  buildResponse() { return 2; }\n}\n",
      "src/order-builder.service.ts": "export class OrderBuilderService {\n  buildOrder() { return 1; }\n}\n",
      "src/quote.service.ts": "export class QuoteService {\n  buildQuote() { return 1; }\n}\n"
    });
    const frag = analyzeRepo(root, { readContent: true });
    expect(sym(frag, "sym:src/pricing.service.ts#PricingService.buildResponse")!.denominator_eligible).toBe(true);
    expect(sym(frag, "sym:src/order-builder.service.ts#OrderBuilderService.buildOrder")!.denominator_eligible).toBe(true);
    expect(sym(frag, "sym:src/quote.service.ts#QuoteService.buildQuote")!.denominator_eligible).toBe(true);
  });

  it("does NOT introduce a broad *Builder*Service exclusion (guards the #145 over-exclusion)", () => {
    const root = repo({ "src/report-builder.service.ts": "export class ReportBuilderService {\n  generateReport() { return 1; }\n}\n" });
    const frag = analyzeRepo(root, { readContent: true });
    expect(sym(frag, "sym:src/report-builder.service.ts#ReportBuilderService.generateReport")!.denominator_eligible).toBe(true);
  });
});

describe("design-system/icons UI components excluded from the denominator (Medusa icon leak)", () => {
  it("excludes design-system/icons component symbols even when the name matches a behavior verb", () => {
    // On real Medusa, icons like ArchiveBox/CommandLine/ListBullet leaked because their PascalCase
    // name starts with a behavior verb (archive/command/list); the package-role path exclusion catches
    // them regardless of name — they're React SVG UI, not backend behaviors.
    const root = repo({
      "packages/design-system/icons/src/components/archive-box.tsx": "export function ArchiveBox() { return null; }\n"
    });
    const frag = analyzeRepo(root, { readContent: true });
    const node = sym(frag, "sym:packages/design-system/icons/src/components/archive-box.tsx#ArchiveBox");
    expect(node).toBeDefined();
    expect(node!.denominator_eligible).toBe(false);
    expect((node!.properties as Record<string, unknown>).denominator_reason_code).toBe("infra_behavior_surface");
  });

  it("RETAINS a real backend service outside design-system", () => {
    const root = repo({
      "packages/modules/order/src/services/order.service.ts":
        "export class OrderService {\n  createOrder(id: string): string { return `order-${id}`; }\n}\n"
    });
    const frag = analyzeRepo(root, { readContent: true });
    expect(sym(frag, "sym:packages/modules/order/src/services/order.service.ts#OrderService.createOrder")!.denominator_eligible).toBe(true);
  });
});
