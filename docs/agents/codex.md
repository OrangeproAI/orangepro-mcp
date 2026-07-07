# OrangePro With Codex

## Install

```bash
npm install -g @orangepro/orangepro-mcp
cd /path/to/your/repo
opro
```

`opro` writes `.orangepro/behavior-coverage.html` and `.orangepro/rtm.md`. If a model key is available in the environment, it also applies weak AI grounding and AI-suggested candidate flows automatically. Proven coverage still comes only from dynamic targeted proof.

## Codex Plugin

The public, supported path today is MCP setup through `opro agent --client codex` below. `codex plugin add orangepro` is only valid after OrangePro is listed in a Codex marketplace configured for your Codex install.

The bundled plugin metadata in this repo is for marketplace submission and maintainer validation. It starts the same `orangepro-local` MCP server and does not pin an LLM model; OrangePro uses the provider/model configured in your environment, `.env.provider.local`, `.env.local`, `.env`, or `opro setup`.

## MCP Setup

Print a Codex-ready config block:

```bash
opro agent --client codex
```

Add the printed `mcpServers.orangepro-local` block to the MCP settings your Codex environment uses. The printed config intentionally omits model settings. If Codex does not inherit your shell environment, put `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, or `OLLAMA_BASE_URL` in the local client config, or keep them in a repo-local `.env.provider.local` file that is not committed.

If your Codex build supports plugin/shortcut commands, map `$opro` (or `/opro`) to: call `orangepro_start` for the current checkout, then follow the returned `next_actions`. The MCP tool is the source of truth; the shortcut is just a convenience wrapper.

## Agent Prompt

```text
Use OrangePro first. Call orangepro_start for this checkout, inspect the returned next_actions, then generate tests only through orangepro_generate_tests. Write only runnable tests with run_hints. After running them, call `orangepro_prove` with the returned `prove_run` args for Dynamically Proven. Use record_run only for static diagnostics.
```
