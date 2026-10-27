import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { checkBuild, checkBuildAt } from "../../src/local/buildInfo.js";

const STAMP_SCRIPT = path.join(process.cwd(), "scripts", "build-info.mjs");
const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

/** A package laid out as the real one ships: dist/local plus one proof script, stamped by the real script. */
function stampedPackage(version = "9.9.9"): { root: string; local: string; stamp: () => string } {
  const root = realpathSync(mkdtempSync(path.join(tmpdir(), "opro-build-")));
  dirs.push(root);
  mkdirSync(path.join(root, "dist", "local", "contracts"), { recursive: true });
  mkdirSync(path.join(root, "scripts", "spikes"), { recursive: true });
  writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: "@orangepro/orangepro-mcp", version, files: ["dist/local", "scripts/spikes/proof.mjs", "README.md"] }));
  writeFileSync(path.join(root, "package-lock.json"), "{}\n");
  writeFileSync(path.join(root, "README.md"), "readme\n");
  writeFileSync(path.join(root, "dist", "local", "cli.js"), "console.log('cli');\n");
  writeFileSync(path.join(root, "dist", "local", "contracts", "io.js"), "export const io = 1;\n");
  writeFileSync(path.join(root, "scripts", "spikes", "proof.mjs"), "export {};\n");
  const stamp = (): string => {
    const run = spawnSync(process.execPath, [STAMP_SCRIPT, root], { encoding: "utf8" });
    expect(run.status).toBe(0);
    return readFileSync(path.join(root, "dist", "local", "build-info.json"), "utf8");
  };
  stamp();
  return { root, local: path.join(root, "dist", "local"), stamp };
}

describe("P0.6: the build stamp and the stale-build check", () => {
  it("a build whose files match its stamp runs, and the stamp names every shipped file but no doc", () => {
    const pkg = stampedPackage();
    const result = checkBuildAt(pkg.local, "9.9.9");
    expect(result.status).toBe("build");
    expect(result.build_sha256).toMatch(/^[0-9a-f]{64}$/);
    const stamp = JSON.parse(readFileSync(path.join(pkg.local, "build-info.json"), "utf8"));
    expect(stamp.files.map((f: { path: string }) => f.path)).toEqual(["dist/local/cli.js", "dist/local/contracts/io.js", "scripts/spikes/proof.mjs"]);
  });

  it("stamping the same build twice gives the same bytes: no time, path or machine detail", () => {
    const pkg = stampedPackage();
    const first = readFileSync(path.join(pkg.local, "build-info.json"));
    expect(Buffer.from(pkg.stamp())).toEqual(first);
    expect(first.toString()).not.toContain(pkg.root);
  });

  it("refuses a file changed after the build, a missing file, and a file another build left behind", () => {
    const changed = stampedPackage();
    writeFileSync(path.join(changed.local, "contracts", "io.js"), "export const io = 2;\n");
    expect(checkBuildAt(changed.local, "9.9.9")).toMatchObject({ status: "stale", reason: "dist/local/contracts/io.js changed after the build" });
    const missing = stampedPackage();
    rmSync(path.join(missing.root, "scripts", "spikes", "proof.mjs"));
    expect(checkBuildAt(missing.local, "9.9.9")).toMatchObject({ status: "stale", reason: "scripts/spikes/proof.mjs is missing" });
    const mixed = stampedPackage();
    writeFileSync(path.join(mixed.local, "old-module.js"), "export {};\n");
    expect(checkBuildAt(mixed.local, "9.9.9")).toMatchObject({ status: "stale", reason: "dist/local/old-module.js is not part of this build" });
  });

  it("refuses a build stamped as another version, and a build with no stamp", () => {
    const pkg = stampedPackage("9.9.9");
    expect(checkBuildAt(pkg.local, "9.9.10")).toMatchObject({ status: "stale", reason: "it was built as 9.9.9, but package.json says 9.9.10" });
    rmSync(path.join(pkg.local, "build-info.json"));
    expect(checkBuildAt(pkg.local, "9.9.9")).toMatchObject({ status: "stale", reason: "it has no build stamp (dist/local/build-info.json)" });
  });

  it("running from source (tsx, vitest) has no build to check", () => {
    expect(checkBuild()).toEqual({ status: "source", build_sha256: null, reason: null });
  });
});
