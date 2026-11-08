import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { launcherVersion, LAUNCHER_VERSION_ENV } from "../../src/local/version.js";

const ROOT = resolve(__dirname, "../..");
const dirs: string[] = [];
afterEach(() => { while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true }); });
const temp = (): string => { const d = mkdtempSync(join(tmpdir(), "opro-launcher-")); dirs.push(d); return d; };
const readJson = (path: string): Record<string, any> => JSON.parse(readFileSync(path, "utf8"));

describe("launcher pins and names its engine", () => {
  it("depends on the engine of its own version, exactly", () => {
    const launcher = readJson(join(ROOT, "packages/mcp-server/package.json"));
    const engine = readJson(join(ROOT, "package.json"));
    expect(launcher.dependencies[engine.name]).toBe(launcher.version);
    expect(launcher.dependencies[engine.name]).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/);
  });

  it("the release script keeps the pin exact", () => {
    const dir = temp();
    for (const file of ["package.json", "package-lock.json", "server.json", "packages/mcp-server/package.json"]) {
      mkdirSync(dirname(join(dir, file)), { recursive: true });
      copyFileSync(join(ROOT, file), join(dir, file));
    }
    execFileSync(process.execPath, [join(ROOT, "scripts/release.mjs"), "9.8.7-demo.1"], { cwd: dir, stdio: "pipe" });
    const launcher = readJson(join(dir, "packages/mcp-server/package.json"));
    expect(launcher.version).toBe("9.8.7-demo.1");
    expect(launcher.dependencies["@orangepro/orangepro-mcp"]).toBe("9.8.7-demo.1");
  });

  it("passes its own version to the engine it runs", () => {
    const dir = temp();
    const launcherDir = join(dir, "node_modules/@orangepro/mcp-server");
    const engineDir = join(dir, "node_modules/@orangepro/orangepro-mcp");
    mkdirSync(join(launcherDir, "bin"), { recursive: true });
    mkdirSync(join(engineDir, "dist/local"), { recursive: true });
    copyFileSync(join(ROOT, "packages/mcp-server/bin/mcp-server.js"), join(launcherDir, "bin/mcp-server.js"));
    writeFileSync(join(launcherDir, "package.json"), JSON.stringify({ name: "@orangepro/mcp-server", version: "1.2.3", type: "module" }));
    writeFileSync(join(engineDir, "package.json"), JSON.stringify({ name: "@orangepro/orangepro-mcp", version: "1.2.3" }));
    writeFileSync(join(engineDir, "dist/local/cli.js"), `process.stdout.write(String(process.env.${LAUNCHER_VERSION_ENV}) + " " + process.argv.slice(2).join(" "));\n`);
    const out = execFileSync(process.execPath, [join(launcherDir, "bin/mcp-server.js"), "start", "."], { encoding: "utf8", env: { ...process.env, [LAUNCHER_VERSION_ENV]: "" } });
    expect(out).toBe("1.2.3 start .");
  });

  it("reads only a version-shaped value", () => {
    expect(launcherVersion({ [LAUNCHER_VERSION_ENV]: "0.2.59" })).toBe("0.2.59");
    expect(launcherVersion({ [LAUNCHER_VERSION_ENV]: "0.2.59-demo.16" })).toBe("0.2.59-demo.16");
    expect(launcherVersion({})).toBeNull();
    expect(launcherVersion({ [LAUNCHER_VERSION_ENV]: "^0.2.59" })).toBeNull();
    expect(launcherVersion({ [LAUNCHER_VERSION_ENV]: "0.2.59\nfake: yes" })).toBeNull();
  });
});
