import { describe, expect, it } from "vitest";
import { installPlanOf, InstallPlanError } from "../../src/local/chainInstall.js";
import { runnerPlanOf, testArgv } from "../../src/local/chainRunner.js";

const none = { packageManagerField: null, fixtureManager: null };

describe("the install a fixture names", () => {
  it("keeps npm ci exactly as before, and as the default", () => {
    expect(installPlanOf(undefined, none)).toEqual({ manager: "npm", version: null, version_from: "image", fixture_command: ["npm", "ci", "--no-audit", "--no-fund"], argv: ["npm", "ci", "--no-audit", "--no-fund"], lockfile: "package-lock.json", env: {} });
    const plan = installPlanOf(["npm", "ci", "--package-lock=true", "--no-audit", "--no-fund"], none);
    expect(plan.argv).toEqual(["npm", "ci", "--package-lock=true", "--no-audit", "--no-fund"]);
    expect(() => installPlanOf(["npm", "install"], none)).toThrow(/npm ci with flags only: npm install can change the lockfile/);
  });

  it("runs pnpm through corepack at the repository's pinned version, with its store in the container's /tmp", () => {
    const plan = installPlanOf(["pnpm", "install", "--frozen-lockfile"], { packageManagerField: "pnpm@11.13.1+sha512.b2fc7683b8a6525414e7d13e1ba28caaddde96bf66ec540bfaeb7e702b81f3e0be4d1f295edf7f9fe0396740a8dce4509c582ddf79891f4543fea32d37645f25", fixtureManager: null });
    expect(plan).toMatchObject({ manager: "pnpm", version: "11.13.1", version_from: "packageManager", lockfile: "pnpm-lock.yaml" });
    expect(plan.argv).toEqual(["corepack", "pnpm", "install", "--frozen-lockfile", "--store-dir", "/tmp/opro-pnpm-store"]);
    expect(plan.env).toEqual({ COREPACK_HOME: "/tmp/opro-corepack", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" });
  });

  it("takes the version from the fixture only when the repository pins none", () => {
    const plan = installPlanOf(["pnpm", "install", "--frozen-lockfile"], { packageManagerField: null, fixtureManager: "pnpm@10.33.2" });
    expect(plan.argv.slice(0, 3)).toEqual(["corepack", "pnpm@10.33.2", "install"]);
    expect(plan.version_from).toBe("fixture");
    expect(() => installPlanOf(["pnpm", "install", "--frozen-lockfile"], none)).toThrow(/no pnpm version is pinned/);
    expect(() => installPlanOf(["pnpm", "install", "--frozen-lockfile"], { packageManagerField: null, fixtureManager: "pnpm@latest" })).toThrow(/an exact version/);
  });

  it("runs yarn frozen, in either spelling, with its cache in /tmp", () => {
    const berry = installPlanOf(["yarn", "install", "--immutable"], { packageManagerField: "yarn@4.17.1", fixtureManager: null });
    expect(berry.argv).toEqual(["corepack", "yarn", "install", "--immutable"]);
    expect(berry.env.YARN_CACHE_FOLDER).toBe("/tmp/opro-yarn-cache");
    expect(berry.lockfile).toBe("yarn.lock");
    const classic = installPlanOf(["yarn", "install", "--frozen-lockfile"], { packageManagerField: null, fixtureManager: "yarn@1.22.22" });
    expect(classic.argv).toEqual(["corepack", "yarn@1.22.22", "install", "--frozen-lockfile"]);
  });

  it("refuses what could change the lockfile, an unknown manager, a manager that is not the repository's, and anything but plain flags", () => {
    const pinned = { packageManagerField: "pnpm@10.33.2", fixtureManager: null };
    expect(() => installPlanOf(["pnpm", "install"], pinned)).toThrow(/must carry --frozen-lockfile/);
    expect(() => installPlanOf(["yarn", "install"], { packageManagerField: "yarn@4.17.1", fixtureManager: null })).toThrow(/--immutable or --frozen-lockfile/);
    expect(() => installPlanOf(["pnpm", "install", "--frozen-lockfile", "--no-frozen-lockfile"], pinned)).toThrow(/not --no-frozen-lockfile/);
    expect(() => installPlanOf(["pnpm", "install", "--frozen-lockfile", "--store-dir=/work/repo"], pinned)).toThrow(/not --store-dir/);
    expect(() => installPlanOf(["pnpm", "add", "left-pad"], pinned)).toThrow(/plain flags only|pnpm install with flags only/);
    expect(() => installPlanOf(["bun", "install"], none)).toThrow(/starts with `bun`; the package managers an install stage can run are npm, pnpm, yarn/);
    expect(() => installPlanOf(["yarn", "install", "--immutable"], pinned)).toThrow(/packageManager field names pnpm, and the fixture's commands.install names yarn/);
    expect(() => installPlanOf(["pnpm", "install", "--frozen-lockfile", "; rm -rf /"], pinned)).toThrow(InstallPlanError);
    expect(() => installPlanOf("pnpm install", pinned)).toThrow(/a list of strings/);
  });
});

describe("a Vitest 5 stage", () => {
  const plan = runnerPlanOf(["vitest", "run"], (detail) => {
    throw new Error(detail);
  });
  it("keeps its module cache out of node_modules, and Vitest 4 gets no option it does not know", () => {
    expect(testArgv(plan, null, "5.0.5").slice(-2)).toEqual(["--fsModuleCachePath", "/tmp/opro-vitest-cache"]);
    expect(testArgv(plan, null, "4.1.12")).not.toContain("--fsModuleCachePath");
    expect(testArgv(plan, null)).not.toContain("--fsModuleCachePath");
  });
});
