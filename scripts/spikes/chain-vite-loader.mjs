// Runs one file through a repository's own Vite, the way its Vitest tests load their code, so a
// TypeScript project's source resolves as it does under test. Used by the chain's Vitest stages:
//   node chain-vite-loader.mjs --check <file>     the file transforms (exit 0) or does not (exit 1)
//   node chain-vite-loader.mjs --run <module>     loads the module (the witness, which prints its own line)
//   optional: --config <path inside the repository>
// Vite is taken from the repository's node_modules, never from OrangePro. Nothing is written to the
// repository: the config is processed in memory and Vite's cache goes to the temporary folder.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const args = process.argv.slice(2);
const valueOf = (flag) => {
  const at = args.indexOf(flag);
  return at >= 0 ? args[at + 1] : undefined;
};
const check = valueOf("--check");
const run = valueOf("--run");
const root = process.cwd();
const CONFIG_NAMES = ["vitest.config.ts", "vitest.config.mts", "vitest.config.cts", "vitest.config.js", "vitest.config.mjs", "vitest.config.cjs", "vite.config.ts", "vite.config.mts", "vite.config.cts", "vite.config.js", "vite.config.mjs", "vite.config.cjs"];

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exit(1);
}

if ((check === undefined) === (run === undefined)) fail("usage: chain-vite-loader.mjs (--check <file> | --run <module>) [--config <path>]");

// The package's ESM entry, read from its own package.json ("exports" in any of its usual shapes).
function esmEntry(pkg) {
  let at = pkg.exports?.["."] ?? pkg.exports;
  for (let depth = 0; depth < 6 && at && typeof at === "object"; depth++) at = at.import ?? at.node ?? at.default;
  return typeof at === "string" ? at : (pkg.module ?? pkg.main ?? "index.js");
}

function findPackage(name, from = root) {
  for (let dir = from; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", name, "package.json");
    if (existsSync(candidate)) return candidate;
    if (dirname(dir) === dir) return null;
  }
}

let vite;
try {
  // Vite as Vitest itself resolves it: from Vitest's own place first (a strict layout such as pnpm's keeps
  // Vitest's dependencies beside it, not at the root), then from the repository's root.
  const vitestPkg = findPackage("vitest");
  const pkgPath = (vitestPkg ? findPackage("vite", dirname(realpathSync(vitestPkg))) : null) ?? findPackage("vite");
  if (!pkgPath) throw new Error("vite is not installed beside this repository's Vitest");
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
  vite = await import(pathToFileURL(resolve(dirname(pkgPath), esmEntry(pkg))).href);
} catch (error) {
  fail(`this repository's Vite could not be loaded: ${error?.message ?? error}`);
}

const given = valueOf("--config");
const configFile = given ? resolve(root, given) : (CONFIG_NAMES.map((name) => join(root, name)).find((path) => existsSync(path)) ?? false);

let server;
try {
  server = await vite.createServer({
    root,
    configFile,
    configLoader: "runner",
    cacheDir: join(tmpdir(), "opro-vite-cache"),
    logLevel: "silent",
    clearScreen: false,
    appType: "custom",
    server: { middlewareMode: true, ws: false, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] }
  });
} catch (error) {
  fail(`this repository's Vite did not start: ${error?.message ?? error}`);
}

let code = 0;
try {
  if (check !== undefined) {
    const result = await server.transformRequest(resolve(root, check), { ssr: true });
    if (!result || typeof result.code !== "string") throw new Error("the file gave no code");
  } else {
    await server.ssrLoadModule(resolve(root, run));
  }
} catch (error) {
  process.stderr.write(`${error?.stack ?? error?.message ?? error}\n`);
  code = 1;
}
await server.close();
process.exit(code);
