import { describe, expect, it } from "vitest";
import { createOrangeProToolHandlers } from "../src/orangeproTools.js";
import { loadConfig } from "../src/config.js";

class FakeClient {
  calls: Array<{ method: string; path: string; body?: unknown }> = [];

  async get(path: string) {
    this.calls.push({ method: "GET", path });
    return [{ agent_id: "ag-1", name: "Jira Crawler" }];
  }

  async post(path: string, body?: unknown) {
    this.calls.push({ method: "POST", path, body });
    return { run_id: "#run-1", status: "running" };
  }
}

describe("orangepro tool handlers", () => {
  it("lists agents for default tenant", async () => {
    const client = new FakeClient();
    const handlers = createOrangeProToolHandlers(client as never, loadConfig({ ORANGEPRO_TENANT_ID: "beautyco_max" }));

    const result = await handlers.listAgents({});

    expect(client.calls[0]).toEqual({ method: "GET", path: "/admin/tenants/beautyco_max/agent-platform/agents" });
    expect(result.content[0].text).toContain("Jira Crawler");
  });

  it("runs agent with encoded path", async () => {
    const client = new FakeClient();
    const handlers = createOrangeProToolHandlers(client as never, loadConfig({ ORANGEPRO_TENANT_ID: "beautyco_max" }));

    await handlers.runAgent({ agent_id: "ag/test" });

    expect(client.calls[0]).toEqual({
      method: "POST",
      path: "/admin/tenants/beautyco_max/agent-platform/agents/ag%2Ftest/run",
      body: undefined
    });
  });

  it("resolves story through grounding route", async () => {
    const client = new FakeClient();
    const handlers = createOrangeProToolHandlers(client as never, loadConfig({ ORANGEPRO_TENANT_ID: "beautyco_max" }));

    await handlers.resolveStory({ story_text: "As a user..." });

    expect(client.calls[0]).toEqual({
      method: "POST",
      path: "/kg/grounding/resolve",
      body: {
        story_text: "As a user...",
        input_kind: "story",
        source_type: "manual",
        top_k: 5
      }
    });
  });
});
