import { readFileSync, writeFileSync } from "fs";
import { execSync } from "child_process";

const newVersion = process.argv[2];
if (!newVersion) { console.error("Usage: npm run release 0.2.14"); process.exit(1); }

const bump = (path, fn) => {
  const pkg = JSON.parse(readFileSync(path, "utf8"));
  fn(pkg);
  writeFileSync(path, JSON.stringify(pkg, null, 2) + "\n");
  console.log(`✓ ${path}`);
};

bump("package.json", p => p.version = newVersion);
bump("packages/mcp-server/package.json", p => {
  p.version = newVersion;
  p.dependencies["@orangepro/orangepro-mcp"] = `^${newVersion}`;
});
bump("server.json", p => {
  p.version = newVersion;
  p.packages[0].version = newVersion;
});

execSync("npm install", { stdio: "inherit" });
console.log(`\n✅ All files bumped to ${newVersion}. Now run:\nnpm run build && npm publish --access public`);
