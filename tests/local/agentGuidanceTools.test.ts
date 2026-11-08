import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createLocalServer } from "../../src/local/mcp.js";

/**
 * Agent-facing guidance may only name MCP tools the local server registers.
 * Repo-root copies and the plugin mirror must name the same set, so one
 * location cannot mention a tool the other dropped or invented.
 */
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../..");

const ROOT_GUIDANCE = ["skills/opro/SKILL.md", "rules/orangepro.mdc"];
const PLUGIN_GUIDANCE = [
  "plugins/orangepro/skills/opro/SKILL.md",
  "plugins/orangepro/rules/orangepro.mdc"
];
const SCANNED = [...ROOT_GUIDANCE, ...PLUGIN_GUIDANCE, "docs/agent-workflow.md"];

const TOOL_NAME = /\borangepro_[a-z0-9_]+\b/g;

function toolNames(relPath: string): string[] {
  const text = readFileSync(join(ROOT, relPath), "utf8");
  return [...new Set(text.match(TOOL_NAME) ?? [])].sort();
}

function toolSet(relPaths: string[]): string[] {
  return [...new Set(relPaths.flatMap(toolNames))].sort();
}

function registeredToolNames(): Set<string> {
  const server = createLocalServer() as unknown as { _registeredTools: Record<string, unknown> };
  return new Set(Object.keys(server._registeredTools));
}

describe("agent guidance tool names", () => {
  const registered = registeredToolNames();

  it("only names orangepro_* tools the MCP server registers", () => {
    const unknown: string[] = [];
    for (const path of SCANNED) {
      for (const name of toolNames(path)) {
        if (!registered.has(name)) unknown.push(`${path}: ${name}`);
      }
    }
    expect(unknown).toEqual([]);
  });

  it("keeps the repo-root guidance and the plugin mirror on the same tool set", () => {
    const root = toolSet(ROOT_GUIDANCE);
    const plugin = toolSet(PLUGIN_GUIDANCE);
    expect(root.length).toBeGreaterThan(0);
    expect(plugin.length).toBeGreaterThan(0);
    expect(root).toEqual(plugin);
  });
});

describe("item 9: agent docs, MCP text and CLI text use the README's tier names", () => {
  const OLD = [/Dynamically Proven/i, /Dynamic Proven/, /Runtime-covered/, /Associated signal/i, /Candidate signal/i, /No integration signal/i, /Statically Linked/i, /\bNo link\b/, /\bNo-link\b/];
  const DOCS = [
    "docs/agent-workflow.md",
    "docs/agents/cursor.md",
    "docs/agents/claude-code.md",
    "docs/agents/codex.md",
    "docs/agents/opencode.md",
    "docs/agents/vscode.md",
    "docs/local-proof-kit.md",
    "QUICKSTART.md",
    "rules/orangepro.mdc",
    "plugins/orangepro/rules/orangepro.mdc",
    "skills/opro/SKILL.md",
    "plugins/orangepro/skills/opro/SKILL.md",
    "plugins/orangepro/.codex-plugin/plugin.json"
  ];
  // The shipped text an agent or a person reads: tool descriptions, next actions, doctor headlines, the CLI summary.
  const SOURCES = ["src/local/mcp.ts", "src/local/cli.ts", "src/local/operations.ts", "src/local/proofDoctor.ts", "src/local/agentWorkflow.ts", "src/local/rtm.ts", "src/local/pack/coverageReport.ts", "src/local/viz/html.ts"];

  it("no doc or shipped text names a tier the old way", () => {
    for (const relPath of [...DOCS, ...SOURCES]) {
      const text = readFileSync(join(ROOT, relPath), "utf8");
      // One COVERAGE_REPORT.md warning line keeps "Dynamic Proven": the same line names the analyze time
      // limit by its code name, which CI's name guard rejects in any added line, so it cannot be edited here.
      const checked = text.split("\n").filter((line) => !/PARTIAL SCAN: the analyze/.test(line)).join("\n");
      for (const old of OLD) expect(old.test(checked), `${relPath} still matches ${old}`).toBe(false);
    }
  });

  it("the two rule files stay identical and name the README's tiers", () => {
    const root = readFileSync(join(ROOT, "rules/orangepro.mdc"), "utf8");
    expect(readFileSync(join(ROOT, "plugins/orangepro/rules/orangepro.mdc"), "utf8")).toBe(root);
    expect(root).toContain("Proven, Reproven, Runs under tests, Linked, Unconfirmed, or No test found");
  });

  it("the RTM tool description lists the README's names", () => {
    const mcp = readFileSync(join(ROOT, "src/local/mcp.ts"), "utf8");
    expect(mcp).toContain("Proven, Runs under tests, Linked, Unconfirmed, No test found, Reproven");
  });
});
