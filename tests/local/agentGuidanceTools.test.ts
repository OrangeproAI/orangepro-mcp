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
