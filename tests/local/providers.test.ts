import { describe, it, expect } from "vitest";
import { OpenAICompatibleProvider, providerTimeoutMs } from "../../src/local/generate/providers.js";
import type { ProviderConfig } from "../../src/local/localConfig.js";

const OK = { choices: [{ message: { content: "GENERATED" } }] };

function cfg(model: string): ProviderConfig {
  return { provider: "openai", model, baseUrl: "https://api.openai.com/v1", apiKey: "sk-test" };
}

/** Fake fetch that records each request body and replays a queue of responses. */
function fakeFetch(responses: Array<{ status: number; body: unknown }>) {
  const calls: Record<string, unknown>[] = [];
  const queue = [...responses];
  const fn = (async (_url: string, init: { body: string }) => {
    calls.push(JSON.parse(init.body));
    const next = queue.shift();
    if (!next) throw new Error("fakeFetch: no more responses queued");
    const text = JSON.stringify(next.body);
    return {
      ok: next.status >= 200 && next.status < 300,
      status: next.status,
      text: async () => text
    };
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const UNSUPPORTED_MAX_TOKENS = {
  error: {
    message: "Unsupported parameter: 'max_tokens' is not supported with this model. Use 'max_completion_tokens' instead.",
    type: "invalid_request_error",
    param: "max_tokens",
    code: "unsupported_parameter"
  }
};

const UNSUPPORTED_TEMPERATURE = {
  error: {
    message: "Unsupported value: 'temperature' does not support 0.2 with this model. Only the default (1) value is supported.",
    type: "invalid_request_error",
    param: "temperature",
    code: "unsupported_value"
  }
};

describe("provider timeouts", () => {
  it("reasoning models get the 10-minute ceiling; others keep the 60s default", () => {
    expect(providerTimeoutMs("gpt-5")).toBe(600_000);
    expect(providerTimeoutMs("o3-mini")).toBe(600_000);
    expect(providerTimeoutMs("gpt-4.1")).toBe(60_000);
  });

  it("maps the cryptic AbortError to an actionable timeout message", async () => {
    const abortingFetch = (async () => {
      const e = new Error("This operation was aborted");
      e.name = "AbortError";
      throw e;
    }) as unknown as typeof fetch;
    await expect(
      new OpenAICompatibleProvider(cfg("gpt-5"), abortingFetch).complete({ system: "s", user: "u" })
    ).rejects.toThrow(/timed out after 600s/);
  });
});

describe("OpenAICompatibleProvider reasoning starvation", () => {
  const STARVED = { choices: [{ message: { content: "" }, finish_reason: "length" }] };

  it("retries ONCE with 4x the budget when content is empty and finish_reason is length", async () => {
    const f = fakeFetch([
      { status: 200, body: STARVED },
      { status: 200, body: OK }
    ]);
    const out = await new OpenAICompatibleProvider(cfg("gpt-5"), f.fn).complete({ system: "s", user: "u" });
    expect(out).toBe("GENERATED");
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0].max_completion_tokens).toBe(4000);
    expect(f.calls[1].max_completion_tokens).toBe(16000);
  });

  it("returns empty after the single retry (no infinite loop); caller refuses empty tests", async () => {
    const f = fakeFetch([
      { status: 200, body: STARVED },
      { status: 200, body: STARVED }
    ]);
    const out = await new OpenAICompatibleProvider(cfg("gpt-5"), f.fn).complete({ system: "s", user: "u" });
    expect(out).toBe("");
    expect(f.calls).toHaveLength(2);
  });

  it("does NOT retry a legitimately empty stop (finish_reason stop)", async () => {
    const f = fakeFetch([{ status: 200, body: { choices: [{ message: { content: "" }, finish_reason: "stop" }] } }]);
    const out = await new OpenAICompatibleProvider(cfg("gpt-5"), f.fn).complete({ system: "s", user: "u" });
    expect(out).toBe("");
    expect(f.calls).toHaveLength(1);
  });
});

describe("OpenAICompatibleProvider parameter compatibility", () => {
  it("older model: sends max_tokens + temperature (unchanged behavior)", async () => {
    const f = fakeFetch([{ status: 200, body: OK }]);
    const out = await new OpenAICompatibleProvider(cfg("gpt-4.1"), f.fn).complete({ system: "s", user: "u" });
    expect(out).toBe("GENERATED");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toHaveProperty("max_tokens");
    expect(f.calls[0]).not.toHaveProperty("max_completion_tokens");
    expect(f.calls[0]).toHaveProperty("temperature");
  });

  it("reasoning model (gpt-5.x): seeds max_completion_tokens and omits temperature", async () => {
    const f = fakeFetch([{ status: 200, body: OK }]);
    const out = await new OpenAICompatibleProvider(cfg("gpt-5.5"), f.fn).complete({ system: "s", user: "u" });
    expect(out).toBe("GENERATED");
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0]).toHaveProperty("max_completion_tokens");
    expect(f.calls[0]).not.toHaveProperty("max_tokens");
    expect(f.calls[0]).not.toHaveProperty("temperature");
  });

  it("self-corrects when the API rejects max_tokens", async () => {
    const f = fakeFetch([
      { status: 400, body: UNSUPPORTED_MAX_TOKENS },
      { status: 200, body: OK }
    ]);
    // A model the heuristic treats as "old" but the gateway rejects max_tokens.
    const out = await new OpenAICompatibleProvider(cfg("some-new-model"), f.fn).complete({ system: "s", user: "u" });
    expect(out).toBe("GENERATED");
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]).toHaveProperty("max_tokens");
    expect(f.calls[1]).toHaveProperty("max_completion_tokens");
    expect(f.calls[1]).not.toHaveProperty("max_tokens");
  });

  it("drops temperature when the model rejects a custom value", async () => {
    const f = fakeFetch([
      { status: 400, body: UNSUPPORTED_TEMPERATURE },
      { status: 200, body: OK }
    ]);
    const out = await new OpenAICompatibleProvider(cfg("gpt-4.1"), f.fn).complete({ system: "s", user: "u" });
    expect(out).toBe("GENERATED");
    expect(f.calls).toHaveLength(2);
    expect(f.calls[0]).toHaveProperty("temperature");
    expect(f.calls[1]).not.toHaveProperty("temperature");
  });

  it("gives up on an unrelated 400 instead of looping", async () => {
    const f = fakeFetch([
      { status: 400, body: { error: { message: "The model does not exist", code: "model_not_found", param: "model" } } }
    ]);
    await expect(
      new OpenAICompatibleProvider(cfg("nope"), f.fn).complete({ system: "s", user: "u" })
    ).rejects.toThrow(/HTTP 400/);
    expect(f.calls).toHaveLength(1);
  });

  it("reasoning model: an unrelated 400 surfaces the real error, never flips to max_tokens", async () => {
    const f = fakeFetch([
      { status: 400, body: { error: { message: "Some unrelated problem.", code: "invalid_request_error", param: "messages" } } }
    ]);
    await expect(
      new OpenAICompatibleProvider(cfg("gpt-5"), f.fn).complete({ system: "s", user: "u" })
    ).rejects.toThrow(/HTTP 400/);
    expect(f.calls).toHaveLength(1); // no retry, no swap
    expect(f.calls[0]).toHaveProperty("max_completion_tokens");
    expect(f.calls[0]).not.toHaveProperty("max_tokens");
  });
});
