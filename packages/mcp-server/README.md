# @orangepro/mcp-server

Compatibility launcher for the OrangePro CLI and local stdio MCP server.

```bash
# Analyze the current repository, prove eligible existing tests, and render the report.
npx -y @orangepro/mcp-server@latest start . --prompt-version v5
```

For MCP clients:

```bash
npx -y @orangepro/mcp-server@latest mcp
```

The implementation delegates to the main package, `@orangepro/orangepro-mcp`.
