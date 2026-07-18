import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ORANGEPRO_VERSION } from "../../src/local/version.js";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

function readJson(path: string): Record<string, any> {
  return JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as Record<string, any>;
}

describe("MCP Registry metadata", () => {
  const rootPackage = readJson("package.json");
  const lockfile = readJson("package-lock.json");
  const launcherPackage = readJson("packages/mcp-server/package.json");
  const server = readJson("server.json");
  const registryPackage = server.packages[0];

  it("keeps release and ownership metadata aligned", () => {
    expect(launcherPackage.version).toBe(rootPackage.version);
    expect(registryPackage.version).toBe(rootPackage.version);
    expect(launcherPackage.dependencies[rootPackage.name]).toBe(`^${rootPackage.version}`);
    expect(lockfile.version).toBe(rootPackage.version);
    expect(lockfile.packages[""].version).toBe(rootPackage.version);
    expect(launcherPackage.mcpName).toBe(server.name);
    expect(ORANGEPRO_VERSION).toBe(rootPackage.version);
    const [, repositoryOwner] = new URL(server.repository.url).pathname.split("/");
    expect(server.name.split("/")[0]).toBe(`io.github.${repositoryOwner}`);
  });

  it("describes a schema-safe package launch", () => {
    expect(server.description.length).toBeLessThanOrEqual(100);
    expect(registryPackage.runtimeHint).toBe("npx");
    expect(registryPackage.runtimeArguments).toBeUndefined();
    expect(registryPackage.packageArguments).toContainEqual(
      expect.objectContaining({ type: "positional", value: "mcp" })
    );
  });

  it("declares every supported provider without overclaiming privacy", () => {
    expect(registryPackage.environmentVariables.map(({ name }: { name: string }) => name)).toEqual([
      "OPENAI_API_KEY",
      "ANTHROPIC_API_KEY",
      "OLLAMA_BASE_URL"
    ]);
    expect(launcherPackage.description).not.toMatch(/code never leaves your machine/i);
    expect(launcherPackage.description).toContain("redacted grounded context");
  });
});
