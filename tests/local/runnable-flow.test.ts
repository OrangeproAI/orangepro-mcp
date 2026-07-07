import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTests } from "../../src/local/generate/generator.js";
import { runnableRunHintsFor } from "../../src/local/generate/runHints.js";
import { resetResolverCaches } from "../../src/local/resolve/resolver.js";
import { resetExportIndexCache } from "../../src/local/resolve/exportIndex.js";
import { makeNode, makeEdge } from "../../src/local/graph/factories.js";
import { GeneratedTest, LOCAL_GRAPH_SCHEMA_VERSION, LocalGraph } from "../../src/local/graph/ontology.js";
import type { ModelProvider } from "../../src/local/types.js";

const CLOCK = () => "2026-06-07T00:00:00Z";
const prov = (ref: string) => ({ source_scope_id: "s", source_ref: ref, detector: "t" });

function graph(root = "/tmp/f"): LocalGraph {
  const req = makeNode({
    kind: "Requirement",
    external_id: "REQ-001",
    title: "Card payment is captured on confirm",
    properties: { priority: "high", area: "payments" },
    evidence_strength: "hard",
    review_status: "local_reviewed",
    confidence: 1,
    provenance: prov("t.csv#row=2")
  });
  const ac = makeNode({
    kind: "AcceptanceCriterion",
    external_id: "AC-001",
    title: "A successful capture returns a transaction id",
    properties: { text: "A successful capture returns a transaction id" },
    evidence_strength: "hard",
    review_status: "local_reviewed",
    confidence: 1,
    provenance: prov("t.csv#row=2")
  });
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "f", root, root_hash: "h", source_upload_policy: "metadata_only" },
    created_at: CLOCK(),
    updated_at: CLOCK(),
    sources: [],
    nodes: [req, ac],
    edges: [
      makeEdge({
        from_external_id: "REQ-001",
        to_external_id: "AC-001",
        relationship_type: "HAS_ACCEPTANCE_CRITERION",
        evidence_strength: "hard",
        review_status: "local_reviewed",
        provenance: prov("t.csv#row=2")
      })
    ],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: CLOCK(), git: null, files: {} }
  };
}

function provider(body: string): ModelProvider {
  return { providerName: "openai", modelName: "fake", async complete() { return body; } };
}

describe("generate runnable + import_provenance flow (PLAN 6.5)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetResolverCaches();
    resetExportIndexCache();
    while (dirs.length) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  // A minimal real repo that DECLARES vitest, so the framework import is recognized
  // as an installed package (not flagged as a hallucinated/unavailable import).
  function vitestRepo(): string {
    const root = mkdtempSync(join(tmpdir(), "oplocal-vitest-"));
    dirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
    return root;
  }

  it('a model body with its own imports + an assertion → runnable, provenance "model_provided"', async () => {
    const body = "import { describe, it, expect } from 'vitest';\ndescribe('x', () => { it('captures', () => { expect(1).toBe(1); }); });";
    const res = await generateTests(graph(vitestRepo()), { target_ids: ["REQ-001"], limit: 1 }, provider(body), () => null, CLOCK);
    expect(res.generated_tests).toHaveLength(1);
    const t = res.generated_tests[0];
    expect(t.grounding.import_provenance).toBe("model_provided");
    expect(t.runnable).toBe(true);
    expect(t.unresolved_reason).toBeUndefined();
  });

  it("a body with imports but NO assertion → not runnable, with an unresolved_reason draft", async () => {
    const body = "import { describe, it } from 'vitest';\ndescribe('x', () => { it('does nothing', () => { const a = 1; }); });";
    const res = await generateTests(graph(vitestRepo()), { target_ids: ["REQ-001"], limit: 1 }, provider(body), () => null, CLOCK);
    expect(res.generated_tests).toHaveLength(1);
    const t = res.generated_tests[0];
    expect(t.runnable).toBe(false);
    expect(t.unresolved_reason).toBeTruthy();
  });

  it("a model-written RELATIVE import that does not resolve → NOT runnable (Codex #55 regression)", async () => {
    // The model wrote its own imports incl. a relative one that points nowhere.
    // provenance is "model_provided" but the kit must still validate the specifier:
    // a test whose own import won't load is a draft, never runnable: true.
    const body =
      "import { doesNotExist } from './definitely-missing';\n" +
      "import { describe, it, expect } from 'vitest';\n" +
      "describe('x', () => { it('x', () => { expect(doesNotExist()).toBe(1); }); });";
    const res = await generateTests(graph(vitestRepo()), { target_ids: ["REQ-001"], limit: 1 }, provider(body), () => null, CLOCK);
    expect(res.generated_tests).toHaveLength(1);
    const t = res.generated_tests[0];
    expect(t.grounding.import_provenance).toBe("model_provided");
    expect(t.runnable).toBe(false);
    expect(t.unresolved_reason).toMatch(/definitely-missing/);
  });

  it("a model-written UNDECLARED bare package → NOT runnable (Codex #55 round-4)", async () => {
    // vitest is declared (skipped) but the made-up package is neither resolvable,
    // declared, nor a builtin — a hallucinated import that fails at module load.
    const body =
      "import madeUp from 'definitely-not-real-orangepro-package';\n" +
      "import { describe, it, expect } from 'vitest';\n" +
      "describe('x', () => { it('x', () => { expect(madeUp()).toBe(1); }); });";
    const res = await generateTests(graph(vitestRepo()), { target_ids: ["REQ-001"], limit: 1 }, provider(body), () => null, CLOCK);
    const t = res.generated_tests[0];
    expect(t.runnable).toBe(false);
    expect(t.unresolved_reason).toMatch(/definitely-not-real-orangepro-package/);
  });
});

describe("runnableRunHintsFor excludes non-runnable drafts (PLAN 6.5)", () => {
  const base = (over: Partial<GeneratedTest>): GeneratedTest => ({
    id: "r-t1",
    run_id: "r",
    title: "x",
    test_type: "unit",
    framework_hint: "vitest",
    body: "import { expect } from 'vitest';\nit('x', () => expect(1).toBe(1));",
    grounding: { entity_ids: [], source_refs: [], weak_relationships_used: [] },
    weak_evidence_used: false,
    ...over
  });

  it("runnable:false → no run hint (no run_command); runnable:true/undefined → kept", () => {
    const tests = [
      base({ id: "ok", runnable: true }),
      base({ id: "draft", runnable: false }),
      base({ id: "legacy" }) // undefined → treated as runnable
    ];
    const hints = runnableRunHintsFor(tests);
    const ids = hints.map((h) => h.generated_test_id).sort();
    expect(ids).toEqual(["legacy", "ok"]);
    expect(ids).not.toContain("draft");
  });
});

describe("tsconfig path-alias imports are validated, not waved through (Codex #55 round-2)", () => {
  const dirs: string[] = [];
  afterEach(() => {
    resetResolverCaches();
    resetExportIndexCache();
    while (dirs.length) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });

  // A repo with a tsconfig `@/* -> src/*` alias; src/real.ts exists only when asked.
  // `vitest` (+ optional extra deps) are declared so the framework import is treated
  // as a real package, not a missing baseUrl-local module.
  function aliasRepo(withRealTarget: boolean, extraDeps: string[] = []): string {
    const root = mkdtempSync(join(tmpdir(), "oplocal-alias-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    const devDependencies: Record<string, string> = { vitest: "^3" };
    for (const d of extraDeps) devDependencies[d] = "^1";
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies }));
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } })
    );
    if (withRealTarget) writeFileSync(join(root, "src", "real.ts"), "export function real(){ return 1 }\n");
    return root;
  }

  it("a model-written @/* alias that does not resolve → NOT runnable", async () => {
    const root = aliasRepo(false);
    const body =
      "import { missing } from '@/definitely-missing';\n" +
      "import { describe, it, expect } from 'vitest';\n" +
      "describe('x', () => { it('x', () => { expect(missing()).toBe(1); }); });";
    const res = await generateTests(graph(root), { target_ids: ["REQ-001"], limit: 1 }, provider(body), () => null, CLOCK);
    const t = res.generated_tests[0];
    expect(t.runnable).toBe(false);
    expect(t.unresolved_reason).toMatch(/@\/definitely-missing/);
  });

  it("a model-written @/* alias that DOES resolve stays runnable (no false negative)", async () => {
    const root = aliasRepo(true);
    const body =
      "import { real } from '@/real';\n" +
      "import { describe, it, expect } from 'vitest';\n" +
      "describe('x', () => { it('x', () => { expect(real()).toBe(1); }); });";
    const res = await generateTests(graph(root), { target_ids: ["REQ-001"], limit: 1 }, provider(body), () => null, CLOCK);
    const t = res.generated_tests[0];
    expect(t.runnable).toBe(true);
    expect(t.unresolved_reason).toBeUndefined();
  });

  it("a DECLARED bare package (in package.json) is skipped, even if unresolved here", async () => {
    const root = aliasRepo(true, ["lodash"]); // lodash declared as a dep
    const body =
      "import { real } from '@/real';\n" +
      "import _ from 'lodash';\n" +
      "import { describe, it, expect } from 'vitest';\n" +
      "describe('x', () => { it('x', () => { expect(_.identity(real())).toBe(1); }); });";
    const res = await generateTests(graph(root), { target_ids: ["REQ-001"], limit: 1 }, provider(body), () => null, CLOCK);
    expect(res.generated_tests[0].runnable).toBe(true);
  });

  it("a node builtin import is skipped (not a false draft)", async () => {
    const root = aliasRepo(true);
    const body =
      "import { real } from '@/real';\n" +
      "import { readFileSync } from 'node:fs';\n" +
      "import { describe, it, expect } from 'vitest';\n" +
      "describe('x', () => { it('x', () => { expect(typeof readFileSync).toBe('function'); expect(real()).toBe(1); }); });";
    const res = await generateTests(graph(root), { target_ids: ["REQ-001"], limit: 1 }, provider(body), () => null, CLOCK);
    expect(res.generated_tests[0].runnable).toBe(true);
  });

  // A repo with baseUrl:"src" (no paths) — a bare `utils/x` is a LOCAL module path.
  function baseUrlRepo(withRealTarget: boolean): string {
    const root = mkdtempSync(join(tmpdir(), "oplocal-baseurl-"));
    dirs.push(root);
    mkdirSync(join(root, "src", "utils"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
    writeFileSync(
      join(root, "tsconfig.json"),
      JSON.stringify({ compilerOptions: { baseUrl: "src", moduleResolution: "Bundler", module: "ESNext" } })
    );
    if (withRealTarget) writeFileSync(join(root, "src", "utils", "real.ts"), "export function real(){ return 1 }\n");
    return root;
  }

  it("a baseUrl-local bare import that does not resolve → NOT runnable (Codex #55 round-3)", async () => {
    const root = baseUrlRepo(false);
    const body =
      "import { missing } from 'utils/definitely-missing';\n" +
      "import { describe, it, expect } from 'vitest';\n" +
      "describe('x', () => { it('x', () => { expect(missing()).toBe(1); }); });";
    const res = await generateTests(graph(root), { target_ids: ["REQ-001"], limit: 1 }, provider(body), () => null, CLOCK);
    const t = res.generated_tests[0];
    expect(t.runnable).toBe(false);
    expect(t.unresolved_reason).toMatch(/utils\/definitely-missing/);
  });

  it("a baseUrl-local bare import that DOES resolve stays runnable", async () => {
    const root = baseUrlRepo(true);
    const body =
      "import { real } from 'utils/real';\n" +
      "import { describe, it, expect } from 'vitest';\n" +
      "describe('x', () => { it('x', () => { expect(real()).toBe(1); }); });";
    const res = await generateTests(graph(root), { target_ids: ["REQ-001"], limit: 1 }, provider(body), () => null, CLOCK);
    expect(res.generated_tests[0].runnable).toBe(true);
  });
});
