import ts from "typescript";

export const TEST_SUPPORT_RANKING_REASON_CODE = "test_support_helper" as const;

const TEST_SUPPORT_PATH_RE = /(^|\/)((?:[^/]+-)?e2e[-_]?testing|testing|testutils?|testhelpers?|fixtures?|mocks?|fakes?)(\/|$)/i;

/**
 * Modules only test code imports: test runners and their assertion APIs, and k6
 * (load tests). Plain `playwright` is a browser library product code can use, and
 * subpaths such as `vitest/config` configure a runner rather than test with it.
 */
const TEST_FRAMEWORK_MODULES: ReadonlySet<string> = new Set(["@playwright/test", "playwright/test", "@jest/globals", "vitest", "cypress", "k6"]);
const TEST_FRAMEWORK_GATE_RE = /@playwright\/test|playwright\/test|@jest\/globals|vitest|cypress|k6/;

export interface BuiltInRankExclusion {
  code: typeof TEST_SUPPORT_RANKING_REASON_CODE;
  reason: string;
}

/**
 * Built-in ranking-only exclusions. These symbols remain in the graph and keep
 * their denominator eligibility; they simply do not compete with production
 * behaviors in the primary priority worklist.
 */
export function builtInRankExclusion(file: string): BuiltInRankExclusion | undefined {
  if (!TEST_SUPPORT_PATH_RE.test(file)) return undefined;
  return {
    code: TEST_SUPPORT_RANKING_REASON_CODE,
    reason: "Test-support helper — retained in the behavior denominator, excluded from the primary production priority ranking."
  };
}

export function isTestFrameworkModule(specifier: string): boolean {
  return TEST_FRAMEWORK_MODULES.has(specifier) || specifier.startsWith("k6/");
}

/**
 * True when JS/TS source imports a test framework: `import` (type-only too),
 * `export … from`, `require()` or `import()`. TypeScript's own import scanner reads
 * the source, so a name in a comment or a string never counts.
 */
export function importsTestFramework(content: string): boolean {
  if (!TEST_FRAMEWORK_GATE_RE.test(content)) return false;
  return ts.preProcessFile(content, true, true).importedFiles.some((f) => isTestFrameworkModule(f.fileName));
}

/**
 * Test support recognized by what a non-test JS/TS file imports: page objects,
 * fixtures and helpers built on a test framework. Like the path rule, the symbols
 * stay in the graph and the denominator; unlike it, they leave the worklist only
 * after scoring, so no other function's score moves.
 */
export function importRankExclusion(content: string): BuiltInRankExclusion | undefined {
  if (!importsTestFramework(content)) return undefined;
  return {
    code: TEST_SUPPORT_RANKING_REASON_CODE,
    reason: "Test-support code: its file imports a test framework. Retained in the behavior denominator, excluded from the primary production priority ranking."
  };
}
