import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { opAnalyze, opGenerate, opInit } from "../../src/local/operations.js";
import { loadGraph, saveGraph, workspacePaths } from "../../src/local/workspace.js";
import type { ModelCompletionRequest, ModelProvider } from "../../src/local/types.js";

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "oplocal-pin-"));
  dirs.push(d);
  return d;
}

function scaffold(root: string, body = 'return n + "!";'): void {
  mkdirSync(join(root, "src/payments"), { recursive: true });
  mkdirSync(join(root, "tests/payments"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "pin-fixture", devDependencies: { vitest: "^3" } }));
  writeFileSync(join(root, "src/payments/card.ts"), `export function saveCard(n: string) { ${body} }\n`);
  writeFileSync(
    join(root, "tests/payments/card.test.ts"),
    [
      'import { it, expect } from "vitest";',
      'import { saveCard } from "../../src/payments/card";',
      'it("saves a card", () => { expect(saveCard("a")).toBe("a!"); });',
      ""
    ].join("\n")
  );
}

/** Emits a DIFFERENT runnable body on every call, so a byte-identical second
 *  result can only mean the stored draft was reused, never re-generated. */
class CountingProvider implements ModelProvider {
  readonly providerName = "fake";
  readonly modelName = "fake-pin";
  calls = 0;

  async complete(_req: ModelCompletionRequest): Promise<string> {
    this.calls += 1;
    const n = this.calls;
    return [
      `it("saveCard keeps its input (draft ${n})", () => {`,
      `  expect(saveCard("a")).toBe("a!");`,
      `  expect(${n}).toBe(${n});`,
      "});"
    ].join("\n");
  }
}

const TARGET = "sym:src/payments/card.ts#saveCard";

describe("pinned generated drafts", () => {
  it("reuses the stored draft for an unchanged target instead of regenerating", async () => {
    const root = temp();
    const clock = () => "2026-07-28T00:00:00Z";
    const provider = new CountingProvider();
    const deps = { clock, env: {} as NodeJS.ProcessEnv, aiProvider: provider };
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);

    const first = await opGenerate(root, { limit: 1, target_ids: [TARGET] }, deps);
    expect(first.generated_tests).toHaveLength(1);
    const firstDraft = first.generated_tests[0];
    expect(firstDraft.runnable).not.toBe(false);
    expect(firstDraft.pinned).toBeUndefined();
    expect(firstDraft.target_fingerprint).toMatch(/^sha256:/);
    const callsAfterFirst = provider.calls;
    expect(callsAfterFirst).toBeGreaterThan(0);

    const second = await opGenerate(root, { limit: 1, target_ids: [TARGET] }, deps);
    expect(second.generated_tests).toHaveLength(1);
    const secondDraft = second.generated_tests[0];

    // Identical draft, served from the pin: same id, same body, no model call.
    expect(provider.calls).toBe(callsAfterFirst);
    expect(secondDraft.pinned).toBe(true);
    expect({ ...secondDraft, pinned: undefined }).toEqual({ ...firstDraft, pinned: undefined });
    expect(second.run_id).toBeNull();
    expect(second.warnings.join("\n")).toContain("Reused");

    // ...and the pin does NOT duplicate the draft in the persisted graph.
    const stored = loadGraph(workspacePaths(root).graphPath).generated_tests.filter(
      (t) => t.target_symbol_external_id === TARGET
    );
    expect(stored).toHaveLength(1);
    expect(stored[0].id).toBe(firstDraft.id);
  });

  it("regenerates once the target's fingerprint changes", async () => {
    const root = temp();
    const clock = () => "2026-07-28T00:00:00Z";
    const provider = new CountingProvider();
    const deps = { clock, env: {} as NodeJS.ProcessEnv, aiProvider: provider };
    opInit(root, deps);
    scaffold(root);
    opAnalyze(root, { source: root }, deps);

    const first = await opGenerate(root, { limit: 1, target_ids: [TARGET] }, deps);
    const callsAfterFirst = provider.calls;

    // Edit the target's source and restamp ONLY its manifest hash — what a real
    // edit + re-analysis does to the fingerprint — while leaving the stored drafts
    // in place (a full opAnalyze rebuild would drop them and prove nothing).
    scaffold(root, 'return n + "!!";');
    const graphPath = workspacePaths(root).graphPath;
    const stale = loadGraph(graphPath);
    saveGraph(graphPath, {
      ...stale,
      manifest: {
        ...stale.manifest,
        files: {
          ...stale.manifest.files,
          "src/payments/card.ts": { ...stale.manifest.files["src/payments/card.ts"], hash: "sha256:edited" }
        }
      }
    });

    const second = await opGenerate(root, { limit: 1, target_ids: [TARGET] }, deps);
    expect(provider.calls).toBeGreaterThan(callsAfterFirst);
    expect(second.generated_tests[0].pinned).toBeUndefined();
    expect(second.generated_tests[0].body).not.toBe(first.generated_tests[0].body);
    expect(second.generated_tests[0].target_fingerprint).not.toBe(first.generated_tests[0].target_fingerprint);
  });
});
