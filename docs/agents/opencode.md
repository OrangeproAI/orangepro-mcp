# OrangePro With OpenCode

## Install

```bash
npm install -g @orangepro/orangepro-mcp
cd /path/to/your/repo
opro
```

`opro` is the one-command preparation step: behavior report, RTM, optional weak AI grounding and AI-suggested candidate flows when a provider key is configured, and next actions for the agent.

## MCP Setup

Print the OpenCode MCP block:

```bash
opro agent --client opencode
```

Add the printed `mcpServers.orangepro-local` block to your OpenCode MCP settings. If OpenCode does not inherit your shell environment, put the model provider key in the local MCP config, or keep it in a repo-local `.env.provider.local` file that is not committed.

For a direct OpenCode config, add this server under `mcp`:

```jsonc
{
  "mcp": {
    "orangepro-local": {
      "enabled": true,
      "command": "npx",
      "args": ["-y", "@orangepro/mcp-server@latest", "mcp"]
    }
  }
}
```

If your OpenCode setup supports slash or dollar commands, map `/opro` or `$opro` to: call `orangepro_start` for the current checkout, then follow the returned `next_actions`. The shortcut should call the MCP tool; it is not a separate graph builder.

## Agent Prompt

```text
Use OrangePro first. Call orangepro_start, generate tests only through orangepro_generate_tests, write runnable tests with run_hints, run the command, and call `orangepro_prove` with the returned `prove_run` args after a pass for Dynamically Proven. Use record_run only for static diagnostics. Report setup failures plainly.
```
