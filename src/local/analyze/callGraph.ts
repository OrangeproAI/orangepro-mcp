// AST-derived call extraction for TS/JS (Layer-1 call graph, PR 1).
//
// Pure parse step: walk a file's AST and record each call as a (caller, callee)
// pair, where the caller is the nearest enclosing NAMED symbol scope. Resolution
// of the callee to a concrete CodeSymbol — and the strict "both endpoints are
// emitted symbols" rule — happens in the analyzer, which holds the cross-file
// symbol index and the import-binding map.
//
// SCOPE-AWARE (no guessing): a free `bar()` or static `C.bar()` is dropped when
// `bar`/`C` is shadowed by a parameter, local variable, local function/class,
// catch binding, or destructuring binding in the enclosing lexical scope — the
// call then targets the LOCAL, not an emitted symbol. We over-approximate the
// shadow set (every binding anywhere in the enclosing function chain, excluding
// nested function scopes), which can only UNDER-emit; hard CALLS cannot guess.
//
// Callee forms captured (everything else dropped):
//   - `bar()`      → free identifier (same-file or import-resolved later)
//   - `this.bar()` → a member of the caller's own class (never shadowed)
//   - `C.bar()`    → a static member, qualifier is the class identifier
//   - `this.dep.bar()` → an injected field whose type is explicit in the class

import ts from "typescript";

export type CallVia = "free" | "this" | "static" | "injected";

export interface RawCall {
  /** Structural name of the nearest enclosing named symbol: `foo` | `X` | `Class.method`. */
  caller: string;
  /** The called identifier (the member name for this/static). */
  callee: string;
  via: CallVia;
  /** For `static`: object identifier (`C` in `C.bar()`); for `injected`: field name (`dep` in `this.dep.bar()`). */
  qualifier?: string;
  /** For `injected`: explicit class/type name of the injected field. */
  injectedType?: string;
}

export interface MedusaGeneratedService {
  className: string;
  modelKeys: string[];
  methods: string[];
}

export const MEDUSA_INTERNAL_SERVICE_TYPE = "__medusa_internal_service__";

const MAX_CALLS_PER_FILE = 2000;

type FnLike =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration
  | ts.ConstructorDeclaration
  | ts.GetAccessorDeclaration
  | ts.SetAccessorDeclaration;

function isFunctionLike(n: ts.Node): n is FnLike {
  return (
    ts.isFunctionDeclaration(n) ||
    ts.isFunctionExpression(n) ||
    ts.isArrowFunction(n) ||
    ts.isMethodDeclaration(n) ||
    ts.isConstructorDeclaration(n) ||
    ts.isGetAccessorDeclaration(n) ||
    ts.isSetAccessorDeclaration(n)
  );
}

/** Collect identifier names introduced by a binding name (incl. destructuring). */
function collectBindingName(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) {
    out.add(name.text);
  } else {
    for (const el of name.elements) {
      if (ts.isBindingElement(el)) collectBindingName(el.name, out);
    }
  }
}

/**
 * All names bound lexically inside `fn`: its own name, parameters (destructuring-
 * aware), and every declaration at any block depth within the body — EXCLUDING
 * nested function scopes (which own their bindings). Over-approximated on
 * purpose (block/TDZ nuance ignored): a superset only ever drops more edges.
 */
function scopeBindings(fn: FnLike): Set<string> {
  const out = new Set<string>();
  if ("name" in fn && fn.name && ts.isIdentifier(fn.name)) out.add(fn.name.text);
  for (const p of fn.parameters) collectBindingName(p.name, out);
  if (fn.body) collectDecls(fn.body, out);
  return out;
}

/** Collect declared bindings under `node`, NOT descending into nested function scopes. */
function collectDecls(node: ts.Node, out: Set<string>): void {
  ts.forEachChild(node, (child) => {
    if (isFunctionLike(child) || ts.isClassExpression(child)) {
      if ((ts.isFunctionDeclaration(child) || ts.isClassDeclaration(child)) && child.name) out.add(child.name.text);
      return; // separate scope — its locals do not shadow here
    }
    if (ts.isClassDeclaration(child)) {
      if (child.name) out.add(child.name.text);
      return;
    }
    if (ts.isVariableDeclaration(child) || ts.isBindingElement(child)) collectBindingName(child.name, out);
    if (ts.isCatchClause(child) && child.variableDeclaration) collectBindingName(child.variableDeclaration.name, out);
    collectDecls(child, out);
  });
}

function simpleTypeName(type: ts.TypeNode | undefined): string | null {
  if (!type || !ts.isTypeReferenceNode(type) || !ts.isIdentifier(type.typeName) || (type.typeArguments?.length ?? 0) > 0) return null;
  return type.typeName.text;
}

function medusaInternalServiceTypeName(type: ts.TypeNode | undefined): string | null {
  if (!type || !ts.isTypeReferenceNode(type)) return null;
  const name = type.typeName;
  if (ts.isIdentifier(name) && name.text === "IMedusaInternalService") return MEDUSA_INTERNAL_SERVICE_TYPE;
  if (ts.isQualifiedName(name) && name.right.text === "IMedusaInternalService") return MEDUSA_INTERNAL_SERVICE_TYPE;
  return null;
}

function injectableTypeName(type: ts.TypeNode | undefined): string | null {
  return simpleTypeName(type) ?? medusaInternalServiceTypeName(type);
}

function hasParameterPropertyModifier(param: ts.ParameterDeclaration): boolean {
  return Boolean(
    param.modifiers?.some((m) =>
      m.kind === ts.SyntaxKind.PublicKeyword ||
      m.kind === ts.SyntaxKind.PrivateKeyword ||
      m.kind === ts.SyntaxKind.ProtectedKeyword ||
      m.kind === ts.SyntaxKind.ReadonlyKeyword
    )
  );
}

function typeLiteralPropertyTypes(type: ts.TypeNode | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!type || !ts.isTypeLiteralNode(type)) return out;
  for (const member of type.members) {
    if (!ts.isPropertySignature(member) || !member.type) continue;
    const prop = member.name && ts.isIdentifier(member.name) ? member.name.text : null;
    const propType = injectableTypeName(member.type);
    if (prop && propType) out.set(prop, propType);
  }
  return out;
}

function collectInterfacePropertyTypes(sf: ts.SourceFile): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  ts.forEachChild(sf, (node) => {
    if (ts.isTypeAliasDeclaration(node) && ts.isTypeLiteralNode(node.type)) {
      out.set(node.name.text, typeLiteralPropertyTypes(node.type));
      return;
    }
    if (!ts.isInterfaceDeclaration(node)) return;
    const props = new Map<string, string>();
    for (const member of node.members) {
      if (!ts.isPropertySignature(member) || !member.type || !ts.isIdentifier(member.name)) continue;
      const propType = simpleTypeName(member.type);
      if (propType) props.set(member.name.text, propType);
    }
    out.set(node.name.text, props);
  });
  return out;
}

function objectBindingPropertyTypes(type: ts.TypeNode | undefined, interfaces: ReadonlyMap<string, Map<string, string>>): Map<string, string> {
  if (type && ts.isTypeReferenceNode(type) && ts.isIdentifier(type.typeName) && (type.typeArguments?.length ?? 0) === 0) {
    return interfaces.get(type.typeName.text) ?? new Map();
  }
  return typeLiteralPropertyTypes(type);
}

function collectConstructorParamTypes(ctor: ts.ConstructorDeclaration, interfaces: ReadonlyMap<string, Map<string, string>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const p of ctor.parameters) {
    const directType = injectableTypeName(p.type);
    if (ts.isIdentifier(p.name) && directType) {
      out.set(p.name.text, directType);
      continue;
    }
    if (!ts.isObjectBindingPattern(p.name)) continue;
    const propTypes = objectBindingPropertyTypes(p.type, interfaces);
    for (const el of p.name.elements) {
      if (!ts.isBindingElement(el) || !ts.isIdentifier(el.name)) continue;
      const propName = el.propertyName && ts.isIdentifier(el.propertyName) ? el.propertyName.text : el.name.text;
      const propType = propTypes.get(propName);
      if (propType) out.set(el.name.text, propType);
    }
  }
  return out;
}

function collectInjectedFields(cls: ts.ClassDeclaration, interfaces: ReadonlyMap<string, Map<string, string>>): Map<string, string> {
  const out = new Map<string, string>();
  for (const member of cls.members) {
    if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
      const typeName = injectableTypeName(member.type);
      if (typeName) out.set(member.name.text, typeName);
      continue;
    }
    if (!ts.isConstructorDeclaration(member)) continue;
    const paramTypes = collectConstructorParamTypes(member, interfaces);
    for (const p of member.parameters) {
      if (!ts.isIdentifier(p.name) || !hasParameterPropertyModifier(p)) continue;
      const typeName = injectableTypeName(p.type);
      if (typeName) out.set(p.name.text, typeName);
    }
    if (!member.body) continue;
    for (const stmt of member.body.statements) {
      if (!ts.isExpressionStatement(stmt) || !ts.isBinaryExpression(stmt.expression)) continue;
      const assignment = stmt.expression;
      if (assignment.operatorToken.kind !== ts.SyntaxKind.EqualsToken) continue;
      const left = assignment.left;
      const right = assignment.right;
      if (!ts.isPropertyAccessExpression(left) || left.expression.kind !== ts.SyntaxKind.ThisKeyword || !ts.isIdentifier(left.name)) continue;
      if (!ts.isIdentifier(right)) continue;
      const typeName = paramTypes.get(right.text);
      if (typeName) out.set(left.name.text, typeName);
    }
  }
  return out;
}

function collectInjectedFieldsByClass(sf: ts.SourceFile): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>();
  const interfaces = collectInterfacePropertyTypes(sf);
  ts.forEachChild(sf, (node) => {
    if (!ts.isClassDeclaration(node) || !node.name) return;
    const fields = collectInjectedFields(node, interfaces);
    if (fields.size > 0) out.set(node.name.text, fields);
  });
  return out;
}

export const MEDUSA_GENERATED_METHOD_BASES = ["retrieve", "list", "listAndCount", "delete", "softDelete", "restore", "create", "update"] as const;
export type MedusaGeneratedMethodBase = (typeof MEDUSA_GENERATED_METHOD_BASES)[number];

function upperCaseFirst(value: string): string {
  return value ? `${value[0].toUpperCase()}${value.slice(1)}` : value;
}

function pluralizeModelKey(value: string): string {
  if (/[sxz]$/i.test(value) || /(?:ch|sh)$/i.test(value)) return `${value}es`;
  if (/[^aeiou]y$/i.test(value)) return `${value.slice(0, -1)}ies`;
  return `${value}s`;
}

export function medusaGeneratedMethodNames(modelKey: string): string[] {
  return MEDUSA_GENERATED_METHOD_BASES.map((base) => medusaGeneratedMethodName(modelKey, base));
}

export function medusaGeneratedMethodName(modelKey: string, base: MedusaGeneratedMethodBase): string {
  const singular = upperCaseFirst(modelKey);
  const plural = upperCaseFirst(pluralizeModelKey(modelKey));
  return `${base}${base === "retrieve" ? singular : plural}`;
}

function modelKeysFromObjectLiteral(expr: ts.ObjectLiteralExpression): string[] | null {
  const keys: string[] = [];
  for (const prop of expr.properties) {
    if (!ts.isPropertyAssignment(prop) && !ts.isShorthandPropertyAssignment(prop)) return null;
    if (ts.isPropertyAssignment(prop)) {
      if (prop.name && ts.isIdentifier(prop.name)) keys.push(prop.name.text);
      else if (prop.name && ts.isStringLiteral(prop.name) && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(prop.name.text)) keys.push(prop.name.text);
      else return null;
    } else {
      keys.push(prop.name.text);
    }
  }
  return keys;
}

function constObjectModelMaps(sf: ts.SourceFile): Map<string, string[]> {
  const out = new Map<string, string[]>();
  ts.forEachChild(sf, (node) => {
    if (!ts.isVariableStatement(node)) return;
    for (const decl of node.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer || !ts.isObjectLiteralExpression(decl.initializer)) continue;
      const keys = modelKeysFromObjectLiteral(decl.initializer);
      if (keys) out.set(decl.name.text, keys);
    }
  });
  return out;
}

function medusaServiceCall(expr: ts.Expression): ts.CallExpression | null {
  if (!ts.isCallExpression(expr)) return null;
  const callee = expr.expression;
  if (ts.isIdentifier(callee) && callee.text === "MedusaService") return expr;
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.name.text === "MedusaService" &&
    ts.isIdentifier(callee.expression) &&
    callee.expression.text === "ModulesSdkUtils"
  ) {
    return expr;
  }
  return null;
}

function modelKeysFromExpr(expr: ts.Expression, constModels: ReadonlyMap<string, string[]>): string[] | null {
  if (ts.isObjectLiteralExpression(expr)) return modelKeysFromObjectLiteral(expr);
  if (ts.isIdentifier(expr)) return constModels.get(expr.text) ?? null;
  return null;
}

export function extractMedusaGeneratedServices(content: string, tsx: boolean): MedusaGeneratedService[] {
  const sf = ts.createSourceFile(
    tsx ? "generated.tsx" : "generated.ts",
    content,
    ts.ScriptTarget.Latest,
    true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const constModels = constObjectModelMaps(sf);
  const out: MedusaGeneratedService[] = [];
  ts.forEachChild(sf, (node) => {
    if (!ts.isClassDeclaration(node) || !node.name || !node.heritageClauses) return;
    for (const clause of node.heritageClauses) {
      if (clause.token !== ts.SyntaxKind.ExtendsKeyword) continue;
      for (const type of clause.types) {
        const call = medusaServiceCall(type.expression);
        const arg = call?.arguments[0];
        if (!arg) continue;
        const modelKeys = modelKeysFromExpr(arg, constModels);
        if (!modelKeys || modelKeys.length === 0) continue;
        const methods = [...new Set(modelKeys.flatMap(medusaGeneratedMethodNames))];
        out.push({ className: node.name.text, modelKeys, methods });
      }
    }
  });
  return out;
}

/**
 * Extract raw (caller, callee) call pairs from a TS/JS file. `tsx` selects the
 * grammar (TSX for .tsx/.jsx). Caller attribution: a call is attributed to the
 * nearest enclosing function declaration, class method, or const binding —
 * anonymous closures (callbacks, `useEffect(() => …)`) inherit their enclosing
 * named scope. Calls at module scope (no enclosing named symbol) are dropped.
 */
export function extractCalls(content: string, tsx: boolean): RawCall[] {
  const sf = ts.createSourceFile(
    tsx ? "calls.tsx" : "calls.ts",
    content,
    ts.ScriptTarget.Latest,
    /*setParentNodes*/ true,
    tsx ? ts.ScriptKind.TSX : ts.ScriptKind.TS
  );
  const out: RawCall[] = [];
  let capped = false;
  const injectedFieldsByClass = collectInjectedFieldsByClass(sf);

  // `thisExact` = `this` currently refers to the lexical class instance, so a
  // `this.member()` resolves exactly to that class's member. True only inside a
  // class method body and arrow callbacks nested within it; a non-arrow
  // `function () {}` (or a nested function declaration) REBINDS `this`, so a
  // `this.member()` there is NOT exact and is dropped.
  const recordCall = (node: ts.CallExpression, caller: string, shadowed: ReadonlySet<string>, thisExact: boolean): void => {
    if (out.length >= MAX_CALLS_PER_FILE) {
      capped = true;
      return;
    }
    const e = node.expression;
    if (ts.isIdentifier(e)) {
      if (shadowed.has(e.text)) return; // a local binding shadows the callee
      out.push({ caller, callee: e.text, via: "free" });
    } else if (ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.name)) {
      if (e.expression.kind === ts.SyntaxKind.ThisKeyword) {
        if (!thisExact) return; // `this` was rebound by a non-arrow function — not exact
        out.push({ caller, callee: e.name.text, via: "this" });
      } else if (
        ts.isPropertyAccessExpression(e.expression) &&
        e.expression.expression.kind === ts.SyntaxKind.ThisKeyword &&
        ts.isIdentifier(e.expression.name)
      ) {
        if (!thisExact) return; // `this` was rebound by a non-arrow function — not exact
        const cls = caller.includes(".") ? caller.slice(0, caller.indexOf(".")) : "";
        const field = e.expression.name.text;
        const injectedType = cls ? injectedFieldsByClass.get(cls)?.get(field) : undefined;
        if (injectedType) out.push({ caller, callee: e.name.text, via: "injected", qualifier: field, injectedType });
      } else if (ts.isIdentifier(e.expression)) {
        if (shadowed.has(e.expression.text)) return; // a local shadows the qualifier object
        out.push({ caller, callee: e.name.text, via: "static", qualifier: e.expression.text });
      }
    }
  };

  const extend = (parent: ReadonlySet<string>, fn: FnLike): ReadonlySet<string> => {
    const locals = scopeBindings(fn);
    if (locals.size === 0) return parent;
    return new Set([...parent, ...locals]);
  };

  // `topLevel` = we are at the file's MODULE scope, where a named function/class/
  // const declaration is an emittable symbol the analyzer can match by name. It
  // is FALSE inside any function/method/closure body AND inside a `namespace`/
  // `module` block (whose members are NOT emitted as top-level symbols, so a
  // namespace-nested `inner` must not impersonate a top-level exported `inner`).
  // A nested named declaration does not establish a caller; its calls are dropped
  // (under-emit; hard CALLS cannot guess). Anonymous closures still inherit the
  // enclosing caller — they have no name to impersonate.
  const walk = (node: ts.Node, caller: string | null, shadowed: ReadonlySet<string>, thisExact: boolean, topLevel: boolean): void => {
    if (capped) return;

    if (ts.isModuleDeclaration(node)) {
      // namespace/module N { … } — a non-emitting boundary. Drop its calls.
      if (node.body) ts.forEachChild(node.body, (x) => walk(x, null, shadowed, false, false));
      return;
    }
    if (ts.isClassDeclaration(node) || ts.isClassExpression(node)) {
      if (!topLevel || ts.isClassExpression(node)) return; // nested/namespace/expression class — drop
      const cls = node.name?.text;
      for (const m of node.members) {
        if (ts.isMethodDeclaration(m) && m.name && ts.isIdentifier(m.name) && m.body) {
          const c = cls ? `${cls}.${m.name.text}` : null;
          // A method body has class `this` (exact); it is no longer top-level.
          if (c) ts.forEachChild(m.body, (x) => walk(x, c, extend(shadowed, m), true, false));
        }
      }
      return;
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      if (node.body) {
        const sh = extend(shadowed, node);
        // Nested/namespace function declaration → drop (caller=null); rebinds `this`.
        const next = topLevel ? node.name.text : null;
        ts.forEachChild(node.body, (x) => walk(x, next, sh, false, false));
      }
      return;
    }
    if (ts.isVariableStatement(node)) {
      if (!topLevel) return; // nested/namespace const/let → drop (would impersonate an emitted symbol)
      for (const d of node.declarationList.declarations) {
        if (ts.isIdentifier(d.name) && d.initializer) {
          const callerName = d.name.text;
          const init = d.initializer;
          if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) {
            walk(init, callerName, shadowed, thisExact, false); // arrow/fn handler decides `this`
          } else {
            // wrapper call (forwardRef(...), memo(...)): don't record it, descend for inner closures.
            ts.forEachChild(init, (x) => walk(x, callerName, shadowed, thisExact, false));
          }
        }
      }
      return;
    }
    if (ts.isArrowFunction(node)) {
      // Arrow: keeps the enclosing caller AND lexical `this`. Walk the body NODE
      // directly so an EXPRESSION body (`() => render()`) is not skipped.
      const sh = extend(shadowed, node);
      if (node.body) walk(node.body, caller, sh, thisExact, false);
      return;
    }
    if (ts.isFunctionExpression(node)) {
      // `function () {}` rebinds `this` — clear thisExact for its body.
      const sh = extend(shadowed, node);
      if (node.body) walk(node.body, caller, sh, false, false);
      return;
    }

    if (caller && ts.isCallExpression(node)) recordCall(node, caller, shadowed, thisExact);
    ts.forEachChild(node, (c) => walk(c, caller, shadowed, thisExact, topLevel));
  };

  const EMPTY: ReadonlySet<string> = new Set();
  ts.forEachChild(sf, (c) => walk(c, null, EMPTY, false, true));
  return out;
}
