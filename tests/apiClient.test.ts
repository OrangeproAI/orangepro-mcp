import { describe, expect, it } from "vitest";
import { OrangeProApiError, OrangeProClient } from "../src/apiClient.js";
import { loadConfig } from "../src/config.js";

describe("OrangeProClient", () => {
  it("sends auth and tenant headers", async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetchImpl = async (url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), init: init || {} });
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    };
    const client = new OrangeProClient(
      loadConfig({
        ORANGEPRO_API_BASE_URL: "https://api.example.com/api/v1",
        ORANGEPRO_API_KEY: "secret",
        ORANGEPRO_USER_EMAIL: "qa@example.com",
        ORANGEPRO_ORGANIZATION_NAME: "beautyco_max"
      }),
      fetchImpl as typeof fetch
    );

    await client.post("/path", { ok: true });

    expect(calls[0].url).toBe("https://api.example.com/api/v1/path");
    expect(calls[0].init.headers).toMatchObject({
      Authorization: "Bearer secret",
      "X-API-Key": "secret",
      "X-User-Email": "qa@example.com",
      "X-Organization-Name": "beautyco_max",
      "Content-Type": "application/json"
    });
  });

  it("raises typed error on non-2xx", async () => {
    const client = new OrangeProClient(
      loadConfig({ ORANGEPRO_API_BASE_URL: "https://api.example.com/api/v1" }),
      (async () => new Response("nope", { status: 403 })) as typeof fetch
    );

    await expect(client.get("/blocked")).rejects.toBeInstanceOf(OrangeProApiError);
  });
});
