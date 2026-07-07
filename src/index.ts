#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { loadConfig, OrangeProConfig } from "./config.js";
import { createServer } from "./server.js";

function validateConfig(config: OrangeProConfig): void {
  if (!config.apiKey) {
    console.error("[orangepro-mcp] warning: ORANGEPRO_API_KEY not set. Authenticated endpoints will fail.");
  }
  if (!config.defaultTenantId) {
    console.error("[orangepro-mcp] warning: ORANGEPRO_TENANT_ID not set. Tools will require explicit tenant_id.");
  }
}

async function main() {
  const config = loadConfig();
  validateConfig(config);
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((error) => {
  console.error("[orangepro-mcp] fatal:", error);
  process.exit(1);
});
