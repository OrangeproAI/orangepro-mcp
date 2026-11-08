import { describe, expect, it } from "vitest";
import { redactProviderEndpoints, redactSecrets } from "../../src/local/util/redact.js";

describe("provider endpoints are redacted by value", () => {
  it("replaces each *_BASE_URL value, with or without its trailing slash, by the variable's name", () => {
    const values = { OPENAI_BASE_URL: "https://gw.example.test/openai/", OLLAMA_BASE_URL: "http://10.0.0.5:11434" };
    expect(redactProviderEndpoints("POST https://gw.example.test/openai/chat and https://gw.example.test/openai", values)).toBe("POST <OPENAI_BASE_URL>chat and <OPENAI_BASE_URL>");
    expect(redactProviderEndpoints("ECONNREFUSED http://10.0.0.5:11434/api/chat", values)).toBe("ECONNREFUSED <OLLAMA_BASE_URL>/api/chat");
    expect(redactProviderEndpoints("nothing here", {})).toBe("nothing here");
  });

  it("redactSecrets, which every log and record goes through, applies the endpoints the environment holds", () => {
    const before = process.env.ANTHROPIC_BASE_URL;
    process.env.ANTHROPIC_BASE_URL = "https://proxy.example.test/anthropic";
    try {
      expect(redactSecrets("fetch https://proxy.example.test/anthropic/messages failed")).toBe("fetch <ANTHROPIC_BASE_URL>/messages failed");
    } finally {
      if (before === undefined) delete process.env.ANTHROPIC_BASE_URL;
      else process.env.ANTHROPIC_BASE_URL = before;
    }
  });
});
