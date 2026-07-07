import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-cluster-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("structural clusters", () => {
  it("groups symbols connected by exact CALLS edges", () => {
    const root = repo({
      "src/a.ts": "export function loadHelper() { return 1; }\n",
      "src/b.ts": "import { loadHelper } from './a';\nexport function run() { return loadHelper(); }\n"
    });

    const frag = analyzeRepo(root, { readContent: true });
    const cluster = frag.analysis.structural_clusters!.clusters.find(
      (c) => c.top_symbols.includes("sym:src/a.ts#loadHelper") && c.top_symbols.includes("sym:src/b.ts#run")
    );

    expect(cluster).toBeDefined();
    expect(cluster!.hard_calls).toBe(1);
    expect(cluster!.likely_calls).toBe(0);
    expect(frag.edges.some((e) => e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS")).toBe(false);
  });

  it("groups symbols connected by likely-call hints without promoting them to proof", () => {
    const root = repo({
      "src/mod.ts": "export function executeThing() { return 1; }\n",
      "src/svc.ts": "import * as mod from './mod';\nexport function run() { return mod.executeThing(); }\n"
    });

    const frag = analyzeRepo(root, { readContent: true });
    const cluster = frag.analysis.structural_clusters!.clusters.find(
      (c) => c.top_symbols.includes("sym:src/mod.ts#executeThing") && c.top_symbols.includes("sym:src/svc.ts#run")
    );

    expect(cluster).toBeDefined();
    expect(cluster!.likely_calls).toBe(1);
    expect(frag.candidate_edges.some((e) => e.relationship_type === "MAY_CALL" && e.evidence_strength === "weak")).toBe(true);
    expect(frag.edges.some((e) => e.relationship_type === "TESTED_BY" || e.relationship_type === "COVERS")).toBe(false);
  });

  it("uses local import links for nearby files", () => {
    const root = repo({
      "src/domain/a.ts": "export function loadA() { return 1; }\n",
      "src/domain/b.ts": "import { loadA } from './a';\nexport function loadB() { return 2; }\n"
    });

    const frag = analyzeRepo(root, { readContent: true });
    const cluster = frag.analysis.structural_clusters!.clusters.find(
      (c) => c.top_symbols.includes("sym:src/domain/a.ts#loadA") && c.top_symbols.includes("sym:src/domain/b.ts#loadB")
    );

    expect(cluster).toBeDefined();
    expect(cluster!.import_links).toBe(1);
    expect(frag.analysis.structural_clusters!.import_edges_used).toBe(1);
  });

  it("skips hub imports so one shared file does not collapse the repo into one cluster", () => {
    const files: Record<string, string> = {
      "src/shared.ts": "export function loadShared() { return 1; }\n"
    };
    for (let i = 0; i < 26; i++) {
      files[`src/feature${i}.ts`] = "import { loadShared } from './shared';\nexport function loadFeature() { return 1; }\n";
    }

    const frag = analyzeRepo(repo(files), { readContent: true });

    expect(frag.analysis.structural_clusters!.import_hub_threshold).toBe(25);
    expect(frag.analysis.structural_clusters!.import_edges_considered).toBe(26);
    expect(frag.analysis.structural_clusters!.import_edges_used).toBe(0);
    expect(frag.analysis.structural_clusters!.clusters.some((c) => c.size > 10)).toBe(false);
  });

  it("excludes denominator-ineligible infra symbols from clusters", () => {
    const root = repo({
      "src/product.ts": "import { fake } from '../mocks/fake';\nexport function product() { return 1; }\n",
      "mocks/fake.ts": "export function fake() { return 1; }\n"
    });

    const frag = analyzeRepo(root, { readContent: true });
    const allClusterSymbols = frag.analysis.structural_clusters!.clusters.flatMap((c) => c.top_symbols);

    expect(frag.nodes.find((n) => n.external_id === "sym:mocks/fake.ts#fake")?.denominator_eligible).toBe(false);
    expect(allClusterSymbols).not.toContain("sym:mocks/fake.ts#fake");
  });

  it("orders cluster output deterministically", () => {
    const root = repo({
      "src/a.ts": "export function a() { return 1; }\nexport function aa() { return a(); }\n",
      "src/b.ts": "export function b() { return 1; }\nexport function bb() { return b(); }\n"
    });

    const one = analyzeRepo(root, { readContent: true }).analysis.structural_clusters!.clusters.map((c) => c.id);
    const two = analyzeRepo(root, { readContent: true }).analysis.structural_clusters!.clusters.map((c) => c.id);

    expect(two).toEqual(one);
  });

  it("splits oversized same-directory components into navigable file clusters", () => {
    const files: Record<string, string> = {};
    for (let i = 0; i < 26; i++) {
      const prevImport = i === 0 ? "" : `import { behavior${i - 1}_0 } from './file${i - 1}';\n`;
      const fns = Array.from({ length: 10 }, (_, j) =>
        j === 0 && i > 0 ? `export function behavior${i}_${j}() { return behavior${i - 1}_0(); }` : `export function behavior${i}_${j}() { return ${j}; }`
      ).join("\n");
      files[`src/actions/file${i}.ts`] = `${prevImport}${fns}\n`;
    }

    const frag = analyzeRepo(repo(files), { readContent: true });
    const largest = Math.max(...frag.analysis.structural_clusters!.clusters.map((c) => c.size));

    expect(largest).toBeLessThanOrEqual(10);
    expect(frag.analysis.structural_clusters!.total_clusters).toBeGreaterThanOrEqual(26);
  });
});
