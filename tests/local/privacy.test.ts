import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { opAnalyze, opExport, opGenerate, opStatus } from "../../src/local/operations.js";

// A fake BYOK key that must NEVER be persisted to any local artifact.
const FAKE_KEY = "sk-shouldNeverPersist-000000000000000000";
// Unique tokens placed inside a source file: a secret-looking string and a
// distinctive function body token. Neither should ever appear in the pack,
// because snippets are off by default (metadata-only).
const SECRET_TOKEN = "MyV3ryUniqueSecretLooking_TOKEN_aa11bb22cc33";
const FUNCTION_BODY_TOKEN = "uniqueFunctionBodyMarker_xyz789_doNotLeak";

const CLOCK = () => "2026-06-07T00:00:00Z";
// deps for analyze/status/export: env carries the fake key, which must never
// be written to graph.json / config.json / the evidence pack.
const depsWithKey = { clock: CLOCK, env: { OPENAI_API_KEY: FAKE_KEY } as NodeJS.ProcessEnv };
// deps for generate: opt into the offline DeterministicProvider explicitly so
// the test makes no real network/LLM calls (deterministic is now opt-in only).
const depsOffline = { clock: CLOCK, env: { ORANGEPRO_ALLOW_DETERMINISTIC: "1" } as NodeJS.ProcessEnv };

function writeFixture(root: string): void {
  // A package.json so the analyzer detects a real workspace + frameworks.
  writeFileSync(
    join(root, "package.json"),
    JSON.stringify(
      {
        name: "privacy-fixture",
        version: "0.0.0",
        devDependencies: { vitest: "^1.0.0" }
      },
      null,
      2
    ),
    "utf8"
  );

  const srcDir = join(root, "src");
  mkdirSync(srcDir, { recursive: true });

  // Source file containing BOTH a secret-looking string and a distinctive
  // function body token. The metadata-only pack must contain neither raw value.
  writeFileSync(
    join(srcDir, "checkout.ts"),
    [
      "export function applyDiscount(total: number): number {",
      `  // ${FUNCTION_BODY_TOKEN}`,
      `  const apiKey = "${SECRET_TOKEN}";`,
      "  if (total > 100) return total * 0.9;",
      "  return total;",
      "}",
      ""
    ].join("\n"),
    "utf8"
  );

  // A requirements markdown so behavior anchors exist for generation.
  writeFileSync(
    join(root, "requirements.md"),
    [
      "# Requirements",
      "",
      "## Checkout discount",
      "As a shopper, when my cart total exceeds 100 the system applies a 10% discount.",
      "",
      "Acceptance criteria:",
      "- discount is applied above threshold",
      "- no discount at or below threshold",
      ""
    ].join("\n"),
    "utf8"
  );
}

describe("privacy / no-upload defaults / BYOK key safety", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "oplocal-"));
    writeFixture(dir);
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("reports local-only privacy with upload disabled and no source snippets", () => {
    opAnalyze(dir, {}, depsWithKey);
    const status = opStatus(dir, depsWithKey);

    expect(status.privacy).toEqual({
      graph_storage: "local",
      upload_enabled: false,
      source_snippets_in_pack: false
    });
    expect(status.local_only).toBe(true);
  });

  it("never persists the BYOK key or its env var name into graph/config/pack", async () => {
    opAnalyze(dir, {}, depsWithKey);
    // Generation runs fully offline (empty env -> DeterministicProvider).
    await opGenerate(dir, {}, depsOffline);
    const exported = opExport(dir, "evidence-pack.json", {}, depsWithKey);

    const graphJson = readFileSync(join(dir, ".orangepro", "graph.json"), "utf8");
    const configJson = readFileSync(join(dir, ".orangepro", "config.json"), "utf8");
    const packJson = readFileSync(exported.pack_path, "utf8");

    for (const [label, contents] of [
      ["graph.json", graphJson],
      ["config.json", configJson],
      ["pack", packJson]
    ] as const) {
      expect(contents, `${label} must not contain the BYOK key`).not.toContain(FAKE_KEY);
      expect(contents, `${label} must not contain OPENAI_API_KEY`).not.toContain("OPENAI_API_KEY");
    }
  });

  it("excludes raw source function bodies from the exported pack (snippets off by default)", () => {
    opAnalyze(dir, {}, depsWithKey);
    const exported = opExport(dir, "evidence-pack.json", {}, depsWithKey);
    const packJson = readFileSync(exported.pack_path, "utf8");

    // The distinctive function body token lives only inside raw source; a
    // metadata-only pack must not embed it.
    expect(packJson).not.toContain(FUNCTION_BODY_TOKEN);
    // The secret-looking string likewise must never cross the IP boundary.
    expect(packJson).not.toContain(SECRET_TOKEN);
  });

  it("does not write generated test files into the source tree", async () => {
    opAnalyze(dir, {}, depsWithKey);
    const result = await opGenerate(dir, {}, depsOffline);

    expect(result.wrote_repo_files).toBe(false);

    // Only the .orangepro workspace dir is OrangePro-owned; the source tree
    // must be untouched apart from our fixture files. Specifically, no test
    // files should have been emitted anywhere under the source tree.
    const srcFiles = readdirSync(join(dir, "src"));
    expect(srcFiles).toEqual(["checkout.ts"]);

    // No spec/test files anywhere outside the workspace dir.
    const topLevel = readdirSync(dir).filter((n) => n !== ".orangepro" && n !== ".orangeproignore");
    for (const name of topLevel) {
      expect(name).not.toMatch(/\.(test|spec)\.[jt]sx?$/);
    }
  });
});
