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
  };
  overrides: RiskOverride[];
}

export const DEFAULT_RISK_CONFIG: RiskConfig = {
  classification: { test_support_paths: [], scheduled_entry_paths: [], destructive_sinks: [], sensitivity_ignore: [], rank_exclude_paths: [] },
  tuning: { irreversibility_floor: true, silence_multiplier: true },
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

/** Glob → RegExp: `*` matches within a path segment, `**` matches across segments. */
export function globToRegExp(glob: string): RegExp {
  const esc = glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*\*/g, "\u0000").replace(/\*/g, "[^/]*").replace(/\u0000/g, ".*");
  return new RegExp(`^${esc}$`);
}

export function loadRiskConfig(repoRoot: string): LoadedRiskConfig {
  const warnings: string[] = [];
  const cfg: RiskConfig = JSON.parse(JSON.stringify(DEFAULT_RISK_CONFIG)) as RiskConfig;
  const file = join(repoRoot, ".orangepro", "config.json");
  if (repoRoot && existsSync(file)) {
    try {
      const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
      const cls = (raw.classification ?? {}) as Record<string, unknown>;
      cfg.classification.test_support_paths = asStringArray(cls.test_support_paths);
      cfg.classification.scheduled_entry_paths = asStringArray(cls.scheduled_entry_paths);
      cfg.classification.destructive_sinks = asStringArray(cls.destructive_sinks);
      cfg.classification.sensitivity_ignore = asStringArray(cls.sensitivity_ignore);
      cfg.classification.rank_exclude_paths = asStringArray(cls.rank_exclude_paths);
      const tun = (raw.tuning ?? {}) as Record<string, unknown>;
      if (typeof tun.irreversibility_floor === "boolean") cfg.tuning.irreversibility_floor = tun.irreversibility_floor;
      if (typeof tun.silence_multiplier === "boolean") cfg.tuning.silence_multiplier = tun.silence_multiplier;
      for (const o of Array.isArray(raw.overrides) ? raw.overrides : []) {
        const ov = o as Partial<RiskOverride>;
        if (typeof ov.symbol !== "string" || !["suppress", "pin", "reclassify"].includes(ov.action ?? "")) {
          warnings.push(`config: override ignored (needs symbol + action): ${JSON.stringify(o).slice(0, 80)}`);
          continue;
        }
        if (typeof ov.reason !== "string" || ov.reason.trim().length < 8) {
          warnings.push(`config: override for ${ov.symbol} ignored — a reason (≥8 chars) is required so it can be shown on the report.`);
          continue;
        }
        cfg.overrides.push({ symbol: ov.symbol, action: ov.action as RiskOverride["action"], sensitivity: ov.sensitivity, reason: ov.reason.trim() });
      }
    } catch (err) {
      warnings.push(`config: .orangepro/config.json unreadable for risk settings (${(err as Error).message}); defaults used.`);
    }
  }
  const canonical = JSON.stringify(cfg, Object.keys(cfg).sort());
  const hash = createHash("sha256").update(JSON.stringify(cfg)).digest("hex").slice(0, 12);
  void canonical;
  return { config: cfg, hash, warnings };
}
