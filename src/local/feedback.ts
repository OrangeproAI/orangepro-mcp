import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AnalysisMeta } from "./graph/ontology.js";

/**
 * Voluntary feedback links. OrangePro never sends anything itself: a link opens the
 * hosted form only when the user chooses it, and the form submits only on an explicit
 * Submit. Everything the link carries sits in the URL fragment (after `#`), which a
 * browser never sends to the server, so loading the form transmits nothing. The
 * fragment holds only the entry point, the user's preselected answer, and optional
 * coarse context the form includes only after a visible opt-in. It never holds a
 * repository name, path, symbol, finding text, email or identifier.
 */
export const FEEDBACK_SCHEMA_VERSION = 1;
export const DEFAULT_FEEDBACK_URL = "https://orangepro.ai/feedback";
export const DEFAULT_INVITATION_COOLDOWN_DAYS = 14;

export type FeedbackEntry = "result" | "blocked" | "finding";
export type FeedbackAnswer = "yes" | "partly" | "no" | "not_sure";
export type RunOutcome = "complete" | "incomplete" | "failed";
export const RUNNER_FAMILIES = ["pytest", "jest", "vitest", "mocha", "junit", "mixed", "other"] as const;
export type RunnerFamily = (typeof RUNNER_FAMILIES)[number];

export interface FeedbackContext {
  toolVersion?: string;
  runnerFamily?: RunnerFamily;
  runOutcome?: RunOutcome;
}

export interface FeedbackLinkOptions {
  entry: FeedbackEntry;
  /** `empty` marks a completed run with no findings. Only valid with entry `result`. */
  variant?: "empty";
  answer?: FeedbackAnswer;
  /** A generated test exists, so the form may ask how it was used. */
  patch?: boolean;
  context?: FeedbackContext;
}

type Env = Record<string, string | undefined>;

/** Base URL of the hosted form, or null when links are turned off (`ORANGEPRO_FEEDBACK_URL=off`). */
export function feedbackBaseUrl(env: Env = process.env): string | null {
  const raw = env.ORANGEPRO_FEEDBACK_URL?.trim();
  if (raw === undefined || raw === "") return DEFAULT_FEEDBACK_URL;
  if (/^(off|false|0|none)$/i.test(raw)) return null;
  try {
    const url = new URL(raw);
    if (url.protocol !== "https:" && url.protocol !== "http:") return DEFAULT_FEEDBACK_URL;
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return DEFAULT_FEEDBACK_URL;
  }
}

const VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]{1,32})?$/;

/** Build a feedback link. Returns null when feedback links are turned off. */
export function feedbackUrl(opts: FeedbackLinkOptions, env: Env = process.env): string | null {
  const base = feedbackBaseUrl(env);
  if (!base) return null;
  const params = new URLSearchParams();
  params.set("sv", String(FEEDBACK_SCHEMA_VERSION));
  params.set("entry", opts.entry);
  if (opts.entry === "result" && opts.variant === "empty") params.set("variant", "empty");
  if (opts.answer && opts.entry === "result") params.set("answer", opts.answer);
  if (opts.patch && opts.entry === "result" && opts.variant !== "empty") params.set("patch", "1");
  const ctx = opts.context;
  if (ctx?.toolVersion && VERSION_RE.test(ctx.toolVersion)) params.set("ctx_v", ctx.toolVersion);
  if (ctx?.runnerFamily && (RUNNER_FAMILIES as readonly string[]).includes(ctx.runnerFamily)) params.set("ctx_runner", ctx.runnerFamily);
  if (ctx?.runOutcome) params.set("ctx_outcome", ctx.runOutcome);
  return `${base}#${params.toString()}`;
}

const RUNNER_PATTERNS: Array<[Exclude<RunnerFamily, "mixed" | "other">, RegExp]> = [
  ["pytest", /\bpytest\b/i],
  ["vitest", /\bvitest\b/i],
  ["jest", /\bjest\b/i],
  ["mocha", /\bmocha\b/i],
  ["junit", /\bjunit\b/i]
];

/** Coarse runner family from the report's framework label (for example "jest, pytest"). */
export function runnerFamilyOf(frameworkLabel: string | undefined): RunnerFamily {
  const found = RUNNER_PATTERNS.filter(([, re]) => re.test(frameworkLabel ?? "")).map(([family]) => family);
  if (found.length === 1) return found[0];
  return found.length > 1 ? "mixed" : "other";
}

/** A run is incomplete when part of the repository was not analysed, or nothing was. */
export function runOutcomeOf(analysis: Partial<AnalysisMeta> | undefined, behaviorTotal: number): RunOutcome {
  if (behaviorTotal === 0) return "incomplete";
  if (!analysis) return "complete";
  if (analysis.files_cap_hit || analysis.symbol_cap_hit) return "incomplete";
  // Any "not_analyzed_*" marker means files were skipped (for example a time limit).
  if (Object.keys(analysis).some((key) => key.startsWith("not_analyzed") && Boolean((analysis as Record<string, unknown>)[key]))) return "incomplete";
  if ((analysis.tree_sitter?.downgraded ?? []).length > 0) return "incomplete";
  if (analysis.files_scanned === 0) return "incomplete";
  return "complete";
}

// ── Local invitation preferences. Stored only on this machine, never uploaded. ──

export interface FeedbackPrefs {
  /** "off" hides the expanded "Did this help?" invitation until turned back on. Links stay. */
  invitations?: "on" | "off";
  /** When the expanded invitation was last shown (ISO time). */
  last_invited_at?: string;
  cooldown_days?: number;
}

export function feedbackPrefsPath(env: Env = process.env): string {
  return env.ORANGEPRO_FEEDBACK_PREFS?.trim() || join(homedir(), ".orangepro", "feedback-prefs.json");
}

export function readFeedbackPrefs(env: Env = process.env): FeedbackPrefs {
  try {
    const parsed = JSON.parse(readFileSync(feedbackPrefsPath(env), "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    const p = parsed as Record<string, unknown>;
    return {
      ...(p.invitations === "on" || p.invitations === "off" ? { invitations: p.invitations } : {}),
      ...(typeof p.last_invited_at === "string" ? { last_invited_at: p.last_invited_at } : {}),
      ...(typeof p.cooldown_days === "number" && Number.isFinite(p.cooldown_days) && p.cooldown_days >= 0 ? { cooldown_days: p.cooldown_days } : {})
    };
  } catch {
    return {};
  }
}

export function writeFeedbackPrefs(prefs: FeedbackPrefs, env: Env = process.env): boolean {
  try {
    const path = feedbackPrefsPath(env);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, `${JSON.stringify(prefs, null, 2)}\n`);
    return true;
  } catch {
    return false;
  }
}

export function invitationCooldownDays(prefs: FeedbackPrefs, env: Env = process.env): number {
  const fromEnv = Number(env.ORANGEPRO_FEEDBACK_COOLDOWN_DAYS);
  if (env.ORANGEPRO_FEEDBACK_COOLDOWN_DAYS !== undefined && Number.isFinite(fromEnv) && fromEnv >= 0) return fromEnv;
  return prefs.cooldown_days ?? DEFAULT_INVITATION_COOLDOWN_DAYS;
}

/**
 * Decide whether this report shows the expanded "Did this help?" invitation, and
 * record the showing. It shows at most once per cooldown window, so repeated runs
 * and report refreshes stay quiet. If the preference file cannot be written, the
 * invitation is not shown: better silent than repeated.
 */
export function claimOutcomeInvitation(now: Date = new Date(), env: Env = process.env): boolean {
  if (feedbackBaseUrl(env) === null) return false;
  const prefs = readFeedbackPrefs(env);
  if (prefs.invitations === "off") return false;
  const last = prefs.last_invited_at ? Date.parse(prefs.last_invited_at) : NaN;
  const cooldownMs = invitationCooldownDays(prefs, env) * 24 * 60 * 60 * 1000;
  if (Number.isFinite(last) && now.getTime() - last < cooldownMs) return false;
  return writeFeedbackPrefs({ ...prefs, last_invited_at: now.toISOString() }, env);
}

export function setInvitations(state: "on" | "off", env: Env = process.env): boolean {
  const prefs = readFeedbackPrefs(env);
  return writeFeedbackPrefs({ ...prefs, invitations: state }, env);
}

// ── What a report shows. ──

export interface ReportFeedbackAnswer {
  label: string;
  url: string;
}

export interface ReportFeedback {
  /** Persistent footer link ("Give feedback"). */
  general: string;
  /** "This finding looks wrong" link; carries no information about the finding. */
  finding: string;
  prompt:
    | { kind: "result" | "empty"; expanded: boolean; question: string; answers: ReportFeedbackAnswer[] }
    | { kind: "blocked"; expanded: false; question: string; answers: ReportFeedbackAnswer[] };
}

export interface ReportFeedbackInput {
  frameworkLabel?: string;
  toolVersion?: string;
  analysis?: Partial<AnalysisMeta>;
  behaviorTotal: number;
  /** Number of ranked findings shown (priority gaps plus delete paths). */
  findings: number;
  /** A generated test exists. */
  hasPatch: boolean;
  /**
   * Show the expanded invitation. A function is called only when the run completed,
   * so a blocked run never uses up the invitation (usually claimOutcomeInvitation).
   */
  invite: boolean | (() => boolean);
}

/** Feedback links for one report, or undefined when links are turned off. */
export function reportFeedback(input: ReportFeedbackInput, env: Env = process.env): ReportFeedback | undefined {
  if (feedbackBaseUrl(env) === null) return undefined;
  const runOutcome = runOutcomeOf(input.analysis, input.behaviorTotal);
  const context: FeedbackContext = { toolVersion: input.toolVersion, runnerFamily: runnerFamilyOf(input.frameworkLabel), runOutcome };
  const link = (opts: FeedbackLinkOptions): string => feedbackUrl({ ...opts, context }, env)!;
  if (runOutcome !== "complete") {
    const blocked = link({ entry: "blocked" });
    const state = input.behaviorTotal === 0 ? "No code was found to analyse." : "Part of the repository was not analysed.";
    return {
      general: blocked,
      finding: link({ entry: "finding" }),
      prompt: { kind: "blocked", expanded: false, question: `${state} What stopped you from completing this?`, answers: [{ label: "Tell us", url: blocked }] }
    };
  }
  const general = link({ entry: "result", patch: input.hasPatch });
  const expanded = typeof input.invite === "function" ? input.invite() : input.invite;
  if (input.findings === 0) {
    return {
      general,
      finding: link({ entry: "finding" }),
      prompt: {
        kind: "empty",
        expanded,
        question: "Expected a gap we didn't find?",
        answers: [
          { label: "Yes", url: link({ entry: "result", variant: "empty", answer: "yes" }) },
          { label: "No", url: link({ entry: "result", variant: "empty", answer: "no" }) },
          { label: "Not sure", url: link({ entry: "result", variant: "empty", answer: "not_sure" }) }
        ]
      }
    };
  }
  return {
    general,
    finding: link({ entry: "finding" }),
    prompt: {
      kind: "result",
      expanded,
      question: "Did this help you decide what to test?",
      answers: [
        { label: "Yes", url: link({ entry: "result", answer: "yes", patch: input.hasPatch }) },
        { label: "Partly", url: link({ entry: "result", answer: "partly", patch: input.hasPatch }) },
        { label: "No", url: link({ entry: "result", answer: "no", patch: input.hasPatch }) }
      ]
    }
  };
}
