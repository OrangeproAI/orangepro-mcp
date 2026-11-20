# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What This Is

**OrangePro Local Proof Kit** (`src/local/**`, bin `opro`, alias `orangepro-local`) is the one product in this repository and what the npm package ships: a local-first CLI + MCP server that builds an OrangePro-shaped evidence graph from a local checkout, scores readiness, generates grounded tests via BYOK model adapters, dynamically proves behaviors via a mutation oracle (TS/JS, Go, Java, Python), and exports a metadata-only evidence pack. It does NOT call the hosted API. See [docs/local-proof-kit.md](docs/local-proof-kit.md).

The hosted MCP server that once lived beside it (top-level `src/*.ts`) has moved to a private repository.

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
npm test             # full sharded suite; Go/Java/Python chunks skip when the toolchain is absent
npm run test:rest    # fast TS-only lane (excludes the language proof spikes)
npm run typecheck    # tsc --noEmit
```

Single test file: `npx vitest run tests/local/cliArgs.test.ts`

Local proof kit: `npm run local -- analyze .` (dev), `node scripts/smoke-local.mjs` (offline e2e smoke). Other smoke lanes: `npm run smoke:generate-prove`, `smoke:generate-prove-v5`, `smoke:db-sqljs`, `smoke:gap-fill`.

## Environment

Local proof kit is BYOK, and a key is only needed for LLM test generation — analysis and dynamic proof run keyless. Set `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or `OLLAMA_BASE_URL` (optional `ORANGEPRO_PROVIDER`, `*_MODEL`, `*_BASE_URL`), read only from the process environment: the shell, or the `env` block of an MCP client's config. No `.env` file is read, so a scanned repository cannot choose where a key is sent. See [docs/local-proof-kit.md](docs/local-proof-kit.md).

## Architecture

```
src/
  local/            — Local Proof Kit: CLI (cli.ts), MCP server (mcp.ts), analyze/ + graph/ (evidence graph),
                      generate/ (BYOK test generation), autoProve.ts + operations.ts (dynamic proof + mint),
                      rtm.ts (traceability matrix), viz/ (behavior report HTML), pack/ (metadata-only export)
                      — see docs/local-proof-kit.md
```
