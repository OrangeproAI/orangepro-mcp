# OrangePro With Cursor

## Install

```bash
npm install -g @orangepro/orangepro-mcp
cd /path/to/your/repo
opro
```

The first `opro` run creates `.orangepro/behavior-coverage.html`, `.orangepro/rtm.md`, and an agent-ready plan. With a configured model key, weak AI grounding and AI-suggested candidate flows are applied automatically and stay out of Proven coverage.

## Cursor Plugin

Install OrangePro from the Cursor Marketplace when it is listed. Until then, use the bundled plugin directory for local testing:

```text
plugins/orangepro
```

The plugin starts the `orangepro-local` MCP server through `npx -y -p @orangepro/orangepro-mcp@latest opro mcp` and applies OrangePro rules for gap/test workflows. It does not pin a model; provider keys and model defaults come from your environment, `.env.provider.local`, `.env.local`, `.env`, or `opro setup`.

## MCP Setup

Print the Cursor MCP block:

```bash
opro agent --client cursor
```

Paste the printed block into Cursor Settings -> MCP or `~/.cursor/mcp.json`. If Cursor does not inherit your shell environment, add the provider key to the local MCP config, or keep it in a repo-local `.env.provider.local` file that is not committed.

If your Cursor setup supports custom commands, map `/opro` to: call `orangepro_start` for the current checkout, then follow the returned `next_actions`. The shortcut should use the MCP tool so Proven / Associated signal / No integration signal semantics stay intact.

## Agent Prompt

```text
Use OrangePro first. Call orangepro_start in this repo, then follow its next_actions. Generate tests with orangepro_generate_tests, write only runnable outputs with run_hints, run the suggested command, and call `orangepro_prove` with the returned `prove_run` args after a passing run for Dynamically Proven. Use record_run only for static diagnostics.
```
