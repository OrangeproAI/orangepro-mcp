import { describe, it, expect } from "vitest";
import { selectProviderAndModel, SUPPORTED_MODELS } from "../../src/local/interactive.js";

/** Scripted choose/ask: replays queued indices and free-text answers. */
function scripted(choices: number[], texts: string[] = []) {
  const c = [...choices];
  const t = [...texts];
  const choose = async (): Promise<number> => (c.length ? (c.shift() as number) : -1);
  const ask = async (): Promise<string> => (t.length ? (t.shift() as string) : "");
  return { choose, ask };
}

const NO_ENV = {} as NodeJS.ProcessEnv;

describe("selectProviderAndModel", () => {
  it("picks a curated model (openai → first)", async () => {
    const { choose, ask } = scripted([0, 0]);
    const sel = await selectProviderAndModel(NO_ENV, choose, ask);
    expect(sel).toEqual({ provider: "openai", model: SUPPORTED_MODELS.openai[0].model });
  });

  it("supports a custom model id", async () => {
    // openai (0), then the trailing 'custom' option (index === models.length).
    const customIdx = SUPPORTED_MODELS.openai.length;
    const { choose, ask } = scripted([0, customIdx], ["gpt-5.5"]);
    const sel = await selectProviderAndModel(NO_ENV, choose, ask);
    expect(sel).toEqual({ provider: "openai", model: "gpt-5.5" });
  });

  it("anthropic curated model", async () => {
    const { choose, ask } = scripted([1, 0]);
    const sel = await selectProviderAndModel(NO_ENV, choose, ask);
    expect(sel).toEqual({ provider: "anthropic", model: SUPPORTED_MODELS.anthropic[0].model });
  });

  it("deterministic needs no model", async () => {
    const { choose, ask } = scripted([3]); // 4th provider = deterministic
    const sel = await selectProviderAndModel(NO_ENV, choose, ask);
    expect(sel).toEqual({ provider: "deterministic" });
  });

  it("cancel at provider returns null", async () => {
    const { choose, ask } = scripted([-1]);
    expect(await selectProviderAndModel(NO_ENV, choose, ask)).toBeNull();
  });

  it("blank custom model returns null", async () => {
    const customIdx = SUPPORTED_MODELS.openai.length;
    const { choose, ask } = scripted([0, customIdx], [""]);
    expect(await selectProviderAndModel(NO_ENV, choose, ask)).toBeNull();
  });
});
