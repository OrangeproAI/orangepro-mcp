#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const cliPath = require.resolve("@orangepro/orangepro-mcp/dist/local/cli.js");
const child = spawnSync(process.execPath, [cliPath, ...process.argv.slice(2)], {
  stdio: "inherit"
});

if (child.error) {
  console.error(child.error.message);
  process.exit(1);
}

process.exit(child.status ?? 1);
