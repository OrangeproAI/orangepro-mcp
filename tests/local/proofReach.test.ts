/**
 * F4: a mutant that survives says "the test does not catch a break" only when the test ran the
 * changed function. Four outcomes, never three: caught, ran but missed, never ran, can't tell.
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { isNotExercised, isReachUnknown, isRoastSurvivor } from "../../src/local/autoProve.js";
import { withReachOutcome } from "../../src/local/operations.js";
import { NON_KILLING_NOTE, NOT_EXERCISED_NOTE, REACH_UNKNOWN_NOTE, nonKillingLabelFor, nonKillingNoteFor } from "../../src/local/proofDoctor.js";
import { survivorKind } from "../../src/local/proofReach.js";
import { byHandCounts } from "../../src/local/viz/byHand.js";
import { verbFor } from "../../src/local/viz/worklist.js";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const script = path.join(root, "scripts/spikes/dynamic-proof-spike.mjs");
const fixtures = path.join(root, "tests/local/__fixtures__/dynamic-proof");
// vitest 4 no longer exports the "./vitest.mjs" subpath; the bin file is still shipped beside package.json.
const vitestBin = path.join(path.dirname(require.resolve("vitest/package.json")), "vitest.mjs");
const mochaBin = require.resolve("mocha/bin/mocha.js");

interface Verdict { status: string; proven: boolean; reach?: string; reason: string }

function prove(args: string[], env: NodeJS.ProcessEnv = {}): Verdict {
  const run = spawnSync(process.execPath, [script, ...args, "--replacement", "return null;", "--json"], {
    cwd: root,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...env }
  });
  return JSON.parse(run.stdout) as Verdict;
}

const esm = (test: string, env?: NodeJS.ProcessEnv): Verdict =>
  prove(["--root", path.join(fixtures, "reach-esm"), "--test", `test/${test}.test.ts`, "--target", "src/url.ts", "--method", "createAddress", "--runner", "vitest", "--vitest-bin", vitestBin], env);
const cjs = (test: string): Verdict =>
  prove(["--root", path.join(fixtures, "reach-cjs"), "--test", `test/${test}.test.js`, "--target", "src/calc.js", "--method", "double", "--runner", "mocha", "--mocha-bin", mochaBin]);

describe("reach marker: the proof script, ESM under Vitest", { timeout: 120_000 }, () => {
  it("a linked test that never calls the function reads 'never ran', never 'survived'", () => {
    const verdict = esm("never");
    expect(verdict.status).toBe("not_exercised");
    expect(verdict.reach).toBe("never_ran");
    expect(verdict.reason).toBe("not exercised: this test never runs createAddress");
    expect(verdict.proven).toBe(false);
  });

  it("a test that calls the function and asserts nothing about it reads 'ran but missed'", () => {
    const verdict = esm("weak");
    expect(verdict.status).toBe("associated_survived");
    expect(verdict.reach).toBe("ran");
  });

  it("a test that catches the break is proven", () => {
    const verdict = esm("catch");
    expect(verdict.status).toBe("proven");
    expect(verdict.proven).toBe(true);
  });

  it("a marker that is not written reads 'can't tell', never 'survived'", () => {
    const verdict = esm("weak", { OPRO_REACH_MARKER: "off" });
    expect(verdict.status).toBe("reach_unknown");
    expect(verdict.reach).toBe("unknown");
    expect(verdict.reason).toBe("reach unknown: could not check whether this test runs createAddress");
  });

  it("a test that replaces the environment object cannot yield 'never ran'", () => {
    const verdict = esm("hides");
    expect(verdict.status).toBe("reach_unknown");
  });
});

describe("reach marker: the proof script, CommonJS under Mocha", { timeout: 120_000 }, () => {
  it("never ran / ran but missed / caught", () => {
    expect(cjs("never")).toMatchObject({ status: "not_exercised", reach: "never_ran" });
    expect(cjs("weak")).toMatchObject({ status: "associated_survived", reach: "ran" });
    expect(cjs("catch")).toMatchObject({ status: "proven", proven: true });
  });
});

describe("one reading of a survivor for every language", () => {
  const survived = { status: "associated_survived", proven: false, method: "parse" };

  it("keeps 'survived' only when the function ran", () => {
    expect(withReachOutcome({ ...survived, reach: "ran" })).toMatchObject({ status: "associated_survived", reach: "ran" });
  });

  it("turns an empty marker into 'not exercised'", () => {
    expect(withReachOutcome({ ...survived, reach: "never_ran" })).toMatchObject({
      status: "not_exercised", reach: "never_ran", reason: "not exercised: this test never runs parse"
    });
  });

  it("turns a survivor with no reach (a language without a marker) into 'reach unknown'", () => {
    expect(withReachOutcome(survived)).toMatchObject({
      status: "reach_unknown", reach: "unknown", reason: "reach unknown: could not check whether this test runs parse"
    });
  });

  it("leaves every other outcome alone", () => {
    const proven = { status: "proven", proven: true };
    expect(withReachOutcome(proven)).toBe(proven);
    const unrunnable = { status: "unrunnable", proven: false, reason: "baseline test did not pass" };
    expect(withReachOutcome(unrunnable)).toBe(unrunnable);
  });

  it("reads a record written before the marker as 'can't tell'", () => {
    expect(survivorKind("associated_survived", undefined)).toBe("cant_tell");
    expect(survivorKind("survived", undefined)).toBe("cant_tell");
    expect(survivorKind("associated_survived", "ran")).toBe("ran_but_missed");
    expect(survivorKind("not_exercised", undefined)).toBe("never_ran");
    expect(survivorKind("reach_unknown", undefined)).toBe("cant_tell");
    expect(survivorKind("proven", "ran")).toBeUndefined();
  });
});

describe("what each outcome is allowed to say", () => {
  const attempt = (mutant_status: string, reach?: "ran" | "never_ran" | "unknown") =>
    ({ target_symbol: "f", test_path: "t.test.js", classification: "non_killing" as const, mutant_status, ...(reach ? { reach } : {}) });

  it("roast lists only 'ran but missed' as survivors", () => {
    expect(isRoastSurvivor(attempt("associated_survived", "ran"))).toBe(true);
    expect(isRoastSurvivor(attempt("associated_survived"))).toBe(false);
    expect(isRoastSurvivor(attempt("not_exercised", "never_ran"))).toBe(false);
    expect(isRoastSurvivor(attempt("reach_unknown", "unknown"))).toBe(false);
    expect(isNotExercised(attempt("not_exercised", "never_ran"))).toBe(true);
    expect(isReachUnknown(attempt("associated_survived"))).toBe(true);
    expect(isReachUnknown(attempt("reach_unknown", "unknown"))).toBe(true);
  });

  it("doctor says 'equivalent mutation' only for 'ran but missed'", () => {
    expect(nonKillingNoteFor("associated_survived", "ran")).toBe(NON_KILLING_NOTE);
    expect(NON_KILLING_NOTE).toContain("possibly an equivalent mutation");
    expect(nonKillingNoteFor("not_exercised", "never_ran")).toBe(NOT_EXERCISED_NOTE);
    expect(nonKillingNoteFor("reach_unknown", "unknown")).toBe(REACH_UNKNOWN_NOTE);
    expect(nonKillingNoteFor("associated_survived")).toBe(REACH_UNKNOWN_NOTE);
    for (const note of [NOT_EXERCISED_NOTE, REACH_UNKNOWN_NOTE]) {
      expect(note).not.toContain("equivalent");
      expect(note).not.toContain("proven negative");
    }
    expect(nonKillingLabelFor("associated_survived", "ran")).toBe("mutant survived");
    expect(nonKillingLabelFor("not_exercised", "never_ran")).toBe("not exercised");
    expect(nonKillingLabelFor("associated_survived")).toBe("reach unknown");
  });

  it("the worklist: Write for 'never ran', Prove for 'can't tell', and 'does not catch' only when it ran", () => {
    const base = { evidence: "linked" as const, linkedTest: "t.test.js" };
    expect(verbFor({ ...base, proof: { status: "survived", current: true, test: "t.test.js" } }))
      .toEqual({ verb: "write", reason: "t.test.js runs it but does not catch a break." });
    expect(verbFor({ ...base, proof: { status: "not_exercised", current: true, test: "t.test.js" } }))
      .toEqual({ verb: "write", reason: "Not exercised: t.test.js never runs it." });
    const unknown = verbFor({ ...base, proof: { status: "reach_unknown", current: true, test: "t.test.js" } });
    expect(unknown.verb).toBe("prove");
    expect(unknown.reason).toContain("Reach unknown");
    expect(unknown.reason).not.toContain("does not catch");
  });

  it("the By hand line counts a found test as weak only when it ran the function", () => {
    const found = (mutant_status: string, reach?: string, n = 0) =>
      ({ target_symbol: `f${n}`, test_path: `t${n}.test.js`, test_source: "found" as const, classification: "non_killing" as const, mutant_status, ...(reach ? { reach } : {}) });
    const counts = byHandCounts({
      attempts: [found("associated_survived", "ran", 1), found("associated_survived", undefined, 2), found("not_exercised", "never_ran", 3), found("reach_unknown", "unknown", 4)],
      drafts: 0,
      staticOnly: false
    });
    expect(counts.weak).toBe(1);
  });
});
