import { TestLayer } from "../graph/ontology.js";

export type FileRole = "code" | "test" | "config" | "doc" | "other";

const LANGUAGE_BY_EXT: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  py: "python",
  go: "go",
  rb: "ruby",
  java: "java",
  kt: "kotlin",
  rs: "rust",
  php: "php",
  cs: "csharp",
  swift: "swift",
  c: "c",
  h: "c",
  cc: "cpp",
  cpp: "cpp",
  cxx: "cpp",
  hh: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  md: "markdown",
  json: "json",
  yaml: "yaml",
  yml: "yaml",
  toml: "toml",
  sql: "sql"
};

const DOC_EXTS = new Set(["md", "mdx", "rst", "txt", "adoc"]);

const CONFIG_BASENAMES = new Set([
  "package.json",
  "tsconfig.json",
  "vitest.config.ts",
  "vitest.config.js",
  "jest.config.js",
  "jest.config.ts",
  "playwright.config.ts",
  "playwright.config.js",
  "cypress.config.ts",
  "cypress.config.js",
  "pytest.ini",
  "tox.ini",
  "pyproject.toml",
  "requirements.txt",
  "setup.cfg",
  "go.mod",
  "cargo.toml",
  "pom.xml",
  "build.gradle",
  "build.gradle.kts",
  "gemfile",
  "dockerfile",
  ".eslintrc.js",
  ".eslintrc.json",
  "vite.config.ts",
  "next.config.js",
  "next.config.ts"
]);

export function extOf(relPath: string): string {
  const base = relPath.split("/").pop() || relPath;
  const dot = base.lastIndexOf(".");
  return dot >= 0 ? base.slice(dot + 1).toLowerCase() : "";
}

export function baseName(relPath: string): string {
  return (relPath.split("/").pop() || relPath).toLowerCase();
}

export function languageOf(relPath: string): string {
  return LANGUAGE_BY_EXT[extOf(relPath)] || "other";
}

export function isTestFile(relPath: string): boolean {
  const p = relPath.toLowerCase();
  const file = relPath.split("/").pop() || relPath;
  return (
    /\.(test|spec)\.[a-z]+$/.test(p) ||
    /(^|\/)test\.[cm]?[jt]sx?$/.test(p) ||
    /(^|\/)__tests__\//.test(p) ||
    /(^|\/)(tests?|e2e|cypress|spec)\//.test(p) ||
    /(^|\/)(unit|integration|functional|acceptance)tests?\//.test(p) ||
    /_test\.(py|go)$/.test(p) ||
    /test_.*\.py$/.test(p) ||
    // Deliberately original-case: FooTests.cs is a C# test; LoadTest.cs can be product code.
    /Tests\.[cC][sS]$/.test(file) ||
    // Deliberately original-case: UserTest.java is a test; Latest.java is product code.
    /(?:^Test[A-Z0-9_].*|.*(?:Test|Tests|ITCase|TestCase)|.*[a-z0-9]IT)\.(java|kt)$/.test(file) ||
    /(?:^test_[^/]+|[^/]+_(?:test|spec))\.rb$/i.test(file)
  );
}

/**
 * Test-support files (mocks, fixtures, helpers): legitimate IMPORTS targets but
 * never TESTED_BY/COVERS-direction linkage targets — a test exercising its own
 * helper is not evidence that production behavior is covered.
 */
export function isTestSupportPath(relPath: string): boolean {
  const p = relPath.toLowerCase();
  const base = baseName(relPath);
  return (
    /(^|\/)__mocks__\//.test(p) ||
    /(^|\/)__fixtures__\//.test(p) ||
    /(^|\/)(mocks?|fixtures?|testdata|testlib|mock[-_][^/]+|[^/]+[-_]mock)\//.test(p) ||
    /(^|\/)testing\/[^/]*(mock|test(?:ing)?[-_]?utils?)/.test(p) ||
    /\.(mocks?|fixtures?)\./.test(base) ||
    /^testdata\.[a-z0-9]+$/.test(base) ||
    /testlib\.[a-z0-9]+$/.test(base) ||
    /-helpers?\.[a-z0-9]+$/.test(base) ||
    /^test[-_]/.test(base) ||
    /^testutils?\./.test(base)
  );
}

/**
 * Test infrastructure (e2e suites, fixtures, mocks, Playwright/Cypress libs).
 * Broader than isTestFile (which classifies an individual test); this also
 * catches `e2e-tests/`-style harness dirs whose helper CLASSES are role:"code"
 * but whose methods are NOT production behavior. Used ONLY to keep such class
 * methods out of the denominator — it does not reclassify the file.
 */
const TEST_INFRA_DIR =
  /(^|\/)(e2e[-_]?tests?|e2e|__tests__|tests?|cypress|playwright|specs?|__mocks__|fixtures|testdata|testlib|test[-_]?utils?|mock[-_][^/]+|[^/]+[-_]mock)\//i;
export function isTestInfraPath(relPath: string): boolean {
  return TEST_INFRA_DIR.test(relPath) || isTestSupportPath(relPath);
}

/** Plain-language reason a non-product symbol is excluded from the behavior denominator. */
export const NON_PRODUCT_REASON =
  "CI/test-infra path (.github, e2e/cypress/playwright suite, mocks/fixtures/testdata/testlib) — not product behavior.";
export const GENERATED_CODE_REASON = "Generated code (Code generated ... DO NOT EDIT) — not product-authored behavior.";

export function isGeneratedCode(content: string): boolean {
  const lines = content.slice(0, 8192).split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const isComment = /^(?:\/\/|#|\/\*|\*)/.test(line);
    if (isComment) {
      if (/\bCode generated\b/.test(line)) {
        const window = lines
          .slice(i, Math.min(lines.length, i + 6))
          .map((l) => l.trim())
          .filter((l) => !l || /^(?:\/\/|#|\/\*|\*)/.test(l))
          .join("\n");
        if (/DO NOT EDIT\.?/.test(window)) return true;
      }
      continue;
    }
    // Go generated markers normally sit before `package`; some generators put the
    // marker immediately after it. Once real declarations/imports begin, a marker
    // may be part of a template string and must not classify the source file.
    if (/^package\s+[A-Za-z_][A-Za-z0-9_]*\s*;?$/.test(line)) continue;
    return false;
  }
  return false;
}

const CI_DIR = /(^|\/)\.github(\/|$)/;
// Test-artifact DIRECTORIES anywhere — fixtures, generated mocks, Go testdata,
// and explicit test support libraries. Matches a directory segment only.
const INFRA_DIR_ANYWHERE = /(^|\/)(__mocks__|__fixtures__|__tests__|mocks?|fixtures?|testdata|testlib|mock[-_][^/]+|[^/]+[-_]mock)\//;
// Test-support library files outside a dedicated test-support directory, e.g.
// Mattermost's api4/apitestlib.go and cmd/mattermost/commands/cmdtestlib.go.
const TESTLIB_FILE = /(^|\/)[^/]*testlib\.[a-z0-9]+$/i;
const TESTDATA_FILE = /(^|\/)testdata\.[a-z0-9]+$/i;
const TESTING_SUPPORT_FILE = /(^|\/)testing\/[^/]*(mock|test(?:ing)?[-_]?utils?)[^/]*\.[a-z0-9]+$/i;
// A test SUITE at the repo ROOT (first path segment). A `playwright`/`cypress`/`e2e`
// segment NESTED under product code (e.g. `src/playwright/`) is NOT matched.
const ROOT_TEST_SUITE = /^(?:\.\/)?(e2e|e2e[-_]tests?|cypress|playwright|tests?|specs?)\//;

/**
 * A path whose exported symbols are NOT product behavior, for DENOMINATOR
 * exclusion. Deliberately STRICTER than `isTestInfraPath` (which is a permissive
 * test-SUPPORT-import detector): it requires real test/CI context, so product
 * code that merely integrates Playwright (`src/playwright/runner.ts`) or has a
 * helper-suffixed filename (`src/date-helper.ts`) is NOT excluded — over-exclusion
 * would falsely raise coverage. No broad `scripts/`/`tools/` exclusion. Symbols
 * here are kept as nodes with denominator_eligible:false + a reason.
 */
export function isNonProductPath(relPath: string): boolean {
  return (
    CI_DIR.test(relPath) ||
    INFRA_DIR_ANYWHERE.test(relPath) ||
    TESTLIB_FILE.test(relPath) ||
    TESTDATA_FILE.test(relPath) ||
    TESTING_SUPPORT_FILE.test(relPath) ||
    ROOT_TEST_SUITE.test(relPath)
  );
}

/**
 * Path/name-only test-layer hint. Coarse on purpose — a LOW-confidence
 * corroborator for the AST classifier (testLayer.ts), never the authority.
 * Returns "unknown" when no path signal matches: a path alone NEVER asserts
 * `unit` (the old catch-all), because that would fold unclassifiable e2e/api
 * behaviors into the structural confirmed-%.
 */
export function testLayerOf(relPath: string): TestLayer {
  const p = relPath.toLowerCase();
  if (/(^|\/)(e2e)\//.test(p) || /\.e2e\./.test(p) || p.includes("playwright") || p.includes("cypress")) return "e2e";
  if (/(^|\/)integration\//.test(p) || /\.integration\./.test(p) || /\.int\./.test(p)) return "integration";
  if (/(^|\/)(api)\//.test(p) || /\.api\./.test(p)) return "api";
  if (/\.(component|comp)\./.test(p) || p.includes("/components/")) return "component";
  if (/(^|\/)(unit)\//.test(p) || /\.(unit)\./.test(p)) return "unit";
  return "unknown";
}

export function roleOf(relPath: string): FileRole {
  const base = baseName(relPath);
  const ext = extOf(relPath);
  if (isTestFile(relPath)) return "test";
  if (CONFIG_BASENAMES.has(base) || /\.config\.[cm]?[jt]s$/.test(base)) return "config";
  if (DOC_EXTS.has(ext)) return "doc";
  if (LANGUAGE_BY_EXT[ext] && ext !== "md" && ext !== "json" && ext !== "yaml" && ext !== "yml" && ext !== "toml") {
    return "code";
  }
  return "other";
}

export function manifestKindOf(relPath: string): string {
  const role = roleOf(relPath);
  return role;
}
