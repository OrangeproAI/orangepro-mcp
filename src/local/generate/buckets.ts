/**
 * Lightweight LOCAL bucket strategy for generation diversity.
 *
 * Public/local only: these categories, heuristics, and slot preferences are the
 * proof kit's own. They intentionally do NOT replicate the hosted platform's
 * bucket orchestration, caps, taxonomy, or prompt internals. Selection is pure
 * and evidence-gated — buckets with no supporting evidence are skipped, never
 * padded with generic tests.
 */
import { LocalBucket } from "../graph/ontology.js";

export const LOCAL_BUCKETS: readonly LocalBucket[] = [
  "happy_path",
  "validation_error",
  "edge_case",
  "integration_flow",
  "security_privacy",
  "regression"
];

export const BUCKET_LABEL: Record<LocalBucket, string> = {
  happy_path: "happy path",
  validation_error: "validation error",
  edge_case: "edge case",
  integration_flow: "integration flow",
  security_privacy: "security / privacy",
  regression: "regression"
};

/** Per-bucket evidence verdicts. happy_path is gated on "is this testable at all". */
export interface BucketSignals {
  hasExpectedBehavior: boolean;
  hasValidationEvidence: boolean;
  hasEdgeEvidence: boolean;
  hasIntegrationEvidence: boolean;
  hasSecurityEvidence: boolean;
  hasRegressionEvidence: boolean;
}

const SIGNAL_OF: Record<LocalBucket, keyof BucketSignals> = {
  happy_path: "hasExpectedBehavior",
  validation_error: "hasValidationEvidence",
  edge_case: "hasEdgeEvidence",
  integration_flow: "hasIntegrationEvidence",
  security_privacy: "hasSecurityEvidence",
  regression: "hasRegressionEvidence"
};

/**
 * Ordered "slots" per total-test budget. Each slot is a small preference list;
 * the first evidence-justified, not-yet-chosen bucket in a slot fills it. A slot
 * with no justified candidate is skipped (no padding). Caps match the existing
 * generation limits (default 3, max 5).
 */
const SLOTS_BY_LIMIT: Record<number, LocalBucket[][]> = {
  1: [["happy_path"]],
  2: [["happy_path"], ["validation_error", "edge_case"]],
  3: [["happy_path"], ["validation_error", "edge_case"], ["integration_flow", "regression"]],
  4: [["happy_path"], ["validation_error"], ["edge_case"], ["integration_flow"]],
  5: [["happy_path"], ["validation_error"], ["edge_case"], ["integration_flow"], ["security_privacy", "regression"]]
};

/**
 * Choose up to `limit` local buckets, in priority order, that are justified by
 * the evidence signals. Pure and deterministic. Never pads unjustified buckets.
 */
export function selectLocalBuckets(signals: BucketSignals, limit: number): LocalBucket[] {
  const L = Math.max(1, Math.min(5, Math.floor(limit) || 1));
  const slots = SLOTS_BY_LIMIT[L];
  const chosen: LocalBucket[] = [];
  for (const slot of slots) {
    for (const bucket of slot) {
      if (chosen.includes(bucket)) continue;
      if (signals[SIGNAL_OF[bucket]]) {
        chosen.push(bucket);
        break;
      }
    }
  }
  return chosen;
}

/** Structured evidence used to derive bucket signals from a behavior's context. */
export interface BucketEvidence {
  /** Combined, lowercased evidence text (title, AC, workflow, code refs, weak notes). */
  corpus: string;
  /** Distinct related code files linked to the behavior. */
  relatedFiles: number;
  /** Number of explicit workflow steps. */
  workflowSteps: number;
  /** Observed/related test names (existing coverage signal). */
  testNames: number;
  /** Whether there is enough evidence to assert expected successful behavior. */
  hasTestableAnchor: boolean;
  /** Whether the behavior anchor was inferred from existing tests. */
  inferredFromTests: boolean;
}

const VALIDATION_RE =
  /\b(invalid|errors?|required|reject(ed|s)?|validation|validate|forbidden|not allowed|unauthorized|400|422|constraint|missing (field|value|required)|bad request|must not)\b/;
const EDGE_RE =
  /\b(limits?|empty|nulls?|nullable|boundary|missing data|concurren\w*|stale|retr(y|ies)|timeouts?|edge[\s-]?cases?|maximum|minimum|overflow|underflow|zero|negative|out of range|race condition|duplicate)\b/;
const INTEGRATION_RE =
  /\b(routes?|endpoints?|api|https?|requests?|responses?|services?|workflows?|flows?|integration|fetch|client|navigat\w*|pages?|screens?|redirect|webhooks?|pipeline|composable|store)\b/;
const SECURITY_RE =
  /\b(auth\w*|permissions?|tokens?|secrets?|pii|privacy|sessions?|invites?|oauth|api[\s-]?keys?|roles?|access control|login|logout|passwords?|credentials?|csrf|xss|encrypt\w*)\b/;
const REGRESSION_RE =
  /\b(regressions?|bugs?|incidents?|fixed|broke(n)?|known issue|changelog|hotfix|defects?|reproduc\w*)\b/;

/** Derive bucket signals from a behavior's evidence. Pure. */
export function deriveBucketSignals(e: BucketEvidence): BucketSignals {
  return {
    hasExpectedBehavior: e.hasTestableAnchor,
    hasValidationEvidence: VALIDATION_RE.test(e.corpus),
    hasEdgeEvidence: EDGE_RE.test(e.corpus),
    hasIntegrationEvidence: INTEGRATION_RE.test(e.corpus) || e.relatedFiles >= 2 || e.workflowSteps > 0,
    hasSecurityEvidence: SECURITY_RE.test(e.corpus),
    hasRegressionEvidence: REGRESSION_RE.test(e.corpus) || e.testNames > 0 || e.inferredFromTests
  };
}
