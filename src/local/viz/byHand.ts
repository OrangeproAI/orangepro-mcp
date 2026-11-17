/**
 * Item 48: the summary report's "By hand" line. It counts only what one `opro start` run
 * produced, from that run's own outputs, and puts a rough engineer-time figure on it.
 *
 * Every count has one source:
 * - tests written and passing: proof attempts on a test OrangePro wrote this run whose original-code
 *   run passed (proven or not catching the fault);
 * - drafts to finish: the drafting step's drafts (never run, in any mode), plus written tests that did
 *   not pass;
 * - functions proven: distinct functions with a proven attempt this run;
 * - tests found that don't catch a break: attempts on a test found in the repository whose mutant
 *   survived (never a time-out, a set-up failure or an inconclusive run).
 *
 * A record without `test_source` is read as "found", so the line never credits work it cannot show.
 * Static-only runs run nothing: nothing counts as written and passing or as proven.
 */

/** Minutes per item, by hand (owner, 16 Nov). */
export const BY_HAND_MINUTES = { written: 10, drafts: 5, proven: 5, weak: 15 } as const;

/** One proof attempt, as `opro start` holds it (the fields this line reads). */
export interface ByHandAttempt {
  target_symbol: string;
  test_path?: string;
  test_source?: "written" | "found";
  classification: string;
  mutant_status?: string;
  deduped?: boolean;
}

/** What `opro start` hands its last report write. */
export interface ByHandRun {
  attempts: ByHandAttempt[];
  /** The drafting step's new drafts this run (`start_generation.generated`). */
  drafts: number;
  staticOnly: boolean;
}

export interface ReportByHand {
  /** Null on reports another command wrote: only the "Not counted" line shows. */
  run: { written: number; drafts: number; proven: number; weak: number; minutes: number; staticOnly: boolean } | null;
  notCounted: { functions: number; testFiles: number };
}

export function byHandCounts(run: ByHandRun): NonNullable<ReportByHand["run"]> {
  const attempts = run.attempts.filter((a) => !a.deduped);
  const isWritten = (a: ByHandAttempt): boolean => a.test_source === "written";
  const passed = (a: ByHandAttempt): boolean => a.classification === "proven" || a.classification === "non_killing";
  const written = run.staticOnly ? 0 : attempts.filter((a) => isWritten(a) && passed(a)).length;
  const writtenNotPassing = attempts.filter((a) => isWritten(a) && !passed(a)).length;
  const drafts = Math.max(0, run.drafts) + writtenNotPassing;
  const proven = run.staticOnly ? 0 : new Set(attempts.filter((a) => a.classification === "proven").map((a) => a.target_symbol)).size;
  const weak = new Set(
    attempts
      .filter((a) => !isWritten(a) && a.classification === "non_killing" && a.mutant_status === "associated_survived")
      .map((a) => `${a.target_symbol}\u0000${a.test_path ?? ""}`)
  ).size;
  const minutes = written * BY_HAND_MINUTES.written + drafts * BY_HAND_MINUTES.drafts + proven * BY_HAND_MINUTES.proven + weak * BY_HAND_MINUTES.weak;
  return { written, drafts, proven, weak, minutes, staticOnly: run.staticOnly };
}

/** Hours to one decimal place, never 0.0 when there is something to count. */
export function byHandHours(minutes: number): string {
  if (minutes <= 0) return "0";
  return (Math.max(1, Math.round(minutes / 6)) / 10).toFixed(1);
}

function count(n: number, one: string, many: string): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

function listWithAnd(items: string[]): string {
  return items.length <= 1 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`;
}

export const BY_HAND_SOURCES =
  "Estimates from published studies of developers writing tests (Fraser et al. 2015; Petrović et al. 2018; Schuler & Zeller 2013); tests that go through a real request usually take longer.";

/**
 * The block's sentences, in order. Zero items are left out; with nothing to count, only the
 * "Not counted" sentence. `noun` is the report's own (functions, or the model's noun).
 */
export function byHandSentences(byHand: ReportByHand, noun: { singular: string; plural: string }): string[] {
  const r = byHand.run;
  const items: Array<{ text: string; per: string; minutes: number }> = [];
  if (r) {
    if (r.written > 0) items.push({ text: count(r.written, "test written and passing", "tests written and passing"), per: "test written and passing", minutes: BY_HAND_MINUTES.written });
    if (r.drafts > 0) items.push({ text: count(r.drafts, "draft to finish", "drafts to finish"), per: "draft to finish", minutes: BY_HAND_MINUTES.drafts });
    if (r.proven > 0) items.push({ text: `${count(r.proven, noun.singular, noun.plural)} proven`, per: `${noun.singular} proven`, minutes: BY_HAND_MINUTES.proven });
    if (r.weak > 0) items.push({ text: count(r.weak, "test found that doesn't catch a break", "tests found that don't catch a break"), per: "test found that doesn't catch a break", minutes: BY_HAND_MINUTES.weak });
  }
  const notCounted = `Not counted: mapping ${count(byHand.notCounted.functions, noun.singular, noun.plural)} to ${count(byHand.notCounted.testFiles, "test file", "test files")} and ranking them.`;
  if (!r || items.length === 0) return [notCounted];
  const assumes = listWithAnd(items.map((it, i) => (i === 0 ? `${it.minutes} minutes per ${it.per}` : `${it.minutes} per ${it.per}`)));
  return [
    `Done by this run: ${items.map((it) => it.text).join(", ")}. By hand, about ${byHandHours(r.minutes)} engineer-hours.`,
    `Assumes ${assumes}.`,
    BY_HAND_SOURCES,
    notCounted
  ];
}
