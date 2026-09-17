import { readFileSync, writeFileSync } from "node:fs";

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(newVersion)) {
  console.error("Usage: npm run release -- 0.2.43");
  process.exit(1);
}

const updateJson = (file, update) => {
  const value = JSON.parse(readFileSync(file, "utf8"));
  update(value);
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
  console.log(`✓ ${file}`);
};

updateJson("package.json", (pkg) => {
  pkg.version = newVersion;
});
updateJson("packages/mcp-server/package.json", (pkg) => {
  pkg.version = newVersion;
  pkg.dependencies["@orangepro/orangepro-mcp"] = `^${newVersion}`;
});
updateJson("server.json", (server) => {
  server.version = newVersion;
  server.packages[0].version = newVersion;
});
updateJson("package-lock.json", (lock) => {
  lock.version = newVersion;
  if (!lock.packages?.[""]) throw new Error("package-lock.json is missing the root package entry");
  lock.packages[""].version = newVersion;
});

console.log([
  "",
  `✅ Release metadata aligned to ${newVersion}.`,
  "No dependencies were updated.",
  "",
  "Run the release gate with npm 10.9.2:",
  "npx -y -p npm@10.9.2 -c 'npm run typecheck && npm run build && npm test'",
  "npx -y -p npm@10.9.2 -c 'npm pack --dry-run --json'"
].join("\n"));
