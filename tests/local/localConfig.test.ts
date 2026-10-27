import { describe, expect, it } from "vitest";

import * as localConfig from "../../src/local/localConfig.js";
import { resolveProviderConfig } from "../../src/local/localConfig.js";

describe("provider settings come only from the environment", () => {
  it("offers no .env file loader: keys, provider, base URLs and models are never read from a file", () => {
    expect(Object.keys(localConfig)).not.toContain("loadProviderEnv");
    expect(Object.keys(localConfig)).not.toContain("PROVIDER_ENV_FILES");
  });

  it("resolves the provider, model, base URL and key from the environment it is given", () => {
    const cfg = resolveProviderConfig({ OPENAI_API_KEY: "env-key", OPENAI_MODEL: "env-model", OPENAI_BASE_URL: "http://127.0.0.1:9/v1/" });

    expect(cfg).toMatchObject({ provider: "openai", model: "env-model", baseUrl: "http://127.0.0.1:9/v1" });
    expect(cfg?.apiKey).toBe("env-key");
  });

  it("defaults OpenAI generation to GPT-5.3 Codex", () => {
    const cfg = resolveProviderConfig({ OPENAI_API_KEY: "env-key" });

    expect(cfg).toMatchObject({ provider: "openai", model: "gpt-5.3-codex" });
  });

  it("defaults Anthropic generation to Claude Sonnet 5", () => {
    const cfg = resolveProviderConfig({ ANTHROPIC_API_KEY: "env-key" });

    expect(cfg).toMatchObject({ provider: "anthropic", model: "claude-sonnet-5" });
  });
});
