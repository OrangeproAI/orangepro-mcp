import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { loadProviderEnv, resolveProviderConfig } from "../../src/local/localConfig.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "op-env-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe("local provider env files", () => {
  it("loads BYOK provider values from .env.provider.local without persisting them", () => {
    const root = makeTempDir();
    writeFileSync(
      join(root, ".env.provider.local"),
      [
        "OPENAI_API_KEY=file-openai-key",
        "OPENAI_MODEL=\"gpt-4.1\"",
        "UNRELATED_SECRET=must-not-load",
        ""
      ].join("\n"),
      "utf8"
    );

    const env = loadProviderEnv([root], {});
    const cfg = resolveProviderConfig(env);

    expect(env.OPENAI_API_KEY).toBe("file-openai-key");
    expect(env.UNRELATED_SECRET).toBeUndefined();
    expect(cfg).toMatchObject({ provider: "openai", model: "gpt-4.1" });
  });

  it("lets process environment override local file values", () => {
    const root = makeTempDir();
    writeFileSync(join(root, ".env.local"), "OPENAI_API_KEY=file-key\nOPENAI_MODEL=file-model\n", "utf8");

    const env = loadProviderEnv([root], { OPENAI_API_KEY: "env-key", OPENAI_MODEL: "env-model" });
    const cfg = resolveProviderConfig(env);

    expect(cfg).toMatchObject({ provider: "openai", model: "env-model" });
    expect(cfg?.apiKey).toBe("env-key");
  });

  it("defaults OpenAI generation to the stronger public-demo model", () => {
    const cfg = resolveProviderConfig({ OPENAI_API_KEY: "env-key" });

    expect(cfg).toMatchObject({ provider: "openai", model: "gpt-4.1" });
  });
});
