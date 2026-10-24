## OrangePro (targeted mutation proof)

OrangePro is an MCP server (`orangepro-local`). It tells you whether the tests for a behavior would notice if that behavior broke, by breaking the function in an isolated copy and running the test. It runs on the merged base build, after merge and before release. It is not a PR gate or a release gate. Proof uses no AI model.

Add it to `.mcp.json`:
```json
{ "mcpServers": { "orangepro-local": { "command": "npx", "args": ["-y", "@orangepro/mcp-server@latest", "mcp"] } } }
```

After you change code or write tests, and before you say the tests are good:
1. Call `orangepro_start` on this checkout and follow `next_actions`.
2. Call `orangepro_find_test_gaps`. Pick the top gap.
3. Write a test at the suggested path and run it from the owning package.
4. Call `orangepro_prove_loop` (or `orangepro_prove`) for that behavior.
5. Report exactly what it returned: Proven, Not proven, or Unrunnable. If nothing moved, say so.

If `.orangepro/` exists at session start, read its latest report before writing tests.

Rules:
- Never weaken, delete, skip or loosen a test or assertion to get a result.
- Write only tests that include `run_hints`. Drafts and AI links are context, not proof.
- Do not call a behavior Proven unless OrangePro says so.
- Do not claim OrangePro prevents production issues.
- Never commit keys or MCP config files that contain keys.
