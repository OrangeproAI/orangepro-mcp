import { describe, it, expect, beforeAll, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { opInit, opAnalyze } from "../../src/local/operations.js";
import { loadGraph } from "../../src/local/workspace.js";
import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
import { BOILERPLATE_REASON } from "../../src/local/analyze/boilerplate.js";

const DEPS = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

beforeAll(async () => {
  await preloadTreeSitter(["java", "python", "go"]);
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-boiler-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function symbol(root: string, name: string) {
  const g = loadGraph(join(root, ".orangepro", "graph.json"));
  return g.nodes.find((n) => n.kind === "CodeSymbol" && n.title === name);
}
function analysis(root: string) {
  return loadGraph(join(root, ".orangepro", "graph.json")).analysis;
}

describe("boilerplate exclusion is wired into analyze, disclosed via counter", () => {
  it("excludes Java accessors from the denominator but keeps them as nodes", () => {
    const root = repo({
      "src/main/java/m/Owner.java":
        ["public class Owner {", "  private String name;", "  public String getName() { return name; }", "  public void setName(String n) { this.name = n; }", "  public String toString() { return name; }", "  public boolean validate() { return name != null && !name.isEmpty(); }", "}", ""].join("\n")
    });
    opInit(root, DEPS);
    opAnalyze(root, { source: root }, DEPS);

    const getName = symbol(root, "getName");
    expect(getName).toBeDefined();
    expect(getName!.denominator_eligible).toBe(false);
    expect(getName!.denominator_reason).toBe(BOILERPLATE_REASON);

    expect(symbol(root, "setName")!.denominator_eligible).toBe(false);
    expect(symbol(root, "toString")!.denominator_eligible).toBe(false);
    // A real method is still counted.
    expect(symbol(root, "validate")!.denominator_eligible).toBe(true);

    expect(analysis(root)?.excluded_boilerplate).toBe(3); // getName, setName, toString
  });

  it("CRITICAL: a getX-named SERVICE method with a real body stays denominator-eligible (Codex #58)", () => {
    const root = repo({
      "src/main/java/m/OwnerService.java":
        ["public class OwnerService {", "  private Repo repository;", "  public Owner getOwner(int id) { return repository.findById(id); }", "  public boolean validateOwner(Owner owner) { return owner != null; }", "  public String getName() { return name; }", "}", ""].join("\n")
    });
    opInit(root, DEPS);
    opAnalyze(root, { source: root }, DEPS);
    // getOwner() calls a repository — NOT a trivial accessor — must be counted.
    expect(symbol(root, "getOwner")!.denominator_eligible).toBe(true);
    expect(symbol(root, "validateOwner")!.denominator_eligible).toBe(true);
    // getName() is a bare field return — trivial, excluded.
    expect(symbol(root, "getName")!.denominator_eligible).toBe(false);
    expect(analysis(root)?.excluded_boilerplate).toBe(1); // getName only
  });

  it("keeps Python snake_case get_* and __init__, excludes only __repr__/__str__", () => {
    const root = repo({
      "app/service.py":
        ["class Service:", "    def __init__(self):", "        self.x = 1", "    def __repr__(self):", "        return 'Service'", "    def get_user(self, id):", "        return self.db.query(id)", ""].join("\n")
    });
    opInit(root, DEPS);
    opAnalyze(root, { source: root }, DEPS);

    expect(symbol(root, "__repr__")!.denominator_eligible).toBe(false);
    expect(symbol(root, "get_user")!.denominator_eligible).toBe(true);
    expect(symbol(root, "__init__")!.denominator_eligible).toBe(true);
    expect(analysis(root)?.excluded_boilerplate).toBe(1); // __repr__ only
  });

  it("does not exclude Go main", () => {
    const root = repo({
      "main.go": ["package main", "func main() { println(\"hi\") }", "func Handle() bool { return true }", ""].join("\n")
    });
    opInit(root, DEPS);
    opAnalyze(root, { source: root }, DEPS);
    expect(symbol(root, "main")!.denominator_eligible).toBe(true);
    expect(analysis(root)?.excluded_boilerplate).toBe(0);
  });
});
