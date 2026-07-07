import { describe, expect, it, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { opAnalyze, opDynamicProof, opInit, type OperationDeps } from "../../src/local/operations.js";

/**
 * G2 — module-root walk-up + Python sandbox narrowing. Driven through
 * opDynamicProof with a capturing fake runner that records the spike args and
 * throws before any oracle work: these tests prove SCOPING only and can never
 * mint, which is exactly the G2 trust boundary (discovery/scoping ≠ gate).
 */
const deps: OperationDeps = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };

const dirs: string[] = [];
function temp(): string {
  const d = mkdtempSync(join(tmpdir(), "oplocal-modroot-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function capturing(): { runner: (args: string[], opts?: unknown) => never; args: () => string[] } {
  let captured: string[] = [];
  return {
    runner: (args: string[]) => {
      captured = args;
      throw new Error("CAPTURED-ARGS");
    },
    args: () => captured
  };
}

function flag(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
}

describe("G2 — Go module-root walk-up (bounded by the invocation root)", () => {
  it("walks ABOVE the analyzed path to the invocation root's go.mod (the `opro start ./subpkg` wall)", () => {
    const ws = temp();
    writeFileSync(join(ws, "go.mod"), "module example.com/m\n\ngo 1.22\n");
    const source = join(ws, "sub");
    mkdirSync(join(source, "pkg"), { recursive: true });
    writeFileSync(join(source, "pkg", "calc.go"), "package pkg\n\nfunc Add(a int, b int) int { return a + b }\n");
    opInit(ws, deps);
    opAnalyze(ws, { source }, deps);

    const cap = capturing();
    expect(() =>
      opDynamicProof(
        ws,
        { target_symbol: "sym:pkg/calc.go#Add", source, test_run: "^TestAdd$" },
        { ...deps, dynamicProofRunner: cap.runner }
      )
    ).toThrow("CAPTURED-ARGS");
    // The sandbox root is the go.mod ABOVE the analyzed path — bounded at ws.
    expect(flag(cap.args(), "--root")).toBe(resolve(ws));
    // The target is re-expressed relative to the chosen module root.
    expect(flag(cap.args(), "--target")).toBe("sub/pkg/calc.go");
  });

  it("keeps today's behavior when go.mod lives inside the analyzed path", () => {
    const ws = temp();
    const source = join(ws, "svc");
    mkdirSync(join(source, "pkg"), { recursive: true });
    writeFileSync(join(source, "go.mod"), "module example.com/svc\n\ngo 1.22\n");
    writeFileSync(join(source, "pkg", "calc.go"), "package pkg\n\nfunc Add(a int, b int) int { return a + b }\n");
    opInit(ws, deps);
    opAnalyze(ws, { source }, deps);

    const cap = capturing();
    expect(() =>
      opDynamicProof(
        ws,
        { target_symbol: "sym:pkg/calc.go#Add", source, test_run: "^TestAdd$" },
        { ...deps, dynamicProofRunner: cap.runner }
      )
    ).toThrow("CAPTURED-ARGS");
    expect(flag(cap.args(), "--root")).toBe(resolve(source));
    expect(flag(cap.args(), "--target")).toBe("pkg/calc.go");
  });

  it("never escapes: an analyzed path OUTSIDE the invocation root keeps sourceRoot confinement and fails closed", () => {
    const ws = temp();
    const source = temp(); // sibling temp dir — NOT inside ws
    mkdirSync(join(source, "pkg"), { recursive: true });
    writeFileSync(join(source, "pkg", "calc.go"), "package pkg\n\nfunc Add(a int, b int) int { return a + b }\n");
    opInit(ws, deps);
    opAnalyze(ws, { source }, deps);

    const cap = capturing();
    // No go.mod anywhere under source, and the walk must NOT wander toward ws
    // (or the filesystem root) — it fails closed with the honest bound named.
    expect(() =>
      opDynamicProof(
        ws,
        { target_symbol: "sym:pkg/calc.go#Add", source, test_run: "^TestAdd$" },
        { ...deps, dynamicProofRunner: cap.runner }
      )
    ).toThrow(/No go\.mod found/);
  });
});

describe("G2 — Python sandbox narrowing (nearest project root, fail-safe)", () => {
  function pythonFixture(splitTest: boolean): { ws: string; source: string } {
    const ws = temp();
    const source = join(ws, "app");
    mkdirSync(join(source, "pkg", "tests"), { recursive: true });
    writeFileSync(join(source, "pkg", "pyproject.toml"), "[project]\nname = \"pkg\"\n");
    writeFileSync(join(source, "pkg", "app.py"), "def add(a, b):\n    return a + b\n");
    const testDir = splitTest ? join(source, "tests") : join(source, "pkg", "tests");
    mkdirSync(testDir, { recursive: true });
    writeFileSync(join(testDir, "test_app.py"), "from pkg.app import add\n\ndef test_add():\n    assert add(1, 2) == 3\n");
    opInit(ws, deps);
    opAnalyze(ws, { source }, deps);
    return { ws, source };
  }

  it("narrows the sandbox to the owning pyproject dir when target AND test live inside it", () => {
    const { ws, source } = pythonFixture(false);
    const cap = capturing();
    expect(() =>
      opDynamicProof(
        ws,
        {
          target_symbol: "sym:pkg/app.py#add",
          source,
          test_path: "pkg/tests/test_app.py",
          replacement: "return 1",
          runner: "pytest"
        },
        { ...deps, dynamicProofRunner: cap.runner }
      )
    ).toThrow("CAPTURED-ARGS");
    expect(flag(cap.args(), "--root")).toBe(join(resolve(source), "pkg"));
    expect(flag(cap.args(), "--target")).toBe("app.py");
    expect(flag(cap.args(), "--test")).toBe("tests/test_app.py");
  });

  it("falls back to the analyzed root when the test lives OUTSIDE the project dir (narrowing only, never breaking)", () => {
    const { ws, source } = pythonFixture(true);
    const cap = capturing();
    expect(() =>
      opDynamicProof(
        ws,
        {
          target_symbol: "sym:pkg/app.py#add",
          source,
          test_path: "tests/test_app.py",
          replacement: "return 1",
          runner: "pytest"
        },
        { ...deps, dynamicProofRunner: cap.runner }
      )
    ).toThrow("CAPTURED-ARGS");
    expect(flag(cap.args(), "--root")).toBe(resolve(source));
    expect(flag(cap.args(), "--target")).toBe("pkg/app.py");
    expect(flag(cap.args(), "--test")).toBe("tests/test_app.py");
  });
});
