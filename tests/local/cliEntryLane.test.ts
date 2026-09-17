import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { analyzeRepo } from "../../src/local/analyze/analyzer.js";
import { makeEdge, makeNode } from "../../src/local/graph/factories.js";
import { behaviorEntries } from "../../src/local/flows/flowWalker.js";
import { LOCAL_GRAPH_SCHEMA_VERSION, type LocalGraph } from "../../src/local/graph/ontology.js";
import { rankRiskGaps } from "../../src/local/score/risk.js";
import { buildSystemMapModel, excludedCliCommands } from "../../src/local/viz/behaviorReportData.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("Patch 4 CLI entry lane", () => {
  it("marks imported oclif, Salesforce CLI and Commander static run methods, but rejects local spoofs", () => {
    const dir = mkdtempSync(join(tmpdir(), "opro-cli-entry-"));
    dirs.push(dir);
    mkdirSync(join(dir, "src", "commands"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cli-entry-fixture" }));
    writeFileSync(
      join(dir, "src", "commands", "entry.ts"),
      [
        'import { Command as OclifCommand } from "@oclif/core";',
        'import { SfCommand } from "@salesforce/sf-plugins-core";',
        'import { Command as CommanderCommand } from "commander";',
        'export class OclifEntry extends OclifCommand { public async run(): Promise<void> {} public helper(): void {} }',
        'export class SalesforceEntry extends SfCommand<void> { public async run(): Promise<void> {} }',
        'export class CommanderEntry extends CommanderCommand { public static run(): void {} }',
        'class Command {}',
        'export class LocalSpoof extends Command { public static run(): void {} }',
        'export class NoRun extends OclifCommand { public execute(): void {} }'
      ].join("\n")
    );
    const fragment = analyzeRepo(dir);
    const code = fragment.nodes.filter((n) => n.kind === "CodeSymbol");
    const byTitle = new Map(code.map((n) => [n.title, n]));
    expect(byTitle.get("OclifEntry.run")?.properties).toMatchObject({ cli_entrypoint: true, entry_lane: "cli", cli_framework: "oclif" });
    expect(byTitle.get("SalesforceEntry.run")?.properties).toMatchObject({ cli_entrypoint: true, entry_lane: "cli", cli_framework: "salesforce-cli" });
    expect(byTitle.get("CommanderEntry.run")?.properties).toMatchObject({ cli_entrypoint: true, entry_lane: "cli", cli_framework: "commander" });
    expect(byTitle.get("OclifEntry.helper")?.properties.cli_entrypoint).toBeUndefined();
    expect(byTitle.get("LocalSpoof.run")?.properties.cli_entrypoint).toBeUndefined();
    expect(byTitle.get("NoRun.execute")?.properties.cli_entrypoint).toBeUndefined();
  });

  it("keeps a verified CLI command run method in the denominator despite a broad asset-path exclusion", () => {
    const dir = mkdtempSync(join(tmpdir(), "opro-cli-denominator-"));
    dirs.push(dir);
    mkdirSync(join(dir, "src", "commands", "agent", "mcp", "asset"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "cli-denominator-fixture" }));
    writeFileSync(
      join(dir, "src", "commands", "agent", "mcp", "asset", "replace.ts"),
      [
        'import { SfCommand } from "@salesforce/sf-plugins-core";',
        'export default class AssetReplace extends SfCommand<void> { public async run(): Promise<void> {} }'
      ].join("\n")
    );
    const fragment = analyzeRepo(dir);
    const command = fragment.nodes.find((node) => node.kind === "CodeSymbol" && node.title === "AssetReplace.run");
    expect(command?.denominator_eligible).toBe(true);
    expect(command?.properties).toMatchObject({
      cli_entrypoint: true,
      behavior_surface: "cli_command_entry",
      denominator_reason_code: "cli_command_entry"
    });
    expect(command?.properties.denominator_override_from).toContain("Presentation asset/icon path");
  });

  it("lists any CLI command entry that remains excluded with its exact reason", () => {
    const excluded = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:e2e-tests/commands/demo.ts#Demo.run",
      title: "Demo.run",
      properties: { file: "e2e-tests/commands/demo.ts", cli_entrypoint: true, entry_lane: "cli", cli_framework: "oclif" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "e2e", source_ref: "e2e-tests/commands/demo.ts" },
      denominator_eligible: false,
      denominator_reason: "CI/test infrastructure path — excluded from the behavior denominator."
    });
    const graph: LocalGraph = {
      schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
      workspace: { name: "excluded-cli", root: "", root_hash: "sha256:x", source_upload_policy: "metadata_only" },
      created_at: "",
      updated_at: "",
      sources: [],
      nodes: [excluded],
      edges: [],
      candidate_edges: [],
      generation_runs: [],
      generated_tests: [],
      manifest: { generated_at: "", git: null, files: {} }
    };
    expect(excludedCliCommands(graph)).toEqual([
      {
        path: "Demo.run",
        file: "e2e-tests/commands/demo.ts",
        reason: "CI/test infrastructure path — excluded from the behavior denominator."
      }
    ]);
  });

  it("gives a CLI command entry weight and keeps it as a flow root even with an incoming call", () => {
    const cli = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/commands/deploy.ts#DeployCommand.run",
      title: "DeployCommand.run",
      properties: { file: "src/commands/deploy.ts", cli_entrypoint: true, entry_lane: "cli", cli_framework: "oclif" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "src", source_ref: "src/commands/deploy.ts" },
      denominator_eligible: true,
      denominator_reason: "Exported command behavior."
    });
    const helper = makeNode({
      kind: "CodeSymbol",
      external_id: "sym:src/lib/helper.ts#helper",
      title: "helper",
      properties: { file: "src/lib/helper.ts" },
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "src", source_ref: "src/lib/helper.ts" },
      denominator_eligible: true,
      denominator_reason: "Exported behavior."
    });
    const edge = makeEdge({
      from_external_id: helper.external_id,
      to_external_id: cli.external_id,
      relationship_type: "CALLS",
      evidence_strength: "hard",
      review_status: "auto_detected",
      confidence: 1,
      provenance: { source_scope_id: "graph", source_ref: "fixture" }
    });
    const graph: LocalGraph = {
      schema_version: LOCAL_GRAPH_SCHEMA_VERSION,
      workspace: { name: "cli", root: "", root_hash: "sha256:x", source_upload_policy: "metadata_only" },
      created_at: "",
      updated_at: "",
      sources: [],
      nodes: [cli, helper],
      edges: [edge],
      candidate_edges: [],
      generation_runs: [],
      generated_tests: [],
      manifest: { generated_at: "", git: null, files: {} }
    };
    const ranked = rankRiskGaps(graph, { repoRoot: "", limit: 10 });
    expect(ranked.find((r) => r.id === cli.external_id)).toMatchObject({ entry_point: true, route_weight: 6 });
    expect(ranked.find((r) => r.id === helper.external_id)?.route_weight).toBe(2);
    expect(behaviorEntries(graph.nodes, graph.edges).map((e) => e.external_id)).toContain(cli.external_id);
  });

  it("renders an existing CLI-rooted flow in the CLI lane without creating another flow", () => {
    const model = buildSystemMapModel({
      flows: [
        {
          title: "DeployCommand.run",
          trigger: null,
          root_entry: true,
          entry_lane: "cli",
          risk: "high",
          proof: "none",
          services: 1,
          flow_tier: "hard: reachable",
          why: "fixture",
          steps: [{ sig: "DeployCommand.run", tier: "hard", edge: null, desc: "CLI command" }]
        }
      ],
      risks: [],
      behaviors: []
    });
    expect(model.lanes).toEqual([{ id: "cli", label: "CLI", flows: 1 }]);
  });
});
