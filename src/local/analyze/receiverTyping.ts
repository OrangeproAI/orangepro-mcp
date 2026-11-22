import { readFileSync } from "node:fs";
import ts from "typescript";
import { resolveSpecifier } from "./confirm.js";
import { bindingsOf, type Binding } from "./routeLinks.js";
import { reexportSpecifiers } from "./reexports.js";

/**
 * Receiver typing (J4). Three links a direct-call reader misses:
 *
 * 1. Through a re-export file: a test that imports a package's entry (`require('../')`, where
 *    `index.js` is `module.exports = require('./lib/x')`) and calls it, calls the default export of
 *    the module the entry re-exports. Linked.
 * 2. Factory return typing: a value the test gets from a counted function that copies a module's
 *    exported object onto what it returns (`mixin(v, O)`, `Object.assign(v, O)`,
 *    `Object.setPrototypeOf(v, O)`, `v = Object.create(O)`) has O's members; `value.m()` links to
 *    `O.m`. Linked, and the edge says how.
 * 3. Handler parameters, by name only: inside a function the test passes to a method of such a value,
 *    `p.m()` where the package exports exactly one object named `p` with a member `m`. The step from
 *    the value to the parameter runs in code the map does not read, so this is Unconfirmed, never Linked.
 */

export interface ReceiverFile {
  rel: string;
  abs: string;
  role: "test" | "source";
}

export interface ReceiverLink {
  testRel: string;
  symId: string;
  kind: "reexport_call" | "factory_member";
  /** Factory links: the test's value, the factory, the file whose object it copies. */
  value?: string;
  factory?: string;
  ownerFile?: string;
}

export interface ReceiverCandidate {
  testRel: string;
  symId: string;
  param: string;
  value: string;
  factory: string;
}

export interface ReceiverCounts {
  factories: number;
  reexport_calls: number;
  factory_member_links: number;
  handler_name_candidates: number;
  handler_name_ambiguous: number;
}

export interface ReceiverResult {
  links: ReceiverLink[];
  candidates: ReceiverCandidate[];
  counts: ReceiverCounts;
}

const JS_TS = /\.[cm]?[jt]sx?$/i;

/** Every handler-name candidate's reason starts with this, so the reports can say what it is. */
export const RECEIVER_CANDIDATE_REASON_PREFIX = "Handler parameter";

interface ModuleInfo {
  /** The name of the function `module.exports = X` / `export default X` names, if any. */
  defaultFn?: string;
  /** The exported object's local name: `var app = exports = module.exports = {}`, `module.exports = res`. */
  owner?: string;
  /** Counted functions that return a value built from other modules' exported objects. */
  factories: Map<string, Array<{ file: string; owner: string }>>;
}

function scriptKind(rel: string): ts.ScriptKind {
  if (/\.tsx$/i.test(rel)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(rel)) return ts.ScriptKind.JSX;
  if (/\.[cm]?ts$/i.test(rel)) return ts.ScriptKind.TS;
  return ts.ScriptKind.JS;
}

/** `module.exports`, `exports`, or a chain of assignments to them (`exports = module.exports = X`). */
function isExportsTarget(node: ts.Expression, sf: ts.SourceFile): boolean {
  const t = node.getText(sf);
  return t === "module.exports" || t === "exports";
}

/** The rightmost value of `a = b = c`, and whether a module export target is among the left sides. */
function assignmentChain(node: ts.Expression, sf: ts.SourceFile): { value: ts.Expression; exported: boolean; locals: string[] } {
  let exported = false;
  const locals: string[] = [];
  let cur: ts.Expression = node;
  while (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    if (isExportsTarget(cur.left, sf)) exported = true;
    else if (ts.isIdentifier(cur.left)) locals.push(cur.left.text);
    cur = cur.right;
  }
  return { value: cur, exported, locals };
}

function moduleInfo(sf: ts.SourceFile): Omit<ModuleInfo, "factories"> & { functions: Map<string, ts.FunctionDeclaration> } {
  const info: Omit<ModuleInfo, "factories"> & { functions: Map<string, ts.FunctionDeclaration> } = { functions: new Map() };
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) info.functions.set(stmt.name.text, stmt);
    if (ts.isVariableStatement(stmt)) {
      for (const d of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(d.name) || !d.initializer) continue;
        const chain = assignmentChain(d.initializer, sf);
        // `var app = exports = module.exports = {}`: the exported object is named `app`.
        if (chain.exported && (ts.isObjectLiteralExpression(chain.value) || ts.isCallExpression(chain.value))) info.owner = d.name.text;
      }
    }
    if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression) && stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const chain = assignmentChain(stmt.expression, sf);
      if (chain.exported && ts.isIdentifier(chain.value)) {
        if (info.functions.has(chain.value.text) || sf.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === (chain.value as ts.Identifier).text)) {
          info.defaultFn = chain.value.text;
        } else info.owner = chain.value.text;
      }
    }
    if (ts.isExportAssignment(stmt) && ts.isIdentifier(stmt.expression)) {
      const name = stmt.expression.text;
      if (sf.statements.some((s) => ts.isFunctionDeclaration(s) && s.name?.text === name)) info.defaultFn = name;
      else info.owner = name;
    }
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.modifiers?.some((m) => m.kind === ts.SyntaxKind.DefaultKeyword)) info.defaultFn = stmt.name.text;
  }
  // A function declared after `module.exports = name` is still the default export.
  return info;
}

/** The modules a function copies onto the value it returns. */
function factoryOwners(fn: ts.FunctionDeclaration, bindings: Map<string, Binding>, ownerOf: (file: string) => string | undefined): Array<{ file: string; owner: string }> {
  if (!fn.body) return [];
  const returned = new Set<string>();
  const copies = new Map<string, Set<string>>(); // value name → source binding names
  const visit = (node: ts.Node): void => {
    if (ts.isReturnStatement(node) && node.expression && ts.isIdentifier(node.expression)) returned.add(node.expression.text);
    if (ts.isCallExpression(node)) {
      const callee = node.expression.getText();
      const [target, source] = node.arguments;
      const isCopy = /(^|\.)mixin$|^Object\.assign$|^Object\.setPrototypeOf$|^merge$|(^|\.)extend$/.test(callee);
      if (isCopy && target && source && ts.isIdentifier(target) && ts.isIdentifier(source)) {
        (copies.get(target.text) ?? copies.set(target.text, new Set()).get(target.text)!).add(source.text);
      }
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer && ts.isCallExpression(node.initializer)) {
      const init = node.initializer;
      if (init.expression.getText() === "Object.create" && init.arguments[0] && ts.isIdentifier(init.arguments[0])) {
        (copies.get(node.name.text) ?? copies.set(node.name.text, new Set()).get(node.name.text)!).add(init.arguments[0].text);
      }
    }
    if (!ts.isFunctionDeclaration(node) || node === fn) ts.forEachChild(node, visit);
  };
  ts.forEachChild(fn.body, visit);
  const out: Array<{ file: string; owner: string }> = [];
  for (const v of returned) {
    for (const src of copies.get(v) ?? []) {
      const b = bindings.get(src);
      if (!b || b.kind !== "module" || !b.file || (b.name !== "*" && b.name !== "default")) continue;
      const owner = ownerOf(b.file);
      if (owner && !out.some((o) => o.file === b.file)) out.push({ file: b.file, owner });
    }
  }
  return out;
}

export function computeReceiverLinks(input: {
  files: ReceiverFile[];
  symbols: Set<string>;
  repoRoot: string;
  wsPkgs: Map<string, string>;
  read: (abs: string) => string | null;
}): ReceiverResult {
  const counts: ReceiverCounts = { factories: 0, reexport_calls: 0, factory_member_links: 0, handler_name_candidates: 0, handler_name_ambiguous: 0 };
  const relByAbs = new Map(input.files.map((f) => [f.abs, f.rel]));
  const absByRel = new Map(input.files.map((f) => [f.rel, f.abs]));
  const relOf = (abs: string): string | null => relByAbs.get(abs) ?? null;
  const parsed = new Map<string, { sf: ts.SourceFile; info: ReturnType<typeof moduleInfo> }>();
  const parse = (rel: string): { sf: ts.SourceFile; info: ReturnType<typeof moduleInfo> } | null => {
    const hit = parsed.get(rel);
    if (hit) return hit;
    const abs = absByRel.get(rel);
    const text = abs ? input.read(abs) : null;
    if (text === null || text === undefined) return null;
    const sf = ts.createSourceFile(rel, text, ts.ScriptTarget.Latest, true, scriptKind(rel));
    const entry = { sf, info: moduleInfo(sf) };
    parsed.set(rel, entry);
    return entry;
  };
  // Source modules: owners and factories.
  const owners = new Map<string, string>();
  const ownersByName = new Map<string, string[]>();
  for (const f of input.files) {
    if (f.role !== "source" || !JS_TS.test(f.rel)) continue;
    const text = input.read(f.abs);
    if (!text || !/module\.exports|export\s+default/.test(text)) continue;
    const p = parse(f.rel);
    if (p?.info.owner) {
      owners.set(f.rel, p.info.owner);
      (ownersByName.get(p.info.owner) ?? ownersByName.set(p.info.owner, []).get(p.info.owner)!).push(f.rel);
    }
  }
  const factories = new Map<string, Array<{ file: string; owner: string }>>();
  for (const f of input.files) {
    if (f.role !== "source" || !JS_TS.test(f.rel)) continue;
    const p = parsed.get(f.rel);
    if (!p || p.info.functions.size === 0) continue;
    const bindings = bindingsOf(p.sf, f.abs, input.repoRoot, input.wsPkgs, relOf);
    for (const [name, fn] of p.info.functions) {
      const symId = `sym:${f.rel}#${name}`;
      if (!input.symbols.has(symId)) continue;
      const fo = factoryOwners(fn, bindings, (file) => owners.get(file));
      if (fo.length) {
        factories.set(symId, fo);
        counts.factories++;
      }
    }
  }

  /** A module binding followed through re-export files to the module that defines a default function. */
  const defaultFunctionOf = (b: Binding | undefined): { id: string; hops: number } | null => {
    if (!b || b.kind !== "module" || !b.file || (b.name !== "*" && b.name !== "default")) return null;
    let rel: string | null = b.file;
    for (let hop = 0; hop < 4 && rel; hop++) {
      const p = parse(rel);
      if (!p) return null;
      if (p.info.defaultFn) {
        const id = `sym:${rel}#${p.info.defaultFn}`;
        return input.symbols.has(id) ? { id, hops: hop } : null;
      }
      const specs = reexportSpecifiers(p.sf.text);
      if (specs.length !== 1) return null;
      const abs = absByRel.get(rel);
      const target = abs ? resolveSpecifier(specs[0]!, abs, input.repoRoot, input.wsPkgs) : null;
      rel = target ? relOf(target) : null;
    }
    return null;
  };

  const links = new Map<string, ReceiverLink>();
  const candidates = new Map<string, ReceiverCandidate>();
  for (const f of input.files) {
    if (f.role !== "test" || !JS_TS.test(f.rel)) continue;
    const text = input.read(f.abs);
    if (!text) continue;
    const sf = ts.createSourceFile(f.rel, text, ts.ScriptTarget.Latest, true, scriptKind(f.rel));
    const bindings = bindingsOf(sf, f.abs, input.repoRoot, input.wsPkgs, relOf);
    const callable = new Map<string, string>(); // local name → default function symbol
    const throughReexport = new Set<string>(); // names whose function was reached through a re-export file
    for (const [name, b] of bindings) {
      const hit = defaultFunctionOf(b);
      if (!hit) continue;
      callable.set(name, hit.id);
      if (hit.hops > 0) throughReexport.add(name);
    }
    if (callable.size === 0) continue;
    // Values the test gets from a factory call: `const app = express()` or `app = express()`, resolved per
    // scope: a test file often declares `var app` in many `it` blocks, each with its own value.
    type T = { factory: string; owners: Array<{ file: string; owner: string }> };
    const typeOfCall = (expr: ts.Expression): T | null => {
      if (!ts.isCallExpression(expr) || !ts.isIdentifier(expr.expression)) return null;
      const id = callable.get(expr.expression.text);
      const owners2 = id ? factories.get(id) : undefined;
      return id && owners2 ? { factory: id, owners: owners2 } : null;
    };
    const isScope = (n: ts.Node): boolean => ts.isSourceFile(n) || ts.isFunctionLike(n) || ts.isBlock(n);
    const scopeOf = (decl: ts.VariableDeclaration): ts.Node => {
      const list = decl.parent;
      const isVar = ts.isVariableDeclarationList(list) && (list.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0;
      let cur: ts.Node = list;
      while (cur.parent && !(isVar ? ts.isSourceFile(cur) || ts.isFunctionLike(cur) : isScope(cur))) cur = cur.parent;
      return cur;
    };
    const decls = new Map<string, Array<{ decl: ts.VariableDeclaration; scope: ts.Node }>>();
    const findDecls = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) {
        (decls.get(node.name.text) ?? decls.set(node.name.text, []).get(node.name.text)!).push({ decl: node, scope: scopeOf(node) });
      }
      ts.forEachChild(node, findDecls);
    };
    findDecls(sf);
    const contains = (outer: ts.Node, inner: ts.Node): boolean => inner.getStart(sf) >= outer.getStart(sf) && inner.getEnd() <= outer.getEnd();
    const depth = (n: ts.Node): number => {
      let d = 0;
      for (let c: ts.Node | undefined = n; c; c = c.parent) d++;
      return d;
    };
    const resolveDecl = (id: ts.Identifier): ts.VariableDeclaration | null => {
      const options = (decls.get(id.text) ?? []).filter((d) => contains(d.scope, id));
      if (options.length === 0) return null;
      return options.sort((a, b) => depth(b.scope) - depth(a.scope))[0]!.decl;
    };
    const declType = new Map<ts.VariableDeclaration, T | null>();
    const note = (decl: ts.VariableDeclaration, t: T | null): void => {
      // A variable given two different values is not typed: the call could be on either.
      if (declType.has(decl) && JSON.stringify(declType.get(decl)) !== JSON.stringify(t)) declType.set(decl, null);
      else declType.set(decl, t);
    };
    const collect = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) note(node, typeOfCall(node.initializer));
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        const decl = resolveDecl(node.left);
        if (decl) note(decl, typeOfCall(node.right));
      }
      ts.forEachChild(node, collect);
    };
    collect(sf);
    const receiverType = (expr: ts.Expression): { name: string; t: T } | null => {
      if (ts.isIdentifier(expr)) {
        const decl = resolveDecl(expr);
        const t = decl ? declType.get(decl) : undefined;
        return t ? { name: expr.text, t } : null;
      }
      const t = typeOfCall(expr);
      return t ? { name: `${(expr as ts.CallExpression).expression.getText(sf)}()`, t } : null;
    };
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        // 1. A call through a re-export: `express()`. A direct import is left to the confirmer.
        if (ts.isIdentifier(node.expression) && throughReexport.has(node.expression.text)) {
          const id = callable.get(node.expression.text);
          if (id && !links.has(`${f.rel}|${id}`)) {
            links.set(`${f.rel}|${id}`, { testRel: f.rel, symId: id, kind: "reexport_call" });
            counts.reexport_calls++;
          }
        }
        // 2. A member of a typed value: `app.use(...)`.
        if (ts.isPropertyAccessExpression(node.expression)) {
          const recv = receiverType(node.expression.expression);
          if (recv) {
            const m = node.expression.name.text;
            const hits = recv.t.owners.map((o) => ({ o, id: `sym:${o.file}#${o.owner}.${m}` })).filter((h) => input.symbols.has(h.id));
            if (hits.length === 1) {
              const { o, id } = hits[0]!;
              const key = `${f.rel}|${id}`;
              if (!links.has(key)) {
                links.set(key, { testRel: f.rel, symId: id, kind: "factory_member", value: recv.name, factory: recv.t.factory.slice(recv.t.factory.lastIndexOf("#") + 1), ownerFile: o.file });
                counts.factory_member_links++;
              }
            }
            // 3. Handler parameters, by name.
            for (const arg of node.arguments) {
              if (!ts.isArrowFunction(arg) && !ts.isFunctionExpression(arg)) continue;
              const params = arg.parameters.map((p) => (ts.isIdentifier(p.name) ? p.name.text : null));
              const inner = (n: ts.Node): void => {
                if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && ts.isIdentifier(n.expression.expression)) {
                  const p = n.expression.expression.text;
                  if (params.includes(p)) {
                    const files = (ownersByName.get(p) ?? []).filter((rel) => input.symbols.has(`sym:${rel}#${p}.${(n.expression as ts.PropertyAccessExpression).name.text}`));
                    if (files.length === 1) {
                      const id = `sym:${files[0]}#${p}.${(n.expression as ts.PropertyAccessExpression).name.text}`;
                      const key = `${f.rel}|${id}`;
                      if (!candidates.has(key)) {
                        candidates.set(key, { testRel: f.rel, symId: id, param: p, value: recv.name, factory: recv.t.factory.slice(recv.t.factory.lastIndexOf("#") + 1) });
                        counts.handler_name_candidates++;
                      }
                    } else if (files.length > 1) counts.handler_name_ambiguous++;
                  }
                }
                ts.forEachChild(n, inner);
              };
              ts.forEachChild(arg.body, inner);
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  const sortBy = <T extends { testRel: string; symId: string }>(xs: T[]): T[] => xs.sort((a, b) => (a.testRel + a.symId).localeCompare(b.testRel + b.symId));
  return { links: sortBy([...links.values()]), candidates: sortBy([...candidates.values()]), counts };
}

export function readOrNull(abs: string): string | null {
  try {
    return readFileSync(abs, "utf8");
  } catch {
    return null;
  }
}
