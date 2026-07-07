# OrangePro With VS Code / Copilot

## Install

```bash
npm install -g @orangepro/orangepro-mcp
cd /path/to/your/repo
opro
```

`opro` writes `.orangepro/behavior-coverage.html`, `.orangepro/rtm.md`, and next actions. With a configured provider key, weak AI grounding and AI-suggested candidate flows run automatically and stay out of Proven coverage.

## MCP Setup

Add OrangePro as an MCP server in your user or workspace MCP config:

```json
{
  "servers": {
    "orangepro-local": {
      "command": "npx",
      "args": ["-y", "@orangepro/mcp-server@latest", "mcp"]
    }
  }
}
```

Do not hardcode provider keys in a committed workspace config. Prefer your shell environment, `.env.provider.local`, `.env.local`, `.env`, or `opro setup`.

## Agent Prompt

```text
Use OrangePro first. Call orangepro_start for this repo, then follow next_actions. Generate tests with orangepro_generate_tests, write only runnable outputs with run_hints, run the suggested command, and call `orangepro_prove` with the returned `prove_run` args after a pass for Dynamically Proven. Use record_run only for static diagnostics.
```
