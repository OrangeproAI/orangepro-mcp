import { describe, expect, it } from "vitest";
import { loadConfig, resolveTenant } from "../src/config.js";

describe("config", () => {
  it("loads defaults", () => {
    const config = loadConfig({});
    expect(config.apiBaseUrl).toBe("http://localhost:8000/api/v1");
    expect(config.timeoutMs).toBe(30000);
  });

  it("normalizes trailing slashes", () => {
    const config = loadConfig({ ORANGEPRO_API_BASE_URL: "https://example.com/api/v1///" });
    expect(config.apiBaseUrl).toBe("https://example.com/api/v1");
  });

  it("resolves tenant from input before env default", () => {
    const config = loadConfig({ ORANGEPRO_TENANT_ID: "default_tenant" });
    expect(resolveTenant("explicit_tenant", config)).toBe("explicit_tenant");
  });

  it("requires tenant when no default exists", () => {
    expect(() => resolveTenant(undefined, loadConfig({}))).toThrow("tenant_id is required");
  });
});
