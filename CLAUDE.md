# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

Two independent products live here (they share no code):

1. **OrangePro Local Proof Kit** (`src/local/**`, bin `opro`, alias `orangepro-local`) — the product the npm package ships. A local-first CLI + MCP server that builds an OrangePro-shaped evidence graph from a local checkout, scores readiness, generates grounded tests via BYOK model adapters, dynamically proves behaviors via a mutation oracle (TS/JS, Go, Java, Python), and exports a metadata-only evidence pack. It does NOT call the hosted API. See [docs/local-proof-kit.md](docs/local-proof-kit.md).

2. **OrangePro MCP server** (`src/index.ts` + top-level `src/*.ts`) — a Model Context Protocol server that exposes OrangePro's hosted agent platform and QA intelligence APIs as MCP tools over stdio. Clients (Claude Desktop, Claude Code, etc.) connect and call tools to manage OrangePro agents, resolve stories against a Knowledge Graph, and run QA analytics (coverage gaps, PR risk, release readiness, bug-to-test conversion, test generation). Requires a hosted backend; not part of the npm package.

## What counts as a behavior (Local Proof Kit)

The kit does not try to produce a test for every function. It identifies consequential, observable behaviors and the integration scenarios a change affects, then closes selected test gaps with a reviewable, execution-backed test patch. When changing what is seen, counted, ranked or proven, hold to these:

- **A symbol is not a behavior.** Being visible to the analyzer does not make a function count. It must be public and must compute, compare or decide something.
- **Trivial plumbing stays in the graph, uncounted, with a reason.** A body that is empty, returns or stores a value unchanged, or passes its own arguments straight to a counted function is plumbing. So is code its own authors document as private. When it is unclear, it counts.
- **Judge what the body does, not what it is called.** Never add a rule for one repository or one library.
- **Keep helpers in the graph.** A change inside an uncounted helper is followed to the public behavior that uses it. If it cannot be followed, report it as unknown, never as low risk.
- **Bind the exact change.** Changed lines map to one function and its exact bytes; a mutation changes that function and nothing else.
- **Credit a test only when running it shows it would catch a break.**

The graph decides what deserves attention. Execution establishes whether a test protects it. The patch makes that protection usable.

## Commands

```bash
npm run build        # tsc → dist/ (emits both bins via tsconfig.build.json)
npm run dev          # tsx src/index.ts (hosted server, stdio, needs MCP client)
npm run start        # node dist/index.js (requires build first)
npm test             # full sharded suite; Go/Java/Python chunks skip when the toolchain is absent
npm run test:rest    # fast TS-only lane (excludes the language proof spikes)
npm run typecheck    # tsc --noEmit
```

Single test file: `npx vitest run tests/config.test.ts`

Local proof kit: `npm run local -- analyze .` (dev), `node scripts/smoke-local.mjs` (offline e2e smoke). Other smoke lanes: `npm run smoke:generate-prove`, `smoke:generate-prove-v5`, `smoke:db-sqljs`, `smoke:gap-fill`.

## Environment

Hosted MCP server (set in your environment or a local `.env`):
- `ORANGEPRO_API_BASE_URL` — backend API (default: `http://localhost:8000/api/v1`)
- `ORANGEPRO_TENANT_ID` — default tenant; most tools accept an optional `tenant_id` override
- `ORANGEPRO_API_KEY` — bearer token sent as both `Authorization` and `X-API-Key`
- `ORANGEPRO_USER_EMAIL` — sent as `X-User-Email` header
- `ORANGEPRO_ORGANIZATION_NAME` — sent as `X-Organization-Name` header (falls back to tenant ID)

Local proof kit is BYOK, and a key is only needed for LLM test generation — analysis and dynamic proof run keyless. Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OLLAMA_BASE_URL` (optional `ORANGEPRO_PROVIDER`, `*_MODEL`, `*_BASE_URL`), read only from the process environment: the shell, or the `env` block of an MCP client's config. No `.env` file is read, so a scanned repository cannot choose where a key is sent. See [docs/local-proof-kit.md](docs/local-proof-kit.md).

## Architecture

```
src/
  index.ts          — hosted entrypoint: loads config, creates server, connects stdio transport
  config.ts         — env-based config + resolveTenant() helper
  apiClient.ts      — OrangeProClient: thin HTTP client (GET/POST) with auth headers, timeout, abort
  server.ts         — createServer(): registers all hosted MCP tools and prompts on McpServer
  orangeproTools.ts — agent platform tool handlers (list/get/run agents, runs, logs, health, KG resolve)
  qaTools.ts        — QA intelligence tool handlers (coverage, bugs, regression, PR risk, release readiness, test generation)
  types.ts          — shared response types for API payloads
  local/            — Local Proof Kit: CLI (cli.ts), MCP server (mcp.ts), analyze/ + graph/ (evidence graph),
                      generate/ (BYOK test generation), autoProve.ts + operations.ts (dynamic proof + mint),
                      rtm.ts (traceability matrix), viz/ (behavior report HTML), pack/ (metadata-only export)
                      — see docs/local-proof-kit.md
```

**Tool registration pattern**: `server.ts` wires Zod input schemas to handler functions from `orangeproTools.ts` and `qaTools.ts`. Handlers call `OrangeProClient` methods and return `ToolTextResponse` via `asText()`.

**Two hosted tool families**:
1. **Agent platform** (`orangepro_*`) — CRUD on agents scoped by tenant. All use `TenantInput` (optional `tenant_id` falling back to env default). API paths go through `/admin/tenants/{id}/agent-platform/...`.
2. **QA intelligence** (`get_coverage_gaps`, `convert_bug_to_tests`, `build_regression_pack`, `explain_quality_risk`, `generate_missing_coverage`, `analyze_pr_risk`, `analyze_release_readiness`) — analytics endpoints at `/analytics/...`, `/bug-to-test/...`, `/test-generation/...`. These are tenant-scoped via API key, not explicit tenant ID.

**Test generation** (`generateMissingCoverage`) uses a polling pattern: initialize job → submit → poll status every 5s up to 120s deadline → fetch results.

**Testing pattern**: Tests inject a fake `fetchImpl` into `OrangeProClient` to intercept HTTP calls without network. No mocking library needed — the client constructor accepts `FetchLike`.
