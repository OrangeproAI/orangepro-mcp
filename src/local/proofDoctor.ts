/**
 * G1 — `opro doctor --proof`: explain WHY top targets are not Dynamically Proven.
 *
 * Read-only diagnostics over already-produced, already-redacted data:
 *   - `.orangepro/proof-attempts.json` — a distilled sidecar of the last run's
 *     auto-prove attempt classifications (written by opStart AFTER autoProve
 *     returns; autoProve itself and the proof oracle are untouched).
 *   - the graph + ledger via the CANONICAL judge (buildRtm) for proven counts —
 *     this module never re-derives or re-scores proof.
 *
 * Trust invariants (load-bearing):
 *   - Mints nothing, mutates no ledger, never writes on the doctor path.
 *   - Reasons are the upstream single-line redacted summaries; re-redacted at
 *     sidecar-write time as belt-and-braces. No raw stderr/stdout, ever.
 *   - A survived mutant is a proven NEGATIVE ("not proven, possibly equivalent"),
 *     never blamed on the user and never nudged toward weakening a test.
 *   - Stale sidecar (graph re-analyzed / git moved since) ⇒ fail closed: reasons
 *     are labeled stale and the headline says re-run, never presented as current.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { workspacePaths } from "./workspace.js";
import { redactSecrets } from "./util/redact.js";
import { targetLanguage } from "./ledger.js";
import { readEnginesNode, satisfiesNodeRange, type BaselineCategory } from "./proofRunnability.js";
import type { LocalGraph } from "./graph/ontology.js";
import type { RtmResult } from "./rtm.js";

export const PROOF_ATTEMPTS_SCHEMA_VERSION = "orangepro.proof_attempts.v1";
export const PROOF_ATTEMPTS_FILE = "proof-attempts.json";
export const PROOF_DOCTOR_SCHEMA_VERSION = "orangepro.proof_doctor.v1";

/** Languages with a shipped dynamic-proof profile. Everything else is honest "not yet". */
const PROVABLE_LANGUAGES = new Set(["typescript", "javascript", "go", "java", "python"]);

/** Distilled per-target attempt outcome (metadata only; reason is redacted upstream + here). */
export interface ProofAttemptRecord {
  target_symbol: string;
  test_path?: string;
  classification: "proven" | "non_killing" | "needs_setup" | "gen_failed";
  /** Oracle outcome detail — distinguishes a SURVIVED mutant (test passed) from
   *  a NON-ASSERTION failure (mutant crashed the test before any assertion).
   *  The two are opposite diagnoses with opposite remediations. */
  mutant_status?: string;
  category?: string;
  reason?: string;
  deduped?: boolean;
  language: string;
}

export interface ProofAttemptsFile {
  schema_version: string;
  generated_at: string;
  /** Freshness anchors: the graph this run proved against. */
  graph_generated_at: string | null;
  git_commit: string | null;
  git_dirty: boolean | null;
  attempted: number;
  proven: number;
  attempts: ProofAttemptRecord[];
  skipped: Array<{ target_symbol?: string; title: string; reason: string }>;
}

/** Doctor-level blocker categories = R-1 baseline categories + derived setup causes. */
export type ProofBlockerCategory =
  | Exclude<BaselineCategory, "logic_failure" | "unknown">
  | "runner_missing"
  | "module_root_missing"
  | "assertion_binding"
  | "unsupported_language"
  | "setup_failed";

interface BlockerGuide {
  label: string;
  next_step: string;
}

/**
 * One label + one smallest-next-step per category. Copy discipline: honest
 * pointers only — never nudge toward weakening a test, never call a test bad.
 */
export const PROOF_BLOCKER_GUIDE: Record<ProofBlockerCategory, BlockerGuide> = {
  module_not_found: {
    label: "a module or dependency is missing in the proof sandbox",
    next_step: "Install the package's dependencies (npm ci / go mod download / pip install) so imports resolve, then re-run `opro start`."
  },
  tsconfig_missing: {
    label: "the package extends a monorepo tsconfig the sandbox cannot resolve",
    next_step: "Run `opro start` from the monorepo root so parent tsconfigs are mirrored into the proof sandbox."
  },
  experimental_builtin: {
    label: "the target needs an experimental Node builtin runtime flag",
    next_step: "Re-run with the flag named in the attempt reason (e.g. NODE_OPTIONS=--experimental-sqlite) or a Node version where the builtin is stable."
  },
  engine_mismatch: {
    label: "the runner Node is outside the package's declared engines range",
    next_step: "Switch Node versions (e.g. `nvm use`) to satisfy engines.node, then re-run `opro start`."
  },
  db_or_external: {
    label: "the test needs a database or external service the sandbox lacks",
    next_step: "Provide the service locally (or a test double) via `orangepro_prove_loop` setup_commands, then re-run."
  },
  runner_missing: {
    label: "no supported test runner is available for the target's package",
    next_step: "Install the package's test framework (vitest / jest / mocha; go, mvn, pytest on PATH), then re-run `opro start`."
  },
  module_root_missing: {
    label: "no module root (go.mod / pom.xml / build.gradle) was found under the analyzed path",
    next_step: "Run `opro start` from the module root that owns this target (the directory containing go.mod / pom.xml)."
  },
  assertion_binding: {
    label: "the proof could not bind exactly one test to the target (ambiguous test identity)",
    next_step: "Give the covering test a unique title/name so the oracle can bind exactly one test to the mutant; ambiguity fails closed."
  },
  unsupported_language: {
    label: "no dynamic-proof profile exists for this language yet",
    next_step: "TS/JS, Go, Java and Python are dynamically provable today; other languages stay honestly in their static tiers."
  },
  setup_failed: {
    label: "proof setup failed before the oracle could run",
    next_step: "Read the attempt reason, fix the named setup step, then re-run `opro start`."
  }
};

/** Wording is load-bearing: a survivor is a proven negative, never a user failure. */
export const NON_KILLING_NOTE =
  "Not proven: the test still passed while the target was mutated (possibly an equivalent mutation). " +
  "The mutant surviving is a proven negative about assertion strength — it is never counted as Dynamically Proven.";

/** Opposite failure mode: the mutant DID make the test fail, but via a runtime
 *  crash rather than a trusted assertion. The test exercises the target; the
 *  proof standard (assertion failure) was not met. Misreporting this as
 *  "mutant survived" sends users to fix the wrong thing. */
export const NON_ASSERTION_NOTE =
  "Not proven: the mutant made the test FAIL, but with a runtime error instead of a trusted assertion failure. " +
  "The test does exercise the target; strengthen the assertion to check the target's returned value directly, or re-run — " +
  "whether the crash or the assertion is hit first can vary between runs.";

export function nonKillingNoteFor(mutantStatus?: string): string {
  return mutantStatus === "associated_non_assertion_failure" ? NON_ASSERTION_NOTE : NON_KILLING_NOTE;
}

export interface ProofDoctorBlocker {
  category: ProofBlockerCategory;
  label: string;
  count: number;
  /** Up to 5 blocked target symbols (dedup shows breadth without dumping everything). */
  targets: string[];
  representative: { target_symbol: string; test_path?: string; reason?: string };
  next_step: string;
  /** "attempt" = from the last run's recorded attempts; "preflight" = cheap static check, no test was run. */
  source: "attempt" | "preflight";
}

export interface ProofDoctorResult {
  schema_version: string;
  /**
   * proven  — RTM says ≥1 behavior is Dynamically Proven.
   * blocked — 0 proven and we have current blocker evidence.
   * stale   — attempt data predates the current graph/commit; re-run for current reasons.
   * no_data — no attempt sidecar and nothing to preflight.
   */
  status: "proven" | "blocked" | "stale" | "no_data";
  /** Canonical counts, read verbatim from buildRtm's summary — never recomputed here. */
  proven: number;
  denominator: number;
  attempted: number | null;
  stale: boolean;
  headline: string;
  blockers: ProofDoctorBlocker[];
  non_killing: Array<{ target_symbol: string; test_path?: string; mutant_status?: string; note: string }>;
  generated_at: string | null;
}

export function proofAttemptsPath(root: string): string {
  return join(workspacePaths(root).dir, PROOF_ATTEMPTS_FILE);
}

/** Structural view of AutoProveResult — kept structural so this module never imports autoProve. */
interface AutoProveLike {
  attempted: number;
  proven: number;
  attempts: Array<{
    target_symbol: string;
    test_path: string;
    classification: "proven" | "non_killing" | "needs_setup" | "gen_failed";
    mutant_status?: string;
    reason?: string;
    category?: string;
    deduped?: boolean;
  }>;
  skipped: Array<{ target_symbol?: string; title: string; reason: string }>;
}

/**
 * Distill an AutoProveResult into the persistable sidecar. Reasons arrive
 * already redacted (autoProve/classifyBaselineFailure discipline); redactSecrets
 * is applied again here so the WRITER enforces the no-secrets guarantee even if
 * an upstream path regresses.
 */
export function distillProofAttempts(
  auto: AutoProveLike,
  meta: { generatedAt: string; graph: LocalGraph }
): ProofAttemptsFile {
  const manifest = meta.graph.manifest;
  return {
    schema_version: PROOF_ATTEMPTS_SCHEMA_VERSION,
    generated_at: meta.generatedAt,
    graph_generated_at: manifest?.generated_at ?? null,
    git_commit: manifest?.git?.commit ?? null,
    git_dirty: manifest?.git?.dirty ?? null,
    attempted: auto.attempted,
    proven: auto.proven,
    attempts: auto.attempts.map((a) => ({
      target_symbol: a.target_symbol,
      test_path: a.test_path || undefined,
      classification: a.classification,
      mutant_status: a.mutant_status,
      category: a.category,
      reason: a.reason ? redactSecrets(a.reason) : undefined,
      deduped: a.deduped,
      language: targetLanguage(a.target_symbol)
    })),
    skipped: auto.skipped.map((s) => ({
      target_symbol: s.target_symbol,
      title: s.title,
      reason: redactSecrets(s.reason)
    }))
  };
}

export function writeProofAttempts(root: string, file: ProofAttemptsFile): string {
  const path = proofAttemptsPath(root);
  writeFileSync(path, JSON.stringify(file, null, 2) + "\n", "utf8");
  return path;
}

/** True when the sidecar anchors to the CURRENT graph generation + commit. */
export function proofAttemptsFresh(attempts: ProofAttemptsFile, graph: LocalGraph): boolean {
  const manifest = graph.manifest;
  return (
    attempts.graph_generated_at === (manifest?.generated_at ?? null) &&
    attempts.git_commit === (manifest?.git?.commit ?? null)
  );
}

export function loadProofAttempts(root: string): ProofAttemptsFile | null {
  const path = proofAttemptsPath(root);
  if (!existsSync(path)) return null;
  // Fail closed on ANY unreadable sidecar — malformed JSON, wrong schema, or a
  // non-object shape. Unreadable evidence is no evidence; doctor must never crash.
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const file = parsed as ProofAttemptsFile;
  if (file.schema_version !== PROOF_ATTEMPTS_SCHEMA_VERSION) return null;
  if (!Array.isArray(file.attempts) || !Array.isArray(file.skipped)) return null;
  return file;
}

/**
 * Map one recorded attempt to a doctor blocker category. Uses the R-1 category
 * when present; otherwise a CONSERVATIVE pattern match on the (redacted) reason.
 * Anything unrecognized stays "setup_failed" — never guess a specific cause.
 */
export function blockerCategoryFor(attempt: { category?: string; reason?: string }): ProofBlockerCategory {
  const reason = attempt.reason ?? "";
  if (/runner binary not found|unsupported or unknown test runner/i.test(reason)) return "runner_missing";
  if (/no go\.mod found|no pom\.xml|no maven or gradle|build\.gradle/i.test(reason)) return "module_root_missing";
  if (/ambiguous|appears more than once|uniquely passed|not uniquely/i.test(reason)) return "assertion_binding";
  const cat = attempt.category as ProofBlockerCategory | undefined;
  if (cat && cat in PROOF_BLOCKER_GUIDE) return cat;
  return "setup_failed";
}

interface PreflightIo {
  /** existsSync-shaped probe, injectable for tests. */
  exists(path: string): boolean;
  /** Runner's Node version (process.version). */
  nodeVersion: string;
}

/**
 * Cheap static preflight for targets with NO attempt record: names blockers
 * WITHOUT running any test. Checks are deliberately few and certain:
 * unsupported language, missing go/java module root, engines mismatch.
 */
function preflightBlockers(
  rtm: RtmResult,
  root: string,
  io: PreflightIo,
  limit: number
): ProofDoctorBlocker[] {
  const rows = rtm.rows.filter((r) => r.evidence_tier !== "proven" && r.code_symbol.startsWith("sym:")).slice(0, limit);
  const found: Array<{ category: ProofBlockerCategory; target: string; test_path?: string }> = [];
  for (const row of rows) {
    const lang = targetLanguage(row.code_symbol);
    const fileRel = row.code_symbol.match(/^sym:(.+)#/)?.[1] ?? "";
    if (!PROVABLE_LANGUAGES.has(lang)) {
      found.push({ category: "unsupported_language", target: row.code_symbol });
      continue;
    }
    if (lang === "go" || lang === "java") {
      const markers = lang === "go" ? ["go.mod"] : ["pom.xml", "build.gradle", "build.gradle.kts"];
      if (!nearestMarker(root, fileRel, markers, io)) {
        found.push({ category: "module_root_missing", target: row.code_symbol });
        continue;
      }
    }
    if (lang === "typescript" || lang === "javascript") {
      const range = readEnginesNode(root, fileRel);
      if (range && satisfiesNodeRange(io.nodeVersion, range) === false) {
        found.push({ category: "engine_mismatch", target: row.code_symbol });
      }
    }
  }
  return groupBlockers(
    found.map((f) => ({
      target_symbol: f.target,
      test_path: undefined,
      category: f.category,
      reason: undefined
    })),
    "preflight"
  );
}

/** Walk from the target file's dir UP to root (inclusive) looking for a marker file. */
function nearestMarker(root: string, fileRel: string, markers: string[], io: PreflightIo): boolean {
  let dir = join(root, dirname(fileRel));
  const stop = root;
  for (;;) {
    for (const m of markers) if (io.exists(join(dir, m))) return true;
    if (dir === stop) return false;
    const parent = dirname(dir);
    if (parent === dir || !parent.startsWith(stop)) return false;
    dir = parent;
  }
}

function groupBlockers(
  blocked: Array<{ target_symbol: string; test_path?: string; category?: string; reason?: string }>,
  source: "attempt" | "preflight"
): ProofDoctorBlocker[] {
  const groups = new Map<ProofBlockerCategory, ProofDoctorBlocker>();
  for (const b of blocked) {
    const category = source === "preflight" && b.category && b.category in PROOF_BLOCKER_GUIDE
      ? (b.category as ProofBlockerCategory)
      : blockerCategoryFor(b);
    const guide = PROOF_BLOCKER_GUIDE[category];
    const existing = groups.get(category);
    if (existing) {
      existing.count += 1;
      if (existing.targets.length < 5) existing.targets.push(b.target_symbol);
    } else {
      groups.set(category, {
        category,
        label: guide.label,
        count: 1,
        targets: [b.target_symbol],
        representative: { target_symbol: b.target_symbol, test_path: b.test_path, reason: b.reason },
        next_step: guide.next_step,
        source
      });
    }
  }
  return [...groups.values()].sort((a, b) => b.count - a.count);
}

export interface ProofDoctorOptions {
  /** Preflight scan cap for unattempted targets. */
  preflightLimit?: number;
  /** Injectable for tests; defaults to real fs + process.version. */
  io?: PreflightIo;
}

/**
 * Pure assembly: graph + canonical RTM result + optional attempts sidecar →
 * deduped blocker report. Never writes; never mints; never recomputes proof.
 */
export function buildProofDoctor(
  graph: LocalGraph,
  rtm: RtmResult,
  attempts: ProofAttemptsFile | null,
  opts: ProofDoctorOptions = {}
): ProofDoctorResult {
  const io: PreflightIo = opts.io ?? { exists: existsSync, nodeVersion: process.version };
  const proven = rtm.summary.proven;
  const denominator = rtm.summary.total;

  // Freshness: the sidecar must anchor to the CURRENT graph generation + commit.
  const stale = Boolean(attempts && !proofAttemptsFresh(attempts, graph));

  const currentAttempts = attempts && !stale ? attempts : null;
  const blocked = (currentAttempts?.attempts ?? []).filter((a) => a.classification === "needs_setup");
  const survivors = (currentAttempts?.attempts ?? []).filter((a) => a.classification === "non_killing");

  let blockers = groupBlockers(blocked, "attempt");
  if (blockers.length === 0 && !currentAttempts) {
    blockers = preflightBlockers(rtm, graph.workspace?.root ?? "", io, opts.preflightLimit ?? 10);
  }

  // Dedupe identical (target, test) survivor pairs — repeat attempts add noise,
  // not information. Attribution stays exact: one row per target+test pair.
  const seenSurvivors = new Set<string>();
  const non_killing: ProofDoctorResult["non_killing"] = [];
  for (const a of survivors) {
    const key = `${a.target_symbol}\u0000${a.test_path ?? ""}`;
    if (seenSurvivors.has(key)) continue;
    seenSurvivors.add(key);
    non_killing.push({ target_symbol: a.target_symbol, test_path: a.test_path, mutant_status: a.mutant_status, note: nonKillingNoteFor(a.mutant_status) });
  }

  let status: ProofDoctorResult["status"];
  let headline: string;
  if (stale) {
    status = "stale";
    headline =
      "Proof-attempt data is stale (the graph or commit changed since the last run) — re-run `opro start` for current blocker reasons.";
  } else if (proven > 0) {
    status = "proven";
    headline = `${proven} of ${denominator} behaviors are Dynamically Proven (RTM). Blockers below explain the rest.`;
  } else if (blockers.length > 0) {
    const top = blockers[0];
    status = "blocked";
    headline =
      top.count > 1
        ? `0 Dynamically Proven — one root cause blocked ${top.count} target${top.count === 1 ? "" : "s"}: ${top.label}.`
        : `0 Dynamically Proven — top blocker: ${top.label}.`;
  } else if (non_killing.length > 0) {
    status = "blocked";
    headline = `0 Dynamically Proven — ${non_killing.length} attempt(s) ran but did not close (see non_killing for the per-target outcome).`;
  } else {
    status = "no_data";
    headline = "No proof-attempt data yet — run `opro start` to attempt dynamic proof and record blockers.";
  }

  return {
    schema_version: PROOF_DOCTOR_SCHEMA_VERSION,
    status,
    proven,
    denominator,
    attempted: currentAttempts?.attempted ?? null,
    stale,
    headline,
    blockers,
    non_killing,
    generated_at: attempts?.generated_at ?? null
  };
}
