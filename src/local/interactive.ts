/**
 * Interactive provider/model selection — shared by `opro setup` (persists a
 * default) and `opro generate` (one-shot picker when nothing is configured).
 *
 * The selection logic is pure and takes injected `choose`/`ask` callbacks so it
 * is unit-testable; the CLI supplies readline-backed implementations. Nothing
 * here reads or stores API keys — those stay in the environment.
 */
import type { ProviderName } from "./localConfig.js";

export interface ModelOption {
  model: string;
  note: string;
}

/**
 * Curated, current known-good models per provider. NOT exhaustive — a custom id
 * is always selectable, and the provider adapters self-correct request params,
 * so newer reasoning models (e.g. gpt-5*, o-series) work even when not listed.
 */
export const SUPPORTED_MODELS: Record<ProviderName, ModelOption[]> = {
  openai: [
    { model: "gpt-4.1", note: "strong general (recommended)" },
    { model: "gpt-4o", note: "fast, multimodal" },
    { model: "gpt-5", note: "reasoning — uses max_completion_tokens" },
    { model: "gpt-4.1-mini", note: "cheap — smoke tests only" }
  ],
  anthropic: [
    { model: "claude-sonnet-4-6", note: "recommended" },
    { model: "claude-opus-4-8", note: "deepest reasoning" },
    { model: "claude-haiku-4-5", note: "fast, cheap" }
  ],
  ollama: [
    { model: "qwen2.5-coder:32b", note: "strong local coder" },
    { model: "llama3.1", note: "general local" }
  ]
};

export interface PickerProvider {
  id: ProviderName | "deterministic";
  label: string;
  ready: boolean;
  hint: string;
}

/** Providers offered by the picker, each flagged with whether creds are present. */
export function detectProviders(env: NodeJS.ProcessEnv): PickerProvider[] {
  return [
    { id: "openai", label: "OpenAI / OpenAI-compatible", ready: Boolean(env.OPENAI_API_KEY), hint: "set OPENAI_API_KEY" },
    { id: "anthropic", label: "Anthropic (Claude)", ready: Boolean(env.ANTHROPIC_API_KEY), hint: "set ANTHROPIC_API_KEY" },
    { id: "ollama", label: "Ollama (local)", ready: Boolean(env.OLLAMA_BASE_URL), hint: "needs local Ollama (default :11434)" },
    { id: "deterministic", label: "Deterministic offline stand-in", ready: true, hint: "no key — scaffold tests only" }
  ];
}

/** Present a titled list; return the chosen 0-based index, or <0 to cancel. */
export type Chooser = (title: string, options: string[]) => Promise<number>;
/** Free-text prompt (used for a custom model id). */
export type Asker = (question: string) => Promise<string>;

export interface ProviderSelection {
  provider: ProviderName | "deterministic";
  /** Omitted for the deterministic stand-in (model is irrelevant there). */
  model?: string;
}

export async function selectProviderAndModel(
  env: NodeJS.ProcessEnv,
  choose: Chooser,
  ask: Asker
): Promise<ProviderSelection | null> {
  const providers = detectProviders(env);
  const provIdx = await choose(
    "Select a model provider:",
    providers.map((p) => `${p.label}  ${p.ready ? "[ready]" : `[${p.hint}]`}`)
  );
  if (provIdx < 0 || provIdx >= providers.length) return null;
  const chosen = providers[provIdx];
  if (chosen.id === "deterministic") return { provider: "deterministic" };

  const models = SUPPORTED_MODELS[chosen.id];
  const labels = models.map((m) => `${m.model} — ${m.note}`);
  labels.push("custom (enter a model id)");
  const modelIdx = await choose(`Select a ${chosen.label} model:`, labels);
  if (modelIdx < 0 || modelIdx > models.length) return null;
  if (modelIdx === models.length) {
    const custom = (await ask("Model id: ")).trim();
    if (!custom) return null;
    return { provider: chosen.id, model: custom };
  }
  return { provider: chosen.id, model: models[modelIdx].model };
}
