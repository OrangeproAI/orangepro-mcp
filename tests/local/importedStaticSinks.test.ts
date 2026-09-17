import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { makeProofEdges, makeTestCaseNode } from "../../src/local/graph/factories.js";
import { loadLedger } from "../../src/local/ledger.js";
import { rankRiskGaps } from "../../src/local/score/risk.js";
import { buildBehaviorReportData } from "../../src/local/viz/behaviorReportData.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "opro-imported-sinks-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "sink-fixture" }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

describe("imported static sink retention", () => {
  it("retains named external static delete and replace calls for risk scoring without emitting CALLS evidence", () => {
    const root = repo({
      "src/commands/cmd.ts": [
        "import { ApiCatalog } from '@vendor/api';",
        "export async function deleteServer() { await ApiCatalog.deleteServer('x'); }",
        "export async function replaceAssets() { await ApiCatalog.replaceAssets([]); }"
      ].join("\n")
    });
    const graph = analyzeRepo(root, { readContent: true });
    const deleteNode = graph.nodes.find((n) => n.external_id === "sym:src/commands/cmd.ts#deleteServer")!;
    const replaceNode = graph.nodes.find((n) => n.external_id === "sym:src/commands/cmd.ts#replaceAssets")!;

    expect(deleteNode.properties.imported_static_callees).toEqual(["ApiCatalog.deleteServer"]);
    expect(replaceNode.properties.imported_static_callees).toEqual(["ApiCatalog.replaceAssets"]);
    expect(graph.edges.some((e) => e.relationship_type === "CALLS" && e.from_external_id === deleteNode.external_id)).toBe(false);
    expect(graph.edges.some((e) => e.relationship_type === "CALLS" && e.from_external_id === replaceNode.external_id)).toBe(false);

    const ranked = rankRiskGaps(graph, { limit: 20, repoRoot: root });
    expect(ranked.find((r) => r.id === deleteNode.external_id)?.sink_callee).toBe("ApiCatalog.deleteServer");
    expect(ranked.find((r) => r.id === replaceNode.external_id)?.sink_callee).toBe("ApiCatalog.replaceAssets");
  });

  it("retains namespace and default external imports", () => {
    const root = repo({
      "src/commands/cmd.ts": [
        "import * as AgentLib from '@vendor/agent';",
        "import AdminApi from '@vendor/admin';",
        "export async function purgeLibrary() { await AgentLib.purgeLibrary('x'); }",
        "export async function replaceConfig() { await AdminApi.replaceConfig({}); }"
      ].join("\n")
    });
    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:src/commands/cmd.ts#purgeLibrary")?.properties.imported_static_callees)
      .toEqual(["AgentLib.purgeLibrary"]);
    expect(graph.nodes.find((n) => n.external_id === "sym:src/commands/cmd.ts#replaceConfig")?.properties.imported_static_callees)
      .toEqual(["AdminApi.replaceConfig"]);
  });

  it("does not treat type-only imports or local spoof objects as imported static sinks", () => {
    const root = repo({
      "src/commands/cmd.ts": [
        "import type { ApiCatalog } from '@vendor/api';",
        "const LocalApi = { replaceAssets() { return true; }, deleteServer() { return true; } };",
        "export function localReplace() { return LocalApi.replaceAssets(); }",
        "export function localDelete() { return LocalApi.deleteServer(); }",
        "export type Catalog = ApiCatalog;"
      ].join("\n")
    });
    const graph = analyzeRepo(root, { readContent: true });
    expect(graph.nodes.find((n) => n.external_id === "sym:src/commands/cmd.ts#localReplace")?.properties.imported_static_callees).toBeUndefined();
    expect(graph.nodes.find((n) => n.external_id === "sym:src/commands/cmd.ts#localDelete")?.properties.imported_static_callees).toBeUndefined();
  });

  it("keeps Associated sinks out of the main gap list but visible in the irreversible worklist", () => {
    const root = repo({
      "src/commands/cmd.ts": [
        "import { ApiCatalog } from '@vendor/api';",
        "export async function deleteServer() { await ApiCatalog.deleteServer('x'); }"
      ].join("\n")
    });
    const graph = analyzeRepo(root, { readContent: true });
    graph.workspace = {
      name: "sink-fixture",
      root,
      root_hash: "fixture-root",
      source_upload_policy: "metadata_only"
    };
    Object.assign(graph, { manifest: { generated_at: "", git: null, files: graph.file_entries } });
    const symbol = graph.nodes.find((n) => n.external_id === "sym:src/commands/cmd.ts#deleteServer")!;
    graph.nodes.push(makeTestCaseNode({
      testRel: "test/cmd.test.ts",
      title: "cmd",
      testLayer: "unit",
      layerConfidence: "high",
      layerSignals: ["direct invocation"],
      testNames: ["deletes server"],
      provenance: symbol.provenance
    }));
    graph.edges.push(...makeProofEdges({
      testRel: "test/cmd.test.ts",
      symId: symbol.external_id,
      provenance: symbol.provenance,
      lastVerified: Date.now()
    }));

    expect(rankRiskGaps(graph, { repoRoot: root, limit: 20 }).some((row) => row.id === symbol.external_id)).toBe(false);
    expect(rankRiskGaps(graph, { repoRoot: root, limit: 20, includeAssociated: true }).find((row) => row.id === symbol.external_id))
      .toMatchObject({ detection_tier: "associated", sink_callee: "ApiCatalog.deleteServer" });

    const report = buildBehaviorReportData(graph, loadLedger(root), { repoRoot: root });
    expect(report.risks.some((row) => row.path === "deleteServer")).toBe(false);
    expect(report.worklists.irreversible).toEqual(expect.arrayContaining([
      expect.objectContaining({ path: "deleteServer", sink: "ApiCatalog.deleteServer" })
    ]));
  });
});
