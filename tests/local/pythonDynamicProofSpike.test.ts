import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const root = path.resolve(__dirname, "../..");
const spike = path.join(root, "scripts/spikes/python-dynamic-proof-spike.mjs");
const fixtures = path.join(root, "tests/local/__fixtures__/python-proof");
const TEST_TIMEOUT = 60_000;

const HAS_UV = spawnSync("uv", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).status === 0;
const HAS_PYTHON = spawnSync("python", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).status === 0;
const PYTHON = spawnSync("python3", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).status === 0 ? "python3" : "python";
const FALLBACK_PYTHON = HAS_PYTHON ? "python" : "python3";
const UV_PROJECT = "[project]\nname='r7-proof'\nversion='0.0.1'\nrequires-python='>=3.12'\ndependencies=['pytest']\n[tool.uv]\n";

function runSpike(fixture: string, args: { test?: string; target?: string; func?: string; mode?: "sentinel" | "equivalent"; preflight?: boolean; pythonRunner?: string; skipPreflight?: boolean; timeoutMs?: number }) {
  const command = [spike, "--root", fixture, "--test", args.test ?? "tests/test_app.py::test_adds_two_numbers"];
  if (args.preflight) command.push("--preflight");
  else command.push("--target", args.target ?? "app.py", "--func", args.func ?? "add", "--mode", args.mode ?? "sentinel");
  if (args.pythonRunner) command.push("--python-runner", args.pythonRunner);
  if (args.skipPreflight) command.push("--skip-preflight");
  if (args.timeoutMs) command.push("--timeout-ms", String(args.timeoutMs));
  command.push("--json");
  const result = spawnSync(process.execPath, command, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: TEST_TIMEOUT });
  expect(result.status, result.stderr || result.stdout).toBe(0);
  return JSON.parse(result.stdout);
}

function tempPythonProject(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), "python-proof-r7-"));
  for (const [rel, body] of Object.entries(files)) {
    const absolute = path.join(dir, rel);
    mkdirSync(path.dirname(absolute), { recursive: true });
    writeFileSync(absolute, body, "utf8");
  }
  return dir;
}

// CI sets ORANGEPRO_REQUIRE_UV=1 so a missing uv fails the job instead of silently
// skipping every proof case below (a green run must mean these cases executed).
const REQUIRE_UV = process.env.ORANGEPRO_REQUIRE_UV === "1";

describe("python proof environment", () => {
  it.runIf(REQUIRE_UV)("has uv, so the proof cases run instead of being skipped", () => {
    expect(HAS_UV, "ORANGEPRO_REQUIRE_UV=1 but uv was not found on PATH").toBe(true);
  });
});

describe.skipIf(!HAS_UV)("python dynamic proof spike (R7.1)", () => {
  it("proves a typed scalar function and discloses identical runner diagnostics", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "app.py": "def answer() -> int:\n    return 42\n",
      "tests/test_app.py": "from app import answer\n\ndef test_answer():\n    assert answer() == 42\n"
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_app.py::test_answer", target: "app.py", func: "answer" });
      expect(verdict.status).toBe("proven");
      expect(verdict.mutation).toEqual({ sentinel: "0", source: "annotation:scalar" });
      expect(verdict.diagnostics).toEqual(expect.objectContaining({ command: expect.stringContaining("uv run --no-sync python -m pytest"), cwd: fixture, exit_code: 1, duration_ms: expect.any(Number), failure_class: "test_failed", stdout_tail: expect.any(Array), stderr_tail: expect.any(Array) }));
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("uses uv frozen when uv.lock is present and keeps the run command structured", () => {
    const fixture = tempPythonProject({
      "uv.lock": "version = 1\nrevision = 1\nrequires-python = '>=3.12'\n",
      "pyproject.toml": UV_PROJECT,
      "app.py": "def answer() -> int:\n    return 42\n",
      "tests/test_app.py": "from app import answer\n\ndef test_answer():\n    assert answer() == 42\n"
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_app.py::test_answer", target: "app.py", func: "answer" });
      // A synthetic hand-written lock can be stale; selection must nevertheless be
      // visible and any execution failure must fail closed rather than fall back.
      expect(verdict.diagnostics.command).toContain("uv sync --frozen --no-install-workspace");
      expect(verdict.status).not.toBe("proven");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("prepares dependencies without building a local workspace package, then proves the copied source", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT + "\n[build-system]\nrequires=['setuptools']\nbuild-backend='missing_backend_that_must_not_run'\n",
      "app.py": "def answer() -> int:\n    return 42\n",
      "tests/test_app.py": "from app import answer\n\ndef test_answer():\n    assert answer() == 42\n"
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_app.py::test_answer", target: "app.py", func: "answer" });
      expect(verdict.status, JSON.stringify(verdict)).toBe("proven");
      expect(verdict.diagnostics.command).toContain("uv run --no-sync python -m pytest");
      expect(existsSync(path.join(fixture, ".venv"))).toBe(false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("reuses a prepared uv environment without syncing or building the local project", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT + "\n[build-system]\nrequires=['setuptools']\nbuild-backend='missing_backend_that_must_not_run'\n",
      "app.py": "def answer() -> int:\n    return 42\n",
      "tests/test_app.py": "from app import answer\n\ndef test_answer():\n    assert answer() == 42\n"
    });
    try {
      const sync = spawnSync("uv", ["sync", "--no-install-workspace"], { cwd: fixture, encoding: "utf8", timeout: TEST_TIMEOUT });
      expect(sync.status, sync.stderr).toBe(0);
      const verdict = runSpike(fixture, { test: "tests/test_app.py::test_answer", target: "app.py", func: "answer" });
      expect(verdict.status, JSON.stringify(verdict)).toBe("proven");
      expect(verdict.diagnostics.command).toContain(path.join(fixture, ".venv/bin/python") + " -m pytest");
      expect(existsSync(path.join(fixture, ".venv", "bin", "python"))).toBe(true);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("imports the sandbox copy despite an editable installation pointing at the original", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": "[project]\nname='editable-proof-fixture'\nversion='0.0.1'\n[build-system]\nrequires=['setuptools']\nbuild-backend='setuptools.build_meta'\n",
      "app.py": "def answer() -> int:\n    return 42\n",
      "tests/test_app.py": "from app import answer\n\ndef test_answer():\n    assert answer() == 42\n"
    });
    try {
      const venv = spawnSync("uv", ["venv", ".venv", "--python", PYTHON], { cwd: fixture, encoding: "utf8", timeout: TEST_TIMEOUT });
      expect(venv.status, venv.stderr).toBe(0);
      const install = spawnSync("uv", ["pip", "install", "--python", path.join(fixture, ".venv/bin/python"), "-e", fixture, "pytest"], { cwd: fixture, encoding: "utf8", timeout: TEST_TIMEOUT });
      expect(install.status, install.stderr).toBe(0);
      const verdict = runSpike(fixture, { test: "tests/test_app.py::test_answer", target: "app.py", func: "answer" });
      expect(verdict.status, JSON.stringify(verdict)).toBe("proven");
      expect(verdict.target_import).toMatchObject({ verified: true, module: "app" });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("fails closed for an unannotated function without a direct type-constraining oracle", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "app.py": "def answer():\n    return 42\n",
      "tests/test_app.py": "from app import answer\n\ndef test_answer():\n    assert answer() > 0\n"
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_app.py::test_answer", target: "app.py", func: "answer" });
      expect(verdict.status).toBe("unrunnable");
      expect(verdict.category).toBe("mutation_unsupported");
      expect(verdict.reason).toContain("return_annotation_or_observed_oracle_required");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("proves an unannotated function that never returns a value by removing its side effect", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "store.py": [
        "class Store:",
        "    def __init__(self, client):",
        "        self.client = client",
        "",
        "    def remove(self, key):",
        "        def prefixed(k):",
        "            return 'ns:' + k",
        "        self.client.delete(prefixed(key))",
        ""
      ].join("\n"),
      "tests/test_store.py": [
        "from unittest.mock import MagicMock",
        "from store import Store",
        "",
        "def test_remove_deletes_prefixed_key():",
        "    client = MagicMock()",
        "    Store(client).remove('a')",
        "    client.delete.assert_called_once_with('ns:a')",
        ""
      ].join("\n")
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_store.py::test_remove_deletes_prefixed_key", target: "store.py", func: "remove" });
      expect(verdict.status).toBe("proven");
      expect(verdict.mutation).toEqual({ sentinel: "None", source: "body:no_return_value" });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("proves a kill even when the code under test logs ERROR lines that pytest prints as captured output", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "store.py": [
        "import logging",
        "log = logging.getLogger('store')",
        "",
        "class Store:",
        "    def __init__(self, client):",
        "        log.error('Error connecting to backing store')",
        "        print('ERROR something printed by the app')",
        "        self.client = client",
        "",
        "    def remove(self, key):",
        "        self.client.delete(key)",
        ""
      ].join("\n"),
      "tests/test_store.py": [
        "from unittest.mock import MagicMock",
        "from store import Store",
        "",
        "def test_remove_deletes_key():",
        "    client = MagicMock()",
        "    Store(client).remove('a')",
        "    client.delete.assert_called_once_with('a')",
        ""
      ].join("\n")
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_store.py::test_remove_deletes_key", target: "store.py", func: "remove" });
      expect(verdict.status).toBe("proven");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("still refuses an unannotated function that returns a value on any path", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "app.py": "def pick(flag):\n    if flag:\n        return 'yes'\n    print('no')\n",
      "tests/test_app.py": "from app import pick\n\ndef test_pick():\n    assert pick(True)\n"
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_app.py::test_pick", target: "app.py", func: "pick" });
      expect(verdict.status).toBe("unrunnable");
      expect(verdict.reason).toContain("return_annotation_or_observed_oracle_required");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("permits an unannotated function only when a direct scalar equality oracle constrains it", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "app.py": "def answer():\n    return 42\n",
      "tests/test_app.py": "from app import answer\n\ndef test_answer():\n    assert answer() == 42\n"
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_app.py::test_answer", target: "app.py", func: "answer" });
      expect(verdict.status).toBe("proven");
      expect(verdict.mutation).toEqual({ sentinel: "0", source: "observed_oracle:scalar" });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("classifies collection/import failure as environment_unavailable in one collection preflight", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "app.py": "def answer() -> int:\n    return 42\n",
      "tests/test_app.py": "import definitely_missing_r7_dependency\n\ndef test_answer():\n    assert True\n"
    });
    try {
      const verdict = runSpike(fixture, { preflight: true });
      expect(verdict.status).toBe("environment_unavailable");
      expect(verdict.category).toBe("collection_error");
      expect(verdict.diagnostics).toMatchObject({ failure_class: "collection_error", stdout_tail: expect.any(Array), stderr_tail: expect.any(Array) });
      expect(verdict.diagnostics.stdout_tail.length).toBeLessThanOrEqual(40);
      expect(verdict.diagnostics.stderr_tail.length).toBeLessThanOrEqual(40);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("uses the nested test project cwd while allowing a target elsewhere inside the repo", () => {
    const fixture = tempPythonProject({
      "shared.py": "def answer() -> int:\n    return 42\n",
      "apps/api/pyproject.toml": UV_PROJECT,
      "apps/api/tests/test_app.py": "import sys\nfrom pathlib import Path\nsys.path.insert(0, str(Path(__file__).parents[3]))\nfrom shared import answer\n\ndef test_answer():\n    assert answer() == 42\n"
    });
    try {
      const verdict = runSpike(fixture, { test: "apps/api/tests/test_app.py::test_answer", target: "shared.py", func: "answer" });
      expect(verdict.status).toBe("proven");
      expect(verdict.project_root).toBe("apps/api");
      expect(verdict.diagnostics.cwd).toBe(path.join(fixture, "apps/api"));
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("proves a target inside a namespace subpackage (no __init__.py) of a regular package", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "pkg/__init__.py": "",
      "pkg/experimental/server/db.py": "def answer() -> int:\n    return 42\n",
      "tests/test_db.py": "from pkg.experimental.server.db import answer\n\ndef test_answer():\n    assert answer() == 42\n"
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_db.py::test_answer", target: "pkg/experimental/server/db.py", func: "answer" });
      expect(verdict.status).toBe("proven");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("still refuses a target whose top-level folder is not a regular package", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "loose/server/db.py": "def answer() -> int:\n    return 42\n",
      "tests/test_db.py": "from loose.server.db import answer\n\ndef test_answer():\n    assert answer() == 42\n"
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_db.py::test_answer", target: "loose/server/db.py", func: "answer" });
      expect(verdict.status).toBe("unrunnable");
      expect(verdict.reason).toContain("target_not_loaded_from_sandbox");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("parses a custom runner into argv without a shell and redacts separate diagnostic tails", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "runner.py": [
        "import os, sys",
        "print('stdout-' + os.environ.get('PROOF_MARK', 'missing'))",
        "print('api_key=abcdefghijklmnopqrstuv', file=sys.stderr)",
        "raise SystemExit(2)"
      ].join("\n"),
      "app.py": "def answer() -> int:\n    return 42\n",
      "tests/test_app.py": "def test_answer():\n    assert True\n"
    });
    try {
      const verdict = runSpike(fixture, { preflight: true, pythonRunner: `${PYTHON} runner.py --label 'two words'; touch shell-was-run` });
      expect(verdict.diagnostics.command).toContain(`${PYTHON} runner.py --label two words; touch shell-was-run -q --collect-only`);
      expect(verdict.diagnostics.failure_class).toBe("env_unavailable");
      expect(verdict.diagnostics.stdout_tail.join("\n")).toContain("stdout-missing");
      expect(verdict.diagnostics.stderr_tail.join("\n")).toContain("<redacted:credential>");
      expect(verdict.diagnostics.stderr_tail.join("\n")).not.toContain("abcdefghijklmnopqrstuv");
      expect(existsSync(path.join(fixture, "shell-was-run"))).toBe(false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("classifies a missing custom executable and a timeout as env-unavailable and timeout diagnostics", () => {
    const missing = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "app.py": "def answer() -> int:\n    return 42\n",
      "tests/test_app.py": "def test_answer():\n    assert True\n"
    });
    const slow = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "runner.py": "import time\ntime.sleep(10)\n",
      "app.py": "def answer() -> int:\n    return 42\n",
      "tests/test_app.py": "def test_answer():\n    assert True\n"
    });
    try {
      const missingVerdict = runSpike(missing, { preflight: true, pythonRunner: "definitely-missing-python-proof-runner" });
      expect(missingVerdict).toMatchObject({ status: "environment_unavailable", category: "environment_unavailable" });
      expect(missingVerdict.diagnostics).toMatchObject({ failure_class: "env_unavailable", exit_code: null });

      const timeoutVerdict = runSpike(slow, { preflight: true, pythonRunner: `${PYTHON} runner.py`, timeoutMs: 50 });
      expect(timeoutVerdict).toMatchObject({ status: "environment_unavailable", category: "environment_unavailable" });
      expect(timeoutVerdict.diagnostics).toMatchObject({ failure_class: "timeout" });
    } finally {
      rmSync(missing, { recursive: true, force: true });
      rmSync(slow, { recursive: true, force: true });
    }
  }, TEST_TIMEOUT);

  it("does not copy Cargo build output into the isolated Python project", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "native/Cargo.toml": "[package]\nname='native-fixture'\nversion='0.1.0'\n",
      "native/target/debug/deps/generated.o": "compiled artifact, not source",
      "runner.py": "from pathlib import Path\nprint('COPIED_TARGET=' + str(Path('native/target').exists()))\nraise SystemExit(2)\n",
      "tests/test_app.py": "def test_answer():\n    assert True\n"
    });
    try {
      const verdict = runSpike(fixture, { preflight: true, pythonRunner: `${PYTHON} runner.py` });
      expect(verdict.diagnostics.stdout_tail.join("\n")).toContain("COPIED_TARGET=False");
      expect(existsSync(path.join(fixture, "native/target/debug/deps/generated.o"))).toBe(true);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("kills timed-out runner descendants before cleaning the isolated copy", async () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "runner.py": [
        "import subprocess, sys, time",
        "subprocess.Popen([sys.executable, '-c', 'import time; from pathlib import Path; time.sleep(0.3); Path(' + repr(sys.argv[1]) + ').write_text(\"survived\")'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)",
        "time.sleep(5)"
      ].join("\n"),
      "tests/test_app.py": "def test_answer():\n    assert True\n"
    });
    const marker = path.join(fixture, "surviving-child.txt");
    try {
      const verdict = runSpike(fixture, { preflight: true, pythonRunner: `${PYTHON} runner.py '${marker}'`, timeoutMs: 100 });
      expect(verdict.diagnostics.failure_class).toBe("timeout");
      await new Promise((resolve) => setTimeout(resolve, 600));
      expect(existsSync(marker)).toBe(false);
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("uses python3 as the fallback interpreter when python is unavailable", () => {
    const fixture = tempPythonProject({
      "app.py": "def answer() -> int:\n    return 42\n",
      "tests/test_app.py": "from app import answer\n\ndef test_answer():\n    assert answer() == 42\n"
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_app.py::test_answer", target: "app.py", func: "answer" });
      expect(verdict.diagnostics.command).toContain(`${FALLBACK_PYTHON} -m pytest`);
      if (!HAS_PYTHON) expect(verdict.diagnostics.runner_fallback).toContain("python is unavailable; using python3");
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("supports skipping a previously successful preflight and uses a mapping sentinel", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "app.py": "from typing import Mapping\n\ndef value() -> Mapping[str, int]:\n    return {'answer': 42}\n",
      "tests/test_app.py": "from app import value\n\ndef test_value():\n    assert value() == {'answer': 42}\n"
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_app.py::test_value", target: "app.py", func: "value", skipPreflight: true });
      expect(verdict.status).toBe("proven");
      expect(verdict.mutation).toEqual({ sentinel: "{}", source: "annotation:mapping" });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);

  it("uses the same empty mapping sentinel and provenance for a concrete dict annotation", () => {
    const fixture = tempPythonProject({
      "pyproject.toml": UV_PROJECT,
      "app.py": "def value() -> dict[str, int]:\n    return {'answer': 42}\n",
      "tests/test_app.py": "from app import value\n\ndef test_value():\n    assert value() == {'answer': 42}\n"
    });
    try {
      const verdict = runSpike(fixture, { test: "tests/test_app.py::test_value", target: "app.py", func: "value", skipPreflight: true });
      expect(verdict.status).toBe("proven");
      expect(verdict.mutation).toEqual({ sentinel: "{}", source: "annotation:mapping" });
    } finally { rmSync(fixture, { recursive: true, force: true }); }
  }, TEST_TIMEOUT);
});
