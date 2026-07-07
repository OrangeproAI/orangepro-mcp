# Maintainer notes

Internal checklist — this file is not part of the published npm package.

## Publishing Checklist

Before public plugin launch:

1. Verify `@orangepro/orangepro-mcp` is published and plugin MCP configs can run `npx -y @orangepro/orangepro-mcp@latest mcp`.
2. Codex: ship `.agents/plugins/marketplace.json` and `plugins/orangepro`; bare `codex plugin add orangepro` needs a configured/default marketplace listing.
3. Claude Code: ship `.claude-plugin/marketplace.json` and `plugins/orangepro`; marketplace install is a separate listing step.
4. Cursor: submit `plugins/orangepro` to the Cursor Marketplace when ready; local testing uses that same directory.
5. OpenCode / VS Code: keep the MCP snippets current until they expose a plugin marketplace path for this style of local server.
6. Smoke every path in a clean checkout and verify no config pins a model or commits a provider key.
