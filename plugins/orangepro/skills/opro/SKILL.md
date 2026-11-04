---
name: opro
description: Use OrangePro to find behavioral test gaps and generate grounded tests for this repository.
---

Use the OrangePro MCP tools for local evidence-graph analysis and grounded test generation.

1. Start with `orangepro_start` for the current checkout.
2. If OrangePro reports a large-repo scope breakdown, prefer a focused scope for AI/generation; full deterministic analysis is still allowed.
3. For PR work, call `orangepro_generate_tests` with `base_ref=main`.
4. For baseline work, call `orangepro_find_test_gaps`, pick one high-priority gap, then call `orangepro_generate_tests` for that target.
5. Write only generated tests that include `run_hints`; drafts are context, not runnable claims.
6. Run the suggested command from the owning package directory.
7. After a pass, take the `prove_run` args returned by `orangepro_generate_tests` and pass them to `orangepro_prove` so OrangePro can dynamically prove the target. Use `record_run` only for static diagnostics.
8. Report status as Proven, Reproven, Runtime-covered, Associated signal, or No link. Never promote Associated signal or AI links to Proven. A successful `orangepro_prove` returns `proven: true` and stores the ledger status `reproven`, including the first time. Proven is the report count of behaviors with that certificate. Reproven (this run) is the traceability label for the same certificate. It does not mean the function was proved before.

For JavaScript or TypeScript, `orangepro_prove` needs `target_symbol` in the form `sym:<file>#<Symbol>`, `test_path`, and `replacement` set to an empty body or a single literal return such as `return null;`. An async function also needs `replacement_mode` `promise-json`. Set `runner` to the repo's runner (`jest`, `vitest`, or `mocha`). Example: `target_symbol` `sym:index.js#run`, `test_path` `index.test.js`, `replacement` `return null;`, `replacement_mode` `promise-json`, `runner` `jest`.

OrangePro may use weak AI grounding when a provider key is configured, but AI links are suggestions for generation only and never change Proven coverage.
