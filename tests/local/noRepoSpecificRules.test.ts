import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// Guard against overfitting: ranking/linking/proof rules must key on code
// structure, never on the names of a repo we evaluated against. Comments may
// cite an evaluation as history; executable lines may not.
const EVALUATION_REPO_IDENTIFIERS = [
  /litellm/i,
  /\bMyLocal\b/,
  /\bLlmProviders\b/,
  /fastuuid/i,
  /BudgetRepository/,
  /prisma_client/,
  /user_api_key_auth/,
  /get_secret_str/,
  /add_known_models/
];

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) return sourceFiles(full);
    return /\.(ts|mjs)$/.test(name) ? [full] : [];
  });
}

describe("no evaluation-repo-specific identifiers in rule code", () => {
  it("src/ and the proof spikes contain no evaluation-repo identifiers outside comments", () => {
    const root = join(__dirname, "..", "..");
    const files = [...sourceFiles(join(root, "src")), ...sourceFiles(join(root, "scripts", "spikes"))];
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8").split("\n").forEach((line, index) => {
        const code = line.replace(/\/\/.*$/, "").replace(/^\s*\*.*$/, "").replace(/^\s*\/\*.*$/, "");
        if (EVALUATION_REPO_IDENTIFIERS.some((re) => re.test(code))) hits.push(`${file.slice(root.length + 1)}:${index + 1}: ${line.trim().slice(0, 120)}`);
      });
    }
    expect(hits).toEqual([]);
  });
});
