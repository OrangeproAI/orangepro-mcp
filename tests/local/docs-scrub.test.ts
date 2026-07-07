import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");

// Public surfaces guarded against stale private-prompt / IP-adjacent claims.
// README.md + docs/local-proof-kit.md ship in the npm package (package.json `files`);
// src/local/cli.ts compiles into the shipped dist/local/cli.js (its --help text).
// All guarded for defense-in-depth.
const GUARDED_DOCS = [
  { rel: "README.md", required: true },
  { rel: "docs/agent-workflow.md", required: true },
  { rel: "docs/agents/codex.md", required: true },
  { rel: "docs/agents/claude-code.md", required: true },
  { rel: "docs/agents/cursor.md", required: true },
  { rel: "docs/agents/opencode.md", required: true },
  { rel: "docs/agents/vscode.md", required: true },
  { rel: "docs/local-proof-kit.md", required: true },
  { rel: "docs/demo-local-proof-kit.md", required: true },
  { rel: "src/local/cli.ts", required: true },
  { rel: "scripts/demo-local-proof-kit.mjs", required: true },
  { rel: "src/local/generate/generator.ts", required: true },
  { rel: "src/local/generate/compareReport.ts", required: true },
  { rel: "src/local/generate/runHints.ts", required: true },
  { rel: "src/local/generate/prompt.ts", required: true }
];

const phrase = (...parts: string[]) => parts.join("");

// Removed implementation details and mutating/inaccurate-behavior wording must not reappear.
const BANNED_PHRASES = [
  phrase("hosted", " ", "prompt"),
  phrase("same full hosted", " ", "prompt"),
  phrase("two", "-", "phase", " ", "hosted"),
  phrase("two", "-", "phase", " ", "hosted", " ", "flow"),
  phrase("two", "-", "phase", " ", "hosted", " ", "prompt"),
  phrase("strong", " ", "prompt"),
  phrase("internal", " ", "a/b"),
  phrase("internal", " ", "evaluation", " ", "harness"),
  phrase("removed", " ", "before", " ", "public", " ", "release"),
  phrase("not", " ", "shipped"),
  phrase("no", " ", "source", " ", "upload"),
  phrase("op", "_", "strong", "_", "prompt"),
  phrase("two", "phase"),
  phrase("compare", "system", "prompt"),
  phrase("gh", "-", "checkout"),
];

const BANNED_LINKS = [
  "docs/internal-ab-eval.md",
  "docs/demo-local-proof-kit.md"
];

describe("shipped docs do not leak hosted-prompt / IP-adjacent phrases", () => {
  for (const { rel, required } of GUARDED_DOCS) {
    const abs = resolve(repoRoot, rel);

    it(`${rel} exists and is non-empty`, () => {
      if (!required && !existsSync(abs)) return;
      expect(existsSync(abs), `${rel} is missing (renamed? update GUARDED_DOCS)`).toBe(true);
      expect(readFileSync(abs, "utf8").trim().length).toBeGreaterThan(0);
    });

    for (const phrase of BANNED_PHRASES) {
      it(`${rel} does not contain "${phrase}"`, () => {
        if (!required && !existsSync(abs)) return;
        // collapse whitespace so a phrase wrapped across a line break is still caught
        const content = readFileSync(abs, "utf8").toLowerCase().replace(/\s+/g, " ");
        expect(
          content.includes(phrase.toLowerCase()),
          `${rel} contains banned phrase "${phrase}" — scrub the public surface`,
        ).toBe(false);
      });
    }
  }

  for (const rel of ["README.md", "docs/local-proof-kit.md"]) {
    for (const link of BANNED_LINKS) {
      it(`${rel} does not link to private/source-only doc ${link}`, () => {
        const content = readFileSync(resolve(repoRoot, rel), "utf8").toLowerCase();
        expect(content.includes(link.toLowerCase()), `${rel} links to ${link}`).toBe(false);
      });
    }
  }
});
