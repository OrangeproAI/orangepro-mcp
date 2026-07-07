// AST/framework-aware test-layer classifier (Phase 4.6).
//
// Replaces the path-only `testLayerOf` heuristic as the AUTHORITATIVE signal for a
// test file's layer. The layer is read from the file's parsed imports + call
// expressions (the framework actually used), with path/name hints as a
// low-confidence fallback only. The honest default is `unknown` — we NEVER
// silently call an unclassifiable test `unit`, because that would fold e2e/api
// behaviors (which a structural resolver cannot confirm) into the structural
// confirmed-% and corrupt the headline.
//
// Precedence (first match wins): e2e > api > integration > component > unit > unknown.

import ts from "typescript";
import { TestLayer } from "../graph/ontology.js";
import { extOf, testLayerOf } from "./classify.js";

export interface LayerClassification {
  layer: TestLayer;
  confidence: "high" | "medium" | "low" | "none";
  /** The matched import/call/path evidence, for provenance. */
  signals: string[];
}

// Import specifiers that pin a layer. A trailing "/" means a scope/namespace prefix.
const E2E_IMPORTS = ["@playwright/test", "playwright", "cypress", "@cypress/", "puppeteer", "webdriverio", "@wdio/"];
const API_IMPORTS = ["supertest", "@nestjs/testing"];
const INTEGRATION_IMPORTS = [
  "testcontainers",
  "@testcontainers/",
  "pg",
  "mongodb",
  "mongoose",
  "ioredis",
  "redis",
  "mysql",
  "mysql2",
  "better-sqlite3",
  "knex",
  "typeorm",
  "prisma"
];
const COMPONENT_IMPORTS = ["@testing-library/", "@vue/test-utils", "enzyme", "@solidjs/testing-library"];

const TSJS_EXTS = new Set(["ts", "tsx", "js", "jsx", "mts", "cts", "mjs", "cjs"]);

function isInternalSpecifier(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/");
}

function matchesImport(specs: string[], list: string[]): string | undefined {
  return specs.find((s) => list.some((p) => (p.endsWith("/") ? s.startsWith(p) : s === p || s.startsWith(p + "/"))));
}

function calleeText(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const base = ts.isIdentifier(e.expression) ? e.expression.text + "." : "";
    return base + e.name.text;
  }
  return "";
}

/** A type-only import (`import type ...` or an all-`type` named import) — never a framework signal. */
function isTypeOnlyImport(node: ts.ImportDeclaration): boolean {
  const clause = node.importClause;
  if (!clause) return false; // side-effect import runs code
  if (clause.isTypeOnly) return true;
  const named = clause.namedBindings;
  if (clause.name === undefined && !(named && ts.isNamespaceImport(named)) && named && ts.isNamedImports(named)) {
    return named.elements.length > 0 && named.elements.every((el) => el.isTypeOnly);
  }
  return false;
}

/**
 * Classify a test file's layer from its parsed imports + calls (TS/JS), falling
 * back to path hints (low confidence) for non-TS/JS or unread files. Never
 * defaults to `unit`: no decisive signal yields `unknown`.
 */
export function classifyTestLayer(relPath: string, content: string | null): LayerClassification {
  const ext = extOf(relPath);
  const isTsJs = TSJS_EXTS.has(ext);
  const pathLayer = testLayerOf(relPath); // path-only; "unknown" when no path signal

  if (!content || !isTsJs) {
    // No AST available — the path hint is the only (low-confidence) signal.
    if (pathLayer !== "unknown") return { layer: pathLayer, confidence: "low", signals: [`path:${pathLayer}`] };
    return { layer: "unknown", confidence: "none", signals: [] };
  }

  const sf = ts.createSourceFile(
    relPath,
    content,
    ts.ScriptTarget.Latest,
    false,
    ext === "tsx" || ext === "jsx" ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const importSpecs: string[] = [];
  const calls: string[] = [];
  let hasJsx = false;
  let hasInternalImport = false;
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      // Type-only imports never witness a framework's RUNTIME use (a `import type
      // { Pool } from "pg"` does not make a unit test an integration test).
      if (!isTypeOnlyImport(node)) {
        const s = node.moduleSpecifier.text;
        importSpecs.push(s);
        if (isInternalSpecifier(s)) hasInternalImport = true;
      }
    } else if (ts.isCallExpression(node)) {
      calls.push(calleeText(node));
    }
    if (ts.isJsxElement(node) || ts.isJsxSelfClosingElement(node) || ts.isJsxFragment(node)) hasJsx = true;
    ts.forEachChild(node, visit);
  };
  visit(sf);

  // e2e — browser/driver IMPORT, or a DISTINCTIVE driver idiom (cy.* / browser.* /
  // a Playwright page.* navigation). Bare `page.`/`goto`/`visit` are NOT trusted
  // (collide with pagination / unrelated locals); a path hint alone never upgrades
  // past unknown here (it would mislabel a unit test under an e2e/ dir).
  const e2eImp = matchesImport(importSpecs, E2E_IMPORTS);
  const e2eCall = calls.find(
    (c) =>
      /^cy\.\w/.test(c) ||
      /^browser\.\w/.test(c) ||
      /^page\.(goto|waitForURL|waitForNavigation|locator|getBy\w+|click|fill|press|check|selectOption)\b/.test(c)
  );
  if (e2eImp || e2eCall) return { layer: "e2e", confidence: "high", signals: [`e2e:${e2eImp ?? e2eCall}`] };

  // api — supertest / nestjs testing IMPORT. A bare `request(...)` call is NOT
  // trusted (collides with a local request() helper); rely on the import.
  const apiImp = matchesImport(importSpecs, API_IMPORTS);
  if (apiImp) return { layer: "api", confidence: "high", signals: [`api:${apiImp}`] };

  // integration — a real DB/container client RUNTIME import.
  const intImp = matchesImport(importSpecs, INTEGRATION_IMPORTS);
  if (intImp) return { layer: "integration", confidence: "high", signals: [`integration:${intImp}`] };

  // component — RTL/component-testing IMPORT, a DISTINCTIVE RTL idiom (screen.* /
  // userEvent.*), or a JSX subject rendered in a .tsx/.jsx test. Bare
  // `render()`/`mount()` are NOT trusted (generic names); the import covers RTL.
  const compImp = matchesImport(importSpecs, COMPONENT_IMPORTS);
  const compCall = calls.find((c) => /^screen\.\w/.test(c) || /^userEvent\.\w/.test(c));
  if (compImp || compCall || (hasJsx && (ext === "tsx" || ext === "jsx"))) {
    return { layer: "component", confidence: "high", signals: [`component:${compImp ?? compCall ?? "jsx"}`] };
  }

  // unit — exercises an in-repo module directly, with no higher-tier signal.
  if (hasInternalImport) return { layer: "unit", confidence: "medium", signals: ["unit:internal-import"] };

  // No decisive AST signal: honest unknown (path api/integration/component names
  // collide with module dirs and do NOT upgrade past unknown on their own).
  return { layer: "unknown", confidence: "none", signals: [] };
}
