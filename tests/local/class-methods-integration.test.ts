import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-member-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

const analyze = (root: string) => analyzeRepo(root, { readContent: true });
const sym = (frag: ReturnType<typeof analyzeRepo>, id: string) => frag.nodes.find((n) => n.external_id === id);

describe("class-method member symbols (Finding 2 — guarded)", () => {
  it("emits eligible member symbols with member_of + qualified external_id", () => {
    const frag = analyze(repo({ "src/api/admin.ts": "export class AdminAboutAPI {\n  about() { return 1; }\n  statistics() { return 2; }\n}\n" }));
    const about = sym(frag, "sym:src/api/admin.ts#AdminAboutAPI.about");
    expect(about).toBeDefined();
    expect(about!.kind).toBe("CodeSymbol");
    expect(about!.properties.symbol_kind).toBe("method");
    expect(about!.properties.member_of).toBe("AdminAboutAPI");
    expect(about!.denominator_eligible).toBe(true);
    // the class itself is also present
    expect(sym(frag, "sym:src/api/admin.ts#AdminAboutAPI")).toBeDefined();
  });

  it("never hard-confirms a member symbol (not fed to the exported-binding confirmer)", () => {
    const frag = analyze(repo({ "src/api/admin.ts": "export class AdminAboutAPI {\n  about() { return 1; }\n}\n" }));
    const id = "sym:src/api/admin.ts#AdminAboutAPI.about";
    const hardOnMember = frag.edges.filter(
      (e) => (e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS") && (e.from_external_id === id || e.to_external_id === id)
    );
    expect(hardOnMember).toEqual([]); // member is candidate/has-test only, never hard
  });

  it("does not emit private/protected/#private members as denominator behaviors (Codex #60)", () => {
    const frag = analyze(repo({ "src/api.ts": "export class Api {\n  public about() {}\n  private parse() {}\n  protected build() {}\n  static make() {}\n  #secret() {}\n}\n" }));
    expect(sym(frag, "sym:src/api.ts#Api.about")?.denominator_eligible).toBe(true);
    expect(sym(frag, "sym:src/api.ts#Api.make")?.denominator_eligible).toBe(true);
    expect(sym(frag, "sym:src/api.ts#Api.parse")).toBeUndefined(); // private — not in graph
    expect(sym(frag, "sym:src/api.ts#Api.build")).toBeUndefined(); // protected — not in graph
    expect(sym(frag, "sym:src/api.ts#Api.#secret")).toBeUndefined(); // #private — not in graph
  });

  it("does not emit declaration-only members (abstract / ambient) as behaviors (Codex #60)", () => {
    const frag = analyze(repo({
      "src/svc.ts": "export abstract class Service {\n  abstract load(): Promise<void>;\n  concrete() {}\n}\nexport declare class Ambient {\n  fetch(): Promise<void>;\n}\n"
    }));
    expect(sym(frag, "sym:src/svc.ts#Service.concrete")?.denominator_eligible).toBe(true);
    expect(sym(frag, "sym:src/svc.ts#Service.load")).toBeUndefined(); // abstract — no body
    expect(sym(frag, "sym:src/svc.ts#Ambient.fetch")).toBeUndefined(); // ambient declare
    expect(sym(frag, "sym:src/svc.ts#Ambient")).toBeUndefined(); // the ambient class NODE itself
  });

  it("KEEPS test-infra member methods as nodes but denominator-ineligible (Codex #63)", () => {
    // `e2e-tests/` is role:code (not matched by isTestFile) but IS test infra.
    const frag = analyze(repo({ "e2e-tests/lib/browser.ts": "export class TestBrowser {\n  login() {}\n  switchUser() {}\n}\n" }));
    // class AND its methods are kept as nodes, all denominator-ineligible.
    for (const id of ["sym:e2e-tests/lib/browser.ts#TestBrowser", "sym:e2e-tests/lib/browser.ts#TestBrowser.login", "sym:e2e-tests/lib/browser.ts#TestBrowser.switchUser"]) {
      expect(sym(frag, id)).toBeDefined();
      expect(sym(frag, id)!.denominator_eligible).toBe(false);
    }
  });
});
