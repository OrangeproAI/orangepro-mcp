export type OrangeProConfig = {
  apiBaseUrl: string;
  defaultTenantId?: string;
  apiKey?: string;
  userEmail?: string;
  organizationName?: string;
  timeoutMs: number;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): OrangeProConfig {
  const apiBaseUrl = (env.ORANGEPRO_API_BASE_URL || "http://localhost:8000/api/v1").replace(/\/+$/, "");
  const timeoutMs = Number.parseInt(env.ORANGEPRO_TIMEOUT_MS || "30000", 10);

  return {
    apiBaseUrl,
    defaultTenantId: env.ORANGEPRO_TENANT_ID,
    apiKey: env.ORANGEPRO_API_KEY,
    userEmail: env.ORANGEPRO_USER_EMAIL,
    organizationName: env.ORANGEPRO_ORGANIZATION_NAME || env.ORANGEPRO_TENANT_ID,
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 30000
  };
}

export function resolveTenant(inputTenantId: string | undefined, config: OrangeProConfig): string {
  const tenantId = inputTenantId || config.defaultTenantId;
  if (!tenantId) {
    throw new Error("tenant_id is required. Pass tenant_id or set ORANGEPRO_TENANT_ID.");
  }
  return tenantId;
}
