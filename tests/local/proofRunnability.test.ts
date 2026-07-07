import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  classifyBaselineFailure,
  EXPERIMENTAL_SQLITE_TEST_ENV,
  IMPORT_TIME_CATEGORIES,
  isNeedsSetupCategory,
  readEnginesNode,
  referencesExperimentalSqlite,
  satisfiesNodeRange,
  targetNeedsExperimentalSqlite
} from "../../src/local/proofRunnability.js";

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) {
    const dir = tempDirs.pop();
    if (dir) rmSync(dir, { recursive: true, force: true });
  }
});

describe("classifyBaselineFailure — each baseline-red reason", () => {
  it("module_not_found: an unresolved import (needs_setup, not a DB problem)", () => {
    const r = classifyBaselineFailure({ failureSummary: "Error: Cannot find module './order.service'" });
    expect(r.category).toBe("module_not_found");
    expect(isNeedsSetupCategory(r.category)).toBe(true);
    // S3 finding: a linking/import gap must NOT be mislabelled as a DB requirement.
    expect(r.reason).not.toMatch(/needs a database|target needs a database/i);
    expect(r.reason).toMatch(/import/i);
  });

  it("experimental_builtin: node:sqlite / DatabaseSync (checked before module_not_found)", () => {
    const a = classifyBaselineFailure({ failureSummary: "Error: Cannot find module 'node:sqlite'" });
    expect(a.category).toBe("experimental_builtin");
    const b = classifyBaselineFailure({ failureSummary: "TypeError: DatabaseSync is not a constructor" });
    expect(b.category).toBe("experimental_builtin");
    expect(a.reason).toMatch(/experimental-sqlite/);
  });

  it("engine_mismatch (upper bound): Node 26 vs `<25` → engine_mismatch, reports range + version", () => {
    const r = classifyBaselineFailure({
      failureSummary: "SyntaxError: unexpected token",
      enginesNode: ">=24.2.0 <25",
      runnerNode: "v26.3.0"
    });
    expect(r.category).toBe("engine_mismatch");
    expect(r.reason).toContain(">=24.2.0 <25");
    expect(r.reason).toContain("26.3.0");
  });

  it("engine_mismatch (lower bound): a below-floor runner also mismatches", () => {
    const r = classifyBaselineFailure({ failureSummary: "boom", enginesNode: ">=24.2.0", runnerNode: "v22.5.0" });
    expect(r.category).toBe("engine_mismatch");
  });

  it("engine in-range: an open upper bound does NOT falsely mismatch (falls through to text)", () => {
    const r = classifyBaselineFailure({
      failureSummary: "Error: Cannot find module 'node:sqlite'",
      enginesNode: "^22.18.0 || >=24.2.0",
      runnerNode: "v26.3.0"
    });
    expect(r.category).toBe("experimental_builtin"); // not engine_mismatch: 26 satisfies >=24.2.0
  });

  it("db_or_external: a connection error", () => {
    const r = classifyBaselineFailure({ failureSummary: "Error: connect ECONNREFUSED 127.0.0.1:5432" });
    expect(r.category).toBe("db_or_external");
    expect(isNeedsSetupCategory(r.category)).toBe(true);
  });

  it("tsconfig_missing (M-4): a monorepo tsconfig extends failure — recognized whether the oracle surfaces the warning or the fatal line", () => {
    // esbuild WARNING line (what Medplum surfaced → previously fell to unknown)
    const warn = classifyBaselineFailure({ failureSummary: '▲ [WARNING] Cannot find base config file "../../tsconfig.json"' });
    expect(warn.category).toBe("tsconfig_missing");
    // vite/oxc FATAL line
    const fatal = classifyBaselineFailure({ failureSummary: "[TSCONFIG_ERROR] Failed to load tsconfig for 'src/test.setup.ts': Tsconfig not found" });
    expect(fatal.category).toBe("tsconfig_missing");
    // needs_setup + dedupable (package-level: the 25-attempts-one-cause case)
    expect(isNeedsSetupCategory("tsconfig_missing")).toBe(true);
    expect(IMPORT_TIME_CATEGORIES.has("tsconfig_missing")).toBe(true);
    expect(warn.reason).not.toContain("../../tsconfig.json"); // no raw path leak
  });

  it("logic_failure: a genuine assertion on the unmodified code is NOT labelled needs_setup", () => {
    const r = classifyBaselineFailure({ failureSummary: "AssertionError: expected 'order-1' to be 'order-2'" });
    expect(r.category).toBe("logic_failure");
    expect(isNeedsSetupCategory(r.category)).toBe(false);
    expect(IMPORT_TIME_CATEGORIES.has(r.category)).toBe(false);
  });

  it("logic_failure WINS over an env substring in the assertion message (module_not_found text)", () => {
    // An assertion that happens to mention "Cannot find module" REACHED the assertion → it ran.
    const r = classifyBaselineFailure({ failureSummary: "AssertionError: expected [Function] to throw 'Cannot find module'" });
    expect(r.category).toBe("logic_failure");
    expect(isNeedsSetupCategory(r.category)).toBe(false);
  });

  it("logic_failure WINS over an env substring in the assertion message (DatabaseSync text)", () => {
    const r = classifyBaselineFailure({ failureSummary: "expect(db).toBeInstanceOf(DatabaseSync) failed" });
    expect(r.category).toBe("logic_failure");
    expect(isNeedsSetupCategory(r.category)).toBe(false);
  });

  it("logic_failure WINS over an out-of-range runner Node (an assertion proves the Node ran it)", () => {
    const r = classifyBaselineFailure({
      failureSummary: "AssertionError: expected 5 to equal 6",
      enginesNode: ">=24.2.0 <25",
      runnerNode: "v26.3.0" // out of range, but the test still reached an assertion
    });
    expect(r.category).toBe("logic_failure"); // NOT engine_mismatch
    expect(isNeedsSetupCategory(r.category)).toBe(false);
  });

  it("unknown baseline-red is an honest non-proof, NOT needs_setup (does not inflate needs_setup)", () => {
    const r = classifyBaselineFailure({ failureSummary: "Weird failure XYZ that matches nothing" });
    expect(r.category).toBe("unknown");
    expect(isNeedsSetupCategory(r.category)).toBe(false);
  });

  it("unknown: surfaces the redacted first line, no raw multi-line dump", () => {
    const r = classifyBaselineFailure({ failureSummary: "Weird failure XYZ that matches nothing" });
    expect(r.category).toBe("unknown");
    expect(r.reason).toContain("Weird failure XYZ");
  });

  it("no failureSummary → unknown, with a benign reason (never throws)", () => {
    const r = classifyBaselineFailure({});
    expect(r.category).toBe("unknown");
    expect(r.reason).toMatch(/did not pass/i);
  });

  it("secret in a failure line is redacted from the reason", () => {
    const r = classifyBaselineFailure({ failureSummary: "boom sk-ABCDEFGHIJKLMNOPQRSTUVWX weird" });
    expect(r.reason).not.toContain("sk-ABCDEFGHIJKLMNOPQRSTUVWX");
  });
});

describe("satisfiesNodeRange — careful semver range check (no semver lib)", () => {
  it("upper-bound: 26.3.0 is out of `>=24.2.0 <25`", () => {
    expect(satisfiesNodeRange("26.3.0", ">=24.2.0 <25")).toBe(false);
  });
  it("in-range: 24.3.0 satisfies `>=24.2.0 <25`", () => {
    expect(satisfiesNodeRange("24.3.0", ">=24.2.0 <25")).toBe(true);
  });
  it("lower-bound: 22.5.0 is out of `>=24.2.0`", () => {
    expect(satisfiesNodeRange("22.5.0", ">=24.2.0")).toBe(false);
  });
  it("OR groups + caret: 26.3.0 satisfies `^22.18.0 || >=24.2.0`", () => {
    expect(satisfiesNodeRange("26.3.0", "^22.18.0 || >=24.2.0")).toBe(true);
    expect(satisfiesNodeRange("22.20.0", "^22.18.0 || >=24.2.0")).toBe(true);
    expect(satisfiesNodeRange("22.10.0", "^22.18.0 || >=24.2.0")).toBe(false); // < 22.18 and not >=24.2
  });
  it("bounded OR: 26 is out of `>=22.18.0 <23 || >=24.2.0 <25`", () => {
    expect(satisfiesNodeRange("26.3.0", ">=22.18.0 <23 || >=24.2.0 <25")).toBe(false);
    expect(satisfiesNodeRange("22.19.0", ">=22.18.0 <23 || >=24.2.0 <25")).toBe(true);
  });
  it("partial-bound range: an in-range Node is NOT flagged out (X-range expansion, Fix 3)", () => {
    // Regression: these must never fabricate an engine_mismatch for an in-range Node.
    expect(satisfiesNodeRange("24.5.0", ">=24.2 <25")).toBe(true);
    expect(satisfiesNodeRange("22.20.0", ">=22.18 <23")).toBe(true);
  });
  it("partial `<=<major>` must expand to `<(major+1).0.0`, not the exact tuple (Fix 3)", () => {
    // The exact-tuple bug marked 24.5 out of `<=24` (treated as `<=24.0.0`). Correct: `<25.0.0`.
    expect(satisfiesNodeRange("24.5.0", ">=22 <=24")).toBe(true);
    expect(satisfiesNodeRange("24.9.0", "<=24")).toBe(true);
    expect(satisfiesNodeRange("25.0.0", "<=24")).toBe(false); // 25 genuinely out
  });
  it("partial `>` / `>=` expand as X-ranges (no fabricated in/out)", () => {
    expect(satisfiesNodeRange("24.5.0", ">24")).toBe(false); // >24 means >=25.0.0
    expect(satisfiesNodeRange("25.0.0", ">24")).toBe(true);
    expect(satisfiesNodeRange("24.0.0", ">=24")).toBe(true);
    expect(satisfiesNodeRange("24.3.0", ">24.2")).toBe(true); // >24.2 means >=24.3.0
  });
  it("unparseable range → null (never claim a mismatch)", () => {
    expect(satisfiesNodeRange("26.0.0", "garbage!!")).toBeNull();
    expect(satisfiesNodeRange("26.0.0", "1.2.3 - 2.3.4")).toBeNull(); // hyphen range bails
  });
});

describe("readEnginesNode — nearest package.json wins (monorepo-aware)", () => {
  it("reads engines.node from the package nearest the target file", () => {
    const root = mkdtempSync(join(tmpdir(), "engines-"));
    tempDirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "root", engines: { node: ">=18" } }), "utf8");
    mkdirSync(join(root, "packages", "agent", "src"), { recursive: true });
    writeFileSync(
      join(root, "packages", "agent", "package.json"),
      JSON.stringify({ name: "agent", engines: { node: "^22.18.0 || >=24.2.0" } }),
      "utf8"
    );
    writeFileSync(join(root, "packages", "agent", "src", "app.ts"), "export const x = 1;\n", "utf8");
    expect(readEnginesNode(root, "packages/agent/src/app.ts")).toBe("^22.18.0 || >=24.2.0");
    // A file under root with no nearer package.json falls back to the root engines.
    writeFileSync(join(root, "top.ts"), "export const y = 1;\n", "utf8");
    expect(readEnginesNode(root, "top.ts")).toBe(">=18");
  });
  it("no declared engines → undefined", () => {
    const root = mkdtempSync(join(tmpdir(), "engines-none-"));
    tempDirs.push(root);
    writeFileSync(join(root, "package.json"), JSON.stringify({ name: "x" }), "utf8");
    writeFileSync(join(root, "app.ts"), "export const z = 1;\n", "utf8");
    expect(readEnginesNode(root, "app.ts")).toBeUndefined();
  });
});

describe("R-2: node:sqlite detection → env profile", () => {
  it("referencesExperimentalSqlite: import or DatabaseSync use → true; plain source → false", () => {
    expect(referencesExperimentalSqlite("import { DatabaseSync } from 'node:sqlite';")).toBe(true);
    expect(referencesExperimentalSqlite("const db = new DatabaseSync(':memory:');")).toBe(true);
    expect(referencesExperimentalSqlite("export function add(a,b){ return a+b; }")).toBe(false);
  });

  it("targetNeedsExperimentalSqlite: direct reference in the target file", () => {
    const files: Record<string, string> = {
      "src/store.ts": "import { DatabaseSync } from 'node:sqlite';\nexport function q(){ return new DatabaseSync(':memory:'); }"
    };
    const reader = (rel: string) => files[rel] ?? null;
    expect(targetNeedsExperimentalSqlite(reader, "src/store.ts")).toBe(true);
  });

  it("targetNeedsExperimentalSqlite: transitive via a same-package local import (bounded depth)", () => {
    const files: Record<string, string> = {
      "src/app.ts": "import { open } from './store';\nexport function boot(){ return open(); }",
      "src/store.ts": "import { DatabaseSync } from 'node:sqlite';\nexport function open(){ return new DatabaseSync(':memory:'); }"
    };
    const reader = (rel: string) => files[rel] ?? null;
    expect(targetNeedsExperimentalSqlite(reader, "src/app.ts")).toBe(true);
  });

  it("targetNeedsExperimentalSqlite: a non-referencing target (+ imports) → false (no injection)", () => {
    const files: Record<string, string> = {
      "src/app.ts": "import { greet } from './util';\nexport function boot(){ return greet(); }",
      "src/util.ts": "export function greet(){ return 'hi'; }"
    };
    const reader = (rel: string) => files[rel] ?? null;
    expect(targetNeedsExperimentalSqlite(reader, "src/app.ts")).toBe(false);
  });

  it("the profile is exactly the allowlisted --experimental-sqlite NODE_OPTIONS flag", () => {
    expect(EXPERIMENTAL_SQLITE_TEST_ENV).toBe("NODE_OPTIONS=--experimental-sqlite");
  });
});
