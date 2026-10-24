## OrangePro: targeted mutation proof for tests

OrangePro checks whether the tests for a behavior would notice if that behavior broke. It breaks the function in an isolated copy and runs the test. It runs on the merged base build, after merge and before release. It is not a PR gate or a release gate. Proof and ranking use no AI model.

### When to use it
- After you change code or write tests, and before you tell the user the tests are good.
- When the user asks which behaviors are unprotected or whether a test really protects anything.
- At the start of a session, if `.orangepro/` exists, read `.orangepro/rtm.md` first.

### How (MCP server `orangepro-local`)
1. `orangepro_start` on this checkout. Follow its `next_actions`.
2. `orangepro_find_test_gaps` to see unproven behaviors, ranked.
3. For the top gap, write a test at the suggested path and run it with the suggested command from the owning package.
4. `orangepro_prove_loop` for that behavior (setup, targeted mutation proof, report refresh). Use `orangepro_prove` if no setup is needed.
5. Report the result as it is: Proven, Not proven (the test still passed on the broken copy), or Unrunnable (setup failed). If nothing moved, say so.

No MCP client? Use the CLI: `npx -y @orangepro/mcp-server@latest start .`, then `opro gaps --limit 10`.

### Rules
- Never weaken, delete, skip or loosen an existing test or assertion to get a result.
- Write only tests that include `run_hints`. Drafts and AI links (`orangepro_ai_links`, `orangepro_ai_flows`) are context, not proof.
- Do not call a behavior Proven unless OrangePro reports it Proven.
- Do not claim OrangePro prevents production issues. It shows which behaviors the tests protect.
- Never commit API keys or MCP config files that contain keys.

### Setup (once per client)
```json
{ "mcpServers": { "orangepro-local": { "command": "npx", "args": ["-y", "@orangepro/mcp-server@latest", "mcp"] } } }
```
