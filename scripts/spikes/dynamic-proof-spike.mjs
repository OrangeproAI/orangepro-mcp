#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { pickReportableFailureLine } from "./failure-summary.mjs";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_REPLACEMENT_CHARS = 8192;
const MAX_REPLACEMENT_JSON_DEPTH = 24;
const REPLACEMENT_MODES = new Set(["return-json", "promise-json"]);

function usage() {
  return [
    "Usage: node scripts/spikes/dynamic-proof-spike.mjs --root <repo> --test <rel> --target <rel> --method <name> --replacement <sentinel> [--replacement-mode return-json|promise-json] [--test-env KEY=value] [--runner auto|vitest|jest|mocha] [--vitest-config <rel>] [--jest-config <rel>] [--mocha-bin <path>] [--json] [--link-node-modules]",
    "",
    "Runs a baseline test, mutates the target method body in an isolated copy, reruns the same test, and classifies the result.",
    "--replacement must be inert: either empty or a single return of a JSON literal, e.g. 'return {\"ok\":false};'. Use --replacement-mode promise-json for Promise<T> methods.",
    "--link-node-modules is a trusted-repo speed mode: source files are copied, but node_modules is symlinked and must not be treated as write-isolated.",
    "Repo test lifecycle hooks and runner binaries are trusted in this spike; use it only for local measurement on trusted checkouts.",
    "This is a spike harness only; it does not write graph edges or product artifacts."
  ].join("\n");
}

function parseArgs(argv) {
  const args = { json: false, linkNodeModules: false, runner: "auto", replacementMode: "return-json", testEnv: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--json") {
      args.json = true;
      continue;
    }
    if (arg === "--link-node-modules") {
      args.linkNodeModules = true;
      continue;
    }
    if (!arg.startsWith("--")) {
      throw new Error(`Unexpected positional argument: ${arg}`);
    }
    const key = arg.slice(2).replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    const value = argv[i + 1];
    if (value === undefined || (value.startsWith("--") && key !== "replacement")) {
      throw new Error(`Missing value for ${arg}`);
    }
    if (key === "testEnv") {
      args.testEnv.push(value);
      i += 1;
      continue;
    }
    args[key] = value;
    i += 1;
  }
  for (const required of ["root", "test", "target", "method", "replacement"]) {
    if (!Object.prototype.hasOwnProperty.call(args, required)) {
      throw new Error(`Missing required --${required.replace(/[A-Z]/g, c => `-${c.toLowerCase()}`)}`);
    }
  }
  if (!["auto", "vitest", "jest", "mocha"].includes(args.runner)) {
    throw new Error("--runner must be one of: auto, vitest, jest, mocha");
  }
  if (!REPLACEMENT_MODES.has(args.replacementMode)) {
    throw new Error("--replacement-mode must be one of: return-json, promise-json");
  }
  return args;
}

function isSecretEnvKey(key) {
  return /TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET[_-]?KEY|PASSPHRASE|CREDENTIAL|PIN|AUTH|COOKIE|SESSION/i.test(key);
}

// NODE_OPTIONS is the one --test-env key that can change how the runner Node LAUNCHES, so it
// is not enough to secret-filter it — every flag it carries must be on a fixed known-safe
// allowlist. This closes the hole where `--test-env NODE_OPTIONS=--require=/evil.js` (or
// --loader/--import/--inspect) would ride through the generic secret filter. The check lives
// at THIS spike boundary so a direct caller (not just autoProve) cannot bypass it.
const ALLOWED_NODE_OPTION = /^(?:--experimental-sqlite|--no-warnings|--max-old-space-size=\d+)$/;

function assertAllowedNodeOptions(value) {
  const flags = String(value).trim().split(/\s+/).filter(Boolean);
  if (flags.length === 0) {
    throw new Error("--test-env NODE_OPTIONS must not be empty");
  }
  for (const flag of flags) {
    if (!ALLOWED_NODE_OPTION.test(flag)) {
      throw new Error(
        `--test-env NODE_OPTIONS only permits --experimental-sqlite, --no-warnings, --max-old-space-size=<n>; rejected: ${redactSecrets(flag)}`
      );
    }
  }
}

function parseTestEnv(entries) {
  const env = {};
  for (const entry of entries ?? []) {
    const index = entry.indexOf("=");
    if (index <= 0) {
      throw new Error("--test-env must be formatted as KEY=value");
    }
    const key = entry.slice(0, index);
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) {
      throw new Error(`Invalid --test-env key: ${key}`);
    }
    if (isSecretEnvKey(key)) {
      throw new Error(`Secret-looking --test-env key is not allowed: ${key}`);
    }
    const value = entry.slice(index + 1);
    if (key === "NODE_OPTIONS") {
      assertAllowedNodeOptions(value);
    }
    env[key] = value;
  }
  return env;
}

function parseTimeoutMs(value) {
  if (value === undefined) {
    return DEFAULT_TIMEOUT_MS;
  }
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--timeout-ms must be a positive integer");
  }
  return parsed;
}

function parseSafeReplacement(replacementBody) {
  const trimmed = replacementBody.trim();
  if (trimmed === "") {
    return { expr: null };
  }
  if (trimmed.length > MAX_REPLACEMENT_CHARS) {
    throw new Error(`--replacement is too large; max ${MAX_REPLACEMENT_CHARS} characters`);
  }
  const match = /^return[ \t]+([^\r\n\u2028\u2029]+)$/.exec(trimmed);
  if (!match) {
    throw new Error("--replacement must be an inert sentinel: empty or a single return of a literal value");
  }
  const expr = match[1].replace(/;$/, "").trim();
  if (!expr) {
    throw new Error("--replacement return must include a literal value");
  }
  let parsed;
  try {
    parsed = JSON.parse(expr);
  } catch {
    throw new Error("--replacement must be a single return of a JSON literal; no statements, calls, comments, or trailing code are allowed");
  }
  assertSafeJsonLiteral(parsed);
  return { expr };
}

function buildReplacementBody(replacementBody, mode) {
  const { expr } = parseSafeReplacement(replacementBody);
  if (expr === null) {
    return "";
  }
  if (mode === "return-json") {
    return `return ${expr};`;
  }
  if (mode === "promise-json") {
    return `return Promise.resolve(${expr});`;
  }
  throw new Error("--replacement-mode must be one of: return-json, promise-json");
}

function assertSafeJsonLiteral(value, depth = 0) {
  if (depth > MAX_REPLACEMENT_JSON_DEPTH) {
    throw new Error(`--replacement JSON literal is too deeply nested; max depth ${MAX_REPLACEMENT_JSON_DEPTH}`);
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      assertSafeJsonLiteral(item, depth + 1);
    }
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, nested] of Object.entries(value)) {
      if (key === "__proto__" || key === "prototype" || key === "constructor") {
        throw new Error("--replacement JSON literal may not include prototype-shaped keys");
      }
      assertSafeJsonLiteral(nested, depth + 1);
    }
  }
}

function resolveInside(root, relOrAbs) {
  const resolved = path.resolve(root, relOrAbs);
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`Path escapes root: ${relOrAbs}`);
  }
  return resolved;
}

// ── M-1: mirror the tsconfig `extends` chain into the sandbox ──────────────────────
// A monorepo package's tsconfig commonly does `extends: "../../tsconfig.json"`. The
// isolated single-package copy loses that parent, so vite/oxc throws "Tsconfig not found"
// and the suite fails to TRANSFORM (0 tests) before any body runs → every baseline red.
// To let the baseline transform we mirror the minimal monorepo subtree: copy the package
// to tmpRoot/mono/<rel(R, package)> and copy each RELATIVE parent config's BYTES to
// tmpRoot/mono/<rel(R, parent)>, where R = the common ancestor. This ONLY changes WHAT is
// present so compilation can succeed; the proof gate (mutation/baseline/mutant/classify)
// is untouched. Parents are copied as bytes (never writably symlinked), so a test that
// writes to a parent path mutates only the disposable sandbox, never the user checkout.
const TSCONFIG_EXTENDS_MAX_DEPTH = 8;
const TSCONFIG_MAX_PARENT_FILES = 16;
const TSCONFIG_MAX_PARENT_UP_LEVELS = 8;
const TSCONFIG_REFERENCE_MAX_DEPTH = 8;
const TSCONFIG_MAX_REFERENCE_FILES = 128;

class TsconfigMirrorAbort extends Error {}

function stripJsonComments(text) {
  let out = "";
  let inString = false;
  let quote = "";
  let inLine = false;
  let inBlock = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    const next = text[i + 1];
    if (inLine) {
      if (ch === "\n") {
        inLine = false;
        out += ch;
      }
      continue;
    }
    if (inBlock) {
      if (ch === "*" && next === "/") {
        inBlock = false;
        i += 1;
      }
      continue;
    }
    if (inString) {
      out += ch;
      if (ch === "\\") {
        out += next ?? "";
        i += 1;
        continue;
      }
      if (ch === quote) {
        inString = false;
      }
      continue;
    }
    if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
      out += ch;
      continue;
    }
    if (ch === "/" && next === "/") {
      inLine = true;
      i += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlock = true;
      i += 1;
      continue;
    }
    out += ch;
  }
  return out.replace(/,(\s*[}\]])/g, "$1");
}

function readTsconfigExtends(configAbs) {
  // Defensive JSONC parse; on any failure treat as no-extends (fail-safe).
  let raw;
  try {
    raw = readFileSync(configAbs, "utf8");
  } catch {
    return [];
  }
  let parsed;
  try {
    parsed = JSON.parse(stripJsonComments(raw));
  } catch {
    return [];
  }
  const ext = parsed?.extends;
  if (typeof ext === "string") {
    return [ext];
  }
  if (Array.isArray(ext)) {
    return ext.filter(entry => typeof entry === "string");
  }
  return [];
}

function isInsideDir(root, candidate) {
  const relative = path.relative(root, candidate);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

function resolveExtendsTarget(fromDir, value) {
  // null → bare module (resolved from node_modules, #167); throws → policy violation.
  if (path.isAbsolute(value)) {
    throw new TsconfigMirrorAbort("absolute extends is not mirrored");
  }
  if (!value.startsWith(".")) {
    return null;
  }
  const base = path.resolve(fromDir, value);
  const candidates = value.endsWith(".json") ? [base] : [`${base}.json`];
  const found = candidates.find(candidate => existsSync(candidate) && lstatSync(candidate).isFile());
  if (!found) {
    throw new TsconfigMirrorAbort(`unresolvable extends: ${value}`);
  }
  return found;
}

function assertWithinUpBound(packageRoot, target) {
  const upLevels = path.relative(packageRoot, target).split(path.sep).filter(segment => segment === "..").length;
  if (upLevels > TSCONFIG_MAX_PARENT_UP_LEVELS) {
    throw new TsconfigMirrorAbort("parent config is above the plausible monorepo root");
  }
}

function collectExtendsParents(packageRoot) {
  // Absolute paths of RELATIVE parent configs OUTSIDE the package, following the extends
  // chain (string or TS5+ array). Throws TsconfigMirrorAbort on any policy violation.
  const entry = path.join(packageRoot, "tsconfig.json");
  if (!existsSync(entry)) {
    return [];
  }
  const externalParents = [];
  const visited = new Set();
  const walk = (configAbs, depth) => {
    if (visited.has(configAbs)) {
      return;
    }
    visited.add(configAbs);
    if (depth > TSCONFIG_EXTENDS_MAX_DEPTH) {
      throw new TsconfigMirrorAbort("extends chain is too deep");
    }
    const configDir = path.dirname(configAbs);
    for (const value of readTsconfigExtends(configAbs)) {
      const target = resolveExtendsTarget(configDir, value);
      if (target === null) {
        continue;
      }
      if (!isInsideDir(packageRoot, target)) {
        assertWithinUpBound(packageRoot, target);
        if (!externalParents.includes(target)) {
          externalParents.push(target);
          if (externalParents.length > TSCONFIG_MAX_PARENT_FILES) {
            throw new TsconfigMirrorAbort("too many parent configs");
          }
        }
      }
      walk(target, depth + 1);
    }
  };
  walk(entry, 0);
  return externalParents;
}

function readTsconfigReferences(configAbs) {
  const refs = readTsconfigObject(configAbs)?.references;
  if (!Array.isArray(refs)) {
    return [];
  }
  return refs
    .map(ref => (ref && typeof ref === "object" && typeof ref.path === "string" ? ref.path : null))
    .filter(Boolean);
}

function resolveProjectReferenceTarget(fromDir, value) {
  if (path.isAbsolute(value)) {
    throw new TsconfigMirrorAbort("absolute project reference is not mirrored");
  }
  if (!value.startsWith(".")) {
    return null;
  }
  const base = path.resolve(fromDir, value);
  const candidates = value.endsWith(".json")
    ? [base]
    : [path.join(base, "tsconfig.json"), `${base}.json`];
  const found = candidates.find(candidate => existsSync(candidate) && lstatSync(candidate).isFile());
  if (!found) {
    throw new TsconfigMirrorAbort(`unresolvable project reference: ${value}`);
  }
  return found;
}

function collectProjectReferenceMetadata(packageRoot, workspaceRoot) {
  // Vite/OXC may load tsconfig project references while transforming setup files. Even when a
  // referenced workspace package is type-only or copied as built output, its tsconfig/package
  // metadata must exist at the mirrored relative path. Copy metadata only; never source/runtime bytes.
  const entry = path.join(packageRoot, "tsconfig.json");
  if (!existsSync(entry)) {
    return [];
  }
  const files = [];
  const visited = new Set();
  const addFile = file => {
    if (isInsideDir(packageRoot, file)) {
      return;
    }
    assertWithinUpBound(packageRoot, file);
    if (!isInsideDir(workspaceRoot, file)) {
      throw new TsconfigMirrorAbort("project reference escapes the workspace root");
    }
    if (!files.includes(file)) {
      files.push(file);
      if (files.length > TSCONFIG_MAX_REFERENCE_FILES) {
        throw new TsconfigMirrorAbort("too many project reference metadata files");
      }
    }
  };
  const walk = (configAbs, depth) => {
    if (visited.has(configAbs)) {
      return;
    }
    visited.add(configAbs);
    if (depth > TSCONFIG_REFERENCE_MAX_DEPTH) {
      throw new TsconfigMirrorAbort("project reference chain is too deep");
    }
    for (const value of readTsconfigReferences(configAbs)) {
      const target = resolveProjectReferenceTarget(path.dirname(configAbs), value);
      if (target === null) {
        continue;
      }
      addFile(target);
      const pkg = path.join(path.dirname(target), "package.json");
      if (existsSync(pkg) && lstatSync(pkg).isFile()) {
        addFile(pkg);
      }
      walk(target, depth + 1);
    }
  };
  walk(entry, 0);
  return files;
}

function commonAncestorDir(absPaths) {
  const splitPaths = absPaths.map(p => p.split(path.sep));
  const first = splitPaths[0];
  let end = first.length;
  for (const segments of splitPaths.slice(1)) {
    end = Math.min(end, segments.length);
    for (let i = 0; i < end; i += 1) {
      if (segments[i] !== first[i]) {
        end = i;
        break;
      }
    }
  }
  const ancestor = first.slice(0, end).join(path.sep);
  return ancestor === "" ? path.sep : ancestor;
}

// ── M-2: honor tsconfig `paths` — copy the aliased sibling SOURCE + inject the runner alias ──────
// A monorepo package commonly imports a sibling package's SOURCE via a tsconfig `paths` alias
// (e.g. "@b/*": ["../b/src/*"]). esbuild/vitest/jest do NOT honor tsconfig `paths`, so in the
// isolated single-package copy the aliased import doesn't resolve → baseline red. M-2 (1) COPIES
// the referenced sibling source (bytes, into the disposable sandbox mono tree — never a writable
// symlink into the user checkout) and (2) injects the mapping into the runner resolver
// (Vitest `resolve.alias` / Jest `moduleNameMapper`) via a generated, MERGED config. This ONLY
// changes what is present + how imports resolve; the proof gate (mutation/baseline/mutant/classify)
// is untouched. Any policy violation → TsconfigMirrorAbort → mirror nothing → honest unrunnable.
const TSCONFIG_MAX_PATH_ENTRIES = 64;
const TSCONFIG_MAX_ALIAS_FILES = 5000;
const TSCONFIG_MAX_ALIAS_BYTES = 64 * 1024 * 1024;
const MIRROR_SKIP_DIRS = new Set(["node_modules", ".git", ".orangepro"]);
const GENERATED_VITEST_CONFIG = ".opro-dynamic-proof-vitest.config.mjs";
const GENERATED_JEST_CONFIG = ".opro-dynamic-proof-jest.config.cjs";
const GENERATED_MOCHA_TSCONFIG = ".opro-dynamic-proof-mocha.tsconfig.json";

function readTsconfigObject(configAbs) {
  // Defensive JSONC parse of a whole tsconfig; on any failure return null (fail-safe → no paths).
  let raw;
  try {
    raw = readFileSync(configAbs, "utf8");
  } catch {
    return null;
  }
  try {
    return JSON.parse(stripJsonComments(raw));
  } catch {
    return null;
  }
}

function resolvePathAliasTarget(packageRoot, baseUrl, key, rawTarget) {
  // Resolve a tsconfig `paths` target (relative to baseUrl). Returns null for in-package /
  // node_modules-backed targets (out of M-2 scope). Throws TsconfigMirrorAbort for an external
  // target that can't be resolved on disk or sits above the plausible monorepo root.
  const starIndex = rawTarget.indexOf("*");
  const prefix = starIndex === -1 ? rawTarget : rawTarget.slice(0, starIndex);
  const absTarget = path.resolve(baseUrl, prefix);
  if (absTarget.split(path.sep).includes("node_modules")) {
    return null;
  }
  if (absTarget === packageRoot || isInsideDir(packageRoot, absTarget)) {
    return null;
  }
  assertWithinUpBound(packageRoot, absTarget);
  if (!existsSync(absTarget)) {
    throw new TsconfigMirrorAbort(`unresolvable path alias target: ${key}`);
  }
  return { key, star: starIndex !== -1, absTarget, isFile: lstatSync(absTarget).isFile() };
}

function collectPathAliases(packageRoot) {
  // Walk the same extends chain (package first, then parents) and collect the RELATIVE `paths`
  // targets that resolve to sibling SOURCE OUTSIDE the package. The package's own mapping wins over
  // a parent's for the same key. Throws TsconfigMirrorAbort on any policy violation → mirror nothing.
  const entry = path.join(packageRoot, "tsconfig.json");
  if (!existsSync(entry)) {
    return [];
  }
  const collected = [];
  const seenKeys = new Set();
  const visited = new Set();
  const walk = (configAbs, depth) => {
    if (visited.has(configAbs)) {
      return;
    }
    visited.add(configAbs);
    if (depth > TSCONFIG_EXTENDS_MAX_DEPTH) {
      throw new TsconfigMirrorAbort("extends chain is too deep");
    }
    const configDir = path.dirname(configAbs);
    const compilerOptions = readTsconfigObject(configAbs)?.compilerOptions ?? {};
    const baseUrl = typeof compilerOptions.baseUrl === "string"
      ? path.resolve(configDir, compilerOptions.baseUrl)
      : configDir;
    const paths = compilerOptions.paths;
    if (paths && typeof paths === "object") {
      for (const [key, targets] of Object.entries(paths)) {
        if (seenKeys.has(key) || !Array.isArray(targets)) {
          continue;
        }
        for (const rawTarget of targets) {
          if (typeof rawTarget !== "string") {
            continue;
          }
          const info = resolvePathAliasTarget(packageRoot, baseUrl, key, rawTarget);
          if (info === null) {
            continue;
          }
          seenKeys.add(key);
          collected.push(info);
          if (collected.length > TSCONFIG_MAX_PATH_ENTRIES) {
            throw new TsconfigMirrorAbort("too many path aliases");
          }
          break;
        }
      }
    }
    for (const value of readTsconfigExtends(configAbs)) {
      const target = resolveExtendsTarget(configDir, value);
      if (target !== null) {
        walk(target, depth + 1);
      }
    }
  };
  walk(entry, 0);
  return collected;
}

function assertAliasBudget(aliases) {
  // Pre-scan the unique alias target dirs and abort BEFORE any copy if they exceed the file/byte
  // caps, so an over-cap alias mirrors nothing (never a half-copied sandbox).
  const seen = new Set();
  let files = 0;
  let bytes = 0;
  const visit = source => {
    const stat = lstatSync(source);
    if (stat.isSymbolicLink()) {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(source)) {
        if (!MIRROR_SKIP_DIRS.has(name)) {
          visit(path.join(source, name));
        }
      }
      return;
    }
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
      if (files > TSCONFIG_MAX_ALIAS_FILES) {
        throw new TsconfigMirrorAbort("aliased source has too many files");
      }
      if (bytes > TSCONFIG_MAX_ALIAS_BYTES) {
        throw new TsconfigMirrorAbort("aliased source is too large");
      }
    }
  };
  for (const alias of aliases) {
    if (!seen.has(alias.absTarget)) {
      seen.add(alias.absTarget);
      visit(alias.absTarget);
    }
  }
}

function copyAliasTarget(absTarget, dest, isFile) {
  mkdirSync(path.dirname(dest), { recursive: true });
  if (isFile) {
    writeFileSync(dest, readFileSync(absTarget));
    return;
  }
  cpSync(absTarget, dest, {
    recursive: true,
    filter(source) {
      if (lstatSync(source).isSymbolicLink()) {
        return false;
      }
      return !MIRROR_SKIP_DIRS.has(path.basename(source));
    }
  });
}

function copyRuntimeAliasTarget(absTarget, dest, isFile) {
  const isRuntimeFile = file => /\.(?:js|jsx|mjs|cjs|json)$/.test(file);
  mkdirSync(path.dirname(dest), { recursive: true });
  if (isFile) {
    if (isRuntimeFile(absTarget)) {
      writeFileSync(dest, readFileSync(absTarget));
    }
    return;
  }
  cpSync(absTarget, dest, {
    recursive: true,
    filter(source) {
      if (lstatSync(source).isSymbolicLink()) {
        return false;
      }
      const name = path.basename(source);
      if (MIRROR_SKIP_DIRS.has(name)) {
        return false;
      }
      if (lstatSync(source).isDirectory()) {
        return true;
      }
      return isRuntimeFile(source);
    }
  });
}

function copyFixtureRoot(root, label, { linkNodeModules, workspaceRoot }) {
  const tmpRoot = mkdtempSync(path.join(tmpdir(), `opro-dynamic-proof-${label}-`));
  const monoRoot = path.join(tmpRoot, "mono");
  // On any policy violation, mirror nothing → package lands alone at tmpRoot/mono with its
  // dangling extends / unresolved alias → baseline fails to transform/resolve → honest
  // tsconfig_missing / unrunnable (M-4). Extends (M-1) and paths (M-2) share one fail-safe.
  let parents = [];
  let aliases = [];
  try {
    parents = collectExtendsParents(root);
    aliases = collectPathAliases(root);
    assertAliasBudget(aliases);
  } catch (error) {
    if (!(error instanceof TsconfigMirrorAbort)) {
      throw error;
    }
    parents = [];
    aliases = [];
  }
  // M-3 (aspect 2): discover the sibling workspace-dep closure + package-local runner config helpers, each
  // under its OWN fail-safe (a workspace policy violation mirrors no siblings/helpers → honest unrunnable,
  // without discarding the M-1/M-2 tsconfig extends/paths mirror). Sibling enumeration is skipped unless the
  // target declares at least one dep, so single-package / dep-less packages pay nothing.
  let siblingPlans = [];
  try {
    if (workspaceRoot && workspaceRoot !== root && workspaceDepNames(readPackageJson(root), true).length > 0) {
      const members = enumerateWorkspaceMembers(workspaceRoot);
      // planSiblingCopy returns null for a type-only sibling (skipped, not aborted) — drop those.
      siblingPlans = collectWorkspaceSiblings(root, members)
        .map(sibling => planSiblingCopy(sibling.name, sibling.root))
        .filter(Boolean);
      assertSiblingBudget(siblingPlans);
    }
  } catch (error) {
    if (!(error instanceof WorkspaceMirrorAbort)) {
      throw error;
    }
    siblingPlans = [];
  }
  // §4a config-helper collection is INDEPENDENT of sibling resolution (Codex #182): an unresolved/over-cap
  // workspace SIBLING must not suppress a package-local runner config's workspace-root helper, and vice
  // versa. Each fails closed to its own empty mirror with its own reason.
  let configHelpers = [];
  try {
    configHelpers = collectConfigHelpers(root, workspaceRoot ?? root);
  } catch (error) {
    if (!(error instanceof WorkspaceMirrorAbort)) {
      throw error;
    }
    configHelpers = [];
  }
  // TypeScript project references are config metadata, not runtime evidence. Keep them under their own
  // fail-safe so a bad reference cannot discard working sibling/config-helper mirrors.
  let projectReferenceFiles = [];
  try {
    projectReferenceFiles = collectProjectReferenceMetadata(root, workspaceRoot ?? root);
  } catch (error) {
    if (!(error instanceof TsconfigMirrorAbort)) {
      throw error;
    }
    projectReferenceFiles = [];
  }
  // M-3: fold the detected workspace root (+ sibling roots + config-helper/reference paths) into the common ancestor
  // so each is materialized at its own tmpRoot/mono/<rel(R, path)> position ABOVE the package copy
  // (workspaceRoot is an ancestor of root, so this only ever pulls R up; for single-package repos
  // workspaceRoot === root and there are no siblings/helpers → no change).
  const ancestor = commonAncestorDir([
    root,
    ...parents,
    ...aliases.map(alias => alias.absTarget),
    ...siblingPlans.map(plan => plan.siblingRoot),
    ...configHelpers,
    ...projectReferenceFiles,
    workspaceRoot ?? root
  ]);
  const repoRoot = path.join(monoRoot, path.relative(ancestor, root));
  mkdirSync(path.dirname(repoRoot), { recursive: true });
  cpSync(root, repoRoot, {
    recursive: true,
    filter(source) {
      const name = path.basename(source);
      if (source !== root && lstatSync(source).isSymbolicLink()) {
        return false;
      }
      return name !== "node_modules" && name !== ".git" && name !== ".orangepro";
    }
  });
  for (const parent of parents) {
    const dest = path.join(monoRoot, path.relative(ancestor, parent));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(parent));
  }
  for (const file of projectReferenceFiles) {
    const dest = path.join(monoRoot, path.relative(ancestor, file));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(file));
  }
  // M-2: copy each unique aliased sibling target as bytes and map its key → sandbox location.
  const copiedTargets = new Map();
  const aliasEntries = [];
  const siblingNames = new Set(siblingPlans.map(plan => plan.name));
  const aliasPackageName = key => {
    const clean = String(key ?? "").replace(/\/\*$/, "");
    if (clean.startsWith("@")) {
      const parts = clean.split("/");
      return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : clean;
    }
    return clean.split("/", 1)[0] ?? clean;
  };
  for (const alias of aliases) {
    if (siblingNames.has(aliasPackageName(alias.key))) {
      continue;
    }
    let replacement = copiedTargets.get(alias.absTarget);
    if (replacement === undefined) {
      replacement = path.join(monoRoot, path.relative(ancestor, alias.absTarget));
      copyAliasTarget(alias.absTarget, replacement, alias.isFile);
      copiedTargets.set(alias.absTarget, replacement);
    }
    aliasEntries.push({ key: alias.key, star: alias.star, replacement });
  }
  // M-3 (aspect 2): copy each sibling's built output / source as bytes into its mirrored mono position and
  // inject the package-name resolver aliases. Order matters: the bare entry (exact) and each `exports`
  // subpath (exact) precede the catch-all star so `@pkg` and `@pkg/known` hit the copied file while
  // `@pkg/deep` still resolves relative to the copied root. Injected via the same aliasEntries the M-2
  // resolver consumes, so the COPY wins over the read-only workspace-root node_modules link.
  for (const plan of siblingPlans) {
    const destRoot = path.join(monoRoot, path.relative(ancestor, plan.siblingRoot));
    copyAliasTarget(path.join(plan.siblingRoot, "package.json"), path.join(destRoot, "package.json"), true);
    if (plan.isSource) {
      const tsconfig = path.join(plan.siblingRoot, "tsconfig.json");
      if (existsSync(tsconfig)) {
        copyAliasTarget(tsconfig, path.join(destRoot, "tsconfig.json"), true);
      }
    }
    for (const segment of plan.segments) {
      const source = path.join(plan.siblingRoot, segment);
      if (existsSync(source)) {
        const isFile = lstatSync(source).isFile();
        if (plan.runtimeOnly) {
          copyRuntimeAliasTarget(source, path.join(destRoot, segment), isFile);
        } else {
          copyAliasTarget(source, path.join(destRoot, segment), isFile);
        }
      }
    }
    aliasEntries.push({ key: plan.name, star: false, replacement: path.join(destRoot, plan.entryRel) });
    for (const sub of plan.subpathAliases) {
      aliasEntries.push({ key: `${plan.name}/${sub.subpath}`, star: false, replacement: path.join(destRoot, sub.targetRel) });
    }
    aliasEntries.push({ key: `${plan.name}/*`, star: true, replacement: destRoot });
  }
  // M-3 (aspect 2, §4a): copy the bounded RELATIVE config-helper closure as bytes into the same mirrored
  // positions so a package-local runner config that requires a workspace-root helper loads (never a symlink).
  for (const helper of configHelpers) {
    const dest = path.join(monoRoot, path.relative(ancestor, helper));
    mkdirSync(path.dirname(dest), { recursive: true });
    writeFileSync(dest, readFileSync(helper));
  }
  const sourceNodeModules = path.join(root, "node_modules");
  if (linkNodeModules && existsSync(sourceNodeModules)) {
    symlinkSync(sourceNodeModules, path.join(repoRoot, "node_modules"), "dir");
  }
  // M-3: additionally link the WORKSPACE-ROOT node_modules at its own ancestor position so a HOISTED
  // runner + deps resolve by walking up from the package copy. Same read-only dependency-cache trust
  // class as the package-local link above (#167): symlinked, not write-isolated. No sibling SOURCE is
  // copied — only the dependency cache is exposed at an ancestor directory.
  if (linkNodeModules && workspaceRoot && workspaceRoot !== root) {
    const workspaceNodeModules = path.join(workspaceRoot, "node_modules");
    if (existsSync(workspaceNodeModules)) {
      const workspaceRootDest = path.join(monoRoot, path.relative(ancestor, workspaceRoot));
      mkdirSync(workspaceRootDest, { recursive: true });
      const destNodeModules = path.join(workspaceRootDest, "node_modules");
      if (!existsSync(destNodeModules)) {
        symlinkSync(workspaceNodeModules, destNodeModules, "dir");
      }
    }
  }
  return { tmpRoot, repoRoot, monoRoot, aliases: aliasEntries };
}

function findMatchingBrace(source, openBraceIndex) {
  let depth = 0;
  for (let i = openBraceIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return i;
      }
    }
  }
  throw new Error("Could not find closing brace for target method");
}

function mutateMethod(targetAbs, method, replacementBody) {
  const source = readFileSync(targetAbs, "utf8");
  const escaped = method.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Class methods + function declarations: `<name>(params)[: ret] {`.
  const methodRe = new RegExp(`((?:async\\s+)?${escaped}\\s*(?:<[^\\n\\{]+>)?\\s*\\([^)]*\\)\\s*(?::\\s*[^\\{]+)?\\s*)\\{`, "gm");
  // Name-bound block functions the methodRe cannot see (there is `= …` between name and `(`):
  //   arrow-const block      — `export const foo = (c) => { … }`
  //   function expression    — `const foo = function (c) { … }` (anonymous)
  // A NAMED function expression whose inner name matches (`const foo = function foo(c) { … }`) is safely
  // REFUSED as ambiguous: methodRe ALSO matches the inner `foo(c) {`, so the union yields 2 candidates →
  // "Ambiguous method" → unrunnable. Conservative fail-safe, never a false proof.
  // GUARDRAIL 2: the alternation requires EITHER `=>` OR `function` — a bare `const foo = 5;` never matches.
  const freeFnRe = new RegExp(
    `(^|\\n)([ \\t]*(?:export\\s+)?(?:const|let|var)\\s+${escaped}\\s*(?::\\s*[^=\\n]+)?\\s*=\\s*(?:(?:async\\s+)?(?:<[^(\\n{]+>\\s*)?\\([^)]*\\)\\s*(?::\\s*[^={]+)?\\s*=>\\s*|(?:async\\s+)?function\\s*(?:${escaped})?\\s*(?:<[^(\\n{]+>\\s*)?\\([^)]*\\)\\s*(?::\\s*[^={]+)?\\s*)\\{)`,
    "gm"
  );
  // UNION both forms, normalized to { index (declaration start), text (ends at the opening `{`) }, then the
  // SAME ambiguity guard across forms. GUARDRAIL 1: the freeFnRe candidate starts at const/let/var, NOT the
  // captured line separator (group 1), so the indent logic below sees the same slice shape as methodRe.
  const candidates = [
    ...[...source.matchAll(methodRe)].map(m => ({ index: m.index, text: m[0] })),
    ...[...source.matchAll(freeFnRe)].map(m => ({ index: m.index + m[1].length, text: m[2] }))
  ];
  if (candidates.length > 1) {
    throw new Error(`Ambiguous method ${method} in ${targetAbs}: ${candidates.length} matches`);
  }
  const candidate = candidates[0];
  if (!candidate || candidate.index === undefined) {
    throw new Error(`Could not find method ${method} in ${targetAbs}`);
  }
  const openBraceIndex = candidate.index + candidate.text.length - 1;
  const closeBraceIndex = findMatchingBrace(source, openBraceIndex);
  const indentMatch = source.slice(0, candidate.index).match(/(^|\n)([ \t]*)[^\n]*$/);
  const indent = indentMatch?.[2] ?? "";
  const bodyIndent = `${indent}  `;
  const replacement = `{\n${bodyIndent}${replacementBody.trim()}\n${indent}}`;
  const mutated = `${source.slice(0, openBraceIndex)}${replacement}${source.slice(closeBraceIndex + 1)}`;
  writeFileSync(targetAbs, mutated);
}

function firstExisting(paths) {
  return paths.find(candidate => existsSync(candidate)) ?? paths[0];
}

function localToolRoot() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.resolve(scriptDir, "../..");
}

function defaultVitestBin(root, workspaceRoot) {
  return firstExisting([
    path.join(root, "node_modules/vitest/vitest.mjs"),
    ...(workspaceRoot && workspaceRoot !== root
      ? [path.join(workspaceRoot, "node_modules/vitest/vitest.mjs")]
      : []),
    path.join(localToolRoot(), "node_modules/vitest/vitest.mjs")
  ]);
}

function defaultJestBin(root, workspaceRoot) {
  return firstExisting([
    path.join(root, "node_modules/jest/bin/jest.js"),
    ...(workspaceRoot && workspaceRoot !== root
      ? [path.join(workspaceRoot, "node_modules/jest/bin/jest.js")]
      : []),
    path.join(localToolRoot(), "node_modules/jest/bin/jest.js")
  ]);
}

function defaultMochaBin(root, workspaceRoot) {
  return firstExisting([
    path.join(root, "node_modules/mocha/bin/mocha.js"),
    ...(workspaceRoot && workspaceRoot !== root
      ? [path.join(workspaceRoot, "node_modules/mocha/bin/mocha.js")]
      : []),
    path.join(localToolRoot(), "node_modules/mocha/bin/mocha.js")
  ]);
}

function hasMochaConfig(root) {
  const pkg = readPackageJson(root);
  return Boolean(pkg?.mocha) || hasAnyFile(root, [
    ".mocharc.js",
    ".mocharc.cjs",
    ".mocharc.mjs",
    ".mocharc.json"
  ]);
}

function dynamicProofReporterPath() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(scriptDir, "dynamic-proof-vitest-reporter.mjs");
}

function dynamicProofJestReporterPath() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(scriptDir, "dynamic-proof-jest-reporter.cjs");
}

function dynamicProofMochaReporterPath() {
  const scriptDir = path.dirname(fileURLToPath(import.meta.url));
  return path.join(scriptDir, "dynamic-proof-mocha-reporter.cjs");
}

function readPackageJson(root) {
  try {
    return JSON.parse(readFileSync(path.join(root, "package.json"), "utf8"));
  } catch {
    return null;
  }
}

function hasAnyFile(root, names) {
  return names.some(name => existsSync(path.join(root, name)));
}

function packageText(pkg) {
  if (!pkg) {
    return "";
  }
  return JSON.stringify({
    scripts: pkg.scripts ?? {},
    dependencies: pkg.dependencies ?? {},
    devDependencies: pkg.devDependencies ?? {},
    jest: pkg.jest,
    vitest: pkg.vitest
  });
}

function hasPackageDependency(pkg, names) {
  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.devDependencies ?? {}),
    ...(pkg?.peerDependencies ?? {}),
    ...(pkg?.optionalDependencies ?? {})
  };
  return names.some(name => Object.prototype.hasOwnProperty.call(deps, name));
}

// ── M-3 (aspect 1): detect the TS/JS workspace root so a hoisted runner + dependency cache resolve ──
// A focused package inside a monorepo (e.g. a Medusa package) carries no package-local node_modules —
// the runner (jest/vitest) and its deps are HOISTED to the workspace root. Walk UP from the package
// root to the nearest ancestor that declares a workspace (npm/yarn/bun `workspaces`, or a
// pnpm-workspace.yaml); fall back to the package root when none is found within bounds (single-package
// repos like Hono → no-op). Detection only relocates WHERE node_modules is linked/resolved; a wrong
// guess makes the dependency fail to resolve → honest unrunnable, never a false proof, so workspace
// glob-membership need not be checked here.
const WORKSPACE_DETECT_MAX_UP_LEVELS = 12;

function packageDeclaresWorkspaces(dir) {
  const pkg = readPackageJson(dir);
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) {
    return ws.length > 0;
  }
  // yarn classic shape: { "workspaces": { "packages": [...] } }
  if (ws && typeof ws === "object" && Array.isArray(ws.packages)) {
    return ws.packages.length > 0;
  }
  return false;
}

function isWorkspaceRootDir(dir) {
  return (
    packageDeclaresWorkspaces(dir) ||
    existsSync(path.join(dir, "pnpm-workspace.yaml")) ||
    existsSync(path.join(dir, "pnpm-workspace.yml")) ||
    existsSync(path.join(dir, "lerna.json"))
  );
}

function detectWorkspaceRoot(packageRoot) {
  let dir = path.dirname(packageRoot);
  for (let level = 0; level < WORKSPACE_DETECT_MAX_UP_LEVELS; level += 1) {
    if (isWorkspaceRootDir(dir)) {
      return dir;
    }
    const parent = path.dirname(dir);
    if (parent === dir) {
      break;
    }
    dir = parent;
  }
  return packageRoot;
}

// ── M-3 (aspect 2): resolve TS/JS WORKSPACE PACKAGE deps — copy sibling output/source + config helpers ──
// A focused monorepo package imports SIBLING workspace packages by package NAME (e.g. Medusa's
// `@medusajs/*`). In the isolated single-package sandbox those bare imports don't resolve (no local
// node_modules, and the name is not a published package), so the baseline fails to resolve → red. Aspect-2
// (1) discovers the target's DECLARED workspace-dep closure — direct deps + a bounded transitive closure of
// workspace-dep-of-workspace-dep, NEVER a published npm package; (2) for each sibling copies its BUILT
// output (dist subtree + package.json) when the runtime entry is built, else its SOURCE (src + tsconfig),
// as bytes into the disposable sandbox mono tree; and (3) injects a package-name resolver alias (bare entry
// + exact `exports` subpaths + catch-all) — reusing M-2's Vitest resolve.alias / Jest moduleNameMapper
// injection — so the COPY resolves and WINS over the read-only workspace-root node_modules link (runner
// aliases resolve before node_modules). It also copies a bounded closure of RELATIVE helpers required by
// package-local runner CONFIG files (the Medusa `jest.config.js → ../../../define_jest_config` shape).
// This ONLY changes what is present + how imports resolve; the proof gate (mutation/baseline/mutant/
// classify) is untouched. Any cap/ambiguity/cycle/unresolved entry → WorkspaceMirrorAbort → mirror nothing
// → the bare import stays unresolved → honest unrunnable, never a false proof. The credited mutation still
// touches ONLY the target file, in the mutant copy.
const SIBLING_MAX_PACKAGES = 32;
const SIBLING_MAX_DEPTH = 3;
const SIBLING_MAX_FILES = 20_000;
const SIBLING_MAX_BYTES = 128 * 1024 * 1024;
const WORKSPACE_GLOB_MAX_DIRS = 4096;
const CONFIG_HELPER_MAX_DEPTH = 3;
const CONFIG_HELPER_MAX_FILES = 32;
const CONFIG_HELPER_MAX_BYTES = 2 * 1024 * 1024;
const RUNTIME_EXPORT_CONDITIONS = ["node", "import", "require", "default", "module"];
const RUNNER_CONFIG_FILES = [
  "package.json",
  "tsconfig.json",
  "tsconfig.spec.json",
  ".mocharc.js", ".mocharc.cjs", ".mocharc.mjs", ".mocharc.json",
  "jest.config.js", "jest.config.cjs", "jest.config.mjs", "jest.config.ts", "jest.config.json",
  "vitest.config.js", "vitest.config.cjs", "vitest.config.mjs", "vitest.config.ts", "vitest.config.mts",
  "vite.config.js", "vite.config.cjs", "vite.config.mjs", "vite.config.ts", "vite.config.mts"
];
const HELPER_RESOLVE_EXTS = ["", ".js", ".cjs", ".mjs", ".ts", ".cts", ".mts", ".json"];

class WorkspaceMirrorAbort extends Error {}

function safeReaddir(dir) {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
}

function isRealDir(candidate) {
  try {
    return lstatSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

function isRealFile(candidate) {
  try {
    return lstatSync(candidate).isFile();
  } catch {
    return false;
  }
}

function resolveFileWithin(root, rel) {
  // Resolve rel against root; return null (fail-safe) if it escapes root.
  const abs = path.resolve(root, rel);
  const relative = path.relative(root, abs);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return null;
  }
  return abs;
}

function workspaceDepNames(pkg, includeDev) {
  // Direct deps consider devDependencies too (a package can import a sibling only in its tests); the
  // transitive walk uses runtime deps only (dependencies + peerDependencies).
  const deps = {
    ...(pkg?.dependencies ?? {}),
    ...(pkg?.peerDependencies ?? {}),
    ...(includeDev ? (pkg?.devDependencies ?? {}) : {})
  };
  return Object.keys(deps);
}

function readWorkspacePatterns(workspaceRoot) {
  const pkg = readPackageJson(workspaceRoot);
  const ws = pkg?.workspaces;
  if (Array.isArray(ws)) {
    return ws.filter(entry => typeof entry === "string");
  }
  if (ws && typeof ws === "object" && Array.isArray(ws.packages)) {
    return ws.packages.filter(entry => typeof entry === "string");
  }
  for (const name of ["pnpm-workspace.yaml", "pnpm-workspace.yml"]) {
    const file = path.join(workspaceRoot, name);
    if (existsSync(file)) {
      return parsePnpmWorkspacePackages(file);
    }
  }
  const lernaFile = path.join(workspaceRoot, "lerna.json");
  if (existsSync(lernaFile)) {
    try {
      const lerna = JSON.parse(readFileSync(lernaFile, "utf8"));
      if (Array.isArray(lerna.packages)) {
        return lerna.packages.filter(entry => typeof entry === "string");
      }
    } catch {
      return [];
    }
  }
  return [];
}

function parsePnpmWorkspacePackages(file) {
  // Minimal YAML: collect the list items under the top-level `packages:` key. Fail-safe → [].
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const patterns = [];
  let inPackages = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^packages\s*:\s*$/.test(line)) {
      inPackages = true;
      continue;
    }
    if (!inPackages) {
      continue;
    }
    const item = /^\s*-\s*['"]?([^'"#\r\n]+?)['"]?\s*(?:#.*)?$/.exec(line);
    if (item) {
      patterns.push(item[1].trim());
      continue;
    }
    if (/^\S/.test(line)) {
      break; // a new top-level key ends the packages list
    }
  }
  return patterns;
}

function collectDirsRecursive(base, out, tick) {
  out.push(base);
  for (const name of safeReaddir(base)) {
    if (MIRROR_SKIP_DIRS.has(name)) {
      continue;
    }
    const child = path.join(base, name);
    if (isRealDir(child)) {
      tick();
      collectDirsRecursive(child, out, tick);
    }
  }
}

function expandWorkspaceGlob(workspaceRoot, pattern) {
  // Support literal segments, `*` (one dir), and `**` (any depth). Returns member dirs that contain a
  // package.json. Symlinked dirs are excluded (isRealDir). Throws WorkspaceMirrorAbort past the dir cap.
  const segments = pattern.split("/").filter(Boolean);
  let frontier = [workspaceRoot];
  let scanned = 0;
  const tick = () => {
    scanned += 1;
    if (scanned > WORKSPACE_GLOB_MAX_DIRS) {
      throw new WorkspaceMirrorAbort("workspace glob expands too many directories");
    }
  };
  for (const segment of segments) {
    const next = [];
    for (const base of frontier) {
      if (segment === "**") {
        collectDirsRecursive(base, next, tick);
      } else if (segment === "*") {
        for (const name of safeReaddir(base)) {
          if (MIRROR_SKIP_DIRS.has(name)) {
            continue;
          }
          const child = path.join(base, name);
          if (isRealDir(child)) {
            tick();
            next.push(child);
          }
        }
      } else {
        const child = path.join(base, segment);
        if (isRealDir(child)) {
          next.push(child);
        }
      }
    }
    frontier = next;
  }
  return frontier.filter(dir => existsSync(path.join(dir, "package.json")));
}

function enumerateWorkspaceMembers(workspaceRoot) {
  // Map packageName → packageRoot for members matched by the workspace globs. Negation globs (!glob) are
  // ignored. Throws WorkspaceMirrorAbort on a duplicate member name (ambiguous → fail closed).
  const members = new Map();
  const dirs = new Set();
  for (const pattern of readWorkspacePatterns(workspaceRoot)) {
    if (pattern.startsWith("!")) {
      continue;
    }
    for (const dir of expandWorkspaceGlob(workspaceRoot, pattern)) {
      dirs.add(dir);
    }
  }
  for (const dir of dirs) {
    const name = readPackageJson(dir)?.name;
    if (typeof name !== "string" || name === "") {
      continue;
    }
    const existing = members.get(name);
    if (existing !== undefined && existing !== dir) {
      throw new WorkspaceMirrorAbort(`ambiguous workspace member name: ${name}`);
    }
    members.set(name, dir);
  }
  return members;
}

function collectWorkspaceSiblings(packageRoot, members) {
  // BFS the DECLARED workspace-dep closure. A dep whose name is not a workspace member is a published
  // package → never copied. Throws WorkspaceMirrorAbort past the package cap. Returns [{ name, root }].
  const targetPkg = readPackageJson(packageRoot);
  if (!targetPkg) {
    return [];
  }
  const chosen = new Map();
  const queue = workspaceDepNames(targetPkg, true)
    .filter(name => members.has(name))
    .map(name => ({ name, depth: 1 }));
  while (queue.length > 0) {
    const { name, depth } = queue.shift();
    if (chosen.has(name)) {
      continue;
    }
    const root = members.get(name);
    if (root === undefined) {
      continue;
    }
    chosen.set(name, root);
    if (chosen.size > SIBLING_MAX_PACKAGES) {
      throw new WorkspaceMirrorAbort("too many workspace siblings");
    }
    if (depth >= SIBLING_MAX_DEPTH) {
      continue; // don't traverse deeper; a needed dep past the cap stays unresolved → honest unrunnable
    }
    for (const childName of workspaceDepNames(readPackageJson(root), false)) {
      if (members.has(childName) && !chosen.has(childName)) {
        queue.push({ name: childName, depth: depth + 1 });
      }
    }
  }
  return [...chosen.entries()].map(([name, root]) => ({ name, root }));
}

function resolveExportsCondition(value) {
  // Resolve an `exports` value (string or conditions object) to a RUNTIME target string. `types` is never
  // a runtime condition and is skipped. Returns null when unresolvable / blocked (a null export).
  if (typeof value === "string") {
    return value;
  }
  if (value && typeof value === "object" && !Array.isArray(value)) {
    for (const condition of RUNTIME_EXPORT_CONDITIONS) {
      if (Object.prototype.hasOwnProperty.call(value, condition)) {
        const resolved = resolveExportsCondition(value[condition]);
        if (resolved) {
          return resolved;
        }
      }
    }
  }
  return null;
}

function runtimeEntryRel(pkg) {
  // The sibling's RUNTIME entry: exports "." (or a bare conditions object), else main, else module, else
  // node's index.js default. `types` is type-only and is never the runtime entry.
  const exp = pkg?.exports;
  if (exp !== undefined) {
    if (typeof exp === "string") {
      return exp;
    }
    if (exp && typeof exp === "object" && !Array.isArray(exp)) {
      if (Object.prototype.hasOwnProperty.call(exp, ".")) {
        return resolveExportsCondition(exp["."]);
      }
      const keys = Object.keys(exp);
      if (keys.length > 0 && !keys.some(key => key.startsWith("."))) {
        return resolveExportsCondition(exp);
      }
    }
  }
  if (typeof pkg?.main === "string") {
    return pkg.main;
  }
  if (typeof pkg?.module === "string") {
    return pkg.module;
  }
  return "index.js";
}

function topLevelSegment(rel) {
  return rel.split("/").filter(Boolean)[0] ?? "";
}

function sourcePackageSegments(siblingRoot) {
  const skip = new Set([
    "node_modules",
    ".git",
    ".orangepro",
    "test",
    "tests",
    "__tests__",
    "coverage",
    "dist"
  ]);
  return safeReaddir(siblingRoot).filter(name => {
    if (skip.has(name)) {
      return false;
    }
    const abs = path.join(siblingRoot, name);
    if (isRealDir(abs)) {
      return true;
    }
    return /\.(?:ts|tsx|cts|mts|js|jsx|cjs|mjs|json)$/.test(name);
  });
}

function isTypeOnlyPackage(pkg) {
  // A TYPE-ONLY workspace package declares type information (`types`/`typings`) and NO usable runtime
  // entry. BLANK runtime fields do NOT count as a runtime entry — Medplum's @medplum/fhirtypes ships
  // `{ "main": "", "types": "dist/index.d.ts" }`, and `main: ""` / `module: ""` / `exports: null` all mean
  // "no runtime entry". Conservative: a NON-empty runtime field ⇒ not type-only, so a genuinely broken
  // runtime package (e.g. `main: "dist/missing.js"`) still fails closed.
  const isNonEmpty = value => typeof value === "string" && value.trim() !== "";
  const hasTypes = isNonEmpty(pkg?.types) || isNonEmpty(pkg?.typings);
  const hasRuntimeField =
    isNonEmpty(pkg?.main) || isNonEmpty(pkg?.module) || (pkg?.exports !== undefined && pkg?.exports !== null);
  return hasTypes && !hasRuntimeField;
}

function packageDeclaresRuntimeEntry(pkg) {
  const isNonEmpty = value => typeof value === "string" && value.trim() !== "";
  return isNonEmpty(pkg?.main) || isNonEmpty(pkg?.module) || (pkg?.exports !== undefined && pkg?.exports !== null);
}

function planSiblingCopy(name, siblingRoot) {
  // Resolve the runtime entry (built vs source), the byte-copy targets, and the resolver aliases for one
  // sibling. Returns null to SKIP a type-only package (no runtime mirror); throws WorkspaceMirrorAbort
  // when a package that declares a runtime entry can't be resolved on disk (fail closed).
  const pkg = readPackageJson(siblingRoot);
  const declaredRuntime = packageDeclaresRuntimeEntry(pkg);
  let entryRel = runtimeEntryRel(pkg);
  let normalizedEntry = typeof entryRel === "string" ? entryRel.replace(/^\.\//, "") : "";
  let entryAbs = normalizedEntry ? resolveFileWithin(siblingRoot, normalizedEntry) : null;
  if (!declaredRuntime && (normalizedEntry === "" || entryAbs === null || !isRealFile(entryAbs))) {
    for (const candidate of ["index.ts", "index.tsx", "index.mts", "index.cts", "src/index.ts", "src/index.tsx", "src/index.mts", "src/index.cts"]) {
      const candidateAbs = resolveFileWithin(siblingRoot, candidate);
      if (candidateAbs !== null && isRealFile(candidateAbs)) {
        entryRel = candidate;
        normalizedEntry = candidate;
        entryAbs = candidateAbs;
        break;
      }
    }
  }
  if (normalizedEntry === "" || entryAbs === null || !isRealFile(entryAbs)) {
    // No resolvable RUNTIME entry. A TYPE-ONLY package (types but no main/module/exports) is not a
    // runtime dependency — a `import type` of it is erased at transform, and a value import still
    // resolves via the read-only node_modules link. Skip it WITHOUT aborting the whole sibling mirror
    // (so real runtime siblings like @medplum/core still copy). It is NEVER runtime evidence.
    if (isTypeOnlyPackage(pkg)) {
      return null;
    }
    // A package that DECLARES a runtime entry we cannot resolve → genuine blocker → fail closed.
    throw new WorkspaceMirrorAbort(`workspace_package_unresolved: ${name}`);
  }
  const isSource = /\.(?:ts|tsx|cts|mts)$/.test(entryAbs);
  const rootEntry = !normalizedEntry.includes("/");
  const segments = new Set(
    (isSource && !declaredRuntime) || rootEntry
      ? sourcePackageSegments(siblingRoot)
      : [topLevelSegment(normalizedEntry)]
  );
  const subpathAliases = [];
  const exp = pkg?.exports;
  if (exp && typeof exp === "object" && !Array.isArray(exp)) {
    for (const [key, value] of Object.entries(exp)) {
      if (key === "." || !key.startsWith("./") || key.includes("*")) {
        continue; // wildcard subpath patterns fall through to the catch-all alias
      }
      const target = resolveExportsCondition(value);
      if (typeof target !== "string" || !target.startsWith(".")) {
        continue;
      }
      const normalizedTarget = target.replace(/^\.\//, "");
      const targetAbs = resolveFileWithin(siblingRoot, normalizedTarget);
      if (targetAbs === null || !isRealFile(targetAbs)) {
        continue; // unresolved subpath → let the import fail → honest unrunnable
      }
      segments.add(topLevelSegment(normalizedTarget));
      subpathAliases.push({ subpath: key.slice(2), targetRel: normalizedTarget });
    }
  }
  return {
    name,
    siblingRoot,
    entryRel: normalizedEntry,
    isSource,
    runtimeOnly: rootEntry && !isSource && declaredRuntime,
    segments: [...segments].filter(Boolean),
    subpathAliases
  };
}

function assertSiblingBudget(plans) {
  // Pre-scan the sibling copy targets and abort BEFORE any copy if they exceed the file/byte caps, so an
  // over-cap closure mirrors nothing (never a half-copied sandbox).
  let files = 0;
  let bytes = 0;
  const seen = new Set();
  const visit = source => {
    let stat;
    try {
      stat = lstatSync(source);
    } catch {
      return;
    }
    if (stat.isSymbolicLink()) {
      return;
    }
    if (stat.isDirectory()) {
      for (const name of readdirSync(source)) {
        if (!MIRROR_SKIP_DIRS.has(name)) {
          visit(path.join(source, name));
        }
      }
      return;
    }
    if (stat.isFile()) {
      files += 1;
      bytes += stat.size;
      if (files > SIBLING_MAX_FILES) {
        throw new WorkspaceMirrorAbort("workspace siblings have too many files");
      }
      if (bytes > SIBLING_MAX_BYTES) {
        throw new WorkspaceMirrorAbort("workspace siblings are too large");
      }
    }
  };
  for (const plan of plans) {
    const targets = ["package.json", ...(plan.isSource ? ["tsconfig.json"] : []), ...plan.segments];
    for (const rel of targets) {
      const source = path.join(plan.siblingRoot, rel);
      if (seen.has(source) || !existsSync(source)) {
        continue;
      }
      seen.add(source);
      visit(source);
    }
  }
}

function relativeImportSpecifiers(file) {
  // Heuristic scan of a runner CONFIG file for RELATIVE require()/import specifiers. Not a full parser; a
  // specifier that doesn't resolve to a real file is skipped (→ the real config load fails → honest
  // unrunnable). ponytail: regex heuristic, upgrade to an AST walk if a real config confuses it.
  let raw;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  const specifiers = new Set();
  const patterns = [
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /import\s+(?:[^"';]*?\sfrom\s+)?["']([^"']+)["']/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /export\s+(?:\*|\{[^}]*\})\s+from\s+["']([^"']+)["']/g
  ];
  for (const pattern of patterns) {
    let match;
    while ((match = pattern.exec(raw)) !== null) {
      if (match[1].startsWith(".")) {
        specifiers.add(match[1]);
      }
    }
  }
  return [...specifiers];
}

function packageJsonMochaRequireSpecifiers(file) {
  if (path.basename(file) !== "package.json") {
    return [];
  }
  let pkg;
  try {
    pkg = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  const raw = pkg?.mocha?.require;
  const entries = Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : [];
  return entries
    .filter(entry => typeof entry === "string")
    .filter(entry => entry.startsWith(".") || (!entry.startsWith("@") && !entry.startsWith("node_modules/") && isRealFile(path.resolve(path.dirname(file), entry))))
    .map(entry => entry.startsWith(".") ? entry : `./${entry}`);
}

function resolveHelperSpecifier(fromDir, specifier) {
  // Resolve a RELATIVE config-helper specifier to concrete file(s). Files-only, plus an explicit directory
  // module that carries a package.json `main`. Returns { entry, files } or null (unresolvable → skip).
  const base = path.resolve(fromDir, specifier);
  for (const ext of HELPER_RESOLVE_EXTS) {
    const candidate = ext === "" ? base : `${base}${ext}`;
    if (isRealFile(candidate)) {
      return { entry: candidate, files: [candidate] };
    }
  }
  if (isRealDir(base)) {
    const pkgPath = path.join(base, "package.json");
    const main = readPackageJson(base)?.main;
    if (isRealFile(pkgPath) && typeof main === "string") {
      const mainAbs = resolveFileWithin(base, main.replace(/^\.\//, ""));
      if (mainAbs !== null && isRealFile(mainAbs)) {
        return { entry: mainAbs, files: [pkgPath, mainAbs] };
      }
    }
  }
  return null;
}

function collectConfigHelpers(packageRoot, workspaceRoot) {
  // Follow RELATIVE requires/imports from package-local runner CONFIG files to a bounded closure of helper
  // files that resolve OUTSIDE the package but INSIDE the workspace root (the Medusa
  // `jest.config.js → ../../../define_jest_config` shape). Returns absolute file paths to byte-copy.
  // Throws WorkspaceMirrorAbort (→ mirror nothing → honest unrunnable) on a cap breach or a relative
  // import that escapes the workspace root.
  if (workspaceRoot === packageRoot) {
    return [];
  }
  const toCopy = new Set();
  const visited = new Set();
  const queue = [];
  for (const name of RUNNER_CONFIG_FILES) {
    const configAbs = path.join(packageRoot, name);
    if (isRealFile(configAbs)) {
      queue.push({ file: configAbs, depth: 0 });
    }
    const workspaceConfigAbs = path.join(workspaceRoot, name);
    if (workspaceConfigAbs !== configAbs && isRealFile(workspaceConfigAbs)) {
      toCopy.add(workspaceConfigAbs);
      queue.push({ file: workspaceConfigAbs, depth: 0 });
    }
  }
  let files = 0;
  let bytes = 0;
  while (queue.length > 0) {
    const { file, depth } = queue.shift();
    if (visited.has(file)) {
      continue;
    }
    visited.add(file);
    for (const specifier of [...relativeImportSpecifiers(file), ...packageJsonMochaRequireSpecifiers(file)]) {
      const resolved = resolveHelperSpecifier(path.dirname(file), specifier);
      if (resolved === null) {
        continue;
      }
      if (resolved.entry === packageRoot || isInsideDir(packageRoot, resolved.entry)) {
        continue; // inside the package: already copied with the package
      }
      for (const helperFile of resolved.files) {
        if (!isInsideDir(workspaceRoot, helperFile)) {
          throw new WorkspaceMirrorAbort("workspace_config_helper_missing: relative import escapes the workspace root");
        }
        if (toCopy.has(helperFile)) {
          continue;
        }
        toCopy.add(helperFile);
        files += 1;
        let size = 0;
        try {
          size = lstatSync(helperFile).size;
        } catch {
          size = 0;
        }
        bytes += size;
        if (files > CONFIG_HELPER_MAX_FILES) {
          throw new WorkspaceMirrorAbort("workspace_config_helper_missing: too many helper files");
        }
        if (bytes > CONFIG_HELPER_MAX_BYTES) {
          throw new WorkspaceMirrorAbort("workspace_config_helper_missing: helper closure too large");
        }
      }
      if (depth + 1 <= CONFIG_HELPER_MAX_DEPTH) {
        queue.push({ file: resolved.entry, depth: depth + 1 });
      }
    }
  }
  return [...toCopy];
}

function detectRunner(root, args) {
  if (args.runner !== "auto") {
    return args.runner;
  }
  const pkg = readPackageJson(root);
  const workspacePkg = args.workspaceRoot && args.workspaceRoot !== root ? readPackageJson(args.workspaceRoot) : null;
  const text = packageText(pkg);
  const workspaceText = packageText(workspacePkg);
  const hasJestPackage = hasPackageDependency(pkg, [
    "jest",
    "jest-cli",
    "@jest/core",
    "babel-jest",
    "ts-jest",
    "@swc/jest",
    "jest-environment-node",
    "jest-environment-jsdom"
  ]) || hasPackageDependency(workspacePkg, [
    "jest",
    "jest-cli",
    "@jest/core",
    "babel-jest",
    "ts-jest",
    "@swc/jest",
    "jest-environment-node",
    "jest-environment-jsdom"
  ]);
  const hasJest = hasAnyFile(root, [
    "jest.config.js",
    "jest.config.cjs",
    "jest.config.mjs",
    "jest.config.ts",
    "jest.config.json"
  ]) || hasJestPackage || /(?:^|["\s:@/])jest(?:["\s:]|$)/.test(`${text}\n${workspaceText}`) || Boolean(pkg?.jest) || Boolean(workspacePkg?.jest);
  const hasVitestPackage = hasPackageDependency(pkg, ["vitest", "@vitest/ui", "@vitest/coverage-v8"])
    || hasPackageDependency(workspacePkg, ["vitest", "@vitest/ui", "@vitest/coverage-v8"]);
  const hasVitest = hasAnyFile(root, [
    "vitest.config.js",
    "vitest.config.cjs",
    "vitest.config.mjs",
    "vitest.config.ts"
  ]) || hasVitestPackage || /(?:^|["\s:@/])vitest(?:["\s:]|$)/.test(`${text}\n${workspaceText}`) || Boolean(pkg?.vitest) || Boolean(workspacePkg?.vitest);
  const hasMochaPackage = hasPackageDependency(pkg, ["mocha", "@types/mocha", "chai", "@types/chai"])
    || hasPackageDependency(workspacePkg, ["mocha", "@types/mocha", "chai", "@types/chai"]);
  const hasMocha = hasAnyFile(root, [
    ".mocharc.js",
    ".mocharc.cjs",
    ".mocharc.mjs",
    ".mocharc.json",
    "mocha.opts"
  ]) || hasMochaPackage || /(?:^|["\s:@/])mocha(?:["\s:]|$)/.test(`${text}\n${workspaceText}`);
  const detected = [
    hasJest ? "jest" : null,
    hasVitest ? "vitest" : null,
    hasMocha ? "mocha" : null
  ].filter(Boolean);
  return detected.length === 1 ? detected[0] : "unknown";
}

function assertRunnerBin(runner, binPath) {
  if (!existsSync(binPath)) {
    throw new Error(`${runner} runner binary not found: ${binPath}`);
  }
}

function sanitizedEnv(extra = {}) {
  const env = {
    PATH: process.env.PATH ?? "",
    HOME: process.env.HOME ?? "",
    TMPDIR: process.env.TMPDIR ?? tmpdir(),
    TEMP: process.env.TEMP ?? tmpdir(),
    TMP: process.env.TMP ?? tmpdir(),
    NODE_ENV: "test",
    CI: "1",
    FORCE_COLOR: "0",
    NO_COLOR: "1",
    ...extra
  };
  for (const key of Object.keys(env)) {
    if (isSecretEnvKey(key)) {
      delete env[key];
    }
  }
  return env;
}

function escapeRegexLiteral(text) {
  return text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
}

function detectRunnerConfig(repoRoot, candidates) {
  return candidates.find(name => existsSync(path.join(repoRoot, name))) ?? null;
}

function vitestAliasArrayExpr(aliases) {
  // Vite string `find` prefix-matches `find` and `find/...`, so a wildcard "@b/*" maps by find="@b".
  // A non-wildcard key is matched exactly via /^key$/ so it cannot shadow sibling imports.
  const entries = aliases.map(alias => {
    const find = alias.star
      ? JSON.stringify(alias.key.replace(/\/\*$/, ""))
      : `/^${escapeRegexLiteral(alias.key)}$/`;
    return `{ find: ${find}, replacement: ${JSON.stringify(alias.replacement)} }`;
  });
  return `[${entries.join(", ")}]`;
}

function writeVitestAliasConfig(repoRoot, monoRoot, baseConfigRel, aliases) {
  // Generate a config that ONLY adds resolve.alias (+ server.fs.allow for the sandbox mono tree,
  // since the copied sibling source sits outside the package root). If the repo already has a
  // config, mergeConfig it so plugins/reporters/rootDir are preserved (never clobbered). The
  // generated config adds RESOLUTION only — it does not touch the test file, the CLI reporter, or
  // the CLI --root. Returns the generated config's rel path.
  const base = baseConfigRel ?? detectRunnerConfig(repoRoot, [
    "vitest.config.ts", "vitest.config.mts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs",
    "vite.config.ts", "vite.config.mts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"
  ]);
  const aliasExpr = vitestAliasArrayExpr(aliases);
  const allowExpr = JSON.stringify([monoRoot, repoRoot]);
  let source;
  if (base) {
    const baseSpecifier = `./${base.split(path.sep).join("/")}`;
    source = [
      `import { mergeConfig } from "vitest/config";`,
      `import base from ${JSON.stringify(baseSpecifier)};`,
      `const aliasConfig = { resolve: { alias: ${aliasExpr} }, server: { fs: { allow: ${allowExpr} } } };`,
      `export default typeof base === "function"`,
      `  ? async env => mergeConfig((await base(env)) ?? {}, aliasConfig)`,
      `  : mergeConfig(base ?? {}, aliasConfig);`,
      ``
    ].join("\n");
  } else {
    source = `export default { resolve: { alias: ${aliasExpr} }, server: { fs: { allow: ${allowExpr} } } };\n`;
  }
  writeFileSync(path.join(repoRoot, GENERATED_VITEST_CONFIG), source);
  return GENERATED_VITEST_CONFIG;
}

function jestModuleNameMapperExpr(aliases) {
  const entries = aliases.map(alias => {
    const key = alias.star
      ? `^${escapeRegexLiteral(alias.key.replace(/\/\*$/, ""))}/(.*)$`
      : `^${escapeRegexLiteral(alias.key)}$`;
    const value = alias.star
      ? `${alias.replacement.split(path.sep).join("/")}/$1`
      : alias.replacement.split(path.sep).join("/");
    return `${JSON.stringify(key)}: ${JSON.stringify(value)}`;
  });
  return `{ ${entries.join(", ")} }`;
}

function writeJestAliasConfig(repoRoot, baseConfigRel, aliases) {
  // Extend the detected jest config's moduleNameMapper. Only require-loadable base shapes
  // (.js/.cjs/.json, package.json `jest` field, or no base) are merged cleanly; a .ts/.mjs base
  // isn't cleanly requireable here, so injection is SKIPPED (→ honest unrunnable) rather than
  // clobber the repo config. Returns the generated config's rel path, or null when skipped.
  let base = baseConfigRel;
  let usePackageField = false;
  if (!base) {
    const configFile = detectRunnerConfig(repoRoot, ["jest.config.js", "jest.config.cjs", "jest.config.json"]);
    if (configFile) {
      base = configFile;
    } else if (existsSync(path.join(repoRoot, "package.json")) && readPackageJson(repoRoot)?.jest) {
      base = "package.json";
      usePackageField = true;
    }
  }
  if (base && !usePackageField && !/\.(?:js|cjs|json)$/.test(base)) {
    return null;
  }
  const mapperExpr = jestModuleNameMapperExpr(aliases);
  const lines = [];
  if (usePackageField) {
    lines.push(`const resolved = require("./package.json").jest || {};`);
  } else if (base) {
    const baseSpecifier = `./${base.split(path.sep).join("/")}`;
    lines.push(`const loaded = require(${JSON.stringify(baseSpecifier)});`);
    lines.push(`const resolved = (loaded && loaded.default) || loaded || {};`);
  } else {
    lines.push(`const resolved = {};`);
  }
  const rootDir = base ? `resolved.rootDir` : JSON.stringify(repoRoot);
  lines.push(
    `module.exports = { ...resolved, rootDir: ${rootDir}${base ? ` || ${JSON.stringify(repoRoot)}` : ""}, ` +
    `moduleNameMapper: { ...(resolved.moduleNameMapper || {}), ...${mapperExpr} } };`
  );
  writeFileSync(path.join(repoRoot, GENERATED_JEST_CONFIG), `${lines.join("\n")}\n`);
  return GENERATED_JEST_CONFIG;
}

function mochaTsconfigPaths(aliases, cwd) {
  const paths = {};
  for (const alias of aliases) {
    const key = alias.key;
    const rel = path.relative(cwd, alias.replacement).split(path.sep).join("/");
    const target = rel.startsWith(".") ? rel : `./${rel}`;
    paths[key] = [alias.star ? `${target.replace(/\/$/, "")}/*` : target];
  }
  return paths;
}

function writeMochaAliasTsconfig(repoRoot, monoRoot, aliases) {
  const cwd = monoRoot ?? repoRoot;
  const baseAbs = [path.join(cwd, "tsconfig.json"), path.join(repoRoot, "tsconfig.json")].find(isRealFile);
  const base = baseAbs ? (readTsconfigObject(baseAbs) ?? {}) : {};
  const compilerOptions = {
    ...(base.compilerOptions ?? {}),
    baseUrl: ".",
    paths: {
      ...(base.compilerOptions?.paths ?? {}),
      ...mochaTsconfigPaths(aliases, cwd)
    }
  };
  const generated = { ...base, compilerOptions };
  const out = path.join(cwd, GENERATED_MOCHA_TSCONFIG);
  writeFileSync(out, `${JSON.stringify(generated, null, 2)}\n`);
  return out;
}

function runVitest({ repoRoot, monoRoot, testRel, vitestBin, vitestConfigRel, timeoutMs, testEnv, aliases }) {
  assertRunnerBin("vitest", vitestBin);
  const started = performance.now();
  const reportPath = path.join(repoRoot, `.opro-dynamic-proof-report-${process.pid}-${Date.now()}.json`);
  const configRel = aliases && aliases.length > 0
    ? writeVitestAliasConfig(repoRoot, monoRoot, vitestConfigRel, aliases)
    : vitestConfigRel;
  const vitestArgs = [vitestBin, "run", testRel, "--root", repoRoot, `--reporter=${dynamicProofReporterPath()}`];
  if (configRel) {
    vitestArgs.push("--config", path.join(repoRoot, configRel));
  }
  const result = spawnSync(process.execPath, vitestArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    env: sanitizedEnv({ ...testEnv, OPRO_DYNAMIC_PROOF_REPORT: reportPath })
  });
  const elapsedMs = Math.round(performance.now() - started);
  const report = existsSync(reportPath) ? parseVitestJsonReport(readFileSync(reportPath, "utf8")) : null;
  rmSync(reportPath, { force: true });
  return {
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    report,
    elapsedMs,
    cwd: repoRoot
  };
}

function runJest({ repoRoot, testRel, jestBin, jestConfigRel, timeoutMs, testEnv, aliases }) {
  assertRunnerBin("jest", jestBin);
  const started = performance.now();
  const reportPath = path.join(repoRoot, `.opro-dynamic-proof-report-${process.pid}-${Date.now()}.json`);
  const generatedConfig = aliases && aliases.length > 0
    ? writeJestAliasConfig(repoRoot, jestConfigRel, aliases)
    : null;
  const jestArgs = [
    jestBin,
    "--runTestsByPath",
    testRel,
    "--runInBand",
    "--no-coverage",
    `--reporters=${dynamicProofJestReporterPath()}`
  ];
  if (generatedConfig) {
    jestArgs.push("--config", path.join(repoRoot, generatedConfig));
  } else if (jestConfigRel) {
    jestArgs.push("--config", path.join(repoRoot, jestConfigRel));
  } else {
    jestArgs.push("--rootDir", repoRoot);
  }
  const result = spawnSync(process.execPath, jestArgs, {
    cwd: repoRoot,
    encoding: "utf8",
    timeout: timeoutMs,
    env: sanitizedEnv({ ...testEnv, OPRO_DYNAMIC_PROOF_REPORT: reportPath })
  });
  const elapsedMs = Math.round(performance.now() - started);
  const report = existsSync(reportPath) ? parseVitestJsonReport(readFileSync(reportPath, "utf8")) : null;
  rmSync(reportPath, { force: true });
  return {
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    report,
    elapsedMs,
    cwd: repoRoot
  };
}

function runMocha({ repoRoot, monoRoot, testRel, mochaBin, timeoutMs, testEnv, aliases }) {
  assertRunnerBin("mocha", mochaBin);
  const started = performance.now();
  const cwd = monoRoot ?? repoRoot;
  const testArg = path.relative(cwd, path.join(repoRoot, testRel)).split(path.sep).join("/");
  const reportPath = path.join(cwd, `.opro-dynamic-proof-report-${process.pid}-${Date.now()}.json`);
  const generatedTsconfig = aliases && aliases.length > 0 ? writeMochaAliasTsconfig(repoRoot, monoRoot, aliases) : null;
  const preferTsExts = /\.[cm]?tsx?$/.test(testRel);
  const mochaArgs = [];
  if (/\.[cm]?tsx?$/.test(testRel)) {
    mochaArgs.push("--loader", "ts-node/esm");
  }
  mochaArgs.push(
    mochaBin,
    testArg,
    "--reporter",
    dynamicProofMochaReporterPath(),
    "--timeout",
    String(timeoutMs),
    "--no-color"
  );
  const result = spawnSync(process.execPath, mochaArgs, {
    cwd,
    encoding: "utf8",
    timeout: timeoutMs,
    env: sanitizedEnv({
      ...testEnv,
      OPRO_DYNAMIC_PROOF_REPORT: reportPath,
      ...(preferTsExts ? { TS_NODE_PREFER_TS_EXTS: "true" } : {}),
      ...(generatedTsconfig ? { TS_NODE_PROJECT: generatedTsconfig, TS_CONFIG_PATHS_PROJECT: generatedTsconfig } : {})
    })
  });
  const elapsedMs = Math.round(performance.now() - started);
  const report = existsSync(reportPath) ? parseVitestJsonReport(readFileSync(reportPath, "utf8")) : parseVitestJsonReport(result.stdout ?? "");
  rmSync(reportPath, { force: true });
  return {
    exitCode: result.status ?? 1,
    signal: result.signal ?? null,
    timedOut: Boolean(result.error && result.error.code === "ETIMEDOUT"),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    report,
    elapsedMs,
    cwd
  };
}

function runTest({ runner, repoRoot, monoRoot, testRel, vitestBin, jestBin, mochaBin, vitestConfigRel, jestConfigRel, timeoutMs, testEnv, aliases }) {
  if (runner === "vitest") {
    return runVitest({ repoRoot, monoRoot, testRel, vitestBin, vitestConfigRel, timeoutMs, testEnv, aliases });
  }
  if (runner === "jest") {
    return runJest({ repoRoot, testRel, jestBin, jestConfigRel, timeoutMs, testEnv, aliases });
  }
  if (runner === "mocha") {
    return runMocha({ repoRoot, monoRoot, testRel, mochaBin, timeoutMs, testEnv, aliases });
  }
  return {
    exitCode: 1,
    signal: null,
    timedOut: false,
    stdout: "",
    stderr: "Unsupported or unknown test runner",
    report: null,
    elapsedMs: 0,
    cwd: repoRoot
  };
}

function parseVitestJsonReport(stdout) {
  const trimmed = stdout.trim();
  if (!trimmed) {
    return null;
  }
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function stackFrames(message) {
  return String(message).split("\n").slice(1).filter(line => /^\s+at\s+/.test(line));
}

function parseStackFrame(frame) {
  const trimmed = frame.trim();
  const match = /(?:\()?(.*?):(\d+):(\d+)\)?$/.exec(trimmed);
  if (!match) {
    return null;
  }
  let file = match[1].replace(/^at\s+/, "").trim();
  const paren = file.lastIndexOf("(");
  if (paren !== -1) {
    file = file.slice(paren + 1);
  }
  if (file.startsWith("file://")) {
    file = fileURLToPath(file);
  }
  return {
    file,
    line: Number(match[2]),
    column: Number(match[3])
  };
}

function lineHasAssertion(sourceLines, lineNumber) {
  const index = lineNumber - 1;
  const window = sourceLines.slice(Math.max(0, index - 2), index + 1).join("\n");
  return /\bexpect\s*\(|\bassert(?:\.\w+)?\s*\(/.test(window);
}

function lineIsInsideLifecycleHook(sourceLines, lineNumber) {
  const index = lineNumber - 1;
  if (index < 0 || index >= sourceLines.length) {
    return false;
  }
  const start = Math.max(0, index - 30);
  let nearestHook = -1;
  let nearestTest = -1;
  for (let i = start; i <= index; i += 1) {
    const line = sourceLines[i] ?? "";
    if (/\b(?:beforeAll|beforeEach|afterAll|afterEach)\s*\(/.test(line)) {
      nearestHook = i;
    }
    if (/\b(?:it|test)\s*(?:\.\w+)?\s*\(/.test(line)) {
      nearestTest = i;
    }
  }
  return nearestHook !== -1 && nearestHook > nearestTest;
}

function hasStructuredMatcherSignal(detail) {
  return hasVitestMatcherSignal(detail) || hasJestMatcherSignal(detail) || hasMochaAssertionSignal(detail);
}

function hasVitestMatcherSignal(detail) {
  return detail?.name === "AssertionError"
    && Object.prototype.hasOwnProperty.call(detail, "actual")
    && Object.prototype.hasOwnProperty.call(detail, "expected")
    && typeof detail.operator === "string"
    && detail.showDiff === true
    && detail.ok === false
    && typeof detail.diff === "string";
}

function hasJestMatcherSignal(detail) {
  const matcherResult = detail?.matcherResult;
  if (!matcherResult || typeof matcherResult !== "object") {
    return false;
  }
  const errorName = detail.name ?? detail.constructorName ?? "";
  return /^(|Object|Error|JestAssertionError)$/.test(errorName)
    && Object.prototype.hasOwnProperty.call(matcherResult, "actual")
    && Object.prototype.hasOwnProperty.call(matcherResult, "expected")
    && matcherResult.pass === false;
}

function hasMochaAssertionSignal(detail) {
  const errorName = detail?.name ?? detail?.constructorName ?? "";
  return errorName === "AssertionError"
    && Object.prototype.hasOwnProperty.call(detail, "actual")
    && Object.prototype.hasOwnProperty.call(detail, "expected")
    && (
      typeof detail.operator === "string"
      || detail.showDiff === true
      || typeof detail.generatedMessage === "boolean"
      || detail.code === "ERR_ASSERTION"
    );
}

function hasJestLegacyMessageSignal(message) {
  return /^Error: expect\(/.test(String(message).split("\n", 1)[0] ?? "");
}

function canonicalPath(filePath) {
  try {
    return realpathSync(filePath);
  } catch {
    return path.resolve(filePath);
  }
}

function resolveFrameFile(file, frameRoot) {
  if (path.isAbsolute(file)) {
    return file;
  }
  return path.resolve(frameRoot, file);
}

function isAssertionFailureMessage(message, detail, testRel, repoRoot, frameRoot) {
  if (!hasStructuredMatcherSignal(detail) && !hasJestLegacyMessageSignal(message)) {
    return false;
  }
  const text = String(message);
  const firstLine = text.split("\n", 1)[0] ?? "";
  if (!/^AssertionError(?:\b|:|\s+\[)/.test(firstLine) && !/^(Error|JestAssertionError):/.test(firstLine)) {
    return false;
  }
  const testAbs = path.resolve(repoRoot, testRel);
  const sourceLines = readFileSync(testAbs, "utf8").split(/\r?\n/);
  return stackFrames(text).some(rawFrame => {
    const frame = parseStackFrame(rawFrame);
    return frame
      && canonicalPath(resolveFrameFile(frame.file, frameRoot)) === canonicalPath(testAbs)
      && !lineIsInsideLifecycleHook(sourceLines, frame.line)
      && lineHasAssertion(sourceLines, frame.line);
  });
}

function assertionIdentity(assertion) {
  const fullName = typeof assertion?.fullName === "string" ? assertion.fullName.trim() : "";
  if (fullName) {
    return fullName;
  }
  const title = typeof assertion?.title === "string" ? assertion.title.trim() : "";
  const ancestors = Array.isArray(assertion?.ancestorTitles)
    ? assertion.ancestorTitles.filter(item => typeof item === "string" && item.trim()).map(item => item.trim())
    : [];
  return [...ancestors, title].filter(Boolean).join(" ");
}

function uniquelyPassedAssertionIdentities(run) {
  const counts = new Map();
  const passed = new Set();
  const results = Array.isArray(run.report?.testResults) ? run.report.testResults : [];
  for (const suite of results) {
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    for (const assertion of assertions) {
      const id = assertionIdentity(assertion);
      if (!id) {
        continue;
      }
      counts.set(id, (counts.get(id) ?? 0) + 1);
      if (assertion.status !== "passed") {
        continue;
      }
      passed.add(id);
    }
  }
  const ids = new Set();
  for (const id of passed) {
    if (counts.get(id) === 1) {
      ids.add(id);
    }
  }
  return ids;
}

function isAssertionFailure(run, testRel, repoRoot, baselineRun = null) {
  const baselinePassedIds = baselineRun ? uniquelyPassedAssertionIdentities(baselineRun) : null;
  const results = Array.isArray(run.report?.testResults) ? run.report.testResults : [];
  for (const suite of results) {
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    for (const assertion of assertions) {
      if (assertion.status !== "failed") {
        continue;
      }
      if (assertion.failurePhase === "hook") {
        continue;
      }
      if (baselinePassedIds) {
        const id = assertionIdentity(assertion);
        if (!id || !baselinePassedIds.has(id)) {
          continue;
        }
      }
      const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
      const details = Array.isArray(assertion.failureDetails) ? assertion.failureDetails : [];
      if (messages.some((message, index) => isAssertionFailureMessage(message, details[index], testRel, repoRoot, run.cwd ?? repoRoot))) {
        return true;
      }
    }
  }
  return false;
}

function failureSummary(run) {
  const results = Array.isArray(run.report?.testResults) ? run.report.testResults : [];
  for (const suite of results) {
    if (typeof suite.message === "string" && suite.message.trim()) {
      return redactSecrets(pickReportableFailureLine(suite.message));
    }
    const assertions = Array.isArray(suite.assertionResults) ? suite.assertionResults : [];
    for (const assertion of assertions) {
      const messages = Array.isArray(assertion.failureMessages) ? assertion.failureMessages : [];
      const message = messages.find(item => typeof item === "string" && item.trim());
      if (message) {
        return redactSecrets(pickReportableFailureLine(message));
      }
    }
  }
  const stderr = String(run.stderr ?? "").trim();
  if (stderr) {
    return redactSecrets(pickReportableFailureLine(stderr));
  }
  return null;
}

function redactSecrets(text) {
  return String(text)
    .replace(/([A-Z0-9_]*(?:TOKEN|SECRET|PASSWORD|API[_-]?KEY|ACCESS[_-]?KEY|PRIVATE[_-]?KEY|SECRET[_-]?KEY|PASSPHRASE|CREDENTIAL|PIN|AUTH|COOKIE|SESSION)[A-Z0-9_]*=)[^\s'"]+/gi, "$1[REDACTED]")
    .replace(/(:\/\/[^:/@\s]+:)[^@/\s]+(@)/g, "$1[REDACTED]$2")
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[REDACTED]")
    .replace(/(sk-[A-Za-z0-9_-]{8})[A-Za-z0-9_-]+/g, "$1[REDACTED]");
}

function classify({ baseline, mutant, testRel, repoRoot }) {
  if (baseline.exitCode !== 0 || baseline.timedOut) {
    return {
      status: "unrunnable",
      proven: false,
      reason: "baseline test did not pass"
    };
  }
  if (mutant.exitCode === 0 && !mutant.timedOut) {
    return {
      status: "associated_survived",
      proven: false,
      reason: "mutated target did not change the test outcome"
    };
  }
  if (isAssertionFailure(mutant, testRel, repoRoot, baseline)) {
    return {
      status: "proven",
      proven: true,
      reason: "baseline passed and mutant failed at an assertion"
    };
  }
  return {
    status: "associated_non_assertion_failure",
    proven: false,
    reason: "mutant failed, but not with a trusted assertion failure"
  };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const root = path.resolve(args.root);
  const testAbs = resolveInside(root, args.test);
  const targetAbs = resolveInside(root, args.target);
  const testRel = path.relative(root, testAbs);
  const targetRel = path.relative(root, targetAbs);
  const vitestConfigRel = args.vitestConfig ? path.relative(root, resolveInside(root, args.vitestConfig)) : null;
  const jestConfigRel = args.jestConfig ? path.relative(root, resolveInside(root, args.jestConfig)) : null;
  const timeoutMs = parseTimeoutMs(args.timeoutMs);
  const replacementBody = buildReplacementBody(args.replacement, args.replacementMode);
  const testEnv = parseTestEnv(args.testEnv);
  const workspaceRoot = detectWorkspaceRoot(root);
  const runner = detectRunner(root, { ...args, workspaceRoot });
  const vitestBin = args.vitestBin ? path.resolve(args.vitestBin) : defaultVitestBin(root, workspaceRoot);
  const jestBin = args.jestBin ? path.resolve(args.jestBin) : defaultJestBin(root, workspaceRoot);
  const mochaBin = args.mochaBin ? path.resolve(args.mochaBin) : defaultMochaBin(root, workspaceRoot);

  const baselineCopy = copyFixtureRoot(root, "baseline", { linkNodeModules: args.linkNodeModules, workspaceRoot });
  const mutantCopy = copyFixtureRoot(root, "mutant", { linkNodeModules: args.linkNodeModules, workspaceRoot });
  try {
    const baseline = runTest({ runner, repoRoot: baselineCopy.repoRoot, monoRoot: baselineCopy.monoRoot, testRel, vitestBin, jestBin, mochaBin, vitestConfigRel, jestConfigRel, timeoutMs, testEnv, aliases: baselineCopy.aliases });
    mutateMethod(path.join(mutantCopy.repoRoot, targetRel), args.method, replacementBody);
    const mutant = runTest({ runner, repoRoot: mutantCopy.repoRoot, monoRoot: mutantCopy.monoRoot, testRel, vitestBin, jestBin, mochaBin, vitestConfigRel, jestConfigRel, timeoutMs, testEnv, aliases: mutantCopy.aliases });
    const verdict = classify({ baseline, mutant, testRel, repoRoot: mutantCopy.repoRoot });
    const output = {
      ...verdict,
      runner,
      replacementMode: args.replacementMode,
      vitestConfig: vitestConfigRel,
      jestConfig: jestConfigRel,
      testEnv: Object.keys(testEnv).sort(),
      test: testRel,
      target: targetRel,
      method: args.method,
      baseline: {
        exitCode: baseline.exitCode,
        timedOut: baseline.timedOut,
        elapsedMs: baseline.elapsedMs,
        failureSummary: failureSummary(baseline)
      },
      mutant: {
        exitCode: mutant.exitCode,
        timedOut: mutant.timedOut,
        elapsedMs: mutant.elapsedMs,
        assertionFailure: isAssertionFailure(mutant, testRel, mutantCopy.repoRoot, baseline),
        failureSummary: failureSummary(mutant)
      },
      medianProofMs: Math.round((baseline.elapsedMs + mutant.elapsedMs) / 2)
    };
    if (args.json) {
      process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    } else {
      process.stdout.write(`${output.status}: ${output.reason}\n`);
      process.stdout.write(`baseline=${baseline.exitCode} mutant=${mutant.exitCode} median_ms=${output.medianProofMs}\n`);
    }
    process.exitCode = output.status === "unrunnable" ? 2 : 0;
  } finally {
    rmSync(baselineCopy.tmpRoot, { recursive: true, force: true });
    rmSync(mutantCopy.tmpRoot, { recursive: true, force: true });
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n\n${usage()}\n`);
  process.exitCode = 1;
}
