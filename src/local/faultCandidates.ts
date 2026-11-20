// Ranked fault candidates (add-on interface 1.1). An add-on may propose several faults,
// best first, each with its own expected behavior. They are tried in that order, up to
// the caller's cap, each as an ordinary probe-fault run with every check a person's
// input gets. The loop stops at the first fault that ran and that the tests missed.
// Refused candidates and test runs are counted apart; both count toward the cap.

import { checkOracle, withDraftOrigin } from "./contracts/oracle.js";
import type { CandidateTried } from "./contracts/receipt.js";
import { opProbeFault, ProbeFaultRefusal, type ProbeFaultDeps, type ProbeFaultOptions, type ProbeFaultResult } from "./faultProbe.js";
import { ProofRefusalError } from "./operations.js";
import { writeProposedOracle, type ProposedFault, type ProposedOracleFiles } from "./pluginCalls.js";
import { workspacePaths } from "./workspace.js";

export const CANDIDATE_WORDS: Record<CandidateTried["outcome"], string> = {
  refused: "refused, nothing run",
  caught: "caught by the existing tests",
  ran_but_missed: "ran and was missed",
  never_ran: "not exercised: the tests never run it",
  cant_tell: "reach unknown",
  invalid: "not a valid change",
  inconclusive: "inconclusive"
};

/** The scope is always named. Only a whole-suite run may say the suite missed a fault. */
export function scopeWords(fullSuite: boolean): string {
  return fullSuite ? "missed by the whole suite" : "missed by the selected tests";
}

export interface CandidatesInput {
  target_record: unknown;
  proposals: ProposedFault[];
  cap: number;
  /** The person's own expected behavior and witness, used for every candidate when given. */
  person_oracle?: { oracle: unknown; witness_bytes: Buffer };
  /** The caller says a person approved the expected behaviors the candidates carry. */
  accept_supplied_approvals: boolean;
  run: Pick<ProbeFaultOptions, "fixture_bytes" | "tests" | "full_suite" | "source">;
}

export interface CandidatesSummary {
  offered: number;
  cap: number;
  refused: number;
  runs: number;
  /** Test runs up to and including the first fault the tests missed; null when none was. Refusals are not runs. */
  runs_to_first_hit: number | null;
  scope: "selected" | "full_suite";
  tried: CandidateTried[];
}

export type CandidatesResult =
  | { kind: "needs_approval"; candidate: number; files: ProposedOracleFiles }
  | { kind: "done"; chosen: ProbeFaultResult | null; summary: CandidatesSummary };

/** A candidate's own expected behavior: usable only when the caller accepts supplied approvals and it says who approved it. */
export function suppliedOracle(candidate: ProposedFault): { oracle: unknown; witness_bytes: Buffer; via: string } {
  const via = candidate.addon?.name ?? "add-on";
  // Marked as the add-on's draft by OrangePro itself, whatever the add-on wrote in that field.
  const oracle = typeof candidate.oracle === "object" && candidate.oracle !== null ? withDraftOrigin(candidate.oracle as Record<string, unknown>, { name: via, version: candidate.addon?.version ?? "unknown" }) : candidate.oracle;
  const checked = checkOracle(oracle);
  if (!checked.ok) throw new ProbeFaultRefusal("oracle_invalid", checked.message);
  // An unapproved one is refused by probe-fault itself (oracle_not_approved), before anything runs.
  return { oracle, witness_bytes: Buffer.from(candidate.witness_source ?? "", "utf8"), via };
}

/** What a finished run says about its fault, in the four outcome words plus the two no-claim ones. */
export function outcomeOf(result: ProbeFaultResult): CandidateTried["outcome"] {
  const c = result.classification;
  if (c.classification === "caught_by_existing") return "caught";
  if (c.classification === "survived_unverified") {
    return c.reached_by_selected_tests === "reached" ? "ran_but_missed" : c.reached_by_selected_tests === "not_reached" ? "never_ran" : "cant_tell";
  }
  return c.classification === "invalid_mutation" ? "invalid" : "inconclusive";
}

export function opProbeCandidates(root: string, input: CandidatesInput, deps: ProbeFaultDeps): CandidatesResult {
  const { proposals, cap } = input;
  const limit = Math.min(cap, proposals.length);
  const tried: CandidateTried[] = [];
  let refused = 0;
  let runs = 0;
  let chosen: ProbeFaultResult | null = null;
  for (let i = 0; i < limit && !chosen; i++) {
    const candidate = proposals[i]!;
    try {
      let oracle: unknown;
      let witness: Buffer;
      let via: string | null = null;
      if (input.person_oracle) {
        oracle = input.person_oracle.oracle;
        witness = input.person_oracle.witness_bytes;
      } else if (candidate.oracle !== undefined) {
        if (!input.accept_supplied_approvals) {
          // Nothing runs on an expected behavior no person is said to have approved.
          const files = runs === 0 && refused === 0 ? writeProposedOracle(root, workspacePaths(root).dir, input.target_record, candidate) : null;
          if (files) return { kind: "needs_approval", candidate: i + 1, files };
          throw new ProbeFaultRefusal("oracle_invalid", "the candidate's expected behavior needs a person's approval.");
        }
        const supplied = suppliedOracle(candidate);
        oracle = supplied.oracle;
        witness = supplied.witness_bytes;
        via = supplied.via;
      } else {
        throw new ProbeFaultRefusal("oracle_invalid", "the candidate carries no expected behavior and no --oracle was given.");
      }
      const run = opProbeFault(
        root,
        {
          target_record: input.target_record,
          fault: candidate.fault,
          ...(candidate.edit ? { fault_edit: candidate.edit } : {}),
          oracle,
          witness_bytes: witness,
          ...input.run,
          rationale: candidate.reason,
          ...(candidate.addon ? { addon: candidate.addon } : {}),
          candidates: { offered: proposals.length, cap, index: i + 1, earlier: [...tried], refused, runs: runs + 1 },
          ...(via ? { supplied_approval: { via } } : {})
        },
        deps
      );
      runs += 1;
      const outcome = outcomeOf(run);
      const c = run.classification;
      tried.push({ index: i + 1, outcome, detail: `${c.classification}${c.reason ? `: ${c.reason}` : ""}`, run_id: run.run_id });
      if (outcome === "ran_but_missed") chosen = run;
    } catch (e) {
      if (!(e instanceof ProofRefusalError || e instanceof ProbeFaultRefusal)) throw e;
      refused += 1;
      tried.push({ index: i + 1, outcome: "refused", detail: e.code });
    }
  }
  return {
    kind: "done",
    chosen,
    summary: { offered: proposals.length, cap, refused, runs, runs_to_first_hit: chosen ? runs : null, scope: input.run.full_suite ? "full_suite" : "selected", tried }
  };
}

export function renderCandidates(result: Extract<CandidatesResult, { kind: "done" }>): string[] {
  const { summary, chosen } = result;
  const words = scopeWords(summary.scope === "full_suite");
  const lines = summary.tried.map((t) => `  candidate ${t.index}: ${CANDIDATE_WORDS[t.outcome]} (${t.detail})`);
  const counts = `${summary.refused} refused, ${summary.runs} test run${summary.runs === 1 ? "" : "s"}`;
  lines.push(
    chosen
      ? `Candidate ${summary.tried[summary.tried.length - 1]!.index} of ${summary.offered} is ${words}: ${counts} to the first hit (cap ${summary.cap}).`
      : `No claim: none of the ${summary.tried.length} candidates tried was ${words} (${counts}; cap ${summary.cap}, ${summary.offered} offered).`
  );
  return lines;
}
