## OrangePro (targeted mutation proof)

OrangePro is an MCP server (`orangepro-local`) that checks whether tests for a behavior would notice if it broke: it breaks the function in an isolated copy and runs the test. It runs on the merged base build, after merge and before release. It is not a PR gate or a release gate. Proof uses no AI model.

VS Code MCP config (`.vscode/mcp.json` or your MCP settings):
```json
{ "servers": { "orangepro-local": { "command": "npx", "args": ["-y", "@orangepro/mcp-server@latest", "mcp"] } } }
```

After you change code or write tests, before you say the tests are good:
1. `orangepro_start` on this checkout; follow `next_actions`.
2. `orangepro_find_test_gaps`; pick the top gap.
3. Write a test at the suggested path; run it from the owning package.
4. `orangepro_prove_loop` (or `orangepro_prove`) for that behavior.
5. Report Proven, Not proven, or Unrunnable as returned. If nothing moved, say so.

Rules:
- Never weaken, delete, skip or loosen a test or assertion to get a result.
- Write only tests with `run_hints`. Drafts and AI links are context, not proof.
- Do not call a behavior Proven unless OrangePro reports it Proven.
- Do not claim OrangePro prevents production issues.
- Never commit keys or MCP config files that contain keys.
