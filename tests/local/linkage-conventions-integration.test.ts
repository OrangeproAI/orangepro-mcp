import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";

import { opInit, opAnalyze } from "../../src/local/operations.js";
import { loadGraph } from "../../src/local/workspace.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const DEPS = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };

function repo(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-conv-"));
  dirs.push(root);
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }));
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}

function mayRelateTo(root: string): Array<{ from: string; to: string; reason: string }> {
  const g = loadGraph(join(root, ".orangepro", "graph.json"));
  return (g.candidate_edges ?? [])
    .filter((e) => e.relationship_type === "MAY_RELATE_TO")
    .map((e) => ({ from: e.from_external_id, to: e.to_external_id, reason: e.reason }));
}

describe("convention linkage end-to-end (analyze emits MAY_RELATE_TO candidate edges)", () => {
  it("links a Java src/test mirror that the basename-stem matcher cannot reach", () => {
    const root = repo({
      "src/main/java/com/acme/owner/OwnerController.java": "public class OwnerController { public String show() { return \"x\"; } }\n",
      "src/test/java/com/acme/owner/OwnerControllerTests.java": "public class OwnerControllerTests { public void show_works() {} }\n"
    });
    opInit(root, DEPS);
    opAnalyze(root, { source: root }, DEPS);
    const links = mayRelateTo(root);
    const link = links.find((l) => l.from.endsWith("OwnerControllerTests.java"));
    expect(link).toBeDefined();
    expect(link?.to).toBe("src/main/java/com/acme/owner/OwnerController.java");
    expect(link?.reason).toMatch(/src\/test→src\/main mirror/);
  });

  it("links a Python tests/ mirror", () => {
    const root = repo({
      "app/billing.py": "def charge():\n    return 1\n",
      "app/tests/test_billing.py": "def test_charge():\n    assert True\n"
    });
    opInit(root, DEPS);
    opAnalyze(root, { source: root }, DEPS);
    const link = mayRelateTo(root).find((l) => l.from.endsWith("test_billing.py"));
    expect(link?.to).toBe("app/billing.py");
    expect(link?.reason).toMatch(/module mirror/);
  });

  it("does NOT link a non-Test Java file in the test tree (helper/shadow class)", () => {
    // A class under src/test that is not a *Test/*Tests/*IT is a Surefire-excluded
    // helper. The old global stem matcher wrongly linked it to its src/main shadow.
    const root = repo({
      "src/main/java/com/acme/OwnerController.java": "public class OwnerController { public String show() { return \"x\"; } }\n",
      "src/test/java/com/acme/OwnerController.java": "public class OwnerController { /* test-tree helper */ }\n"
    });
    opInit(root, DEPS);
    opAnalyze(root, { source: root }, DEPS);
    const link = mayRelateTo(root).find((l) => l.from === "src/test/java/com/acme/OwnerController.java");
    expect(link).toBeUndefined();
  });

  it("does NOT link a non-test_ Python file in tests/ to a same-stem module", () => {
    const root = repo({
      "app/service.py": "def run():\n    return 1\n",
      "tests/service.py": "# shared test helper, not a test module\n"
    });
    opInit(root, DEPS);
    opAnalyze(root, { source: root }, DEPS);
    const link = mayRelateTo(root).find((l) => l.from === "tests/service.py");
    expect(link).toBeUndefined();
  });

  it("links a Go same-package _test.go", () => {
    const root = repo({
      "user/auth.go": "package user\nfunc Login() bool { return true }\n",
      "user/auth_test.go": "package user\nimport \"testing\"\nfunc TestLogin(t *testing.T) {}\n"
    });
    opInit(root, DEPS);
    opAnalyze(root, { source: root }, DEPS);
    const link = mayRelateTo(root).find((l) => l.from.endsWith("auth_test.go"));
    expect(link?.to).toBe("user/auth.go");
    expect(link?.reason).toMatch(/Go test sibling/);
  });
});
