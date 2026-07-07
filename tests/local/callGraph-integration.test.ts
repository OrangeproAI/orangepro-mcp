import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { medusaGeneratedMethodNames } from "../../src/local/analyze/callGraph.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-calls-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const callEdges = (root: string) =>
  analyzeRepo(root, { readContent: true })
    .edges.filter((e) => e.relationship_type === "CALLS")
    .map((e) => `${e.from_external_id} -> ${e.to_external_id}`)
    .sort();

const callEdgeObjects = (root: string) => analyzeRepo(root, { readContent: true }).edges.filter((e) => e.relationship_type === "CALLS");

const frameworkDerivedEdges = (root: string) =>
  analyzeRepo(root, { readContent: true }).edges.filter((e) => e.relationship_type === "CALLS" && e.evidence_strength === "framework-derived");

describe("call graph — exact-resolved CALLS edges (Layer 1, PR 1)", () => {
  it("derives Medusa generated service method names from model keys", () => {
    expect(medusaGeneratedMethodNames("Cart")).toEqual([
      "retrieveCart",
      "listCarts",
      "listAndCountCarts",
      "deleteCarts",
      "softDeleteCarts",
      "restoreCarts",
      "createCarts",
      "updateCarts"
    ]);
    expect(medusaGeneratedMethodNames("LineItem")).toContain("listLineItems");
  });

  it("emits a same-file CALLS edge between two emitted symbols", () => {
    const root = repo({ "src/a.ts": "export function helper() { return 1; }\nexport function run() { return helper(); }\n" });
    expect(callEdges(root)).toContain("sym:src/a.ts#run -> sym:src/a.ts#helper");
  });

  it("emits an import-resolved CALLS edge to the defining file's symbol", () => {
    const root = repo({
      "src/util.ts": "export function saveUser() { return 1; }\n",
      "src/svc.ts": "import { saveUser } from './util';\nexport function persist() { return saveUser(); }\n"
    });
    expect(callEdges(root)).toContain("sym:src/svc.ts#persist -> sym:src/util.ts#saveUser");
  });

  it("resolves this.member() and static Class.member() to same-file member symbols", () => {
    const root = repo({
      "src/c.ts": "export class C {\n  helper() { return 1; }\n  run() { return this.helper(); }\n  static make() { return C.build(); }\n  static build() { return 2; }\n}\n"
    });
    const e = callEdges(root);
    expect(e).toContain("sym:src/c.ts#C.run -> sym:src/c.ts#C.helper"); // this.helper()
    expect(e).toContain("sym:src/c.ts#C.make -> sym:src/c.ts#C.build"); // C.build() static
  });

  it("does NOT emit a CALLS edge for an unresolved free call or obj.method()", () => {
    const root = repo({ "src/a.ts": "export function run() { external(); thing.method(); }\n" });
    expect(callEdges(root)).toEqual([]); // external is undeclared; thing is not a same-file class
  });

  it("does NOT emit a CALLS edge when the import target does not define the name (barrel/re-export)", () => {
    // ./barrel re-exports from elsewhere and defines no own `saveUser` symbol.
    const root = repo({
      "src/barrel.ts": "export * from './impl';\n",
      "src/impl.ts": "export function saveUser() { return 1; }\n",
      "src/svc.ts": "import { saveUser } from './barrel';\nexport function persist() { return saveUser(); }\n"
    });
    // svc -> barrel#saveUser is NOT emitted (barrel.ts defines no saveUser); exact-only.
    expect(callEdges(root).some((e) => e.includes("barrel.ts#saveUser"))).toBe(false);
  });

  it("does NOT emit a CALLS edge when a parameter shadows an emitted symbol (Codex #62)", () => {
    // `run(helper)` calls the PARAMETER, not the exported helper.
    const root = repo({
      "src/a.ts": "export function helper() { return 1; }\nexport function run(helper: () => number) { return helper(); }\n"
    });
    expect(callEdges(root)).toEqual([]);
  });

  it("does NOT emit a static CALLS edge when a parameter shadows the class (Codex #62)", () => {
    const root = repo({
      "src/a.ts": "export class C { static build() { return 1; } }\nexport function run(C: { build(): number }) { return C.build(); }\n"
    });
    expect(callEdges(root).some((e) => e.includes("C.build"))).toBe(false);
  });

  it("does NOT resolve this.member() inside a non-arrow function expression (Codex #62 round-2)", () => {
    const root = repo({
      "src/c.ts": "export class C {\n  helper() { return 1; }\n  run() { setTimeout(function () { this.helper(); }); }\n}\n"
    });
    expect(callEdges(root).some((e) => e.includes("C.run -> sym:src/c.ts#C.helper"))).toBe(false);
  });

  it("DOES resolve this.member() inside an arrow callback (lexical this)", () => {
    const root = repo({
      "src/c.ts": "export class C {\n  helper() { return 1; }\n  run() { setTimeout(() => { this.helper(); }); }\n}\n"
    });
    expect(callEdges(root)).toContain("sym:src/c.ts#C.run -> sym:src/c.ts#C.helper");
  });

  it("does NOT extract call edges from test-infra or .github CI paths (Codex #62 MEDIUM)", () => {
    const root = repo({
      "e2e-tests/playwright/lib/file.ts": "export function getFileData() { return 1; }\nexport function getFileFromAsset() { return getFileData(); }\n",
      ".github/actions/x/src/main.ts": "export function load() { return 1; }\nexport function run() { return load(); }\n",
      "src/prod.ts": "export function a() { return 1; }\nexport function b() { return a(); }\n"
    });
    const e = callEdges(root);
    expect(e).toContain("sym:src/prod.ts#b -> sym:src/prod.ts#a"); // product path kept
    expect(e.some((x) => x.includes("e2e-tests/"))).toBe(false);
    expect(e.some((x) => x.includes(".github/"))).toBe(false);
  });

  it("does NOT emit a false edge from a nested local that impersonates an emitted symbol (Codex #62 round-3)", () => {
    // The target() call belongs to the NESTED local `inner`, not the exported `inner`.
    const root = repo({
      "src/a.ts": "export function target() {}\nexport function inner() {}\nexport function outer() {\n  function inner() { target(); }\n  inner();\n}\n"
    });
    const e = callEdges(root);
    expect(e.some((x) => x.includes("#inner -> sym:src/a.ts#target"))).toBe(false);
    expect(e.some((x) => x.includes("#outer -> sym:src/a.ts#target"))).toBe(false); // not transitive-as-direct either
  });

  it("does NOT emit a false edge from a namespace-nested local impersonating an emitted symbol (Codex #62 round-4)", () => {
    const root = repo({
      "src/a.ts": "export function target() {}\nexport function inner() {}\nnamespace N { export function inner() { target(); } }\n"
    });
    const e = callEdges(root);
    expect(e.some((x) => x.includes("#inner -> sym:src/a.ts#target"))).toBe(false);
  });

  it("never emits a self-recursion edge", () => {
    const root = repo({ "src/a.ts": "export function fac(n) { return n <= 1 ? 1 : fac(n - 1); }\n" });
    expect(callEdges(root)).toEqual([]); // fac -> fac is suppressed
  });

  it("CALLS edges are structural-only — they are not coverage and not candidate edges", () => {
    const root = repo({ "src/a.ts": "export function h() {}\nexport function r() { h(); }\n" });
    const frag = analyzeRepo(root, { readContent: true });
    const calls = frag.edges.filter((e) => e.relationship_type === "CALLS");
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((e) => typeof e.properties?.call_via === "string" && typeof e.properties?.resolution === "string")).toBe(true);
    // no CALLS leaked into candidate_edges, and none is TESTED_BY/COVERS
    expect(frag.candidate_edges.some((e) => (e.relationship_type as string) === "CALLS")).toBe(false);
    expect(frag.edges.some((e) => e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS")).toBe(false);
  });

  it("resolves injected calls from TypeScript parameter properties", () => {
    const root = repo({
      "src/cart.ts": "export class CartService { create() { return 1; } }\n",
      "src/order.ts": "import { CartService } from './cart';\nexport class OrderService {\n  constructor(private readonly cartService_: CartService) {}\n  run() { return this.cartService_.create(); }\n}\n"
    });
    const edges = callEdgeObjects(root);
    expect(edges.map((e) => `${e.from_external_id} -> ${e.to_external_id}`)).toContain("sym:src/order.ts#OrderService.run -> sym:src/cart.ts#CartService.create");
    expect(edges.find((e) => e.from_external_id === "sym:src/order.ts#OrderService.run" && e.to_external_id === "sym:src/cart.ts#CartService.create")?.properties).toEqual({
      call_via: "injected",
      resolution: "injected_import"
    });
  });

  it("resolves injected calls from constructor assignment with typed params", () => {
    const root = repo({
      "src/cart.ts": "export class CartService { create() { return 1; } }\n",
      "src/order.ts": "import { CartService } from './cart';\nexport class OrderService {\n  constructor(cartService: CartService) { this.cartService_ = cartService; }\n  run() { return this.cartService_.create(); }\n}\n"
    });
    expect(callEdges(root)).toContain("sym:src/order.ts#OrderService.run -> sym:src/cart.ts#CartService.create");
  });

  it("resolves injected calls from typed class fields", () => {
    const root = repo({
      "src/cart.ts": "export class CartService { create() { return 1; } }\n",
      "src/order.ts": "import { CartService } from './cart';\nexport class OrderService {\n  private cartService_!: CartService;\n  run() { return this.cartService_.create(); }\n}\n"
    });
    expect(callEdges(root)).toContain("sym:src/order.ts#OrderService.run -> sym:src/cart.ts#CartService.create");
  });

  it("resolves injected calls from Nest @Inject parameter properties using the TypeScript type", () => {
    const root = repo({
      "src/cart.ts": "export class CartService { create() { return 1; } }\n",
      "src/order.ts": "import { CartService } from './cart';\nfunction Inject(_token: unknown) { return () => undefined; }\nexport class OrderService {\n  constructor(@Inject('CART') private readonly svc: CartService) {}\n  run() { return this.svc.create(); }\n}\n"
    });
    expect(callEdges(root)).toContain("sym:src/order.ts#OrderService.run -> sym:src/cart.ts#CartService.create");
  });

  it("resolves injected calls from same-file dependency interfaces and constructor destructuring", () => {
    const root = repo({
      "src/cart.ts": "export class CartService { create() { return 1; } }\n",
      "src/order.ts": "import type { CartService } from './cart';\ninterface InjectedDependencies { cartService: CartService; }\nexport class OrderService {\n  constructor({ cartService }: InjectedDependencies) { this.cartService_ = cartService; }\n  run() { return this.cartService_.create(); }\n}\n"
    });
    expect(callEdges(root)).toContain("sym:src/order.ts#OrderService.run -> sym:src/cart.ts#CartService.create");
  });

  it("resolves injected calls from Medusa-style type-alias dependency destructuring through barrels", () => {
    const root = repo({
      "src/services/cart.ts": "export class CartService { create() { return 1; } }\n",
      "src/services/index.ts": "export { CartService } from './cart';\n",
      "src/order.ts": "import type { CartService } from './services';\ntype InjectedDependencies = { cartService: CartService };\nexport class OrderService {\n  constructor({ cartService }: InjectedDependencies) { this.cartService_ = cartService; }\n  run() { return this.cartService_.create(); }\n}\n"
    });
    const edges = callEdgeObjects(root);
    expect(edges.map((e) => `${e.from_external_id} -> ${e.to_external_id}`)).toContain("sym:src/order.ts#OrderService.run -> sym:src/services/cart.ts#CartService.create");
    expect(edges.find((e) => e.from_external_id === "sym:src/order.ts#OrderService.run" && e.to_external_id === "sym:src/services/cart.ts#CartService.create")?.properties).toEqual({
      call_via: "injected",
      resolution: "injected_barrel"
    });
  });

  it("resolves imported injected types before same-file same-name decoys", () => {
    const root = repo({
      "src/external.ts": "export class CartService { create() { return 1; } }\n",
      "src/local-shadow.ts": "import { CartService } from './external';\nexport class CartService { create() { return 'local'; } }\nexport class OrderService { constructor(private svc: CartService) {} run() { return this.svc.create(); } }\n"
    });
    const edges = callEdges(root);
    expect(edges).toContain("sym:src/local-shadow.ts#OrderService.run -> sym:src/external.ts#CartService.create");
    expect(edges).not.toContain("sym:src/local-shadow.ts#OrderService.run -> sym:src/local-shadow.ts#CartService.create");
  });

  it("does NOT emit injected CALLS edges without an exact typed field", () => {
    const root = repo({
      "src/cart.ts": "export class CartService { create() { return 1; } }\n",
      "src/order.ts": "export class OrderService {\n  constructor(svc) { this.svc = svc; }\n  run() { return this.svc.create(); }\n}\n"
    });
    expect(callEdges(root)).toEqual([]);
  });

  it("does NOT emit injected CALLS edges for union, generic, or any typed fields", () => {
    const root = repo({
      "src/cart.ts": "export class CartService { create() { return 1; } }\nexport class OtherCartService { create() { return 2; } }\n",
      "src/order.ts": "import { CartService, OtherCartService } from './cart';\nexport class UnionOrderService { constructor(private svc: CartService | OtherCartService) {} run() { return this.svc.create(); } }\nexport class GenericOrderService { constructor(private svc: Promise<CartService>) {} run() { return this.svc.create(); } }\nexport class AnyOrderService { constructor(private svc: any) {} run() { return this.svc.create(); } }\n"
    });
    expect(callEdges(root)).toEqual([]);
  });

  it("does NOT emit injected CALLS edges for ambiguous unimported types", () => {
    const root = repo({
      "src/a.ts": "export class CartService { create() { return 1; } }\n",
      "src/b.ts": "export class CartService { create() { return 2; } }\n",
      "src/order.ts": "export class OrderService { constructor(private svc: CartService) {} run() { return this.svc.create(); } }\n"
    });
    expect(callEdges(root)).toEqual([]);
  });

  it("does NOT emit injected CALLS edges when the target member is not emitted", () => {
    const root = repo({
      "src/cart.ts": "export class CartService { create() { return 1; } }\n",
      "src/order.ts": "import { CartService } from './cart';\nexport class OrderService { constructor(private svc: CartService) {} run() { return this.svc.notAMethod(); } }\n"
    });
    expect(callEdges(root)).toEqual([]);
  });

  it("does NOT capture deeper injected chains or calls on locals as hard CALLS", () => {
    const root = repo({
      "src/cart.ts": "export class CartService { create() { return 1; } }\n",
      "src/order.ts": "import { CartService } from './cart';\nexport class OrderService {\n  constructor(private svc: CartService) {}\n  deep() { return this.svc.child.create(); }\n  local() { const x = this.svc; return x.create(); }\n}\n"
    });
    expect(callEdges(root)).toEqual([]);
  });

  it("emits framework-derived virtual symbols and edges for Medusa generated services", () => {
    const root = repo({
      "src/cart.ts": [
        "declare function MedusaService(models: unknown): new (...args: any[]) => {};",
        "class Cart {}",
        "export class CartModuleService extends MedusaService({ Cart }) {}",
        "export class OrderService {",
        "  constructor(private cartService_: IMedusaInternalService<any>) {}",
        "  run() { return this.cartService_.create({}); }",
        "}",
        "interface IMedusaInternalService<T> { create(data: unknown): T }"
      ].join("\n")
    });
    const fragment = analyzeRepo(root, { readContent: true });
    expect(fragment.nodes.find((n) => n.external_id === "sym:src/cart.ts#CartModuleService.createCarts")).toEqual(expect.objectContaining({
      kind: "CodeSymbol",
      evidence_strength: "framework-derived",
      denominator_eligible: false,
      properties: expect.objectContaining({
        origin: "framework-derived",
        synthesized: true,
        model_key: "Cart",
        method_base: "create"
      })
    }));
    expect(frameworkDerivedEdges(root)).toEqual([
      expect.objectContaining({
        from_external_id: "sym:src/cart.ts#OrderService.run",
        to_external_id: "sym:src/cart.ts#CartModuleService.createCarts",
        evidence_strength: "framework-derived",
        properties: expect.objectContaining({
          call_via: "framework-derived",
          origin: "medusa-generated-service",
          resolution: "medusa_unique_registration",
          model_key: "Cart",
          method_base: "create"
        })
      })
    ]);
  });

  it("does not change the hard CALLS set when adding Medusa framework-derived edges", () => {
    const root = repo({
      "src/cart.ts": [
        "declare function MedusaService(models: unknown): new (...args: any[]) => {};",
        "class Cart {}",
        "export class CartModuleService extends MedusaService({ Cart }) {}",
        "export class OrderService {",
        "  constructor(private cartService_: IMedusaInternalService<any>) {}",
        "  helper() { return 1; }",
        "  run() { this.helper(); return this.cartService_.create({}); }",
        "}",
        "interface IMedusaInternalService<T> { create(data: unknown): T }"
      ].join("\n")
    });
    const fragment = analyzeRepo(root, { readContent: true });
    expect(fragment.edges.filter((e) => e.relationship_type === "CALLS" && e.evidence_strength === "hard").map((e) => `${e.from_external_id} -> ${e.to_external_id}`)).toEqual([
      "sym:src/cart.ts#OrderService.run -> sym:src/cart.ts#OrderService.helper"
    ]);
    expect(fragment.edges.filter((e) => e.relationship_type === "CALLS" && e.evidence_strength === "framework-derived")).toHaveLength(1);
  });

  it("skips framework-derived edges when Medusa generated service registration is ambiguous", () => {
    const root = repo({
      "src/cart.ts": [
        "declare function MedusaService(models: unknown): new (...args: any[]) => {};",
        "class Cart {}",
        "export class CartModuleService extends MedusaService({ Cart }) {}",
        "export class OtherCartModuleService extends MedusaService({ Cart }) {}",
        "export class OrderService {",
        "  constructor(private cartService_: IMedusaInternalService<any>) {}",
        "  run() { return this.cartService_.create({}); }",
        "}",
        "interface IMedusaInternalService<T> { create(data: unknown): T }"
      ].join("\n")
    });
    expect(frameworkDerivedEdges(root)).toEqual([]);
  });

  it("emits zero framework-derived edges for a plain Nest-style fixture", () => {
    const root = repo({
      "src/order.ts": "export class CartService { create() { return 1; } }\nexport class OrderService { constructor(private cartService_: CartService) {} run() { return this.cartService_.create(); } }\n"
    });
    expect(frameworkDerivedEdges(root)).toEqual([]);
  });
});
