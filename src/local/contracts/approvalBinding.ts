import { recordSha256 } from "./io.js";
import type { TargetRecord } from "./targetRecord.js";

// A person approves what a function should do, on its exact bytes. Where it ranks among other functions
// is not part of that: any analysis improvement can move it. An approval names the whole target record's
// hash, so the check below recomputes that hash with only the rank replaced. Every other field (the
// function's bytes and hash, the file's hash, the commits, the changed blocks, the reason) must be as
// approved, and any change to the function's code voids the approval.

/** The highest rank tried. A record ranked beyond it simply does not match, which refuses. */
const MAX_RANK = 100_000;

export interface ApprovalMatch {
  rank_at_approval: number | null;
  current_rank: number | null;
}

export function approvalMatch(current: TargetRecord, approvedSha256: string): ApprovalMatch | null {
  const current_rank = current.selection.rank;
  if (recordSha256(current) === approvedSha256) return { rank_at_approval: current_rank, current_rank };
  const withRank = (rank: number | null): string => recordSha256({ ...current, selection: { ...current.selection, rank } });
  if (withRank(null) === approvedSha256) return { rank_at_approval: null, current_rank };
  for (let rank = 1; rank <= MAX_RANK; rank++) {
    if (withRank(rank) === approvedSha256) return { rank_at_approval: rank, current_rank };
  }
  return null;
}
