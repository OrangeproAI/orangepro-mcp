import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createLocalServer, FEEDBACK_META_KEY } from "../../src/local/mcp.js";

describe("local MCP server", () => {
  it("registers dynamic proof separately from static record_run", () => {
    const server = createLocalServer() as unknown as {
      _registeredTools: Record<string, { description?: string; inputSchema?: z.ZodObject<Record<string, z.ZodTypeAny>> }>;
    };

    const record = server._registeredTools.orangepro_record_run;
    const prove = server._registeredTools.orangepro_prove;

    expect(record?.description).toContain("static diagnostics");
    expect(record?.description).toContain("public Proven requires orangepro_prove");
    expect(prove?.description).toContain("dynamic targeted-proof oracle");
    expect(prove?.description).toContain("Public Proven closes only when baseline green");
    expect(Object.keys(prove.inputSchema?.shape ?? {})).toEqual(
      expect.arrayContaining([
        "target_symbol",
        "target_id",
        "source",
        "test_path",
        "replacement",
        "target_file",
        "method",
        "replacement_mode",
        "runner",
        "timeout_ms",
        "link_node_modules",
        "vitest_config",
        "jest_config",
        "test_env",
        "run_id"
      ])
    );
    expect(() => prove.inputSchema?.parse({ test_path: "x.test.ts", replacement: "return null;", runner: "mocha" })).not.toThrow();
    expect(() => prove.inputSchema?.parse({ test_path: "x.test.ts", replacement: "return null;", runner: "invalid-runner" })).toThrow();
  });

  it("exposes AI candidate flows as a separate non-evidence MCP lane", () => {
    const server = createLocalServer() as unknown as {
      _registeredTools: Record<string, { description?: string; inputSchema?: z.ZodObject<Record<string, z.ZodTypeAny>> }>;
    };

    const start = server._registeredTools.orangepro_start;
    const analyze = server._registeredTools.orangepro_analyze_sources;
    const aiFlows = server._registeredTools.orangepro_ai_flows;

    expect(start?.description).toContain("candidate flows");
    expect(Object.keys(start.inputSchema?.shape ?? {})).toEqual(expect.arrayContaining(["no_ai", "no_ai_flows", "provider", "model"]));
    expect(analyze?.description).toContain("ai_flows=true");
    expect(Object.keys(analyze.inputSchema?.shape ?? {})).toEqual(expect.arrayContaining(["ai_flows", "provider", "model"]));
    expect(aiFlows?.description).toContain("analysis.candidate_flows");
    expect(aiFlows?.description).toContain("never affect Proven");
    expect(aiFlows?.description).toContain("deterministic flow counts");
    expect(Object.keys(aiFlows.inputSchema?.shape ?? {})).toEqual(expect.arrayContaining(["workspace", "apply", "provider", "model"]));
    expect(() => aiFlows.inputSchema?.parse({ provider: "invalid-provider" })).toThrow();
  });

  it("FB08: a failed tool call carries an optional feedback link in _meta and never asks the model for feedback", async () => {
    const server = createLocalServer() as unknown as {
      _registeredTools: Record<string, { description?: string; handler: (input: Record<string, unknown>, extra?: unknown) => Promise<{ isError?: boolean; _meta?: Record<string, unknown> }> }>;
    };
    const workspace = mkdtempSync(join(tmpdir(), "opro-mcp-fb-"));
    const result = await server._registeredTools.orangepro_explain_test.handler({ workspace, generated_test_id: "missing" }, {});
    expect(result.isError).toBe(true);
    const url = String(result._meta?.[FEEDBACK_META_KEY] ?? "");
    expect(url.startsWith("https://orangepro.ai/feedback#")).toBe(true);
    expect(new URLSearchParams(url.split("#")[1]).get("entry")).toBe("blocked");
    expect(url).not.toContain(workspace);
    for (const tool of Object.values(server._registeredTools)) expect(tool.description ?? "").not.toMatch(/feedback/i);
  });
});
