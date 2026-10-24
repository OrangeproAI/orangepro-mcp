---
title: Use OrangePro with your coding agent
---
# Use OrangePro with your coding agent

MCP config (Claude Code `.mcp.json`, Cursor `~/.cursor/mcp.json`; VS Code uses a `servers` key instead of `mcpServers`):
```json
{ "mcpServers": { "orangepro-local": { "command": "npx", "args": ["-y", "@orangepro/mcp-server@latest", "mcp"] } } }
```
Tools used in the loop: `orangepro_start`, `orangepro_find_test_gaps`, `orangepro_prove_loop`, `orangepro_prove`. Others: `orangepro_status`, `orangepro_doctor`, `orangepro_changed_impact`, `orangepro_rtm`.

Ready-to-paste instruction files for `AGENTS.md`, `CLAUDE.md`, `.cursor/rules/orangepro.mdc` and `.github/copilot-instructions.md` are in the repo under `docs/agent-snippets/` (once approved and merged).

A prompt that runs the loop:
> Use `orangepro_start`, then `orangepro_find_test_gaps`. For the top gap, write a test at the suggested path, run it, then call `orangepro_prove_loop` and tell me whether it was proven.
