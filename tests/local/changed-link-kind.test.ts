import { describe, it, expect, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { opInit, opAnalyze, opChanged } from "../../src/local/operations.js";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) {
    const d = dirs.pop();
    if (d) rmSync(d, { recursive: true, force: true });
  }
});

const DEPS = { clock: () => "2026-06-07T00:00:00Z", env: {} as NodeJS.ProcessEnv };

function git(cwd: string, args: string[]): void {
  execFileSync("git", ["-c", "user.email=t@t.io", "-c", "user.name=t", ...args], {
    cwd,
    stdio: ["ignore", "ignore", "ignore"]
  });
}

/**
 * A git workspace where the test file imports the source module under a name that
 * does NOT share its basename stem ("checkout.test.ts" imports "./cart"). So the
 * ONLY way the test can link to the changed module is the RESOLVED import — if the
 * behavior comes back tagged "import", the import-graph path won (not stem/area).
 */
function importLinkedWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), "oplocal-linkkind-"));
  dirs.push(root);
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x", devDependencies: { vitest: "^3" } }));
  writeFileSync(join(root, "src", "cart.ts"), "export function addToCart(n: number){ return n + 1 }\n");
  writeFileSync(
    join(root, "src", "checkout.test.ts"),
    [
      'import { describe, it, expect } from "vitest";',
      'import { addToCart } from "./cart";',
      'describe("checkout flow", () => {',
      '  it("adds an item to the cart", () => {',
      "    expect(addToCart(1)).toBe(2);",
      "  });",
      "});",
      ""
    ].join("\n")
  );
  git(root, ["init", "-q"]);
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "init"]);
  opInit(root, DEPS);
  opAnalyze(root, { source: root }, DEPS);
  return root;
}

describe("changedImpact link_kind provenance (PLAN 6.4)", () => {
  it("tags every affected behavior, and import-resolved links win over area", () => {
    const root = importLinkedWorkspace();
    // Change the SOURCE module (not the test) → the test reaches it only via import.
    writeFileSync(join(root, "src", "cart.ts"), "export function addToCart(n: number){ return n + 2 }\n");
    const res = opChanged(root, "HEAD");

    expect(res.status).toBe("ok");
    expect(res.changed_files).toContain("src/cart.ts");
    expect(res.affected_behaviors.length).toBeGreaterThan(0);

    // link_kinds covers every affected behavior, 1:1.
    expect(Object.keys(res.link_kinds).sort()).toEqual([...res.affected_behaviors].sort());

    const kinds = new Set(Object.values(res.link_kinds));
    // The import-graph path linked the changed module to its test → "import" wins.
    expect(kinds.has("import")).toBe(true);
    // The changed file's area is precisely covered, so the coarse area fallback is
    // empty for it — no behavior is reached only by directory area.
    expect(kinds.has("area")).toBe(false);
  });

  it('a changed TEST file tags its own behaviors "direct"', () => {
    const root = importLinkedWorkspace();
    // Change the TEST file itself → its behavior is reached directly.
    writeFileSync(
      join(root, "src", "checkout.test.ts"),
      [
        'import { describe, it, expect } from "vitest";',
        'import { addToCart } from "./cart";',
        'describe("checkout flow", () => {',
        '  it("adds an item to the cart", () => {',
        "    expect(addToCart(2)).toBe(3);",
        "  });",
        "});",
        ""
      ].join("\n")
    );
    const res = opChanged(root, "HEAD");
    expect(res.status).toBe("ok");
    expect(Object.values(res.link_kinds)).toContain("direct");
  });
});
