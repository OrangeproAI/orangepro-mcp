# Demo write-up: a green test suite that does not notice a broken function
Status: DRAFT. Not published. Every result below is from a real run on the box, Oct 23, 2026 (PT), with `@orangepro/mcp-server@latest` = tool_version 0.2.58, Node 22, vitest 2.1.9. Raw outputs are in `results/*.json`. This folder is the runnable repo (`npm install && npm test`).

## The setup
`src/pricing.ts` has two functions: `applyDiscount(price, percent)` and `isEligibleForFreeShipping(subtotal, isMember)`.
`test/pricing.test.ts` has two tests that only check the type of the result (`typeof ... === "number"` / `"boolean"`).
`npm test`: 2 passed. CI is green.

## Step 1: break both functions by hand
We edited `applyDiscount` to `return price;` (discount ignored) and `isEligibleForFreeShipping` to `return false;`.
Result: `npm test` still shows **2 passed**. Green CI, both behaviors gone.

## Step 2: add specific-value tests (`test/pricing.strong.test.ts`, 4 tests)
On the original code: 4 passed. On the hand-broken code: **3 failed, 1 passed** (the 1 that still passes is the `percent > 100` throw case, which the break did not touch). So the specific tests notice the break; the type-only tests do not.

## Step 3: what OrangePro's targeted mutation proof says (`opro prove`, one function and one test at a time)
OrangePro replaces the function body with a sentinel in an isolated copy and reruns the named test.

| Function | Test file | Sentinel body | OrangePro result | Reason (verbatim) |
|---|---|---|---|---|
| applyDiscount | pricing.test.ts (type-only) | `return 0;` | associated_survived (not proven) | mutated target did not change the test outcome |
| isEligibleForFreeShipping | pricing.test.ts (type-only) | `return false;` | associated_survived (not proven) | mutated target did not change the test outcome |
| isEligibleForFreeShipping | pricing.test.ts (type-only) | `return true;` | associated_survived (not proven) | mutated target did not change the test outcome |
| applyDiscount | pricing.test.ts (type-only) | `return null;` | **proven** | baseline passed and mutant failed at an assertion |
| applyDiscount | pricing.strong.test.ts | `return 0;` | proven | baseline passed and mutant failed at an assertion |
| isEligibleForFreeShipping | pricing.strong.test.ts | `return false;` | proven | baseline passed and mutant failed at an assertion |
| isEligibleForFreeShipping | pricing.strong.test.ts | `return true;` | proven | baseline passed and mutant failed at an assertion |

Read the `return null;` row carefully: the type-only test does catch a function that returns `null`, because `typeof null` is not `"number"`. "Green but blind" holds for breaks that keep the return type (wrong number, wrong boolean), not for every break. Any public claim must say this.

## What this shows (and does not)
- Shows: the same test suite can pass while a function is broken, and a targeted mutation proof run reports which tests would not notice, with a reason and a rerunnable command.
- Does not show: any rate across real repos, any benchmark, or anything about production. No such numbers exist; none are claimed.
- Where it runs: this is a development-time check on one checkout. In the positioning, OrangePro's authoritative run is on the merged base build, after merge and before release. It is not a PR gate or a release gate.

## Known gap found while making this (important for the video)
`opro start .` and `opro roast .` on this repo reported 0 behaviors and "attempted: 0 ... no survived targeted mutants found in this pass" with no reason. The two functions were not counted as behaviors by the default analysis (RTM: "Total denominator behaviors 0"), so the demo uses `opro prove` with an explicit `--target-symbol`, `--test` and `--replacement`. A first-time viewer running `opro roast .` on this repo would see a silent zero. This is backlog N-E7 / v1 #2. Fix or explain before recording the video (D5), or use a repo where `roast` finds targets. Cause not investigated.

## Reproduce
```bash
cd demo-green-but-blind && npm install && npm test        # 2 passed
npx -y @orangepro/mcp-server@latest prove --target-symbol 'sym:src/pricing.ts#applyDiscount' \
  --test test/pricing.test.ts --replacement 'return 0;' --json
```

## Scope note
The silent-zero finding is reported only. Any fix (N-E7) changes output/behavior and is NOT part of this one-day batch; it needs the ProvenUpgrade coordination log entry first.
