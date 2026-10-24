# OrangePro

OrangePro shows which behaviors your tests protect, and which they do not. It breaks a function in an isolated copy and checks that the test fails (targeted mutation proof). It runs on the merged base build, after merge and before release.

```bash
npx -y @orangepro/mcp-server@latest start .
```

`@orangepro/mcp-server` is the launcher for the OrangePro CLI and local stdio MCP server.

```bash
# Analyze the current repository, prove eligible existing tests, and render the report.
npx -y @orangepro/mcp-server@latest start . --prompt-version v5
```

For MCP clients:

```bash
npx -y @orangepro/mcp-server@latest mcp
```

The implementation delegates to the main package, `@orangepro/orangepro-mcp`.
