import { AGENT_RUN_WORKFLOW, GROUNDING_CONTRACT } from "./generate/runHints.js";

export type AgentClient = "generic" | "claude-code" | "cursor" | "codex" | "opencode" | "windsurf";

export interface AgentWorkflowPack {
  client: AgentClient;
  mcp_config: {
    mcpServers: {
      "orangepro-local": {
        command: "node";
        args: string[];
        env: Record<string, string>;
      };
    };
  };
  config_location: string;
  agent_instructions: string[];
  cli_fallback: string[];
  grounding_contract: string[];
}

const CLIENT_CONFIG_LOCATION: Record<AgentClient, string> = {
  generic: "Use your MCP client's mcpServers settings.",
  "claude-code": "Project .mcp.json or ~/.claude.json.",
  cursor: "~/.cursor/mcp.json or Cursor Settings -> MCP.",
  codex: "Use MCP server settings when available; otherwise use the CLI fallback commands.",
  opencode: "opencode MCP/server settings.",
  windsurf: "Windsurf MCP/server settings."
};

export function normalizeAgentClient(value: string | boolean | undefined): AgentClient {
  if (typeof value !== "string") return "generic";
  const v = value.trim().toLowerCase().replace(/_/g, "-");
  if (v === "claude" || v === "claude-code") return "claude-code";
  if (v === "cursor") return "cursor";
  if (v === "codex" || v === "openai") return "codex";
  if (v === "opencode" || v === "open-code") return "opencode";
  if (v === "windsurf") return "windsurf";
  return "generic";
}

export function buildAgentWorkflowPack(cliPath: string, client: AgentClient = "generic"): AgentWorkflowPack {
  return {
    client,
    config_location: CLIENT_CONFIG_LOCATION[client],
    mcp_config: {
      mcpServers: {
        "orangepro-local": {
          command: "node",
          args: [cliPath, "mcp"],
          env: {}
        }
      }
    },
    agent_instructions: [
      "Before writing tests, call OrangePro on the local checkout.",
      "Start with `orangepro_start`; it preflights large repos, builds the graph, applies weak AI grounding and AI candidate flows only when a provider is configured, writes behavior-coverage.html + rtm.md, and returns next actions.",
      "For PR work after start, use `orangepro_generate_tests` with `base_ref=main`; do not invent a PR if there is no diff.",
      "For baseline work after start, use `orangepro_find_test_gaps`, choose a high-priority gap, then call `orangepro_generate_tests` for that target.",
      "Use only generated tests that include `run_hints`; grounded drafts are context, not runnable claims.",
      "Write each runnable test body to its `suggested_path`, run its `run_command` from the owning package, then call the returned `prove_run` args after a pass to attempt public Proven. Use `record_run` only for static diagnostics.",
      "Report pass/fail with stack traces; if the command fails because dependencies or tools are missing, report the setup issue instead of editing around it.",
      "Summarize whether the graph status changed: Proven, Reproven, Runtime-covered, Associated signal, or No integration signal."
    ],
    cli_fallback: [
      "opro",
      "opro start . --generate-coverage",
      "opro gaps --limit 10",
      "opro generate --base main --single --limit 3",
      "opro generate --target <target-id> --single --limit 1",
      "opro explain <generated-test-id>"
    ],
    grounding_contract: GROUNDING_CONTRACT.concat(AGENT_RUN_WORKFLOW)
  };
}

export function renderAgentWorkflowPack(pack: AgentWorkflowPack): string {
  const lines: string[] = [];
  lines.push(`OrangePro agent workflow (${pack.client})`);
  lines.push("");
  lines.push(`Config location: ${pack.config_location}`);
  lines.push("");
  lines.push("MCP config:");
  lines.push(JSON.stringify(pack.mcp_config, null, 2));
  lines.push("");
  lines.push("Agent instructions:");
  for (const item of pack.agent_instructions) lines.push(`- ${item}`);
  lines.push("");
  lines.push("CLI fallback:");
  for (const item of pack.cli_fallback) lines.push(`- ${item}`);
  lines.push("");
  lines.push("Grounding contract:");
  for (const item of pack.grounding_contract) lines.push(`- ${item}`);
  return lines.join("\n");
}
