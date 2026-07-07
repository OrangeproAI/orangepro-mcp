import { TestLayer } from "../graph/ontology.js";
import { baseName } from "./classify.js";

export interface DetectedFramework {
  name: string;
  category: "test" | "build" | "runtime";
  test_layer?: TestLayer;
  /** Where the framework was detected (config file relPath or "package.json"). */
  evidence_ref: string;
}

export interface DetectedPackage {
  name: string;
  ecosystem: string;
  dependencies: string[];
  evidence_ref: string;
}

const TEST_FRAMEWORK_DEPS: Record<string, { layer: TestLayer }> = {
  ava: { layer: "unit" },
  vitest: { layer: "unit" },
  jest: { layer: "unit" },
  mocha: { layer: "unit" },
  jasmine: { layer: "unit" },
  "@playwright/test": { layer: "e2e" },
  playwright: { layer: "e2e" },
  cypress: { layer: "e2e" },
  "@testing-library/react": { layer: "component" },
  supertest: { layer: "api" },
  pytest: { layer: "unit" },
  unittest: { layer: "unit" },
  rspec: { layer: "unit" },
  junit: { layer: "unit" }
};

const CONFIG_FRAMEWORK_HINTS: Array<{ match: RegExp; name: string; layer: TestLayer }> = [
  { match: /^vitest\.config\.[tj]s$/, name: "vitest", layer: "unit" },
  { match: /^jest\.config\.[tj]s$/, name: "jest", layer: "unit" },
  { match: /^playwright\.config\.[tj]s$/, name: "playwright", layer: "e2e" },
  { match: /^cypress\.config\.[tj]s$/, name: "cypress", layer: "e2e" },
  { match: /^pytest\.ini$/, name: "pytest", layer: "unit" },
  { match: /^tox\.ini$/, name: "tox", layer: "unit" }
];

/** Detect a test framework from a config file's base name (no content read needed). */
export function frameworkFromConfig(relPath: string): DetectedFramework | null {
  const base = baseName(relPath);
  for (const hint of CONFIG_FRAMEWORK_HINTS) {
    if (hint.match.test(base)) {
      return { name: hint.name, category: "test", test_layer: hint.layer, evidence_ref: relPath };
    }
  }
  return null;
}

/** Parse package.json content for the project package + test frameworks in deps. */
export function detectFromPackageJson(
  relPath: string,
  content: string
): { pkg: DetectedPackage | null; frameworks: DetectedFramework[] } {
  let parsed: { name?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  try {
    parsed = JSON.parse(content);
  } catch {
    return { pkg: null, frameworks: [] };
  }
  const deps = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) };
  const depNames = Object.keys(deps).sort();
  const pkg: DetectedPackage = {
    name: parsed.name || "project",
    ecosystem: "npm",
    dependencies: depNames.slice(0, 100),
    evidence_ref: relPath
  };
  const frameworks: DetectedFramework[] = [];
  for (const dep of depNames) {
    const hit = TEST_FRAMEWORK_DEPS[dep];
    if (hit) {
      frameworks.push({ name: dep.replace(/^@playwright\/test$/, "playwright"), category: "test", test_layer: hit.layer, evidence_ref: relPath });
    }
  }
  return { pkg, frameworks };
}

/** Detect test frameworks from non-npm manifests (pyproject.toml, requirements). */
export function detectFrameworksFromManifest(relPath: string, content: string): DetectedFramework[] {
  const base = baseName(relPath);
  const frameworks: DetectedFramework[] = [];
  const lower = content.toLowerCase();
  const has = (re: RegExp): boolean => re.test(lower);

  const isPython = base === "pyproject.toml" || base === "setup.cfg" || base === "tox.ini" || base.startsWith("requirements");
  if (isPython) {
    if (has(/\[tool\.pytest/) || has(/\bpytest\b/)) {
      frameworks.push({ name: "pytest", category: "test", test_layer: "unit", evidence_ref: relPath });
    }
    if (has(/\bplaywright\b/)) {
      frameworks.push({ name: "playwright", category: "test", test_layer: "e2e", evidence_ref: relPath });
    }
    if (has(/(^|\s)unittest(\s|$)/m)) {
      frameworks.push({ name: "unittest", category: "test", test_layer: "unit", evidence_ref: relPath });
    }
  }
  if (base === "pom.xml") {
    if (has(/\bjunit-jupiter\b/) || has(/\borg\.junit\.jupiter\b/)) {
      frameworks.push({ name: "junit5", category: "test", test_layer: "unit", evidence_ref: relPath });
    } else if (has(/<groupid>\s*junit\s*<\/groupid>|<artifactid>\s*junit\s*<\/artifactid>/)) {
      frameworks.push({ name: "junit4", category: "test", test_layer: "unit", evidence_ref: relPath });
    }
  }
  return frameworks;
}

/** Detect ecosystem package manifests other than package.json (name only, cheap). */
export function detectManifestPackage(relPath: string, content: string): DetectedPackage | null {
  const base = baseName(relPath);
  if (base === "pyproject.toml") {
    const name = /name\s*=\s*["']([^"']+)["']/.exec(content)?.[1];
    return { name: name || "python-project", ecosystem: "pypi", dependencies: [], evidence_ref: relPath };
  }
  if (base === "go.mod") {
    const name = /^module\s+(\S+)/m.exec(content)?.[1];
    return { name: name || "go-module", ecosystem: "go", dependencies: [], evidence_ref: relPath };
  }
  if (base === "cargo.toml") {
    const name = /name\s*=\s*["']([^"']+)["']/.exec(content)?.[1];
    return { name: name || "rust-crate", ecosystem: "cargo", dependencies: [], evidence_ref: relPath };
  }
  if (base === "requirements.txt") {
    const deps = content
      .split(/\r?\n/)
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#"))
      .map((l) => l.split(/[=<>~!\s]/)[0])
      .slice(0, 100);
    return { name: "python-requirements", ecosystem: "pypi", dependencies: deps, evidence_ref: relPath };
  }
  return null;
}
