# @orangepro/mcp-remote

Remote MCP server for OrangePro — deployed as a Cloudflare Worker at `mcp.orangepro.ai`.

Exposes the OrangePro platform API tools over HTTP using the MCP Streamable HTTP transport. No filesystem access, no local analysis — only the tools that call `api.orangepro.ai`.

## Tools exposed

| Tool | Description |
|---|---|
| `orangepro_list_agents` | List all agents for a tenant |
| `orangepro_get_agent` | Get agent detail and config |
| `orangepro_run_agent` | Trigger an immediate agent run |
| `orangepro_list_agent_runs` | List recent runs for an agent |
| `orangepro_get_agent_logs` | Read agent log lines |
| `orangepro_get_agent_health` | Check agent health and connectivity |
| `orangepro_resolve_story` | Resolve a story against the Knowledge Graph |
| `get_coverage_gaps` | Find application areas lacking test coverage |
| `convert_bug_to_tests` | Generate regression tests from a bug report |
| `build_regression_pack` | Build a regression test pack for an area |
| `explain_quality_risk` | Get a quality risk assessment |
| `generate_missing_coverage` | Generate test cases for a user story |
| `analyze_pr_risk` | Analyze a PR for quality risk |
| `analyze_release_readiness` | Get a tenant-wide release readiness assessment |
| `generate_test_scripts` | Convert test cases to executable scripts |

## Deploy

### Prerequisites

- [Cloudflare account](https://dash.cloudflare.com) with `mcp.orangepro.ai` DNS pointing to Cloudflare
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/install-and-update/)

### Steps

```bash
# 1. Install dependencies
npm install

# 2. Authenticate with Cloudflare
npx wrangler login

# 3. Deploy
npx wrangler deploy

# 4. (Optional) Set a default API key for unauthenticated users
npx wrangler secret put ORANGEPRO_API_KEY

# 5. (Optional) Set a default tenant ID
npx wrangler secret put ORANGEPRO_TENANT_ID
```

The worker will be available at `https://mcp.orangepro.ai/mcp`.

### Local development

```bash
npm run dev
# Worker runs at http://localhost:8787
# MCP endpoint: http://localhost:8787/mcp
```

## Connect to Claude

In Claude Desktop `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "orangepro": {
      "url": "https://mcp.orangepro.ai/mcp",
      "headers": {
        "X-OrangePro-Api-Key": "your-api-key",
        "X-OrangePro-Tenant-Id": "your-tenant-id"
      }
    }
  }
}
```

## Connect to ChatGPT (Plugin)

MCP server URL: `https://mcp.orangepro.ai/mcp`

## Architecture

```
User's Claude/ChatGPT
        │
        │ HTTP/SSE (MCP Streamable HTTP)
        ▼
mcp.orangepro.ai  (Cloudflare Worker)
        │
        │ HTTPS REST
        ▼
api.orangepro.ai  (OrangePro Platform API)
```

The local analysis tools (`orangepro_start`, `orangepro_analyze_sources`, etc.) are not available here — they require a local repo checkout and run via `npx -y @orangepro/mcp-server@latest start .`.
