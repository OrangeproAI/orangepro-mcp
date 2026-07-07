---
name: opro
description: Use when generating grounded tests or doing PR/branch test-review for a LOCAL repo with OrangePro (the `opro` / `orangepro-local` CLI + MCP). Builds a local evidence graph from a checkout, targets the behaviors a diff touches, and returns runnable, source-referenced test drafts with run hints — BYOK, no source upload.
---

# opro — OrangePro

`opro` (alias `orangepro-local`) builds a local, metadata-only evidence graph from a
checkout, then generates grounded test drafts for the behaviors you ask about. It
reads source in-process but never stores or uploads code. Test generation uses the
developer's own model key (BYOK).

**You (the agent) are the test runner.** `opro` returns test code plus run hints; you
write the file and run it with your own shell tools. `opro` never writes into or runs
the repo under test.

## Default workflow (non-mutating)

Run these in the repo you're reviewing:

```bash
opro init                      # one-time: create the local workspace
opro analyze .                 # build/refresh the evidence graph (reads source in-process only)
opro generate --base <ref>     # generate ONLY for behaviors the diff vs <ref> touches
```

`--base <ref>` is the default, **non-mutating** path for PR and branch review. It uses a
read-only diff against `<ref>` (e.g. `--base main`). It does not change your working
tree, switch branches, or pull anything. Use it for almost everything.

For the current branch's diff against its base, use `opro generate --changed`.

Each generated test carries:
- `grounding.source_refs` — the real repo entities it was grounded on.
- `evidence` / `evidence_summary` — citations validated against the local graph.
- `run_hints` — a `suggested_path` to write the test and a `run_command` to run it.

After generating: write each test's `body` to its `suggested_path`, run its
`run_command` from the package that owns that directory, then report pass/fail and
propose fixes for failures. If a test ships with `runnable: false`, treat it as a
grounded DRAFT plus its `unresolved_reason` diagnostic — do not invent an import to
make it "run"; fix the import from the real module or leave it as a draft for review.

## Important: keep it non-mutating by default

- Prefer `--base <ref>` (read-only diff). It is enough for PR review and never touches
  your tree.
- The `--pr <n>` flag is a MUTATING escape hatch: it switches your working tree to the
  PR branch. Do NOT run it on a user's behalf without their explicit go-ahead — it
  refuses on a dirty tree and requires `--yes`/`--force` or an interactive confirmation,
  and you should let the user make that call. When in doubt, check out the PR yourself
  is unnecessary: just pass `--base <the PR base>` and diff in place.

## When to use which command

| Situation | Command |
|---|---|
| Review a PR / branch without disturbing the tree | `opro generate --base <pr-base>` |
| Test the current branch's diff vs its base | `opro generate --changed` |
| Generate for a specific behavior id | `opro generate --target REQ-001` |
| See readiness / coverage / gaps | `opro score`, `opro gaps`, `opro status` |
| Explain a generated test's grounding | `opro explain <generated_test_id>` |
| Use from another agent/tool over MCP | `opro mcp` (the MCP server is read-only: `base_ref` diff, never a checkout) |

Run `opro` (no args) for full help.
