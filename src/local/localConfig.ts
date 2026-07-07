/**
 * Local proof-kit configuration: privacy defaults + BYOK provider resolution.
 *
 * Security invariant: model provider API keys are read from the environment at
 * call time and are NEVER written into the workspace config, the graph, or the
 * evidence pack.
 */
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

export interface PrivacySettings {
  /** Hosted upload is deferred + opt-in; always false in the first slice. */
  upload_enabled: boolean;
  /** Source snippets are excluded from persisted/exported artifacts by default. */
  source_snippets_in_pack: boolean;
}

export interface LocalProofConfig {
  workspace_name: string;
  created_at: string;
  local_only: boolean;
  privacy: PrivacySettings;
  /**
   * Default provider/model chosen via `opro setup`. A convenience only — used
   * when no --provider/--model flag is passed. API keys are NEVER stored here;
   * they continue to come from the environment at call time.
   */
  model_default?: { provider: ProviderName; model: string };
}

export function defaultPrivacySettings(): PrivacySettings {
  return { upload_enabled: false, source_snippets_in_pack: false };
}

export type ProviderName = "openai" | "ollama" | "anthropic";

export interface ProviderConfig {
  provider: ProviderName;
  model: string;
  baseUrl: string;
  /**
   * Runtime-only secret sourced from env. Never persisted, logged, or serialized.
   * Lifecycle: read here, handed to the provider constructor, then discarded — do
   * not retain a reference to ProviderConfig after the provider is built.
   */
  apiKey?: string;
}

export interface ProviderOverride {
  provider?: string;
  model?: string;
}

export const PROVIDER_ENV_FILES = [".env.provider.local", ".env.local", ".env"] as const;

const PROVIDER_ENV_KEYS = new Set([
  "OPENAI_API_KEY",
  "OPENAI_BASE_URL",
  "OPENAI_MODEL",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_BASE_URL",
  "ANTHROPIC_MODEL",
  "OLLAMA_BASE_URL",
  "OLLAMA_MODEL",
  "ORANGEPRO_PROVIDER"
]);

function parseEnvFile(contents: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!match || !PROVIDER_ENV_KEYS.has(match[1])) continue;
    let value = match[2].trim();
    if (
      (value.startsWith("\"") && value.endsWith("\"")) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    out[match[1]] = value;
  }
  return out;
}

export function loadProviderEnv(
  roots: Array<string | undefined>,
  env: NodeJS.ProcessEnv = process.env
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  for (const root of roots) {
    if (!root) continue;
    const abs = resolve(root);
    if (seen.has(abs)) continue;
    seen.add(abs);
    for (const name of PROVIDER_ENV_FILES) {
      const file = join(abs, name);
      if (!existsSync(file)) continue;
      try {
        Object.assign(merged, parseEnvFile(readFileSync(file, "utf8")));
      } catch {
        /* Ignore unreadable local env files; callers will surface no-provider guidance. */
      }
    }
  }
  return { ...merged, ...env };
}

/**
 * Resolve a BYOK provider from env + optional per-call override.
 * Returns null when no usable provider credentials are present, so callers can
 * fall back to a deterministic provider (offline/demo) or surface guidance.
 */
export function resolveProviderConfig(
  env: NodeJS.ProcessEnv = process.env,
  override: ProviderOverride = {}
): ProviderConfig | null {
  const requested = (override.provider || env.ORANGEPRO_PROVIDER || "").toLowerCase();

  const tryOpenAI = (): ProviderConfig | null => {
    if (!env.OPENAI_API_KEY) return null;
    return {
      provider: "openai",
      model: override.model || env.OPENAI_MODEL || "gpt-4.1",
      baseUrl: (env.OPENAI_BASE_URL || "https://api.openai.com/v1").replace(/\/+$/, ""),
      apiKey: env.OPENAI_API_KEY
    };
  };

  const tryAnthropic = (): ProviderConfig | null => {
    if (!env.ANTHROPIC_API_KEY) return null;
    return {
      provider: "anthropic",
      model: override.model || env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
      baseUrl: (env.ANTHROPIC_BASE_URL || "https://api.anthropic.com/v1").replace(/\/+$/, ""),
      apiKey: env.ANTHROPIC_API_KEY
    };
  };

  const tryOllama = (): ProviderConfig | null => {
    const base = env.OLLAMA_BASE_URL;
    if (!base && requested !== "ollama") return null;
    return {
      provider: "ollama",
      model: override.model || env.OLLAMA_MODEL || "llama3.1",
      baseUrl: (base || "http://localhost:11434").replace(/\/+$/, "")
    };
  };

  if (requested === "openai") return tryOpenAI();
  if (requested === "anthropic") return tryAnthropic();
  if (requested === "ollama") return tryOllama();

  // Auto-detect order: OpenAI-compatible, then Ollama, then Anthropic.
  return tryOpenAI() || tryOllama() || tryAnthropic();
}
