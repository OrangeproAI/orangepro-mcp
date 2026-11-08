#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cliPath = require.resolve("@orangepro/orangepro-mcp/dist/local/cli.js");
// The engine records this launcher's version next to its own in every run's provenance.
const { version } = require("../package.json");
const child = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, ORANGEPRO_LAUNCHER_VERSION: version }
});

if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}

process.exit(child.status ?? 1);
