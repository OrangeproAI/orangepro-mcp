import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { preloadTreeSitter } from "../../src/local/analyze/treeSitter/engine.js";
import { opAnalyze, opDynamicProof, opInit } from "../../src/local/operations.js";

const deps = { clock: () => "2026-07-05T00:00:00Z", env: {} as NodeJS.ProcessEnv };
const tempDirs: string[] = [];

beforeAll(async () => {
  await preloadTreeSitter(["python", "typescript"]);
});

afterEach(() => {
  while (tempDirs.length) rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "op-python-product-"));
  tempDirs.push(dir);
  return dir;
}

describe("Python dynamic proof product integration", () => {
  it("routes Python targets through the Python spike and mints public Proven through the existing RTM gate", () => {
    const W = makeTempDir();
    writeFileSync(join(W, "app.py"), "def answer():\n    return 42\n", "utf8");
    writeFileSync(join(W, "test_app.py"), "from app import answer\n\ndef test_answer():\n    assert answer() == 42\n", "utf8");
    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    const runner = vi.fn(() => ({
      stdout: JSON.stringify({
        status: "proven",
        proven: true,
        reason: "mutant failed at a trusted pytest assertion",
        runner: "pytest",
        baseline: { exitCode: 0, timedOut: false },
        mutant: { exitCode: 1, timedOut: false, assertionFailure: true },
        test: "test_app.py::test_answer",
        target: "app.py",
        func: "answer"
      }),
      stderr: "",
      exitCode: 0
    }));

    const result = opDynamicProof(W, {
      target_symbol: "sym:app.py#answer",
      test_path: "test_app.py::test_answer",
      replacement: "return 0",
      runner: "pytest"
    }, { ...deps, dynamicProofRunner: runner });

    expect(runner).toHaveBeenCalledWith(
      expect.arrayContaining(["--root", W, "--test", "test_app.py::test_answer", "--target", "app.py", "--func", "answer", "--mode", "sentinel", "--json"]),
      expect.objectContaining({ cwd: W, scriptPath: expect.stringContaining("python-dynamic-proof-spike.mjs") })
    );
    expect(result.record).toMatchObject({
      target_symbol: "sym:app.py#answer",
      language: "python",
      status: "reproven",
      closed: true,
      dynamic_proof: {
        proof_kind: "dynamic_targeted",
        baseline_green: true,
        mutant_failed_assertion: true,
        target_not_mocked: true,
        runner: "pytest",
        test_path: "test_app.py::test_answer"
      }
    });
  });

  it("refuses pytest for non-Python targets", () => {
    const W = makeTempDir();
    writeFileSync(join(W, "package.json"), JSON.stringify({ name: "fixture" }), "utf8");
    writeFileSync(join(W, "service.ts"), "export function answer(): number { return 42; }\n", "utf8");
    writeFileSync(join(W, "service.test.ts"), "import { answer } from './service';\nit('answer', () => expect(answer()).toBe(42));\n", "utf8");
    opInit(W, deps);
    opAnalyze(W, { source: W }, deps);

    expect(() =>
      opDynamicProof(W, {
        target_symbol: "sym:service.ts#answer",
        test_path: "service.test.ts",
        replacement: "return null;",
        runner: "pytest"
      }, { ...deps, dynamicProofRunner: vi.fn() })
    ).toThrow("prove --runner pytest requires a Python target");
  });
});
