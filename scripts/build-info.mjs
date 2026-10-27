#!/usr/bin/env node
// Stamps the build (P0.6): dist/local/build-info.json names every file the package ships to run, with its
// sha256, and the lockfile it was built from. No time, path or machine detail goes in, so two clean builds
// of the same source give the same stamp. At start-up the CLI checks the files against it and refuses a
// stale or mixed build (src/local/buildInfo.ts).
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";

// The package root: this script's parent folder, or the folder given (tests).
const root = process.argv[2] ?? dirname(dirname(fileURLToPath(import.meta.url)));
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
const STAMP = "dist/local/build-info.json";

function walk(dir) {
  return readdirSync(dir).flatMap((name) => {
    const abs = join(dir, name);
    return statSync(abs).isDirectory() ? walk(abs) : [abs];
  });
}

const shipped = new Set();
for (const entry of pkg.files) {
  const abs = join(root, entry);
  for (const file of statSync(abs).isDirectory() ? walk(abs) : [abs]) {
    const rel = relative(root, file).split(sep).join("/");
    if (rel !== STAMP && !rel.endsWith(".map") && !rel.endsWith(".md") && rel !== "LICENSE") shipped.add(rel);
  }
}
const files = [...shipped].sort().map((path) => ({ path, sha256: sha256(readFileSync(join(root, path))) }));
const identity = { name: pkg.name, version: pkg.version, lockfile_sha256: sha256(readFileSync(join(root, "package-lock.json"))), files };
const stamp = { schema: "orangepro.build_info.v1", build_sha256: sha256(JSON.stringify(identity)), ...identity };
writeFileSync(join(root, STAMP), `${JSON.stringify(stamp, null, 2)}\n`);
console.log(`build stamped: ${stamp.build_sha256.slice(0, 12)} (${files.length} files)`);
