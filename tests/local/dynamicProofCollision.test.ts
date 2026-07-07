import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

// RED regression for a CONFIRMED false-Proven in the #191 test-identity binding.
//
// #191 tightens the TS/JS gate to "the SAME runner-reported test passed baseline AND failed under mutant"
// by matching a FLAT, file-wide Set of passed-baseline identity strings (fullName else ancestorTitles+title).
// That is Set MEMBERSHIP, not same-INSTANCE binding: two distinct tests that share an identity collapse to
// one string, so a mutant-only failure of test B is credited because a DIFFERENT same-identity test A passed
// baseline — exactly the "a different same-name test passed baseline" hole #191 was written to close.
//
// Fixture `collision-repro`: target `mode()` returns { kind: "real" }. Test file has TWO tests titled
// "handles mode" under describe("svc"):
//   A: expect(1 + 1).toBe(2)                         — mutation-INDEPENDENT; passes baseline, seeds identity.
//   B: it.skipIf(mode().kind === "real")(...)        — skipped at baseline (never passes); under the mutant
//                                                       (kind => "mutant") it runs and fails at a real assertion.
// No baseline-PASSING test flips to fail, so the correct verdict is NOT proven. On #191 this mints
// { status: "proven", proven: true } — a false-Proven. This test FAILS (RED) until the binding is made
// per-instance / collision-safe (or refuses ambiguous identities).
const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/spikes/dynamic-proof-spike.mjs");
const vitestBin = require.resolve("vitest/vitest.mjs");

describe("dynamic proof — same-identity collision must not mint proven", () => {
  it("does NOT credit a skipped-at-baseline twin's mutant failure via a colliding passed-baseline identity", () => {
    const repo = path.join(root, "tests/local/__fixtures__/dynamic-proof/collision-repro");
    const run = spawnSync(process.execPath, [
      script,
      "--root", repo,
      "--test", "src/svc.test.ts",
      "--target", "src/svc.ts",
      "--method", "mode",
      "--replacement", "return {\"kind\":\"mutant\"};",
      "--runner", "vitest",
      "--vitest-bin", vitestBin,
      "--json"
    ], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    expect(run.status).toBe(0);
    const result = JSON.parse(run.stdout);
    // The load-bearing trust assertions — both currently FAIL on #191 (false-Proven):
    expect(result.proven).toBe(false);
    expect(result.status).not.toBe("proven");
  }, 30_000);
});
