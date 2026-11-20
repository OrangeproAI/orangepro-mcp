import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { loadFaultRun } from "../../src/local/candidateTest.js";
import { recordBytes, writeRunManifest } from "../../src/local/contracts/io.js";
import { checkOracle, oracleDraftSha256, withDraftOrigin } from "../../src/local/contracts/oracle.js";
import { opProbeCandidates, renderCandidates, scopeWords, type CandidatesInput } from "../../src/local/faultCandidates.js";
import type { ProposedFault } from "../../src/local/pluginCalls.js";

import { OFFSETS, WITNESS, deps, editInput, hostExecutor, sha256, tempDirs, workspace, type Workspace } from "./support/probeWorkspace.js";

afterAll(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

const ADDON = { name: "@orangepro/mcp-pro", version: "0.0.1-test", api_version: "1.1.0", used: ["FaultSelector" as const] };
let counter = 0;
const runDeps = () => ({ clock: deps.clock, container: hostExecutor(), runId: () => `run_cand_${(counter += 1)}` });

/** One refused, one the tests catch, one they miss, one more that is never tried. Each carries the approved expected behavior. */
function fourCandidates(w: Workspace): ProposedFault[] {
  const own = { oracle: w.oracle, witness_source: WITNESS, addon: ADDON };
  return [
    { fault: "rounding_floor_ceil@1", reason: "not a rounding call", ...own },
    { fault: `negation_removal@${OFFSETS.bangInSeconds}`, reason: "the guard", ...own },
    { fault: `rounding_floor_ceil@${OFFSETS.floorInSeconds}`, reason: "the rounding", ...own },
    { fault: "", edit: editInput("value / 1000", "value / 100"), reason: "the divisor", ...own }
  ];
}

function input(w: Workspace, cap: number, extra: Partial<CandidatesInput> = {}): CandidatesInput {
  return { target_record: w.record, proposals: fourCandidates(w), cap, accept_supplied_approvals: true, run: { fixture_bytes: w.fixture, tests: ["test/api.test.js"] }, ...extra };
}

const runFolders = (w: Workspace): string[] => {
  const dir = path.join(w.repo, ".orangepro", "proof-runs");
  return existsSync(dir) ? readdirSync(dir) : [];
};

describe("ranked fault candidates", () => {
  it("tries them in order and stops at the first one the tests miss; refusals and runs are counted apart", () => {
    const w = workspace();
    const result = opProbeCandidates(w.repo, input(w, 6), runDeps());
    expect(result.kind).toBe("done");
    if (result.kind !== "done") return;
    expect(result.summary).toMatchObject({ offered: 4, cap: 6, refused: 1, runs: 2, runs_to_first_hit: 2, scope: "selected" });
    expect(result.summary.tried.map((t) => [t.index, t.outcome])).toEqual([[1, "refused"], [2, "caught"], [3, "ran_but_missed"]]);
    expect(result.chosen?.fault_record.operator.id).toBe("rounding_floor_ceil");
    expect(runFolders(w)).toHaveLength(2);
    // The chosen run's own profile says where it stood, and names the approval with the hashes of what was approved.
    const profile = JSON.parse(readFileSync(path.join(w.repo, result.chosen!.run_dir, "run-profile.json"), "utf8"));
    expect(profile.candidates).toMatchObject({ offered: 4, cap: 6, index: 3, refused: 1, runs: 2 });
    expect(profile.candidates.earlier.map((t: { outcome: string }) => t.outcome)).toEqual(["refused", "caught"]);
    expect(profile.supplied_approval).toEqual({ via: "@orangepro/mcp-pro", by: "test", at: "2026-10-21", where: "this test", oracle_sha256: sha256(recordBytes(withDraftOrigin(w.oracle as unknown as Record<string, unknown>, ADDON))), witness_sha256: sha256(WITNESS) });
    // The run also says the add-on drafted it, beside the person's approval, and that it was approved as drafted.
    expect(profile.oracle_draft).toEqual({ by: "@orangepro/mcp-pro", version: "0.0.1-test", draft_sha256: oracleDraftSha256(w.oracle), unchanged_since_draft: true });
    expect(profile.addon).toEqual(ADDON);
    const lines = renderCandidates(result).join("\n");
    expect(lines).toContain("Candidate 3 of 4 is missed by the selected tests: 1 refused, 2 test runs to the first hit (cap 6).");
    expect(lines).not.toMatch(/suite miss/);
  }, 120_000);

  it("stops at the cap with no claim when none was missed; a refused candidate counts toward the cap", () => {
    const w = workspace();
    const result = opProbeCandidates(w.repo, input(w, 2), runDeps());
    expect(result.kind === "done" && result.chosen).toBeNull();
    if (result.kind !== "done") return;
    expect(result.summary).toMatchObject({ refused: 1, runs: 1, runs_to_first_hit: null });
    expect(result.summary.tried).toHaveLength(2);
    expect(renderCandidates(result).join("\n")).toContain("No claim: none of the 2 candidates tried was missed by the selected tests");
  }, 120_000);

  it("runs nothing on a supplied approval the caller did not accept: the draft is written as proposed", () => {
    const w = workspace();
    const result = opProbeCandidates(w.repo, input(w, 6, { accept_supplied_approvals: false }), runDeps());
    expect(result.kind).toBe("needs_approval");
    if (result.kind !== "needs_approval") return;
    expect(result.candidate).toBe(1);
    expect(JSON.parse(readFileSync(path.join(w.repo, result.files.oracle_path), "utf8")).approval).toEqual({ status: "proposed" });
    expect(runFolders(w)).toHaveLength(0);
  }, 120_000);

  it("refuses a candidate whose own expected behavior is not approved, or is for another target", () => {
    const w = workspace();
    const proposals = fourCandidates(w).slice(2);
    proposals[0] = { ...proposals[0]!, oracle: { ...w.oracle, approval: { status: "proposed" } } };
    proposals[1] = { ...proposals[1]!, oracle: { ...w.oracle, target_record_sha256: "0".repeat(64) } };
    const result = opProbeCandidates(w.repo, input(w, 6, { proposals }), runDeps());
    expect(result.kind === "done" && result.summary).toMatchObject({ refused: 2, runs: 0, runs_to_first_hit: null });
    expect(runFolders(w)).toHaveLength(0);
  }, 120_000);

  it("uses the person's own expected behavior for every candidate when given, and records no supplied approval", () => {
    const w = workspace();
    const result = opProbeCandidates(w.repo, input(w, 6, { accept_supplied_approvals: false, person_oracle: { oracle: w.oracle, witness_bytes: w.witness } }), runDeps());
    expect(result.kind === "done" && result.chosen).not.toBeNull();
    if (result.kind !== "done" || !result.chosen) return;
    const profile = JSON.parse(readFileSync(path.join(w.repo, result.chosen.run_dir, "run-profile.json"), "utf8"));
    expect(profile.supplied_approval).toBeUndefined();
    expect(profile.candidates.index).toBe(3);
  }, 120_000);

  it("a change to the approved expected behavior after the run stops every later step, even with the folder's list of files rewritten", () => {
    const w = workspace();
    const result = opProbeCandidates(w.repo, input(w, 6), runDeps());
    if (result.kind !== "done" || !result.chosen) throw new Error("fixture error");
    const dir = path.join(w.repo, result.chosen.run_dir);
    expect(() => loadFaultRun(w.repo, result.chosen!.run_dir)).not.toThrow();
    const oracleFile = path.join(dir, "oracle.json");
    writeFileSync(oracleFile, readFileSync(oracleFile, "utf8").replace('"expected":"1"', '"expected":"2"'));
    expect(readFileSync(oracleFile, "utf8")).toContain('"expected":"2"');
    rmSync(path.join(dir, "MANIFEST.json"));
    writeRunManifest(dir, result.chosen.run_id, "0.0.0-test");
    expect(() => loadFaultRun(w.repo, result.chosen!.run_dir)).toThrow(/not what was approved/);
  }, 120_000);

  it("a hand-written expected behavior carries no draft origin; a draft changed before approval says so; old files check as before", () => {
    const w = workspace();
    const plain = opProbeCandidates(w.repo, input(w, 6, { accept_supplied_approvals: false, person_oracle: { oracle: w.oracle, witness_bytes: w.witness } }), runDeps());
    if (plain.kind !== "done" || !plain.chosen) throw new Error("fixture error");
    expect(JSON.parse(readFileSync(path.join(w.repo, plain.chosen.run_dir, "run-profile.json"), "utf8")).oracle_draft).toBeUndefined();
    // A person changes the expected text of an add-on's draft, then approves it.
    const drafted = withDraftOrigin(w.oracle as unknown as Record<string, unknown>, ADDON);
    const edited = { ...drafted, why_observable: "the return value, which a caller reads" };
    const w2 = workspace();
    const changed = opProbeCandidates(w2.repo, input(w2, 6, { accept_supplied_approvals: false, person_oracle: { oracle: { ...edited, target_record_sha256: w2.oracle.target_record_sha256 }, witness_bytes: w2.witness } }), runDeps());
    if (changed.kind !== "done" || !changed.chosen) throw new Error("fixture error");
    expect(JSON.parse(readFileSync(path.join(w2.repo, changed.chosen.run_dir, "run-profile.json"), "utf8")).oracle_draft).toMatchObject({ by: "@orangepro/mcp-pro", unchanged_since_draft: false });
    // The format: the field is optional, checked when present, and the new basis kind is allowed.
    expect(checkOracle(w.oracle).ok).toBe(true);
    expect(checkOracle(drafted).ok).toBe(true);
    expect(checkOracle({ ...w.oracle, drafted_by: { name: "x" } }).ok).toBe(false);
    expect(checkOracle({ ...w.oracle, basis: [{ kind: "current_behavior", ref: "commit abc123, seconds(1500)", note: "returns 1" }] }).ok).toBe(true);
    expect(checkOracle({ ...w.oracle, basis: [{ kind: "guess", ref: "x", note: "y" }] }).ok).toBe(false);
  }, 120_000);

  it("names the scope: only a whole-suite result is called missed by the whole suite", () => {
    expect(scopeWords(false)).toBe("missed by the selected tests");
    expect(scopeWords(true)).toBe("missed by the whole suite");
  });
});
