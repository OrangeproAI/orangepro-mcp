import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Public package surface gate.
 *
 * The published package must be LOCAL-ONLY: only the local proof kit ships, never
 * the hosted MCP client (dist/index.js, dist/qaTools.js, dist/server.js, ...),
 * src/, tests/, scripts/, .env, or agent scaffolding. We assert this on the
 * `files`/`bin` allowlist (the real boundary — not .gitignore) and, when a build
 * is present, on the actual `npm pack` file set.
 */
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));

const ALLOWLIST = [
  "LICENSE",
  "README.md",
  "dist/local",
  "docs/agent-workflow.md",
  "docs/agents",
  "docs/local-proof-kit.md",
  // The dynamic-proof runtime (oracle + its reporters + the oracle's failure-summary
  // helper) is resolved from scripts/ at prove time — it MUST ship or every prove/auto-prove
  // throws over the npm channel.
  "scripts/spikes/dynamic-proof-spike.mjs",
  "scripts/spikes/failure-summary.mjs",
  "scripts/spikes/dynamic-proof-vitest-reporter.mjs",
  "scripts/spikes/dynamic-proof-jest-reporter.cjs",
  "scripts/spikes/dynamic-proof-mocha-reporter.cjs",
  "scripts/spikes/python-dynamic-proof-spike.mjs",
  "scripts/spikes/python-mutate.py",
  // Go + Java dynamic-proof spikes + their mutators — resolved from scripts/ at prove
  // time for Go/Java targets, same as the TS/JS + Python runtime above.
  "scripts/spikes/go-dynamic-proof-spike.mjs",
  "scripts/spikes/go-mutate.go",
  "scripts/spikes/java-dynamic-proof-spike.mjs",
  "scripts/spikes/java-mutate.mjs"
];
const TEXT_FILE_RE = /\.(?:c?js|mjs|json|md|d\.ts|map)$/i;
const phrase = (...parts: string[]) => parts.join("");
const BANNED_PACKAGE_CONTENT = [
  phrase("hosted", " ", "prompt"),
  phrase("two", "-", "phase", " ", "hosted"),
  phrase("two", "-", "phase", " ", "hosted", " ", "prompt"),
  phrase("strong", " ", "prompt"),
  phrase("internal", " ", "a/b"),
  phrase("internal", " ", "evaluation", " ", "harness"),
  phrase("removed", " ", "before", " ", "public", " ", "release"),
  phrase("not", " ", "shipped"),
  phrase("op", "_", "strong", "_", "prompt"),
  phrase("two", "phase"),
  phrase("compare", "system", "prompt"),
  "docs/internal-ab-eval.md",
  "docs/demo-local-proof-kit.md"
];

function packedFiles(): string[] {
  const out = execFileSync("npm", ["pack", "--dry-run", "--json"], {
    cwd: ROOT,
    encoding: "utf8",
    maxBuffer: 32 * 1024 * 1024
  });
  return JSON.parse(out)[0].files.map((f: { path: string }) => f.path);
}

describe("public package surface is local-only", () => {
  it("files allowlist is exactly the local-only set (never broad 'dist')", () => {
    expect([...pkg.files].sort()).toEqual([...ALLOWLIST].sort());
    expect(pkg.files).not.toContain("dist");
  });

  it("bin exposes only the local proof kit (opro + orangepro-local alias; no hosted bin)", () => {
    expect(Object.keys(pkg.bin).sort()).toEqual(["opro", "orangepro-local"]);
    expect(pkg.bin["opro"]).toBe("dist/local/cli.js");
    expect(pkg.bin["orangepro-local"]).toBe("dist/local/cli.js");
  });

  it("npm pack ships no hosted dist / src / tests / scripts / .env files", () => {
    // Requires a build so dist/local globs resolve; CI builds before testing.
    if (!existsSync(resolve(ROOT, "dist/local/cli.js"))) return;
    const files = packedFiles();
    // Only the dynamic-proof runtime may ship from scripts/; nothing else under scripts/.
    const SHIPPED_SCRIPTS = new Set([
      "scripts/spikes/dynamic-proof-spike.mjs",
      "scripts/spikes/failure-summary.mjs",
  "scripts/spikes/dynamic-proof-vitest-reporter.mjs",
  "scripts/spikes/dynamic-proof-jest-reporter.cjs",
  "scripts/spikes/dynamic-proof-mocha-reporter.cjs",
  "scripts/spikes/python-dynamic-proof-spike.mjs",
  "scripts/spikes/python-mutate.py",
  "scripts/spikes/go-dynamic-proof-spike.mjs",
  "scripts/spikes/go-mutate.go",
  "scripts/spikes/java-dynamic-proof-spike.mjs",
  "scripts/spikes/java-mutate.mjs"
    ]);
    const forbidden = files.filter(
      (p: string) =>
        /^dist\/(?!local\/)/.test(p) || // any hosted dist root file (index.js, qaTools.js, ...)
        /^(src|tests)\//.test(p) ||
        (/^scripts\//.test(p) && !SHIPPED_SCRIPTS.has(p)) ||
        /(^|\/)\.env/.test(p) ||
        /^\.(agent|claude|omc|paul)\//.test(p)
    );
    expect(forbidden).toEqual([]);
    expect(files).toContain("dist/local/cli.js");
  });
});

describe("removed hosted-IP artifacts can never ship", () => {
  // The private prompt sources were deleted, but tsc never removes STALE dist
  // outputs. The prebuild clean prevents recurrence; this guard makes any
  // future regression loud.
  it("npm pack contains no compiled hosted-prompt artifacts", () => {
    if (!existsSync(resolve(ROOT, "dist/local/cli.js"))) return; // needs a build (CI builds first)
    const files = packedFiles();
    const privatePromptArtifact = new RegExp(`${phrase("compare", "System", "Prompt")}|${phrase("two", "Phase")}`, "i");
    const banned = files.filter((p) => privatePromptArtifact.test(p));
    expect(banned).toEqual([]);
  });

  it("npm pack text files contain no private prompt or source-only doc references", () => {
    if (!existsSync(resolve(ROOT, "dist/local/cli.js"))) return; // needs a build (CI builds first)
    const leaks: string[] = [];
    for (const rel of packedFiles()) {
      if (!TEXT_FILE_RE.test(rel)) continue;
      const content = readFileSync(resolve(ROOT, rel), "utf8").toLowerCase().replace(/\s+/g, " ");
      for (const phrase of BANNED_PACKAGE_CONTENT) {
        if (content.includes(phrase.toLowerCase())) leaks.push(`${rel}: ${phrase}`);
      }
    }
    expect(leaks).toEqual([]);
  });

  it("shipped markdown links only point to shipped files or external URLs", () => {
    if (!existsSync(resolve(ROOT, "dist/local/cli.js"))) return; // needs a build (CI builds first)
    const files = new Set(packedFiles());
    const broken: string[] = [];
    for (const rel of [
      "README.md",
      "docs/agent-workflow.md",
      "docs/agents/codex.md",
      "docs/agents/claude-code.md",
      "docs/agents/cursor.md",
      "docs/agents/opencode.md",
      "docs/agents/vscode.md",
      "docs/local-proof-kit.md"
    ]) {
      const content = readFileSync(resolve(ROOT, rel), "utf8");
      for (const match of content.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)) {
        const raw = match[1].trim();
        if (/^(https?:|mailto:|#)/i.test(raw)) continue;
        const target = raw.split("#")[0];
        if (!target) continue;
        const normalized = resolve(dirname(resolve(ROOT, rel)), target).slice(ROOT.length + 1);
        if (!files.has(normalized)) broken.push(`${rel} -> ${raw}`);
      }
    }
    expect(broken).toEqual([]);
  });
});
