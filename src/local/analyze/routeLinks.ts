import ts from "typescript";
import { resolveSpecifier } from "./confirm.js";

/**
 * Static route linking (J4): a test that sends a request to an Express app's route, through
 * supertest, is linked to the function that route runs.
 *
 * - The app is traced: the value given to `request(…)` must be an import of a source module's
 *   exported app or router. An app the test builds itself links nothing.
 * - The route is read from source files only: `<app>.<verb>(path, …fns)` and
 *   `<app>.route(path).<verb>(…fns)`, with mount prefixes joined from `<app>.use(prefix, router)`
 *   when the router is an import or a local app. Anything computed is counted, never guessed.
 * - The handler is the route's last function. A named function links to itself. An inline function,
 *   or one wrapped in a call (`wrap(async (req, res) => …)`), links to the counted functions it calls
 *   directly: one hop, nothing deeper.
 * - Exactly one matching route links; none or several are counted.
 *
 * A route link is Linked evidence (a test reaches this function), never proof.
 */

export interface RouteLinkFile {
  rel: string;
  abs: string;
  role: "test" | "source";
}

export interface RouteLink {
  testRel: string;
  symId: string;
  method: string;
  path: string;
  via: "named" | "inline";
  /** `<file>:<line>` of the handler: the named function's reference in the route, or the inline function. */
  site: string;
}

export interface RouteLinkCounts {
  routes: number;
  unknown_routes: number;
  unknown_mounts: number;
  requests: number;
  linked_requests: number;
  links: number;
  no_route: number;
  several_routes: number;
  app_not_traced: number;
  handler_not_mapped: number;
}

export interface RouteLinkResult {
  links: RouteLink[];
  counts: RouteLinkCounts;
}

const VERBS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "all"]);
const JS_TS = /\.[cm]?[jt]sx?$/i;

type Binding =
  | { kind: "module"; file: string | null; spec: string; name: "default" | "*" | string }
  | { kind: "local_fn"; name: string };

interface Handler {
  kind: "named" | "inline" | "unknown";
  symId?: string;
  calls?: string[];
  line: number;
}

interface Route {
  method: string;
  path: string;
  handler: Handler;
}

interface Mount {
  prefix: string;
  target: AppRef | null;
}

interface AppRef {
  file: string;
  /** The app's local variable in that file, or an export name to look up. */
  local?: string;
  exportName?: string;
}

interface SourceInfo {
  apps: Map<string, { routes: Route[]; mounts: Mount[] }>;
  /** export name ("default" for module.exports / export default) → local app variable */
  exports: Map<string, string>;
}

function scriptKind(rel: string): ts.ScriptKind {
  if (/\.tsx$/i.test(rel)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(rel)) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/i.test(rel)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

function literalText(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  return null;
}

function isFunctionLiteral(node: ts.Node): node is ts.ArrowFunction | ts.FunctionExpression {
  return ts.isArrowFunction(node) || ts.isFunctionExpression(node);
}

function requireSpec(node: ts.Node | undefined): string | null {
  if (!node || !ts.isCallExpression(node)) return null;
  if (!ts.isIdentifier(node.expression) || node.expression.text !== "require") return null;
  return literalText(node.arguments[0]);
}

/** Import and require bindings of one file, plus its top-level function declarations. */
function bindingsOf(sf: ts.SourceFile, fromAbs: string, repoRoot: string, ws: Map<string, string>, relOf: (abs: string) => string | null): Map<string, Binding> {
  const out = new Map<string, Binding>();
  const resolve = (spec: string): string | null => {
    if (!spec.startsWith(".") && !spec.startsWith("/") && !spec.startsWith("@") && !/^[a-z]/i.test(spec)) return null;
    const abs = resolveSpecifier(spec, fromAbs, repoRoot, ws);
    return abs ? relOf(abs) : null;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      const file = resolve(spec);
      const clause = node.importClause;
      if (clause?.name) out.set(clause.name.text, { kind: "module", file, spec, name: "default" });
      const nb = clause?.namedBindings;
      if (nb && ts.isNamespaceImport(nb)) out.set(nb.name.text, { kind: "module", file, spec, name: "*" });
      if (nb && ts.isNamedImports(nb)) {
        for (const el of nb.elements) out.set(el.name.text, { kind: "module", file, spec, name: (el.propertyName ?? el.name).text });
      }
    } else if (ts.isVariableDeclaration(node) && node.initializer) {
      let init: ts.Expression = node.initializer;
      let member: string | null = null;
      if (ts.isPropertyAccessExpression(init) && requireSpec(init.expression) !== null) {
        member = init.name.text;
        init = init.expression;
      }
      const spec = requireSpec(init);
      if (spec !== null) {
        const file = resolve(spec);
        if (ts.isIdentifier(node.name)) out.set(node.name.text, { kind: "module", file, spec, name: member ?? "*" });
        else if (ts.isObjectBindingPattern(node.name) && member === null) {
          for (const el of node.name.elements) {
            if (!ts.isIdentifier(el.name)) continue;
            const imported = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
            out.set(el.name.text, { kind: "module", file, spec, name: imported });
          }
        }
      }
    } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
      // `app = require('../app')` inside a hook: the test's own binding.
      const spec = requireSpec(node.right);
      if (spec !== null && !out.has(node.left.text)) out.set(node.left.text, { kind: "module", file: resolve(spec), spec, name: "*" });
    } else if (ts.isFunctionDeclaration(node) && node.name && node.parent === sf) {
      out.set(node.name.text, { kind: "local_fn", name: node.name.text });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

/** The counted symbol a callee or handler reference names, through this file's bindings. */
function symbolFor(expr: ts.Expression, rel: string, bindings: Map<string, Binding>, symbols: Set<string>): string | null {
  const viaModule = (b: Binding | undefined, member: string | null): string | null => {
    if (!b) return null;
    if (b.kind === "local_fn") return member === null ? `sym:${rel}#${b.name}` : null;
    if (!b.file) return null;
    if (member !== null) return b.name === "*" || b.name === "default" ? `sym:${b.file}#${member}` : `sym:${b.file}#${b.name}.${member}`;
    if (b.name === "*" || b.name === "default") return null;
    return `sym:${b.file}#${b.name}`;
  };
  let id: string | null = null;
  if (ts.isIdentifier(expr)) id = viaModule(bindings.get(expr.text), null) ?? `sym:${rel}#${expr.text}`;
  else if (ts.isPropertyAccessExpression(expr) && ts.isIdentifier(expr.expression)) {
    id = viaModule(bindings.get(expr.expression.text), expr.name.text) ?? `sym:${rel}#${expr.expression.text}.${expr.name.text}`;
  }
  return id !== null && symbols.has(id) ? id : null;
}

/** Unwrap `wrap(…, fn)` to the function literal it wraps. */
function unwrapHandler(node: ts.Expression): ts.Expression {
  let cur = node;
  for (let i = 0; i < 4 && ts.isCallExpression(cur); i++) {
    const last = cur.arguments[cur.arguments.length - 1];
    if (!last) break;
    cur = last;
  }
  return cur;
}

function handlerOf(arg: ts.Expression, sf: ts.SourceFile, rel: string, bindings: Map<string, Binding>, symbols: Set<string>): Handler {
  const line = sf.getLineAndCharacterOfPosition(arg.getStart(sf)).line + 1;
  const target = unwrapHandler(arg);
  if (isFunctionLiteral(target)) {
    const calls = new Set<string>();
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        const id = symbolFor(node.expression, rel, bindings, symbols);
        if (id) calls.add(id);
      }
      // Calls inside a nested named function declaration are that function's, not the handler's.
      if (!ts.isFunctionDeclaration(node)) ts.forEachChild(node, visit);
    };
    ts.forEachChild(target.body, visit);
    return { kind: "inline", calls: [...calls].sort(), line: sf.getLineAndCharacterOfPosition(target.getStart(sf)).line + 1 };
  }
  if (ts.isIdentifier(target) || ts.isPropertyAccessExpression(target)) {
    const id = symbolFor(target, rel, bindings, symbols);
    return id ? { kind: "named", symId: id, line } : { kind: "unknown", line };
  }
  return { kind: "unknown", line };
}

function isExpressBinding(b: Binding | undefined, member: "default" | "Router"): boolean {
  if (!b || b.kind !== "module" || b.spec !== "express") return false;
  return member === "default" ? b.name === "default" || b.name === "*" : b.name === "Router";
}

/** `express()`, `express.Router()`, `Router()` — a new app or router. */
function isAppConstructor(expr: ts.Expression, bindings: Map<string, Binding>): boolean {
  if (!ts.isCallExpression(expr)) return false;
  const callee = expr.expression;
  if (ts.isIdentifier(callee)) return isExpressBinding(bindings.get(callee.text), "default") || isExpressBinding(bindings.get(callee.text), "Router");
  if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.name.text === "Router") {
    return isExpressBinding(bindings.get(callee.expression.text), "default");
  }
  return false;
}

export function normalizePath(p: string): string {
  const q = p.split(/[?#]/)[0] ?? "";
  const parts = q.split("/").filter(Boolean);
  return `/${parts.join("/")}`;
}

function joinPath(prefix: string, path: string): string {
  return normalizePath(`${prefix}/${path}`);
}

function readSource(file: RouteLinkFile, read: (abs: string) => string | null): ts.SourceFile | null {
  const text = read(file.abs);
  if (text === null || !/\bexpress\b|supertest/.test(text)) return null;
  return ts.createSourceFile(file.rel, text, ts.ScriptTarget.Latest, true, scriptKind(file.rel));
}

function analyzeSource(
  sf: ts.SourceFile,
  file: RouteLinkFile,
  bindings: Map<string, Binding>,
  symbols: Set<string>,
  counts: RouteLinkCounts
): { info: SourceInfo; pendingMounts: Array<{ app: string; prefix: string; expr: ts.Expression }> } {
  const apps = new Map<string, { routes: Route[]; mounts: Mount[] }>();
  const exportsMap = new Map<string, string>();
  const pendingMounts: Array<{ app: string; prefix: string; expr: ts.Expression }> = [];
  const appOf = (name: string): { routes: Route[]; mounts: Mount[] } | undefined => apps.get(name);
  // Pass 1: app variables.
  const findApps = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && isAppConstructor(node.initializer, bindings)) {
      apps.set(node.name.text, { routes: [], mounts: [] });
    }
    ts.forEachChild(node, findApps);
  };
  findApps(sf);
  if (apps.size === 0) return { info: { apps, exports: exportsMap }, pendingMounts };
  // Pass 2: routes, mounts, exports.
  const addRoute = (app: string, method: string, pathNode: ts.Expression | undefined, fns: readonly ts.Expression[]): void => {
    const path = literalText(pathNode);
    if (path === null || fns.length === 0) {
      counts.unknown_routes++;
      return;
    }
    const handler = handlerOf(fns[fns.length - 1]!, sf, file.rel, bindings, symbols);
    appOf(app)!.routes.push({ method: method.toUpperCase(), path: normalizePath(path), handler });
    counts.routes++;
  };
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)) {
      const callee = node.expression;
      const verb = callee.name.text;
      const target = callee.expression;
      if (ts.isIdentifier(target) && apps.has(target.text)) {
        if (VERBS.has(verb) && node.arguments.length >= 2) addRoute(target.text, verb, node.arguments[0], node.arguments.slice(1));
        else if (verb === "use" && node.arguments.length >= 1) {
          const first = node.arguments[0]!;
          const prefixText = literalText(first);
          const last = node.arguments[node.arguments.length - 1]!;
          if (prefixText !== null && node.arguments.length >= 2) pendingMounts.push({ app: target.text, prefix: prefixText, expr: last });
          else if (prefixText === null && (ts.isStringLiteralLike(first) === false) && (ts.isIdentifier(first) || ts.isPropertyAccessExpression(first) || ts.isCallExpression(first))) {
            // `app.use(router)`: a mount at the app's own root when the value is an app or router; a
            // computed prefix (`app.use(route.path, route.route)`) is unknown.
            if (node.arguments.length >= 2) counts.unknown_mounts++;
            else pendingMounts.push({ app: target.text, prefix: "", expr: first });
          }
        }
      }
      // `<app>.route(path).<verb>(…)…`
      if (VERBS.has(verb)) {
        let inner: ts.Expression = target;
        while (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && VERBS.has(inner.expression.name.text)) inner = inner.expression.expression;
        if (ts.isCallExpression(inner) && ts.isPropertyAccessExpression(inner.expression) && inner.expression.name.text === "route" && ts.isIdentifier(inner.expression.expression) && apps.has(inner.expression.expression.text)) {
          addRoute(inner.expression.expression.text, verb, inner.arguments[0], node.arguments);
        }
      }
    }
    // Exports of an app variable.
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.right) && apps.has(node.right.text)) {
      const left = node.left;
      const text = left.getText(sf);
      if (text === "module.exports" || text === "exports") exportsMap.set("default", node.right.text);
      else if (ts.isPropertyAccessExpression(left) && (left.expression.getText(sf) === "module.exports" || left.expression.getText(sf) === "exports")) exportsMap.set(left.name.text, node.right.text);
    }
    if (ts.isExportAssignment(node) && ts.isIdentifier(node.expression) && apps.has(node.expression.text)) exportsMap.set("default", node.expression.text);
    if (ts.isExportDeclaration(node) && !node.moduleSpecifier && node.exportClause && ts.isNamedExports(node.exportClause)) {
      for (const el of node.exportClause.elements) {
        const local = (el.propertyName ?? el.name).text;
        if (apps.has(local)) exportsMap.set(el.name.text, local);
      }
    }
    if (ts.isVariableStatement(node) && node.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)) {
      for (const d of node.declarationList.declarations) if (ts.isIdentifier(d.name) && apps.has(d.name.text)) exportsMap.set(d.name.text, d.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { info: { apps, exports: exportsMap }, pendingMounts };
}

/** What app or router an expression in `file` refers to: a local app, or an import of one. */
function appRefFor(expr: ts.Expression, file: string, bindings: Map<string, Binding>, localApps: Set<string>): AppRef | null {
  let e = expr;
  // `app.listen()`, `app.callback()`: the same app.
  if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && (e.expression.name.text === "listen" || e.expression.name.text === "callback") && e.arguments.length === 0) {
    e = e.expression.expression;
  }
  const spec = requireSpec(e);
  if (spec !== null) return null;
  if (ts.isIdentifier(e)) {
    if (localApps.has(e.text)) return { file, local: e.text };
    const b = bindings.get(e.text);
    if (b?.kind === "module" && b.file) return { file: b.file, exportName: b.name === "*" ? "default" : b.name };
    return null;
  }
  if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)) {
    const b = bindings.get(e.expression.text);
    if (b?.kind === "module" && b.file && (b.name === "*" || b.name === "default")) return { file: b.file, exportName: e.name.text };
  }
  return null;
}

interface ResolvedRoute extends Route {
  file: string;
}

export function computeRouteLinks(input: {
  files: RouteLinkFile[];
  symbols: Set<string>;
  repoRoot: string;
  wsPkgs: Map<string, string>;
  read: (abs: string) => string | null;
}): RouteLinkResult {
  const counts: RouteLinkCounts = { routes: 0, unknown_routes: 0, unknown_mounts: 0, requests: 0, linked_requests: 0, links: 0, no_route: 0, several_routes: 0, app_not_traced: 0, handler_not_mapped: 0 };
  const relByAbs = new Map(input.files.map((f) => [f.abs, f.rel]));
  const relOf = (abs: string): string | null => relByAbs.get(abs) ?? null;
  const sources = new Map<string, SourceInfo>();
  const pending: Array<{ file: string; app: string; prefix: string; ref: AppRef | null }> = [];
  for (const file of input.files) {
    if (file.role !== "source" || !JS_TS.test(file.rel)) continue;
    const sf = readSource(file, input.read);
    if (!sf) continue;
    const bindings = bindingsOf(sf, file.abs, input.repoRoot, input.wsPkgs, relOf);
    const { info, pendingMounts } = analyzeSource(sf, file, bindings, input.symbols, counts);
    if (info.apps.size === 0) continue;
    sources.set(file.rel, info);
    for (const m of pendingMounts) pending.push({ file: file.rel, app: m.app, prefix: m.prefix, ref: appRefFor(m.expr, file.rel, bindings, new Set(info.apps.keys())) });
  }
  const lookup = (ref: AppRef): { file: string; local: string } | null => {
    const info = sources.get(ref.file);
    if (!info) return null;
    if (ref.local) return info.apps.has(ref.local) ? { file: ref.file, local: ref.local } : null;
    const local = info.exports.get(ref.exportName ?? "default");
    return local ? { file: ref.file, local } : null;
  };
  for (const m of pending) {
    const target = m.ref ? lookup(m.ref) : null;
    // A mount of something that is not a traced app or router (middleware, a static folder) adds no routes.
    if (!target) continue;
    sources.get(m.file)!.apps.get(m.app)!.mounts.push({ prefix: m.prefix, target: { file: target.file, local: target.local } });
  }
  const table = new Map<string, ResolvedRoute[]>();
  const routesOf = (file: string, local: string, seen: Set<string>): ResolvedRoute[] => {
    const key = `${file}#${local}`;
    if (seen.has(key)) return [];
    const cached = table.get(key);
    if (cached) return cached;
    seen.add(key);
    const app = sources.get(file)?.apps.get(local);
    const out: ResolvedRoute[] = [];
    if (app) {
      for (const r of app.routes) out.push({ ...r, file });
      for (const m of app.mounts) {
        if (!m.target?.local) continue;
        for (const r of routesOf(m.target.file, m.target.local, seen)) out.push({ ...r, path: joinPath(m.prefix, r.path) });
      }
    }
    seen.delete(key);
    table.set(key, out);
    return out;
  };

  const links = new Map<string, RouteLink>();
  for (const file of input.files) {
    if (file.role !== "test" || !JS_TS.test(file.rel)) continue;
    const sf = readSource(file, input.read);
    if (!sf || !/supertest/.test(sf.text)) continue;
    const bindings = bindingsOf(sf, file.abs, input.repoRoot, input.wsPkgs, relOf);
    const requestNames = new Set([...bindings].filter(([, b]) => b.kind === "module" && b.spec === "supertest").map(([n]) => n));
    if (requestNames.size === 0) continue;
    const agents = new Map<string, ts.Expression>();
    const appArgOf = (call: ts.CallExpression): ts.Expression | null => {
      const callee = call.expression;
      if (ts.isIdentifier(callee) && requestNames.has(callee.text)) return call.arguments[0] ?? null;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "agent" && ts.isIdentifier(callee.expression) && requestNames.has(callee.expression.text)) return call.arguments[0] ?? null;
      return null;
    };
    const collectAgents = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
        const arg = appArgOf(node.initializer);
        if (arg) agents.set(node.name.text, arg);
      }
      ts.forEachChild(node, collectAgents);
    };
    collectAgents(sf);
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && VERBS.has(node.expression.name.text) && node.arguments.length >= 1) {
        const recv = node.expression.expression;
        let appArg: ts.Expression | null = null;
        if (ts.isCallExpression(recv)) appArg = appArgOf(recv);
        else if (ts.isIdentifier(recv)) appArg = agents.get(recv.text) ?? null;
        if (appArg) {
          counts.requests++;
          handleRequest(file.rel, node.expression.name.text.toUpperCase(), node.arguments[0]!, appArg, bindings);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }

  function handleRequest(testRel: string, method: string, pathNode: ts.Expression, appArg: ts.Expression, bindings: Map<string, Binding>): void {
    const ref = appRefFor(appArg, testRel, bindings, new Set());
    const app = ref ? lookup(ref) : null;
    if (!app) {
      counts.app_not_traced++;
      return;
    }
    const segments = requestSegments(pathNode);
    if (segments === null) {
      counts.no_route++;
      return;
    }
    const matches = routesOf(app.file, app.local, new Set()).filter((r) => (r.method === method || r.method === "ALL") && pathMatches(r.path, segments));
    if (matches.length === 0) {
      counts.no_route++;
      return;
    }
    // A wildcard or pattern route never links: it can stand for many paths.
    if (matches.length > 1 || matches.some((r) => isPatternRoute(r.path))) {
      counts.several_routes++;
      return;
    }
    const route = matches[0]!;
    const targets = route.handler.kind === "named" ? [route.handler.symId!] : route.handler.kind === "inline" ? route.handler.calls ?? [] : [];
    if (targets.length === 0) {
      counts.handler_not_mapped++;
      return;
    }
    counts.linked_requests++;
    const via = route.handler.kind === "named" ? "named" : "inline";
    for (const symId of targets) {
      const key = `${testRel}|${symId}`;
      if (links.has(key)) continue;
      links.set(key, { testRel, symId, method: route.method === "ALL" ? method : route.method, path: route.path, via, site: `${route.file}:${route.handler.line}` });
    }
  }

  const out = [...links.values()].sort((a, b) => (a.testRel + a.symId).localeCompare(b.testRel + b.symId));
  counts.links = out.length;
  return { links: out, counts };
}

/** The request's path as segments; a template part stands for one whole segment (`null` = any value). */
function requestSegments(node: ts.Expression): Array<string | null> | null {
  const lit = literalText(node);
  if (lit !== null) {
    if (/^[a-z]+:\/\//i.test(lit)) return null;
    return normalizePath(lit).split("/").filter(Boolean);
  }
  if (ts.isTemplateExpression(node)) {
    let text = node.head.text;
    const MARK = "\u0000";
    for (const span of node.templateSpans) text += MARK + span.literal.text;
    if (/^[a-z]+:\/\//i.test(text) || text.startsWith(MARK)) return null;
    const segs = normalizePath(text).split("/").filter(Boolean);
    const out: Array<string | null> = [];
    for (const s of segs) {
      if (s === MARK) out.push(null);
      else if (s.includes(MARK)) return null; // a value inside a segment: not one whole segment
      else out.push(s);
    }
    return out;
  }
  return null;
}

function isPatternRoute(path: string): boolean {
  return path.split("/").some((p) => /[*()?+]/.test(p));
}

/** Literal and `:param` segments only; a wildcard or pattern route matches nothing it could be confused with. */
function pathMatches(routePath: string, segments: Array<string | null>): boolean {
  const parts = routePath.split("/").filter(Boolean);
  if (parts.some((p) => /[*()?+]/.test(p))) return parts.length === 0 ? false : wildcardMatch(parts, segments);
  if (parts.length !== segments.length) return false;
  return parts.every((p, i) => p.startsWith(":") || (segments[i] !== null && segments[i] === p));
}

function wildcardMatch(parts: string[], segments: Array<string | null>): boolean {
  // A route with a wildcard or pattern segment matches any request that agrees on the literal segments
  // before it. It can only add a second match, never make a link on its own unless it is the only route.
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (/[*()?+]/.test(p)) return true;
    if (i >= segments.length) return false;
    if (!p.startsWith(":") && segments[i] !== p) return false;
  }
  return parts.length === segments.length;
}
