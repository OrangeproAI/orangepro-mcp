// Loads the optional add-on and guards every call into it.
//
// Rules this file keeps:
//   - With no add-on installed, nothing changes and nothing is printed.
//   - Loading never throws and never changes an exit code.
//   - An add-on that sits inside the repository being scanned is never imported.
//   - A call that throws, hangs or answers in the wrong shape counts as "no answer".

import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  ADDON_PACKAGE,
  PLUGIN_API_VERSION,
  type AddonInterfaceName,
  type AddonProvenance,
  type CheckResolver,
  type FaultSelector,
  type OracleProposer,
  type PlatformClient,
  type PluginApi,
  type RuntimeLinker
} from "./pluginApi.js";

export const ADDON_OFF_ENV = "ORANGEPRO_PRO";
export const ADDON_TIMEOUT_ENV = "ORANGEPRO_PRO_TIMEOUT_MS";
export const DEFAULT_ADDON_TIMEOUT_MS = 60_000;

export interface AddonRegistry {
  faultSelector?: FaultSelector;
  oracleProposer?: OracleProposer;
  checkResolver?: CheckResolver;
  runtimeLinker?: RuntimeLinker;
  platformClient?: PlatformClient;
}

export type AddonStatus =
  | { state: "not_installed" }
  | { state: "off" }
  | { state: "not_used"; reason: string }
  | { state: "loaded"; name: string; version: string; api_version: string };

/** Where the add-on package is, and how to import it. Injectable for tests. */
export interface AddonLocation {
  /** The package's own folder (the one holding its package.json). */
  dir: string;
  version: string;
  load: () => Promise<unknown>;
}

export interface PluginHost {
  /** Finds the add-on, or null when it is not installed. May throw; a throw counts as "found, not used". */
  locate: () => AddonLocation | null;
  env: NodeJS.ProcessEnv;
  cwd: () => string;
  warn: (line: string) => void;
}

const EMPTY: AddonRegistry = Object.freeze({});

interface Loaded {
  status: AddonStatus;
  registry: AddonRegistry;
  dir: string | null;
}

let host: PluginHost = defaultHost();
let loading: Promise<Loaded> | null = null;
let settled: Loaded | null = null;
let located: { location: AddonLocation | null; error: string | null } | null = null;
const used = new Set<AddonInterfaceName>();
const warned = new Set<string>();

function defaultHost(): PluginHost {
  return {
    locate: locateInstalledAddon,
    env: process.env,
    cwd: () => process.cwd(),
    warn: (line) => {
      process.stderr.write(`${line}\n`);
    }
  };
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function warnOnce(line: string): void {
  if (warned.has(line)) return;
  warned.add(line);
  try {
    host.warn(line);
  } catch {
    // A warning that cannot be written is dropped.
  }
}

/** Node's own resolution, from where the engine is installed. Never from the folder being scanned. */
function locateInstalledAddon(): AddonLocation | null {
  let url: string;
  try {
    url = import.meta.resolve(ADDON_PACKAGE);
  } catch {
    return null;
  }
  if (!url.startsWith("file:")) throw new Error("it does not resolve to a file");
  const entry = realpathSync(fileURLToPath(url));
  let dir = dirname(entry);
  for (;;) {
    const manifest = join(dir, "package.json");
    if (existsSync(manifest)) {
      const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { name?: unknown; version?: unknown };
      if (pkg.name === ADDON_PACKAGE) {
        return { dir, version: typeof pkg.version === "string" ? pkg.version : "unknown", load: () => import(url) };
      }
    }
    const parent = dirname(dir);
    if (parent === dir) throw new Error("its package.json was not found");
    dir = parent;
  }
}

function realOrSelf(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

/** The folder holding `.git` at or above `start`, or null. */
function gitTopOf(start: string): string | null {
  let dir = start;
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

function isInside(child: string, parent: string): boolean {
  return child === parent || child.startsWith(parent.endsWith(sep) ? parent : parent + sep);
}

/** True when the add-on's folder is inside one of the scanned folders, or inside the repository that holds one. */
export function addonInsideScannedRepo(addonDir: string, roots: readonly string[]): boolean {
  const real = realOrSelf(addonDir);
  for (const root of roots) {
    const top = realOrSelf(root);
    if (isInside(real, top)) return true;
    const git = gitTopOf(top);
    if (git && isInside(real, git)) return true;
  }
  return false;
}

function locateOnce(): { location: AddonLocation | null; error: string | null } {
  if (!located) {
    try {
      located = { location: host.locate(), error: null };
    } catch (e) {
      located = { location: null, error: messageOf(e) };
    }
  }
  return located;
}

function sameMajor(version: string): boolean {
  const major = /^(\d+)\.\d+\.\d+/.exec(version)?.[1];
  return major !== undefined && major === PLUGIN_API_VERSION.split(".")[0];
}

async function importAddon(location: AddonLocation): Promise<Loaded> {
  const notUsed = (reason: string): Loaded => {
    warnOnce(`pro add-on: found, not used (${reason}).`);
    return { status: { state: "not_used", reason }, registry: EMPTY, dir: location.dir };
  };
  let mod: unknown;
  try {
    mod = await location.load();
  } catch (e) {
    return notUsed(`it could not be loaded: ${messageOf(e)}`);
  }
  const m = (mod ?? {}) as { pluginApiVersion?: unknown; register?: unknown };
  if (typeof m.pluginApiVersion !== "string") return notUsed("it does not say which add-on interface version it was built for");
  if (!sameMajor(m.pluginApiVersion)) return notUsed(`it was built for add-on interface ${m.pluginApiVersion}; this engine has ${PLUGIN_API_VERSION}`);
  if (typeof m.register !== "function") return notUsed("it has no register function");

  const registry: AddonRegistry = {};
  const problems: string[] = [];
  const take = <K extends keyof AddonRegistry>(slot: K, label: AddonInterfaceName, method: string) => (impl: NonNullable<AddonRegistry[K]>): void => {
    if (impl === null || typeof impl !== "object" || typeof (impl as unknown as Record<string, unknown>)[method] !== "function") {
      problems.push(`its ${label} has no ${method} function`);
      return;
    }
    registry[slot] = impl;
  };
  const api: PluginApi = {
    apiVersion: PLUGIN_API_VERSION,
    registerFaultSelector: take("faultSelector", "FaultSelector", "proposeFaults"),
    registerOracleProposer: take("oracleProposer", "OracleProposer", "proposeOracle"),
    registerCheckResolver: take("checkResolver", "CheckResolver", "proposeChecks"),
    registerRuntimeLinker: take("runtimeLinker", "RuntimeLinker", "coverageFiles"),
    registerPlatformClient: take("platformClient", "PlatformClient", "publish")
  };
  try {
    await (m.register as (api: PluginApi) => unknown)(api);
  } catch (e) {
    return notUsed(`its register function failed: ${messageOf(e)}`);
  }
  if (problems.length > 0) return notUsed(problems[0]!);
  return {
    status: { state: "loaded", name: ADDON_PACKAGE, version: location.version, api_version: m.pluginApiVersion },
    registry: Object.freeze(registry),
    dir: location.dir
  };
}

async function resolveFor(roots: readonly string[]): Promise<Loaded> {
  try {
    if (/^(off|0|false|no)$/i.test(String(host.env[ADDON_OFF_ENV] ?? ""))) return { status: { state: "off" }, registry: EMPTY, dir: null };
    const found = locateOnce();
    if (found.error !== null) {
      const reason = `it could not be located: ${found.error}`;
      warnOnce(`pro add-on: found, not used (${reason}).`);
      return { status: { state: "not_used", reason }, registry: EMPTY, dir: null };
    }
    if (!found.location) return { status: { state: "not_installed" }, registry: EMPTY, dir: null };
    // Checked before the import, so an add-on shipped by the scanned repository never runs.
    if (addonInsideScannedRepo(found.location.dir, [...roots, host.cwd()])) {
      const reason = "it is inside the repository being scanned";
      warnOnce(`pro add-on: found, not used (${reason}).`);
      return { status: { state: "not_used", reason }, registry: EMPTY, dir: found.location.dir };
    }
    loading ??= importAddon(found.location);
    settled = await loading;
    return settled;
  } catch (e) {
    // Nothing above is expected to throw; if it does, the engine carries on without an add-on.
    return { status: { state: "not_used", reason: messageOf(e) }, registry: EMPTY, dir: null };
  }
}

/** The add-on's registered parts for a run on `root`. Empty when there is no usable add-on. Never throws. */
export async function pluginsFor(root: string, ...moreRoots: string[]): Promise<AddonRegistry> {
  return (await resolveFor([root, ...moreRoots])).registry;
}

/** What `opro doctor` shows. Never throws. */
export async function addonStatusFor(root: string, ...moreRoots: string[]): Promise<AddonStatus> {
  return (await resolveFor([root, ...moreRoots])).status;
}

export function addonStatusLine(status: AddonStatus): string {
  switch (status.state) {
    case "not_installed":
      return "pro add-on: not installed";
    case "off":
      return `pro add-on: turned off (${ADDON_OFF_ENV})`;
    case "not_used":
      return `pro add-on: found, not used (${status.reason})`;
    case "loaded":
      return `pro add-on: ${status.name} ${status.version} (add-on interface ${status.api_version})`;
  }
}

function timeoutMs(): number {
  const raw = Number(host.env[ADDON_TIMEOUT_ENV]);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_ADDON_TIMEOUT_MS;
}

/**
 * One guarded call into the add-on. Returns the checked answer, or null when the add-on
 * threw, ran past the time limit, or answered in a shape `accept` refuses. A null is
 * "no answer": the caller carries on exactly as it does with no add-on.
 */
export async function callAddon<T>(label: AddonInterfaceName, call: () => unknown, accept: (value: unknown) => T | null): Promise<T | null> {
  const limit = timeoutMs();
  let timer: NodeJS.Timeout | undefined;
  try {
    const value = await Promise.race([
      Promise.resolve().then(call),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error(`it ran past the ${Math.round(limit / 1000)} s limit`)), limit);
      })
    ]);
    const checked = accept(value);
    if (checked === null) {
      warnOnce(`pro add-on: ${label} gave an answer in the wrong shape; ignored.`);
      return null;
    }
    return checked;
  } catch (e) {
    warnOnce(`pro add-on: ${label} failed (${messageOf(e)}); ignored.`);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Record that an interface's answer was used in this process's output. */
export function markAddonUsed(label: AddonInterfaceName): void {
  used.add(label);
}

/** Named in outputs only when an add-on's answer was used. Undefined otherwise, so nothing is written. */
export function addonProvenance(only?: readonly AddonInterfaceName[]): AddonProvenance | undefined {
  const status = settled?.status;
  if (used.size === 0 || !status || status.state !== "loaded") return undefined;
  const list = [...used].filter((label) => !only || only.includes(label)).sort();
  if (list.length === 0) return undefined;
  return { name: status.name, version: status.version, api_version: status.api_version, used: list };
}

/** The loaded add-on's name and version, whether or not an answer of its has been used yet. */
export function addonIdentity(): { name: string; version: string } {
  const status = settled?.status;
  return status?.state === "loaded" ? { name: status.name, version: status.version } : { name: ADDON_PACKAGE, version: "unknown" };
}

/** Tests only: replace how the add-on is found, and forget everything loaded. */
export function setPluginHostForTest(overrides: Partial<PluginHost> | null): void {
  host = overrides ? { ...defaultHost(), ...overrides } : defaultHost();
  loading = null;
  located = null;
  settled = null;
  used.clear();
  warned.clear();
}
