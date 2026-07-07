# OrangePro With Claude Code

## Install

```bash
npm install -g @orangepro/orangepro-mcp
cd /path/to/your/repo
opro
```

`opro` prepares the behavior report, RTM, and agent next actions. If your shell has a model key, weak AI grounding and AI-suggested candidate flows run automatically. AI lanes are suggestions only; Proven remains dynamic targeted proof only.

## Claude Plugin

The public, supported path today is MCP setup through `opro agent --client claude-code` below. The bundled plugin metadata is for marketplace submission and maintainer validation; use marketplace install commands only after OrangePro is listed in your Claude Code plugin marketplace.

When installed through a marketplace, the plugin starts the same `orangepro-local` MCP server and exposes the `/orangepro:opro` skill. It does not pin a model; OrangePro uses provider/model values from the environment, `.env.provider.local`, `.env.local`, `.env`, or `opro setup`.

## MCP Setup

Print the Claude Code config:

```bash
opro agent --client claude-code
```

Paste the printed `mcpServers.orangepro-local` block into the project `.mcp.json` or your Claude Code MCP config. If Claude Code does not inherit shell variables, add the provider key to that local config, or keep it in a repo-local `.env.provider.local` file that is not committed.

The printed config intentionally does not pin a model. OrangePro uses the provider/model configured in the process environment, `.env.provider.local`, `.env.local`, `.env`, or `opro setup`.

If your Claude Code setup supports custom slash commands, map `/opro` to: call `orangepro_start` for the current checkout, then follow the returned `next_actions`. The command should call the MCP tool; it should not run a separate source-writing script.

## Agent Prompt

```text
Use OrangePro first. Call orangepro_start, then use orangepro_generate_tests for the returned PR or gap target. Write each runnable test to suggested_path, run run_command, and call `orangepro_prove` with the returned `prove_run` args for Dynamically Proven. Use record_run only for static diagnostics. Do not treat drafts as runnable tests.
```
