import { z } from "zod";
import { OrangeProClient, OrangeProApiError } from "./apiClient.js";
import { OrangeProConfig, resolveTenant } from "./config.js";
import { AgentLogs, AgentRunSummary, AgentSummary, ToolTextResponse } from "./types.js";

export const TenantInput = {
  tenant_id: z.string().min(1).optional().describe("OrangePro tenant id. Defaults to ORANGEPRO_TENANT_ID env var.")
};

export function asText(payload: unknown): ToolTextResponse {
  return {
    content: [
      {
        type: "text",
        text: typeof payload === "string" ? payload : JSON.stringify(payload, null, 2)
      }
    ]
  };
}

export function asError(error: unknown): ToolTextResponse {
  const message = error instanceof OrangeProApiError
    ? `OrangePro API error (HTTP ${error.status}): ${error.message}`
    : error instanceof Error
      ? error.message
      : String(error);
  return { content: [{ type: "text", text: message }], isError: true };
}

export function createOrangeProToolHandlers(client: OrangeProClient, config: OrangeProConfig) {
  return {
    async listAgents(input: { tenant_id?: string }) {
      try {
        const tenantId = resolveTenant(input.tenant_id, config);
        const agents = await client.get<AgentSummary[]>(agentPlatformPath(tenantId, "/agents"));
        return asText({ tenant_id: tenantId, agents });
      } catch (error) {
        return asError(error);
      }
    },

    async getAgent(input: { tenant_id?: string; agent_id: string }) {
      try {
        const tenantId = resolveTenant(input.tenant_id, config);
        const agent = await client.get<unknown>(agentPlatformPath(tenantId, `/agents/${encodeURIComponent(input.agent_id)}`));
        return asText(agent);
      } catch (error) {
        return asError(error);
      }
    },

    async runAgent(input: { tenant_id?: string; agent_id: string }) {
      try {
        const tenantId = resolveTenant(input.tenant_id, config);
        const run = await client.post<AgentRunSummary>(agentPlatformPath(tenantId, `/agents/${encodeURIComponent(input.agent_id)}/run`));
        return asText({ tenant_id: tenantId, agent_id: input.agent_id, run });
      } catch (error) {
        return asError(error);
      }
    },

    async listRuns(input: { tenant_id?: string; agent_id: string; limit?: number; offset?: number }) {
      try {
        const tenantId = resolveTenant(input.tenant_id, config);
        const params = new URLSearchParams();
        if (input.limit !== undefined) params.set("limit", String(input.limit));
        if (input.offset !== undefined) params.set("offset", String(input.offset));
        const suffix = params.size ? `?${params.toString()}` : "";
        const runs = await client.get<AgentRunSummary[]>(agentPlatformPath(tenantId, `/agents/${encodeURIComponent(input.agent_id)}/runs${suffix}`));
        return asText({ tenant_id: tenantId, agent_id: input.agent_id, runs });
      } catch (error) {
        return asError(error);
      }
    },

    async getLogs(input: { tenant_id?: string; agent_id: string; limit?: number; offset?: number }) {
      try {
        const tenantId = resolveTenant(input.tenant_id, config);
        const params = new URLSearchParams();
        if (input.limit !== undefined) params.set("limit", String(input.limit));
        if (input.offset !== undefined) params.set("offset", String(input.offset));
        const suffix = params.size ? `?${params.toString()}` : "";
        const logs = await client.get<AgentLogs>(agentPlatformPath(tenantId, `/agents/${encodeURIComponent(input.agent_id)}/logs${suffix}`));
        return asText(logs);
      } catch (error) {
        return asError(error);
      }
    },

    async getHealth(input: { tenant_id?: string; agent_id: string }) {
      try {
        const tenantId = resolveTenant(input.tenant_id, config);
        const health = await client.get<unknown>(agentPlatformPath(tenantId, `/agents/${encodeURIComponent(input.agent_id)}/health`));
        return asText(health);
      } catch (error) {
        return asError(error);
      }
    },

    async resolveStory(input: { tenant_id?: string; story_text: string; input_kind?: string; source_type?: string; top_k?: number }) {
      try {
        const tenantId = resolveTenant(input.tenant_id, config);
        const result = await client.post<unknown>("/kg/grounding/resolve", {
          story_text: input.story_text,
          input_kind: input.input_kind || "story",
          source_type: input.source_type || "manual",
          top_k: input.top_k || 5
        });
        return asText({ tenant_id: tenantId, result });
      } catch (error) {
        return asError(error);
      }
    }
  };
}

function agentPlatformPath(tenantId: string, suffix: string): string {
  return `/admin/tenants/${encodeURIComponent(tenantId)}/agent-platform${suffix}`;
}
