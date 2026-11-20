/** F3a: every model call's use is recorded, so a spending cap can be checked. */
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AnthropicProvider, OllamaProvider, OpenAICompatibleProvider } from "../../src/local/generate/providers.js";
import { collectModelUsage, modelUsageLine, modelUsageSoFar } from "../../src/local/modelUsage.js";

const reply = (body: unknown) => (async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
const request = { system: "s", user: "u" };

describe("F3a: model use", () => {
  it("records each provider's own token counts, per model", async () => {
    const anthropic = new AnthropicProvider({ provider: "anthropic", model: "model-a", baseUrl: "http://x", apiKey: "k" } as never,
      reply({ content: [{ text: "ok" }], usage: { input_tokens: 100, output_tokens: 20 } }));
    const openai = new OpenAICompatibleProvider({ provider: "openai", model: "model-b", baseUrl: "http://x", apiKey: "k" } as never,
      reply({ choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 7, completion_tokens: 3 } }));
    const local = new OllamaProvider({ provider: "ollama", model: "model-c", baseUrl: "http://x" } as never,
      reply({ message: { content: "ok" }, prompt_eval_count: 5, eval_count: 2 }));
    const { usage, outermost } = await collectModelUsage(async () => {
      await anthropic.complete(request);
      await anthropic.complete(request);
      await openai.complete(request);
      await local.complete(request);
    });
    expect(outermost).toBe(true);
    expect(usage).toEqual({
      calls: 4,
      input_tokens: 212,
      output_tokens: 45,
      unreported_calls: 0,
      by_model: [
        { model: "model-a", calls: 2, input_tokens: 200, output_tokens: 40 },
        { model: "model-b", calls: 1, input_tokens: 7, output_tokens: 3 },
        { model: "model-c", calls: 1, input_tokens: 5, output_tokens: 2 }
      ]
    });
    expect(modelUsageLine(usage)).toBe("Model use: 4 calls, 212 input and 45 output tokens (model-a 2, model-b 1, model-c 1).");
  });

  it("counts a response without token counts as a call with unreported use, never as zero", async () => {
    const silent = new OpenAICompatibleProvider({ provider: "openai", model: "model-b", baseUrl: "http://x", apiKey: "k" } as never,
      reply({ choices: [{ message: { content: "ok" } }] }));
    const { usage } = await collectModelUsage(() => silent.complete(request));
    expect(usage).toMatchObject({ calls: 1, input_tokens: 0, output_tokens: 0, unreported_calls: 1 });
    expect(modelUsageLine(usage)).toBe("Model use: 1 call, 0 input and 0 output tokens (model-b); 1 call reported no token counts.");
  });

  it("an operation started inside another reports to both, and only the outer one is outermost", async () => {
    const provider = new AnthropicProvider({ provider: "anthropic", model: "model-a", baseUrl: "http://x", apiKey: "k" } as never,
      reply({ content: [{ text: "ok" }], usage: { input_tokens: 10, output_tokens: 1 } }));
    const outer = await collectModelUsage(async () => {
      await provider.complete(request);
      const inner = await collectModelUsage(() => provider.complete(request));
      expect(inner.outermost).toBe(false);
      expect(inner.usage.calls).toBe(1);
      expect(modelUsageSoFar().calls).toBe(2);
    });
    expect(outer.usage).toMatchObject({ calls: 2, input_tokens: 20, output_tokens: 2 });
  });

  it("says nothing at zero calls, and records nothing outside an operation", async () => {
    expect(modelUsageLine({ calls: 0, input_tokens: 0, output_tokens: 0, unreported_calls: 0, by_model: [] })).toBe("");
    expect(modelUsageSoFar().calls).toBe(0);
  });

  it("an operation puts the total in its result and in .orangepro/model-usage.json", async () => {
    const { opAiLinks, opAnalyze, opInit } = await import("../../src/local/operations.js");
    const { mkdirSync, writeFileSync } = await import("node:fs");
    const root = mkdtempSync(join(tmpdir(), "opro-model-usage-"));
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/pay.ts"), "export function charge(n: number) { return n * 2; }\n");
    const deps = { clock: () => "2026-11-19T00:00:00.000Z", env: {} };
    opInit(root, deps);
    opAnalyze(root, { source: root }, deps);
    const provider = new AnthropicProvider({ provider: "anthropic", model: "model-a", baseUrl: "http://x", apiKey: "k" } as never,
      reply({ content: [{ text: "{\"links\":[]}" }], usage: { input_tokens: 50, output_tokens: 5 } }));
    const res = await opAiLinks(root, { all: true }, { ...deps, env: {}, aiProvider: provider });
    expect(res.model_usage.calls).toBe(res.model_usage.by_model.reduce((sum, row) => sum + row.calls, 0));
    const file = join(root, ".orangepro", "model-usage.json");
    expect(existsSync(file)).toBe(true);
    expect(JSON.parse(readFileSync(file, "utf8"))).toEqual({ command: "ai-links", ...res.model_usage });
  }, 60_000);
});
