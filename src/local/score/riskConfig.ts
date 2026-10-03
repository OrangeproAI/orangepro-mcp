// Per-repo risk configuration — the ONLY levers a repo can pull on scoring.
//
// Design rule (see docs): classification and a handful of tuning switches are
// configurable; evidence tiers, the proof oracle, the formula shape, and raw
// P/I/D weights are NOT. Every override requires a reason and is surfaced in
// the report, and the config hash is part of the determinism claim:
// same commit + same version + same config ⇒ same ranking.
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

export interface RiskOverride {
  /** Symbol external_id or a glob on it: "sym:common/log/*#CapturePanic". */
  symbol: string;
  action: "suppress" | "pin" | "reclassify";
  /** For reclassify: sensitivity class to force ("none" clears a false positive). */
  sensitivity?: "none" | "auth" | "payment" | "pii";
  /** Required. Rendered on the report row so a tuned report can never pass as clean. */
  reason: string;
}

export interface RiskConfig {
  classification: {
    /** Extra path globs that are test support (never ranked; still counted). */
    test_support_paths: string[];
    /** Extra path globs whose Run/Execute/Handle methods are scheduled entries. */
    scheduled_entry_paths: string[];
    /** Extra destructive callee patterns (matched on the callee's last segment). */
    destructive_sinks: string[];
    /** Symbol title globs whose name-derived sensitivity is ignored. */
    sensitivity_ignore: string[];
    /** Path globs excluded from the RISK RANKING only (still counted): e.g. "ui/**" on a backend repo. */
    rank_exclude_paths: string[];
  };
  tuning: {
    /** Impact floors at 5/10 for paths reaching a destructive external sink. */
    irreversibility_floor: boolean;
    /** Unproven scheduled entries get detection ×1.25. */
    silence_multiplier: boolean;
    /** Recent-history window used by bounded repository-level churn acquisition. */
    churn_window_days: number;
    /** Safety bounds for that acquisition. Defaults are sized so an active monorepo's
     *  full window completes; hitting either bound marks churn "partial" (disclosed). */
    churn_max_commits: number;
    churn_timeout_seconds: number;
  };
  /** Shared proof defaults. Consumers decide how to apply them. */
  proof: {
    /** `auto` or a no-shell executable/argument command string such as `uv run python -m pytest`. */
    python_runner: string;
    attempt_limit: number;
    baseline_green_target: number;
  };
  overrides: RiskOverride[];
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  classification: { test_support_paths: [], scheduled_entry_paths: [], destructive_sinks: [], sensitivity_ignore: [], rank_exclude_paths: [] },
  tuning: { irreversibility_floor: true, silence_multiplier: true, churn_window_days: 180, churn_max_commits: 20_000, churn_timeout_seconds: 300 },
  proof: { python_runner: "auto", attempt_limit: 20, baseline_green_target: 5 },
  overrides: []
};

export interface LoadedRiskConfig {
  config: RiskConfig;
  /** sha256 of the canonical risk-relevant config; stable across key order. */
  hash: string;
  warnings: string[];
}

function asStringArray(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function boundedInt(value: unknown, fallback: number, min: number, max: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.max(min, Math.min(max, Math.floor(value)));
}

/** Glob → RegExp: `*` matches within a path segment, `**` matches across segments. */
export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${esc}$`);
}

/** User-level defaults: ~/.orangepro/config.json (override with ORANGEPRO_USER_CONFIG for tests/CI).
 *  Applied FIRST; the analyzed repo's .orangepro/config.json wins on every key it sets.
 *  The hash covers the merged result, so provenance still tells the truth. */
export function userConfigPath(): string {
  return process.env.ORANGEPRO_USER_CONFIG ?? join(homedir(), ".orangepro", "config.json");
}

function applyFile(cfg: RiskConfig, file: string, warnings: string[], label: string): void {
  if (!existsSync(file)) return;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    const cls = (raw.classification ?? {}) as Record<string, unknown>;
    for (const k of ["test_support_paths", "scheduled_entry_paths", "destructive_sinks", "sensitivity_ignore", "rank_exclude_paths"] as const) {
      if (Array.isArray(cls[k])) cfg.classification[k] = asStringArray(cls[k]);
    }
    const tun = (raw.tuning ?? {}) as Record<string, unknown>;
    if (typeof tun.irreversibility_floor === "boolean") cfg.tuning.irreversibility_floor = tun.irreversibility_floor;
    if (typeof tun.silence_multiplier === "boolean") cfg.tuning.silence_multiplier = tun.silence_multiplier;
    if (tun.churn_window_days !== undefined) cfg.tuning.churn_window_days = boundedInt(tun.churn_window_days, cfg.tuning.churn_window_days, 1, 3_650);
    if (tun.churn_max_commits !== undefined) cfg.tuning.churn_max_commits = boundedInt(tun.churn_max_commits, cfg.tuning.churn_max_commits, 100, 200_000);
    if (tun.churn_timeout_seconds !== undefined) cfg.tuning.churn_timeout_seconds = boundedInt(tun.churn_timeout_seconds, cfg.tuning.churn_timeout_seconds, 10, 1_800);
    const proof = (raw.proof ?? {}) as Record<string, unknown>;
    if (typeof proof.python_runner === "string" && proof.python_runner.trim() !== "") {
      cfg.proof.python_runner = proof.python_runner.trim();
    }
    if (proof.attempt_limit !== undefined) cfg.proof.attempt_limit = boundedInt(proof.attempt_limit, cfg.proof.attempt_limit, 1, 100);
    if (proof.baseline_green_target !== undefined) cfg.proof.baseline_green_target = boundedInt(proof.baseline_green_target, cfg.proof.baseline_green_target, 1, 100);
    for (const o of Array.isArray(raw.overrides) ? raw.overrides : []) {
      const ov = o as Partial<RiskOverride>;
      if (typeof ov.symbol !== "string" || !["suppress", "pin", "reclassify"].includes(ov.action ?? "")) {
        warnings.push(`config (${label}): override ignored (needs symbol + action): ${JSON.stringify(o).slice(0, 80)}`);
        continue;
      }
      if (typeof ov.reason !== "string" || ov.reason.trim().length < 8) {
        warnings.push(`config (${label}): override for ${ov.symbol} ignored — a reason (≥8 chars) is required so it can be shown on the report.`);
        continue;
      }
      cfg.overrides.push({ symbol: ov.symbol, action: ov.action as RiskOverride["action"], sensitivity: ov.sensitivity, reason: ov.reason.trim() });
    }
  } catch (err) {
    warnings.push(`config (${label}): unreadable for risk settings (${(err as Error).message}); skipped.`);
  }
}

export function loadRiskConfig(repoRoot: string): LoadedRiskConfig {
  const warnings: string[] = [];
  const cfg: RiskConfig = JSON.parse(JSON.stringify(DEFAULT_RISK_CONFIG)) as RiskConfig;
  applyFile(cfg, userConfigPath(), warnings, "user defaults");
  if (repoRoot) applyFile(cfg, join(repoRoot, ".orangepro", "config.json"), warnings, "repo");
  const canonical = JSON.stringify(cfg, Object.keys(cfg).sort());
  const hash = createHash("sha256").update(JSON.stringify(cfg)).digest("hex").slice(0, 12);
  void canonical;
  return { config: cfg, hash, warnings };
}
