import { describe, expect, it } from "vitest";
import { buildAgentWorkflowPack, normalizeAgentClient, renderAgentWorkflowPack } from "../../src/local/agentWorkflow.js";

describe("agent workflow pack", () => {
  it("normalizes common client names", () => {
    expect(normalizeAgentClient(undefined)).toBe("generic");
    expect(normalizeAgentClient("claude")).toBe("claude-code");
    expect(normalizeAgentClient("openai")).toBe("codex");
    expect(normalizeAgentClient("open-code")).toBe("opencode");
    expect(normalizeAgentClient("cursor")).toBe("cursor");
    expect(normalizeAgentClient("unknown")).toBe("generic");
  });

  it("builds a client-ready MCP config without embedding a real key", () => {
    const pack = buildAgentWorkflowPack("/tmp/orangepro/dist/local/cli.js", "cursor");
    const server = pack.mcp_config.mcpServers["orangepro-local"];

    expect(server.command).toBe("node");
    expect(server.args).toEqual(["/tmp/orangepro/dist/local/cli.js", "mcp"]);
    expect(server.env).toEqual({});
    expect(JSON.stringify(pack)).not.toContain("gpt-4.1");
    expect(JSON.stringify(pack)).not.toContain("sk-");
  });

  it("tells agents to use run hints and keep Proven separate from Associated", () => {
    const pack = buildAgentWorkflowPack("/tmp/op/cli.js");
    expect(pack.agent_instructions.join("\n")).toContain("orangepro_start");
    expect(pack.agent_instructions.join("\n")).toContain("run_hints");
    expect(pack.agent_instructions.join("\n")).toContain("prove_run");
    expect(renderAgentWorkflowPack(pack)).toContain("Grounding contract");
    expect(renderAgentWorkflowPack(pack)).toContain("weak/candidate evidence is a hint");
  });
});
