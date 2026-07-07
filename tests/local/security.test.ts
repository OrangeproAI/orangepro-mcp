import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateTests, sanitizeGeneratedBody } from "../../src/local/generate/generator.js";
import { makeNode } from "../../src/local/graph/factories.js";
import { LocalGraph, LOCAL_GRAPH_SCHEMA_VERSION } from "../../src/local/graph/ontology.js";
import { ModelProvider } from "../../src/local/types.js";
import { opInit, opAnalyze, opGenerate } from "../../src/local/operations.js";

const PROPRIETARY = "const SECRET_SAUCE = computeProprietaryRanking(alpha, beta, gamma);";

/** A hostile provider that echoes the entire prompt — including SOURCE EXCERPTS. */
class EchoProvider implements ModelProvider {
  readonly providerName = "echo";
  readonly modelName = "echo-1";
  async complete(req: { system: string; user: string }): Promise<string> {
    return req.user;
  }
}

function graphWithSourceBehavior(): LocalGraph {
  const flow = makeNode({
    kind: "UserFlow",
    external_id: "flow:pay",
    title: "payments flow",
    properties: { area: "pay", inferred_from: "test_describe", example_behaviors: ["saves a card"] },
    evidence_strength: "weak",
    review_status: "inferred",
    confidence: 0.3,
    provenance: { source_scope_id: "repo:demo", source_ref: "src/pay/card.ts", detector: "test" }
  });
  const file = makeNode({
    kind: "File",
    external_id: "src/pay/card.ts",
    title: "card.ts",
    properties: { language: "typescript", role: "code" },
    evidence_strength: "hard",
    review_status: "auto_detected",
    confidence: 1,
    provenance: { source_scope_id: "repo:demo", source_ref: "src/pay/card.ts", detector: "test" }
  });
  return {
    schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
    workspace: { name: "demo", root: "/tmp/demo", root_hash: "sha256:x", source_upload_policy: "metadata_only" },
    created_at: "",
    updated_at: "",
    sources: [],
    nodes: [flow, file],
    edges: [],
    candidate_edges: [],
    generation_runs: [],
    generated_tests: [],
    manifest: { generated_at: "", git: null, files: {} }
  };
}

describe("P1: source-echo guard in generated test bodies", () => {
  it("strips proprietary source the model echoes back, and warns", async () => {
    const graph = graphWithSourceBehavior();
    const reader = (rel: string): string | null =>
      rel === "src/pay/card.ts" ? `export function rank() {\n  ${PROPRIETARY}\n  return 1;\n}\n` : null;

    const result = await generateTests(graph, { target_ids: ["flow:pay"], limit: 1 }, new EchoProvider(), reader);

    expect(result.generated_tests.length).toBe(1);
    const body = result.generated_tests[0].body;
    // The echoed proprietary source line must be redacted out of the stored body.
    expect(body).not.toContain("computeProprietaryRanking");
    // The echoed source is disclosed as removed — either as a per-line redaction
    // marker or, when the line sat inside a statement, as a removed statement
    // (the post-redaction AST cleanup keeps the file parseable).
    expect(body).toMatch(/\[orangepro: (source excerpt redacted|statement removed)/);
    expect(result.warnings.some((w) => w.includes("source-excerpt"))).toBe(true);
    // ...AND with no linked-test import and no resolver-derivable subject, the kit
    // does NOT fabricate a module specifier (the old slug guess): the test is
    // disclosed as a non-runnable grounded draft instead (PLAN 6.5).
    const t = result.generated_tests[0];
    expect(t.grounding.import_provenance).toBe("none");
    expect(t.runnable).toBe(false);
    expect(t.unresolved_reason).toBeTruthy();
  });

  it("sanitizeGeneratedBody also blanket-redacts secrets", () => {
    const out = sanitizeGeneratedBody(`api = "sk-${"A".repeat(40)}"`, []);
    expect(out.body).not.toContain("sk-AAAA");
  });
});

describe("P2: deterministic generation is opt-in only", () => {
  const dirs: string[] = [];
  afterEach(() => {
    while (dirs.length) {
      const d = dirs.pop();
      if (d) rmSync(d, { recursive: true, force: true });
    }
  });
  function fixture(): string {
    const root = mkdtempSync(join(tmpdir(), "oplocal-sec-"));
    dirs.push(root);
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
    writeFileSync(
      join(root, "payments-template.csv"),
      "behavior_name,description,acceptance_criteria,actor_or_role,priority_or_risk,source_ref\n" +
        '"Save a card","desc","Card is validated",buyer,high,PAY-1\n'
    );
    return root;
  }

  it("returns setup guidance and no tests when no provider is configured", async () => {
    const root = fixture();
    const deps = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };
    opInit(root, deps);
    opAnalyze(root, { source: root }, deps);
    const result = await opGenerate(root, { limit: 1 }, deps);
    expect(result.generated_tests).toEqual([]);
    expect(result.run_id).toBeNull();
    expect(result.model_provider).toBe("none");
    expect(result.warnings.join(" ")).toMatch(/No model provider configured/i);
    expect(result.wrote_repo_files).toBe(false);
  });

  it("generates when provider='deterministic' is requested explicitly", async () => {
    const root = fixture();
    const deps = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };
    opInit(root, deps);
    opAnalyze(root, { source: root }, deps);
    const result = await opGenerate(root, { limit: 1, provider: "deterministic" }, deps);
    expect(result.model_provider).toBe("deterministic");
    expect(result.generated_tests.length).toBeGreaterThan(0);
  });

  it("(g) opGenerate loads provider credentials from .env.provider.local (not persisted)", async () => {
    const root = fixture();
    // Key lives ONLY in the workspace file, never in the shell env. The base URL is
    // an unreachable localhost port so no real network call is made — the model
    // calls fail fast, but resolving provider='openai' proves the file was loaded.
    writeFileSync(
      join(root, ".env.provider.local"),
      "OPENAI_API_KEY=sk-test-from-env-file\nOPENAI_BASE_URL=http://127.0.0.1:1/v1\n"
    );
    const deps = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };
    opInit(root, deps);
    opAnalyze(root, { source: root }, deps);
    const result = await opGenerate(root, { limit: 1 }, deps);
    expect(result.model_provider).toBe("openai");
    expect(result.warnings.join(" ")).not.toMatch(/No model provider configured/i);
  });
});
