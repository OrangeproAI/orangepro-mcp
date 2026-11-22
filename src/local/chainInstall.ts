// The install stage of the chain (actions-run): which package manager a fixture names, the one
// command OrangePro runs for it inside the container, and where that manager may write. Only a
// frozen install is taken: a command that could change the lockfile is refused, never run.

export const PACKAGE_MANAGERS = ["npm", "pnpm", "yarn"] as const;
export type PackageManager = (typeof PACKAGE_MANAGERS)[number];

export interface InstallPlan {
  manager: PackageManager;
  /** The manager's version when it is pinned (pnpm, yarn); null for npm, which is the image's own. */
  version: string | null;
  /** Where the version came from. */
  version_from: "packageManager" | "fixture" | "image";
  /** The fixture's command, as written. */
  fixture_command: string[];
  /** What runs in the container. */
  argv: string[];
  /** The lockfile this manager installs from, at the package root. */
  lockfile: string;
  /** Variables the install stage sets so that every cache and store is inside the container's /tmp. */
  env: Record<string, string>;
}

export class InstallPlanError extends Error {}

const DEFAULT_COMMAND = ["npm", "ci", "--no-audit", "--no-fund"];
const FLAG = /^--[a-z-]+(=[\w.-]+)?$/;
const VERSION = /^(\d+\.\d+\.\d+)(\+[A-Za-z0-9.]+)?$/;
const LOCKFILE: Record<PackageManager, string> = { npm: "package-lock.json", pnpm: "pnpm-lock.yaml", yarn: "yarn.lock" };
/** The flag that makes each manager stop when the lockfile and the manifest disagree. */
const FROZEN: Record<Exclude<PackageManager, "npm">, string[]> = { pnpm: ["--frozen-lockfile"], yarn: ["--immutable", "--frozen-lockfile"] };
// Flags that undo a frozen install or move what the stage decides.
const NEVER = new Set(["--no-frozen-lockfile", "--fix-lockfile", "--lockfile-only", "--no-immutable", "--store-dir", "--cache-folder", "--global", "--no-lockfile"]);
const COREPACK_ENV = { COREPACK_HOME: "/tmp/opro-corepack", COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

export const lockfileOf = (manager: PackageManager): string => LOCKFILE[manager];

function pinned(field: string | null, label: string): { manager: string; version: string } | null {
  if (field === null) return null;
  const at = field.lastIndexOf("@");
  const match = at > 0 ? VERSION.exec(field.slice(at + 1)) : null;
  if (!match) throw new InstallPlanError(`${label} must name a manager and an exact version, like pnpm@10.33.2 (got ${field}).`);
  return { manager: field.slice(0, at), version: match[1]! };
}

/**
 * The install a fixture asks for. `packageManagerField` is the repository's own package.json
 * `packageManager`; `fixtureManager` is the fixture's `dependencies.package_manager`, used only when the
 * repository pins nothing.
 */
export function installPlanOf(command: unknown, opts: { packageManagerField: string | null; fixtureManager: string | null }): InstallPlan {
  const words = command === undefined || command === null ? DEFAULT_COMMAND : command;
  if (!Array.isArray(words) || words.length < 2 || !words.every((part) => typeof part === "string")) {
    throw new InstallPlanError("the fixture's commands.install must be a package manager's install command (a list of strings).");
  }
  const [name, verb, ...flags] = words as string[];
  if (!PACKAGE_MANAGERS.includes(name as PackageManager)) {
    throw new InstallPlanError(`the fixture's commands.install starts with \`${name}\`; the package managers an install stage can run are ${PACKAGE_MANAGERS.join(", ")}.`);
  }
  const manager = name as PackageManager;
  const bad = flags.find((flag) => !FLAG.test(flag) || NEVER.has(flag.split("=")[0]!));
  if (bad !== undefined) throw new InstallPlanError(`the fixture's commands.install may carry plain flags only, and not ${bad}.`);
  if (manager === "npm") {
    if (verb !== "ci") throw new InstallPlanError("the fixture's commands.install must be npm ci with flags only: npm install can change the lockfile.");
    return { manager, version: null, version_from: "image", fixture_command: words as string[], argv: words as string[], lockfile: LOCKFILE.npm, env: {} };
  }
  if (verb !== "install") throw new InstallPlanError(`the fixture's commands.install must be ${manager} install with flags only.`);
  if (!flags.some((flag) => FROZEN[manager].includes(flag))) {
    throw new InstallPlanError(`the fixture's commands.install must carry ${FROZEN[manager].join(" or ")}: an install that could change the lockfile is not run.`);
  }
  const own = pinned(opts.packageManagerField, "the repository's packageManager field");
  const given = pinned(opts.fixtureManager, "the fixture's dependencies.package_manager");
  if (own && own.manager !== manager) throw new InstallPlanError(`the repository's packageManager field names ${own.manager}, and the fixture's commands.install names ${manager}.`);
  if (!own && given && given.manager !== manager) throw new InstallPlanError(`the fixture's dependencies.package_manager names ${given.manager}, and its commands.install names ${manager}.`);
  const chosen = own ?? given;
  if (!chosen) {
    throw new InstallPlanError(`no ${manager} version is pinned: the repository has no packageManager field, so the fixture must name one in dependencies.package_manager (like ${manager}@1.2.3).`);
  }
  // With the repository's own field, corepack reads it (and checks its hash when it carries one); otherwise the version is named.
  const tool = own ? manager : `${manager}@${chosen.version}`;
  const extra = manager === "pnpm" ? ["--store-dir", "/tmp/opro-pnpm-store"] : [];
  const env: Record<string, string> = { ...COREPACK_ENV, ...(manager === "yarn" ? { YARN_CACHE_FOLDER: "/tmp/opro-yarn-cache" } : {}) };
  return { manager, version: chosen.version, version_from: own ? "packageManager" : "fixture", fixture_command: words as string[], argv: ["corepack", tool, "install", ...flags, ...extra], lockfile: LOCKFILE[manager], env };
}
