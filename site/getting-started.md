---
title: Getting started
---
# Getting started

1. In a repo with tests, run:
   ```bash
   npx -y @orangepro/mcp-server@latest start .
   ```
   It writes `.orangepro/behavior-coverage.html` and `.orangepro/rtm.md` and prints next actions.
2. See what is unproven: `opro gaps --limit 10` (or `npx -y @orangepro/mcp-server@latest gaps --limit 10`).
3. Find passing tests whose targeted mutant survives, without a model key: `opro roast .`
4. Prove one test against one function:
   ```bash
   opro prove --target-symbol 'sym:src/pricing.ts#applyDiscount' --test test/pricing.test.ts --replacement 'return 0;'
   ```

Results: **Proven** (the test failed when the function was broken in an isolated copy), **Not proven** (the test still passed), **Unrunnable** (setup failed; never counted either way).

Languages and runners: see the README for the current list. A "Proven" function means one test failed when that function was broken, nothing more.
