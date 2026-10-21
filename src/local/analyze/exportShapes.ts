import ts from "typescript";

// Five ways of making a TS/JS function public that the declaration-based
// extractor in symbols.ts does not see, judged on syntax only:
//   1. export list              export { a, b as c }
//   2. prototype method         F.prototype.name = function () {}
//   3. exported-object method   X.name = function () {}   (X is the exported object)
//   4. object-literal export    module.exports = { a, b() {}, c: function () {} }
//   5. unnamed default export   export default function () {}
// A shape that is not accepted yields NO symbol (hard symbols cannot guess);
// where the reason is nameable it is returned as a not-supported entry so the
// analysis can disclose what it deliberately left out.

export type SeenBy =
  | "export_list"
  | "prototype_method"
  | "exported_object_method"
  | "object_literal_export"
  | "unnamed_default_export";

export type ShapeForm = "export_list" | "prototype" | "member" | "literal_inline" | "literal_reference" | "unnamed_default";

export type NotSupportedCode =
  | "helper_defined"
  | "computed_or_nested"
  | "owner_kind"
  | "duplicate_member"
  | "ambiguous_owner"
  | "owner_not_seen"
  | "prototype_object"
  | "accessor"
  | "spread"
  | "name_collision"
  | "unnamed_export"
  | "parse_disagreement"
  | "public_reexport_not_followed";

export interface NotSupportedEntry {
  code: NotSupportedCode;
  owner?: string;
  name?: string;
  start_line: number;
  end_line: number;
}

export type TrivialBody = "empty" | "stored_value" | "stores_parameter";

export interface PassThrough {
  via: "free" | "this";
  callee: string;
}

export interface FunctionTraits {
  documented_private: boolean;
  trivial_body?: TrivialBody;
  pass_through?: PassThrough;
}

export type FunctionLikeNode =
  | ts.FunctionDeclaration
  | ts.FunctionExpression
  | ts.ArrowFunction
  | ts.MethodDeclaration;

export interface ExportShape {
  seenBy: SeenBy;
  form: ShapeForm;
  /** Symbol name: the local name, `Owner.name`, the literal key, or `default`. */
  name: string;
  kind: "function" | "class" | "method" | "const";
  memberOf?: string;
  /** Other public names of the same function, in symbol-name form (`Owner.alias` for members). */
  aliases: string[];
  /** The function-like node, or the class declaration for a class reference. */
  node: FunctionLikeNode | ts.ClassDeclaration;
  /** Node whose leading JSDoc documents the function: the top-level statement, the property, or the local's declaration. */
  anchor: ts.Node;
  /** For a reference (way 1, way-4 reference): the local's declaration, whose lines the symbol reports. */
  declaration?: ts.Node;
  /**
   * For a reference: the local name is itself one of the names the file exports.
   * `export { impl as run }` makes `impl` visible, but nothing can import `impl`.
   */
  ownNameExported?: boolean;
  /** How the owner is bound (members only). */
  ownerBinding?: "object_literal" | "object_create" | "function" | "class" | "const";
  /** Assignment targets written before the function, as source text (`res.set`, `View.prototype.render`). */
  targets?: string[];
}

export interface ExistingSymbol {
  kind: "function" | "class" | "const" | "method";
  callable: boolean;
}

export interface ExportShapeResult {
  shapes: ExportShape[];
  notSupported: NotSupportedEntry[];
}

const ASSIGNMENT_OPERATORS = new Set<ts.SyntaxKind>([
  ts.SyntaxKind.EqualsToken,
  ts.SyntaxKind.PlusEqualsToken,
  ts.SyntaxKind.MinusEqualsToken,
  ts.SyntaxKind.AsteriskEqualsToken,
  ts.SyntaxKind.AsteriskAsteriskEqualsToken,
  ts.SyntaxKind.SlashEqualsToken,
  ts.SyntaxKind.PercentEqualsToken,
  ts.SyntaxKind.LessThanLessThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.GreaterThanGreaterThanGreaterThanEqualsToken,
  ts.SyntaxKind.AmpersandEqualsToken,
  ts.SyntaxKind.BarEqualsToken,
  ts.SyntaxKind.CaretEqualsToken,
  ts.SyntaxKind.BarBarEqualsToken,
  ts.SyntaxKind.AmpersandAmpersandEqualsToken,
  ts.SyntaxKind.QuestionQuestionEqualsToken
]);

const IDENTIFIER_RE = /^[A-Za-z_$][\w$]*$/;

/** Parens, `as`, `satisfies`, `!` and angle-bracket assertions are transparent. */
export function stripWrappers(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

function stripParens(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function isModuleExports(n: ts.Node): boolean {
  if (ts.isPropertyAccessExpression(n)) return ts.isIdentifier(n.expression) && n.expression.text === "module" && n.name.text === "exports";
  // `module["exports"]` is the same object.
  return (
    ts.isElementAccessExpression(n) &&
    ts.isIdentifier(n.expression) &&
    n.expression.text === "module" &&
    ts.isStringLiteralLike(n.argumentExpression) &&
    n.argumentExpression.text === "exports"
  );
}

function isExportsIdentifier(n: ts.Node): boolean {
  return ts.isIdentifier(n) && n.text === "exports";
}

function isFunctionValue(n: ts.Node): n is ts.FunctionExpression | ts.ArrowFunction {
  return ts.isFunctionExpression(n) || ts.isArrowFunction(n);
}

function isPlainAssignment(n: ts.Node): n is ts.BinaryExpression {
  return ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken;
}

/** `a = b = value` → targets [a, b] and the final value (parentheses removed between links). */
function assignmentChain(expr: ts.Expression): { targets: ts.Expression[]; value: ts.Expression } {
  const targets: ts.Expression[] = [];
  let cur = stripParens(expr);
  while (isPlainAssignment(cur)) {
    targets.push(cur.left);
    cur = stripParens(cur.right);
  }
  return { targets, value: cur };
}

function isObjectCreateCall(n: ts.Expression): boolean {
  return (
    ts.isCallExpression(n) &&
    ts.isPropertyAccessExpression(n.expression) &&
    ts.isIdentifier(n.expression.expression) &&
    n.expression.expression.text === "Object" &&
    n.expression.name.text === "create"
  );
}

function hasModifier(n: ts.Node, kind: ts.SyntaxKind): boolean {
  return ts.canHaveModifiers(n) && (ts.getModifiers(n)?.some((m) => m.kind === kind) ?? false);
}

function collectBindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (ts.isBindingElement(el)) collectBindingNames(el.name, out);
}

/** `<base>.prototype` with an identifier base → the base name, else null. */
function prototypeOwner(n: ts.Node): string | null {
  return ts.isPropertyAccessExpression(n) && n.name.text === "prototype" && ts.isIdentifier(n.expression) ? n.expression.text : null;
}

/** Key under which property writes are counted: an identifier, `module.exports`, or `F#prototype`. */
function ownerKey(n: ts.Node): string | null {
  if (ts.isIdentifier(n)) return n.text;
  if (isModuleExports(n)) return "module.exports";
  const proto = prototypeOwner(n);
  return proto ? `${proto}#prototype` : null;
}

function literalKeyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name)) return name.text;
  return null;
}

/** Keys an object literal defines; `open` when a spread or computed key makes the set unknowable. */
function literalKeys(obj: ts.ObjectLiteralExpression): { keys: string[]; open: boolean } {
  const keys: string[] = [];
  let open = false;
  for (const p of obj.properties) {
    if (ts.isSpreadAssignment(p)) {
      open = true;
      continue;
    }
    const key = p.name ? literalKeyName(p.name) : null;
    if (key === null) open = true;
    else keys.push(key);
  }
  return { keys, open };
}

function literalHasFunction(obj: ts.ObjectLiteralExpression): boolean {
  return obj.properties.some(
    (p) => ts.isMethodDeclaration(p) || (ts.isPropertyAssignment(p) && isFunctionValue(stripWrappers(p.initializer)))
  );
}

interface FileFacts {
  topFunctions: Map<string, ts.FunctionDeclaration>;
  topClasses: Map<string, ts.ClassDeclaration>;
  topConstFns: Map<string, { declaration: ts.VariableDeclaration; statement: ts.VariableStatement }>;
  topBindings: Set<string>;
  topVarCounts: Map<string, number>;
  /** Every plain `module.exports = …` in the file, at any depth. */
  moduleExportsWrites: ts.BinaryExpression[];
  /** Writes to `module.exports` that are not a plain `=` (`||=`, `??=`, a destructuring target …): the exported object cannot be named. */
  moduleExportsOtherWrites: number;
  /** owner key → property → number of assignments, at any depth. */
  propWrites: Map<string, Map<string, number>>;
  /** owner keys hit by a write whose property names cannot be read (`Object.assign(X, y)`, computed defineProperty). */
  openWrites: Set<string>;
  /** identifier → number of reassignments (`X = …`, `X += …`, `X++`). */
  identWrites: Map<string, number>;
  /** Top-level assignments to `F.prototype` itself. */
  prototypeWrites: Array<{ owner: string; node: ts.BinaryExpression; value: ts.Expression }>;
  /** First `F.prototype.<name> = …` position per owner. */
  firstMemberWrite: Map<string, number>;
  /** `Object.assign(F.prototype, {…})` calls, for disclosure. */
  prototypeAssigns: Array<{ owner: string; node: ts.CallExpression }>;
  classMemberNames: Map<string, Set<string>>;
  /** Identifiers handed to an export statement the extractor may or may not follow. */
  exportedIdentifiers: Set<string>;
}

function bump(map: Map<string, Map<string, number>>, owner: string, prop: string, by = 1): void {
  let inner = map.get(owner);
  if (!inner) {
    inner = new Map();
    map.set(owner, inner);
  }
  inner.set(prop, (inner.get(prop) ?? 0) + by);
}

function collectFacts(sf: ts.SourceFile, deep: boolean): FileFacts {
  const facts: FileFacts = {
    topFunctions: new Map(),
    topClasses: new Map(),
    topConstFns: new Map(),
    topBindings: new Set(),
    topVarCounts: new Map(),
    moduleExportsWrites: [],
    moduleExportsOtherWrites: 0,
    propWrites: new Map(),
    openWrites: new Set(),
    identWrites: new Map(),
    prototypeWrites: [],
    firstMemberWrite: new Map(),
    prototypeAssigns: [],
    classMemberNames: new Map(),
    exportedIdentifiers: new Set()
  };
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name) {
      facts.topBindings.add(stmt.name.text);
      // Overload signatures and ambient declarations have no body — only the implementation counts.
      if (stmt.body && !hasModifier(stmt, ts.SyntaxKind.DeclareKeyword)) facts.topFunctions.set(stmt.name.text, stmt);
    } else if (ts.isClassDeclaration(stmt) && stmt.name) {
      facts.topBindings.add(stmt.name.text);
      if (!hasModifier(stmt, ts.SyntaxKind.DeclareKeyword)) {
        facts.topClasses.set(stmt.name.text, stmt);
        const members = new Set<string>();
        for (const m of stmt.members) {
          const key = !m.name
            ? null
            : ts.isIdentifier(m.name) || ts.isStringLiteral(m.name)
              ? m.name.text
              : ts.isComputedPropertyName(m.name) && ts.isStringLiteralLike(m.name.expression)
                ? m.name.expression.text
                : null;
          if (key) members.add(key);
        }
        facts.classMemberNames.set(stmt.name.text, members);
      }
    } else if (ts.isVariableStatement(stmt)) {
      const isConst = (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0;
      const ambient = hasModifier(stmt, ts.SyntaxKind.DeclareKeyword);
      for (const decl of stmt.declarationList.declarations) {
        collectBindingNames(decl.name, facts.topBindings);
        if (!ts.isIdentifier(decl.name)) continue;
        facts.topVarCounts.set(decl.name.text, (facts.topVarCounts.get(decl.name.text) ?? 0) + 1);
        if (!isConst || ambient || !decl.initializer) continue;
        if (isFunctionValue(stripWrappers(decl.initializer))) facts.topConstFns.set(decl.name.text, { declaration: decl, statement: stmt });
      }
    } else if (ts.isImportDeclaration(stmt) && stmt.importClause) {
      const clause = stmt.importClause;
      if (clause.name) facts.topBindings.add(clause.name.text);
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) facts.topBindings.add(clause.namedBindings.name.text);
        else for (const el of clause.namedBindings.elements) facts.topBindings.add(el.name.text);
      }
    } else if (ts.isImportEqualsDeclaration(stmt)) {
      facts.topBindings.add(stmt.name.text);
    } else if ((ts.isEnumDeclaration(stmt) || ts.isModuleDeclaration(stmt)) && ts.isIdentifier(stmt.name)) {
      facts.topBindings.add(stmt.name.text);
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const subject = stripWrappers(stmt.expression);
      if (ts.isIdentifier(subject)) facts.exportedIdentifiers.add(subject.text);
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) facts.exportedIdentifiers.add((el.propertyName ?? el.name).text);
    }
  }
  if (!deep) return facts;

  const noteObjectWrite = (target: ts.Expression, source: ts.Expression | undefined): void => {
    const key = ownerKey(target);
    if (!key) return;
    const value = source ? stripWrappers(source) : undefined;
    if (value && ts.isObjectLiteralExpression(value)) {
      const { keys, open } = literalKeys(value);
      for (const k of keys) bump(facts.propWrites, key, k);
      if (open) facts.openWrites.add(key);
    } else {
      facts.openWrites.add(key);
    }
  };
  const noteIdentWrite = (name: string): void => {
    facts.identWrites.set(name, (facts.identWrites.get(name) ?? 0) + 1);
  };
  // Every identifier a destructuring target writes: `[a, { b, c: d }] = …`, `for ({ a } of …)`.
  const noteTargetWrites = (target: ts.Node): void => {
    if (ts.isIdentifier(target)) noteIdentWrite(target.text);
    else if (isModuleExports(target)) facts.moduleExportsOtherWrites++;
    else if (ts.isArrayLiteralExpression(target)) target.elements.forEach(noteTargetWrites);
    else if (ts.isSpreadElement(target) || ts.isSpreadAssignment(target) || ts.isParenthesizedExpression(target)) noteTargetWrites(target.expression);
    else if (ts.isBinaryExpression(target) && target.operatorToken.kind === ts.SyntaxKind.EqualsToken) noteTargetWrites(target.left); // a default
    else if (ts.isObjectLiteralExpression(target)) {
      for (const p of target.properties) {
        if (ts.isShorthandPropertyAssignment(p)) noteIdentWrite(p.name.text);
        else if (ts.isPropertyAssignment(p)) noteTargetWrites(p.initializer);
        else if (ts.isSpreadAssignment(p)) noteTargetWrites(p.expression);
      }
    }
  };
  const visit = (node: ts.Node, topLevel: boolean, inFunction = false): void => {
    // A `var` outside any function is the module's binding wherever it is written: a
    // second `var X` in a branch or a loop header re-declares (and may re-bind) X.
    if (ts.isVariableDeclarationList(node) && !inFunction && (node.flags & (ts.NodeFlags.Let | ts.NodeFlags.Const)) === 0) {
      for (const decl of node.declarations) {
        if (ts.isIdentifier(decl.name)) facts.topVarCounts.set(decl.name.text, (facts.topVarCounts.get(decl.name.text) ?? 0) + 1);
      }
    }
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) {
      noteTargetWrites(node.initializer);
    }
    if (ts.isDeleteExpression(node)) {
      // `delete X.name` unmakes the member: count it as another write, so the name is no longer defined once.
      const operand = stripParens(node.expression);
      if (ts.isPropertyAccessExpression(operand) && ts.isIdentifier(operand.name)) {
        const key = ownerKey(operand.expression);
        if (key) bump(facts.propWrites, key, operand.name.text);
      } else if (ts.isElementAccessExpression(operand)) {
        const key = ownerKey(operand.expression);
        if (key) {
          if (ts.isStringLiteralLike(operand.argumentExpression)) bump(facts.propWrites, key, operand.argumentExpression.text);
          else facts.openWrites.add(key);
        }
      }
    }
    if (ts.isBinaryExpression(node) && ASSIGNMENT_OPERATORS.has(node.operatorToken.kind)) {
      const left = node.left;
      if (ts.isIdentifier(left)) {
        noteIdentWrite(left.text);
      } else if (ts.isArrayLiteralExpression(left) || ts.isObjectLiteralExpression(left)) {
        noteTargetWrites(left);
      } else if (isModuleExports(left)) {
        if (node.operatorToken.kind === ts.SyntaxKind.EqualsToken) facts.moduleExportsWrites.push(node);
        else facts.moduleExportsOtherWrites++;
        const { value } = assignmentChain(node);
        if (ts.isIdentifier(value)) facts.exportedIdentifiers.add(value.text);
      } else if (ts.isPropertyAccessExpression(left)) {
        const key = ownerKey(left.expression);
        if (key && ts.isIdentifier(left.name)) {
          bump(facts.propWrites, key, left.name.text);
          const proto = prototypeOwner(left.expression);
          if (proto && !facts.firstMemberWrite.has(proto)) facts.firstMemberWrite.set(proto, node.getStart(sf));
        }
        const proto = prototypeOwner(left);
        if (proto) facts.prototypeWrites.push({ owner: proto, node, value: assignmentChain(node).value });
        if ((isExportsIdentifier(left.expression) || isModuleExports(left.expression)) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
          const { value } = assignmentChain(node);
          if (ts.isIdentifier(value)) facts.exportedIdentifiers.add(value.text);
        }
      } else if (ts.isElementAccessExpression(left)) {
        const key = ownerKey(left.expression);
        const arg = left.argumentExpression;
        // A run-time key (`X[name] = …`) is disclosed as computed, not counted as a write to every name.
        if (key && arg && (ts.isStringLiteral(arg) || ts.isNoSubstitutionTemplateLiteral(arg))) bump(facts.propWrites, key, arg.text);
      }
    } else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) &&
      ts.isIdentifier(node.operand)
    ) {
      facts.identWrites.set(node.operand.text, (facts.identWrites.get(node.operand.text) ?? 0) + 1);
    } else if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "Object"
    ) {
      const method = node.expression.name.text;
      const [target, second] = node.arguments;
      if (target && method === "assign") {
        for (const source of node.arguments.slice(1)) noteObjectWrite(target, source);
        const proto = prototypeOwner(target);
        if (proto && topLevel) facts.prototypeAssigns.push({ owner: proto, node });
      } else if (target && method === "defineProperties") {
        noteObjectWrite(target, second);
      } else if (target && method === "defineProperty") {
        const key = ownerKey(target);
        if (key) {
          if (second && (ts.isStringLiteral(second) || ts.isNoSubstitutionTemplateLiteral(second))) bump(facts.propWrites, key, second.text);
          else facts.openWrites.add(key);
        }
      }
    }
    const nested =
      inFunction ||
      ts.isFunctionDeclaration(node) ||
      ts.isFunctionExpression(node) ||
      ts.isArrowFunction(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isConstructorDeclaration(node) ||
      ts.isGetAccessorDeclaration(node) ||
      ts.isSetAccessorDeclaration(node);
    ts.forEachChild(node, (child) => visit(child, false, nested));
  };
  for (const stmt of sf.statements) {
    // An expression statement's own expression is still "top level" for disclosure purposes.
    if (ts.isExpressionStatement(stmt)) visit(stmt.expression, true);
    else if (ts.isVariableStatement(stmt)) {
      // Its own declarations were counted above; look inside the initializers only.
      for (const decl of stmt.declarationList.declarations) if (decl.initializer) visit(decl.initializer, false);
    } else visit(stmt, false);
  }
  return facts;
}

interface ExportedObject {
  name: string;
  binding: "object_literal" | "object_create";
  /** `exports` is chained to the same object, so `exports.name = …` writes to it. */
  exportsChained: boolean;
  /** The object literal the variable is initialised with, when it is also the way-4 literal. */
  literal?: ts.ObjectLiteralExpression;
}

/** Cheap text gate: only CommonJS / prototype shapes need the whole-tree scan. */
const DEEP_SCAN_RE = /module\s*\.\s*exports|\bexports\s*[.=[]|\.\s*prototype\b/;

/**
 * Find the five export shapes in one parsed file. `existing` is what the
 * declaration-based rules already emit for this file (union of both grammar
 * passes): it decides whether a prototype owner is exported.
 */
export function findExportShapes(sf: ts.SourceFile, existing: ReadonlyMap<string, ExistingSymbol>): ExportShapeResult {
  const deep = DEEP_SCAN_RE.test(sf.text);
  const facts = collectFacts(sf, deep);
  const shapes: ExportShape[] = [];
  const notSupported: NotSupportedEntry[] = [];
  const lineOf = (pos: number): number => sf.getLineAndCharacterOfPosition(pos).line + 1;
  const report = (code: NotSupportedCode, node: ts.Node, owner?: string, name?: string): void => {
    notSupported.push({
      code,
      ...(owner ? { owner } : {}),
      ...(name ? { name } : {}),
      start_line: lineOf(node.getStart(sf)),
      end_line: lineOf(node.getEnd())
    });
  };
  const writes = (owner: string, prop: string): number => facts.propWrites.get(owner)?.get(prop) ?? 0;

  type LocalRef =
    | { kind: "function"; node: ts.FunctionDeclaration; anchor: ts.Node; declaration: ts.Node }
    | { kind: "class"; node: ts.ClassDeclaration; anchor: ts.Node; declaration: ts.Node }
    | { kind: "const"; node: ts.FunctionExpression | ts.ArrowFunction; anchor: ts.Node; declaration: ts.Node };
  const localRef = (name: string): LocalRef | null => {
    const fn = facts.topFunctions.get(name);
    if (fn) return { kind: "function", node: fn, anchor: fn, declaration: fn };
    const cls = facts.topClasses.get(name);
    if (cls) return { kind: "class", node: cls, anchor: cls, declaration: cls };
    const c = facts.topConstFns.get(name);
    if (c && c.declaration.initializer) {
      const init = stripWrappers(c.declaration.initializer);
      if (isFunctionValue(init)) return { kind: "const", node: init, anchor: c.statement, declaration: c.declaration };
    }
    return null;
  };
  const byName = new Map<string, ExportShape>();
  const addReference = (seenBy: SeenBy, form: ShapeForm, local: string, exported: string, ref: LocalRef): void => {
    const prior = byName.get(local);
    if (prior) {
      if (exported !== local && !prior.aliases.includes(exported)) prior.aliases.push(exported);
      if (exported === local) prior.ownNameExported = true;
      return;
    }
    const shape: ExportShape = {
      seenBy,
      form,
      name: local,
      kind: ref.kind,
      aliases: exported !== local ? [exported] : [],
      node: ref.node,
      anchor: ref.anchor,
      declaration: ref.declaration,
      ownNameExported: exported === local
    };
    byName.set(local, shape);
    shapes.push(shape);
  };

  // owner_kind: a function attached to an EXPORTED owner that the member rules
  // cannot judge — a function, a class, a wrapped const, or a variable bound to
  // a call result. `judged` owners are object variables the member rule handles.
  const reportOwnerKinds = (judged: (owner: string) => boolean, exportedByAssignment: (owner: string) => boolean): void => {
    for (const stmt of sf.statements) {
      if (!ts.isExpressionStatement(stmt)) continue;
      const expr = stripParens(stmt.expression);
      if (!isPlainAssignment(expr)) continue;
      const { targets, value } = assignmentChain(expr);
      const first = targets[0];
      if (!first || !isFunctionValue(value) || !ts.isPropertyAccessExpression(first) || !ts.isIdentifier(first.expression)) continue;
      const owner = first.expression.text;
      if (owner === "exports" || owner === "module" || judged(owner)) continue;
      const sameOwner = targets.every(
        (t) => ts.isPropertyAccessExpression(t) && ts.isIdentifier(t.expression) && t.expression.text === owner && ts.isIdentifier(t.name)
      );
      if (!sameOwner) continue;
      if (existing.has(owner) || byName.has(owner) || exportedByAssignment(owner)) report("owner_kind", stmt, owner, first.name.text);
    }
  };
  const finish = (): ExportShapeResult => {
    shapes.sort((a, b) => a.node.getStart(sf) - b.node.getStart(sf) || a.name.localeCompare(b.name));
    notSupported.sort((a, b) => a.start_line - b.start_line || a.code.localeCompare(b.code));
    return { shapes, notSupported };
  };

  // ---- way 1: export list -------------------------------------------------
  for (const stmt of sf.statements) {
    if (!ts.isExportDeclaration(stmt) || stmt.moduleSpecifier || stmt.isTypeOnly) continue;
    if (!stmt.exportClause || !ts.isNamedExports(stmt.exportClause)) continue;
    for (const el of stmt.exportClause.elements) {
      if (el.isTypeOnly) continue;
      const local = (el.propertyName ?? el.name).text;
      const ref = localRef(local);
      if (ref) addReference("export_list", "export_list", local, el.name.text, ref);
    }
  }

  // ---- way 5: unnamed default export --------------------------------------
  for (const stmt of sf.statements) {
    let fn: FunctionLikeNode | null = null;
    if (ts.isFunctionDeclaration(stmt) && !stmt.name && stmt.body && hasModifier(stmt, ts.SyntaxKind.DefaultKeyword)) fn = stmt;
    else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      const subject = stripParens(stmt.expression);
      if (isFunctionValue(subject)) fn = subject;
    }
    if (!fn || byName.has("default")) continue;
    const shape: ExportShape = { seenBy: "unnamed_default_export", form: "unnamed_default", name: "default", kind: "function", aliases: [], node: fn, anchor: stmt };
    byName.set("default", shape);
    shapes.push(shape);
  }

  if (!deep) {
    reportOwnerKinds(() => false, () => false);
    return finish();
  }

  // ---- the file's one export statement (ways 3 and 4) ----------------------
  let exported: ExportedObject | null = null;
  let exportLiteral: ts.ObjectLiteralExpression | null = null;
  let exportLiteralExportsChained = false;
  const objectVars = new Map<string, { binding: ExportedObject["binding"]; chained: boolean; exportsChained: boolean; literal?: ts.ObjectLiteralExpression }>();
  const otherVars = new Set<string>();
  /** `var X = module.exports = <not an object the member rule accepts>`. */
  const chainedOtherVars = new Set<string>();
  for (const stmt of sf.statements) {
    if (!ts.isVariableStatement(stmt)) continue;
    for (const decl of stmt.declarationList.declarations) {
      if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
      const name = decl.name.text;
      const { targets, value } = assignmentChain(decl.initializer);
      const viaExports = targets.every((t) => isModuleExports(t) || isExportsIdentifier(t));
      const binding = ts.isObjectLiteralExpression(value) ? "object_literal" : isObjectCreateCall(value) ? "object_create" : null;
      if (binding && viaExports && name !== "exports" && name !== "module") {
        objectVars.set(name, {
          binding,
          chained: targets.some(isModuleExports),
          exportsChained: targets.some(isExportsIdentifier),
          ...(ts.isObjectLiteralExpression(value) ? { literal: value } : {})
        });
      } else {
        otherVars.add(name);
        if (targets.some(isModuleExports)) chainedOtherVars.add(name);
      }
    }
  }
  const singleExportWrite = facts.moduleExportsWrites.length === 1 && facts.moduleExportsOtherWrites === 0 ? facts.moduleExportsWrites[0] : null;
  if (singleExportWrite) {
    const { targets, value } = assignmentChain(singleExportWrite);
    const exportsChainedHere = targets.some(isExportsIdentifier);
    // Is the write a top-level statement (or the initializer chain of a top-level variable)?
    let topLevelWrite = false;
    let owningVar: string | null = null;
    for (const stmt of sf.statements) {
      if (ts.isExpressionStatement(stmt) && stripParens(stmt.expression) === singleExportWrite) topLevelWrite = true;
      else if (ts.isVariableStatement(stmt)) {
        for (const decl of stmt.declarationList.declarations) {
          if (!decl.initializer || !ts.isIdentifier(decl.name)) continue;
          let cur = stripParens(decl.initializer);
          while (isPlainAssignment(cur)) {
            if (cur === singleExportWrite) {
              topLevelWrite = true;
              owningVar = decl.name.text;
            }
            cur = stripParens(cur.right);
          }
        }
      }
    }
    // `exports = module.exports = {…}`: the write is the inner link of a top-level chain.
    if (!topLevelWrite) {
      for (const stmt of sf.statements) {
        if (!ts.isExpressionStatement(stmt)) continue;
        let cur = stripParens(stmt.expression);
        while (isPlainAssignment(cur)) {
          if (cur === singleExportWrite) topLevelWrite = true;
          cur = stripParens(cur.right);
        }
      }
    }
    if (topLevelWrite) {
      const outerExportsChained = exportsChainedHere || sf.statements.some((stmt) => {
        if (!ts.isExpressionStatement(stmt)) return false;
        let cur = stripParens(stmt.expression);
        let sawExports = false;
        while (isPlainAssignment(cur)) {
          if (isExportsIdentifier(cur.left)) sawExports = true;
          if (cur === singleExportWrite) return sawExports;
          cur = stripParens(cur.right);
        }
        return false;
      });
      if (ts.isObjectLiteralExpression(value)) {
        exportLiteral = value;
        exportLiteralExportsChained = outerExportsChained;
      }
      const candidate = owningVar ?? (ts.isIdentifier(value) ? value.text : null);
      const info = candidate ? objectVars.get(candidate) : undefined;
      if (
        candidate &&
        info &&
        (owningVar ? info.chained : !info.chained) &&
        facts.topVarCounts.get(candidate) === 1 &&
        !facts.topFunctions.has(candidate) &&
        !facts.topClasses.has(candidate) &&
        (facts.identWrites.get(candidate) ?? 0) === 0
      ) {
        exported = {
          name: candidate,
          binding: info.binding,
          exportsChained: owningVar ? info.exportsChained || outerExportsChained : outerExportsChained,
          ...(info.literal ? { literal: info.literal } : {})
        };
      }
    }
  }

  // Owner keys that all name the exported object.
  const exportOwnerKeys = (withVar: boolean): string[] => {
    const keys = ["module.exports"];
    if (exported ? exported.exportsChained : exportLiteralExportsChained) keys.push("exports");
    if (withVar && exported) keys.push(exported.name);
    return keys;
  };
  const exportWrites = (prop: string): number => exportOwnerKeys(true).reduce((sum, key) => sum + writes(key, prop), 0);
  const exportOpen = (): boolean => exportOwnerKeys(true).some((key) => facts.openWrites.has(key));

  // ---- way 4: object-literal export ---------------------------------------
  if (exportLiteral) {
    const literal = exportLiteral;
    const keyCounts = new Map<string, number>();
    for (const p of literal.properties) {
      const key = !ts.isSpreadAssignment(p) && p.name ? literalKeyName(p.name) : null;
      if (key !== null) keyCounts.set(key, (keyCounts.get(key) ?? 0) + 1);
    }
    let lastSpread = -1;
    literal.properties.forEach((p, i) => {
      if (ts.isSpreadAssignment(p)) {
        lastSpread = i;
        report("spread", p);
      }
    });
    const open = exportOpen();
    literal.properties.forEach((p, index) => {
      if (ts.isSpreadAssignment(p)) return;
      if (ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) {
        report("accessor", p, undefined, literalKeyName(p.name) ?? undefined);
        return;
      }
      const inlineFn: FunctionLikeNode | null = ts.isMethodDeclaration(p)
        ? p
        : ts.isPropertyAssignment(p) && isFunctionValue(stripWrappers(p.initializer))
          ? (stripWrappers(p.initializer) as ts.FunctionExpression | ts.ArrowFunction)
          : null;
      const referenced = ts.isShorthandPropertyAssignment(p)
        ? p.name.text
        : ts.isPropertyAssignment(p) && ts.isIdentifier(stripWrappers(p.initializer))
          ? (stripWrappers(p.initializer) as ts.Identifier).text
          : null;
      const ref = referenced ? localRef(referenced) : null;
      if (!inlineFn && !ref) return; // not a function — a value, a require(), a nested object
      const rawKey = p.name ? literalKeyName(p.name) : null;
      if (rawKey === "__proto__" && !ts.isShorthandPropertyAssignment(p)) return; // sets the prototype; not a property
      const key = rawKey !== null && IDENTIFIER_RE.test(rawKey) && (ts.isIdentifier(p.name!) || ts.isStringLiteral(p.name!)) ? rawKey : null;
      if (key === null) {
        report("computed_or_nested", p);
        return;
      }
      if (index < lastSpread) return; // a later spread can replace it; already disclosed as `spread`
      // The literal itself is the one write; a variable-bound literal is counted under module.exports only.
      const duplicate = (keyCounts.get(key) ?? 0) !== 1 || exportWrites(key) !== 0 || open;
      if (duplicate) {
        report("duplicate_member", p, undefined, key);
        return;
      }
      if (ref && referenced) {
        addReference("object_literal_export", "literal_reference", referenced, key, ref);
        return;
      }
      if (!inlineFn) return;
      if (facts.topBindings.has(key)) {
        report("name_collision", p, undefined, key);
        return;
      }
      if (byName.has(key)) return;
      const shape: ExportShape = { seenBy: "object_literal_export", form: "literal_inline", name: key, kind: "function", aliases: [], node: inlineFn, anchor: p };
      byName.set(key, shape);
      shapes.push(shape);
    });
  }

  // ---- way 3: exported-object method ---------------------------------------
  const literalKeysOfExported = exported?.literal ? new Set(literalKeys(exported.literal).keys) : new Set<string>();
  if (!exported && facts.moduleExportsWrites.length > 1) {
    // More than one `module.exports =`: the exported object cannot be named.
    for (const stmt of sf.statements) {
      if (!ts.isExpressionStatement(stmt) || !isPlainAssignment(stmt.expression)) continue;
      const { targets, value } = assignmentChain(stmt.expression);
      const first = targets[0];
      if (isFunctionValue(value) && first && ts.isPropertyAccessExpression(first) && ts.isIdentifier(first.expression) && objectVars.has(first.expression.text)) {
        report("ambiguous_owner", stmt, first.expression.text);
        break;
      }
    }
  }
  // A function assigned to the exported object anywhere below `root` (not `root` itself).
  const assignsMemberFunctionBelow = (root: ts.Node, exportedName: string): boolean => {
    let found = false;
    const scan = (node: ts.Node): void => {
      if (found) return;
      if (
        isPlainAssignment(node) &&
        (ts.isPropertyAccessExpression(node.left) || ts.isElementAccessExpression(node.left)) &&
        ts.isIdentifier(node.left.expression) &&
        node.left.expression.text === exportedName &&
        isFunctionValue(assignmentChain(node).value)
      ) {
        found = true;
        return;
      }
      ts.forEachChild(node, scan);
    };
    scan(root);
    return found;
  };
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt)) {
      if (exported && assignsMemberFunctionBelow(stmt, exported.name)) report("computed_or_nested", stmt, exported.name);
      continue;
    }
    const expr = stripParens(stmt.expression);

    // helper_defined: a top-level call passing the exported object and a function to a local helper.
    if (exported && ts.isCallExpression(expr) && ts.isIdentifier(expr.expression) && (facts.topFunctions.has(expr.expression.text) || facts.topConstFns.has(expr.expression.text))) {
      const args = expr.arguments.map((a) => stripWrappers(a));
      const exportedName = exported.name;
      if (args.some((a) => ts.isIdentifier(a) && a.text === exportedName) && args.some(isFunctionValue)) {
        const label = args.find((a): a is ts.StringLiteral => ts.isStringLiteral(a));
        report("helper_defined", stmt, exported.name, label?.text);
        continue;
      }
    }

    const { targets, value } = isPlainAssignment(expr) ? assignmentChain(expr) : { targets: [] as ts.Expression[], value: expr };
    const first = targets[0];
    const fnValue = isFunctionValue(value) ? value : null;

    if (first && fnValue && ts.isPropertyAccessExpression(first) && ts.isIdentifier(first.expression)) {
      const owner = first.expression.text;
      const allSameOwner = targets.every(
        (t) => ts.isPropertyAccessExpression(t) && ts.isIdentifier(t.expression) && t.expression.text === owner && ts.isIdentifier(t.name)
      );
      if (exported && owner === exported.name && allSameOwner) {
        const names = targets.map((t) => (t as ts.PropertyAccessExpression).name.text);
        const single = names.every((n) => exportWrites(n) === 1 && !literalKeysOfExported.has(n)) && !exportOpen() && new Set(names).size === names.length;
        if (!single) {
          report("duplicate_member", stmt, owner, names[names.length - 1]);
          continue;
        }
        const own = ts.isFunctionExpression(fnValue) && fnValue.name ? fnValue.name.text : null;
        const primary = own && names.includes(own) ? own : names[names.length - 1];
        const name = `${owner}.${primary}`;
        if (byName.has(name)) continue;
        const shape: ExportShape = {
          seenBy: "exported_object_method",
          form: "member",
          name,
          kind: "method",
          memberOf: owner,
          aliases: names.filter((n) => n !== primary).map((n) => `${owner}.${n}`),
          node: fnValue,
          anchor: stmt,
          ownerBinding: exported.binding,
          targets: names.map((n) => `${owner}.${n}`)
        };
        byName.set(name, shape);
        shapes.push(shape);
        continue;
      }
    }

    // computed_or_nested: `X[expr] = function` at top level, or a function assigned to the
    // exported object inside another statement (a callback, a branch, another function body).
    if (exported) {
      const exportedName = exported.name;
      if (first && fnValue && ts.isElementAccessExpression(first) && ts.isIdentifier(first.expression) && first.expression.text === exportedName) {
        report("computed_or_nested", stmt, exported.name);
        continue;
      }
      // The statement's own top-level chain is not "nested": look below its final value.
      if (assignsMemberFunctionBelow(targets.length > 0 ? value : expr, exportedName)) report("computed_or_nested", stmt, exported.name);
    }
  }

  // unnamed_export: `module.exports = function () {…}` with no name.
  for (const write of facts.moduleExportsWrites) {
    const { value } = assignmentChain(write);
    if ((ts.isFunctionExpression(value) && !value.name) || ts.isArrowFunction(value)) report("unnamed_export", write);
  }

  // ---- way 2: prototype method ---------------------------------------------
  const ownerSeen = (owner: string): ExportShape["ownerBinding"] | null => {
    // The symbol named `owner` must BE the file's top-level function, class or const
    // function: `var F = require("events"); exports.F = function () {}` has a symbol
    // `F`, but `F.prototype.x = …` patches the imported class.
    if (!facts.topFunctions.has(owner) && !facts.topClasses.has(owner) && !facts.topConstFns.has(owner)) return null;
    const old = existing.get(owner);
    if (old) {
      if (old.kind === "function") return "function";
      if (old.kind === "class") return "class";
      if (old.kind === "const" && old.callable) return "const";
    }
    const fresh = byName.get(owner);
    if (fresh && (fresh.form === "export_list" || fresh.form === "literal_reference")) {
      return fresh.kind === "class" ? "class" : fresh.kind === "const" ? "const" : "function";
    }
    return null;
  };
  const prototypeOpen = (owner: string): boolean => {
    if (facts.openWrites.has(`${owner}#prototype`)) return true;
    const firstMember = facts.firstMemberWrite.get(owner);
    return facts.prototypeWrites.some((w) => w.owner === owner && firstMember !== undefined && w.node.getStart(sf) > firstMember);
  };
  const prototypeLiteralKeys = (owner: string): string[] =>
    facts.prototypeWrites
      .filter((w) => w.owner === owner)
      .flatMap((w) => {
        const v = stripWrappers(w.value);
        return ts.isObjectLiteralExpression(v) ? literalKeys(v).keys : [];
      });
  for (const stmt of sf.statements) {
    if (!ts.isExpressionStatement(stmt)) continue;
    const expr = stripParens(stmt.expression);
    if (!isPlainAssignment(expr)) continue;
    const { targets, value } = assignmentChain(expr);
    const first = targets[0];
    if (!first || !isFunctionValue(value) || !ts.isPropertyAccessExpression(first)) continue;
    const owner = prototypeOwner(first.expression);
    if (!owner) continue;
    const sameOwner = targets.every((t) => ts.isPropertyAccessExpression(t) && prototypeOwner(t.expression) === owner && ts.isIdentifier(t.name));
    if (!sameOwner) continue;
    const names = targets.map((t) => (t as ts.PropertyAccessExpression).name.text);
    const binding = ownerSeen(owner);
    if (!binding) {
      if (facts.exportedIdentifiers.has(owner)) report("owner_not_seen", stmt, owner, names[names.length - 1]);
      continue;
    }
    const literalDefined = prototypeLiteralKeys(owner);
    const single =
      !prototypeOpen(owner) &&
      new Set(names).size === names.length &&
      names.every(
        (n) => writes(`${owner}#prototype`, n) === 1 && !(facts.classMemberNames.get(owner)?.has(n) ?? false) && !literalDefined.includes(n)
      );
    const own = ts.isFunctionExpression(value) && value.name ? value.name.text : null;
    const primary = own && names.includes(own) ? own : names[names.length - 1];
    const name = `${owner}.${primary}`;
    if (!single || existing.has(name) || byName.has(name)) {
      report("duplicate_member", stmt, owner, primary);
      continue;
    }
    const shape: ExportShape = {
      seenBy: "prototype_method",
      form: "prototype",
      name,
      kind: "method",
      memberOf: owner,
      aliases: names.filter((n) => n !== primary).map((n) => `${owner}.${n}`),
      node: value,
      anchor: stmt,
      ownerBinding: binding,
      targets: names.map((n) => `${owner}.prototype.${n}`)
    };
    byName.set(name, shape);
    shapes.push(shape);
  }
  // prototype_object: the prototype is set or extended as one object.
  for (const w of facts.prototypeWrites) {
    const v = stripWrappers(w.value);
    if (!ts.isObjectLiteralExpression(v) || !literalHasFunction(v)) continue;
    if (ownerSeen(w.owner) || facts.exportedIdentifiers.has(w.owner)) report("prototype_object", w.node, w.owner);
  }
  for (const a of facts.prototypeAssigns) {
    const hasFunctions = a.node.arguments.slice(1).some((s) => {
      const v = stripWrappers(s);
      return ts.isObjectLiteralExpression(v) && literalHasFunction(v);
    });
    if (hasFunctions && (ownerSeen(a.owner) || facts.exportedIdentifiers.has(a.owner))) report("prototype_object", a.node, a.owner);
  }

  const exportedIdentifier = singleExportWrite ? assignmentChain(singleExportWrite).value : null;
  reportOwnerKinds(
    (owner) => objectVars.has(owner),
    (owner) =>
      chainedOtherVars.has(owner) ||
      (exportedIdentifier !== null &&
        ts.isIdentifier(exportedIdentifier) &&
        exportedIdentifier.text === owner &&
        (otherVars.has(owner) || facts.topFunctions.has(owner) || facts.topClasses.has(owner)))
  );
  return finish();
}

// ---- traits: documented private, trivial body ------------------------------

const PRIVATE_TAG_RE = /^@(?:private|access\s+private|api\s+private|internal)(?:\s|$)/;

/**
 * True when the LAST `/** … *\/` block before `anchor` marks it private. Blank
 * lines in between are allowed; `//` and `/* *\/` comments are ignored. A tag
 * counts only at the start of a line (so `@privateRemarks` and a tag quoted in
 * running text do not).
 */
export function isDocumentedPrivate(sf: ts.SourceFile, anchor: ts.Node): boolean {
  // A comment on the same line as the previous token (`{ /** @private */ run() {} }`) is
  // "trailing" to TypeScript; it still sits between that token and this definition.
  const fullStart = anchor.getFullStart();
  const ranges = [...(ts.getTrailingCommentRanges(sf.text, fullStart) ?? []), ...(ts.getLeadingCommentRanges(sf.text, fullStart) ?? [])]
    .filter((range, index, all) => all.findIndex((other) => other.pos === range.pos) === index)
    .sort((a, b) => a.pos - b.pos);
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    const text = sf.text.slice(r.pos, r.end);
    if (r.kind !== ts.SyntaxKind.MultiLineCommentTrivia || !text.startsWith("/**") || text.startsWith("/***")) continue;
    const body = text.slice(3, text.endsWith("*/") ? -2 : undefined);
    return body.split(/\r?\n/).some((line) => PRIVATE_TAG_RE.test(line.replace(/^[\s*]+/, "")));
  }
  return false;
}

function isStoredValue(e: ts.Expression): boolean {
  let cur = stripWrappers(e);
  if (cur.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(cur)) return true;
  while (ts.isPropertyAccessExpression(cur)) {
    if (!ts.isIdentifier(cur.name)) return false;
    cur = stripWrappers(cur.expression);
  }
  return cur.kind === ts.SyntaxKind.ThisKeyword || ts.isIdentifier(cur);
}

/**
 * Body-only judgement of a function that merely moves a value: empty, returns a
 * stored value, stores a parameter, or passes its own parameters straight on.
 * Anything that computes, compares, decides, adds a fixed value or reorders
 * arguments is NOT trivial. `topFunctionNames` are the file's top-level function
 * bindings: a free pass-through is reported only when its callee is one of them
 * (whether that callee is itself counted is the analyzer's decision).
 */
export function bodyTraits(fn: FunctionLikeNode, topFunctionNames: ReadonlySet<string>): Pick<FunctionTraits, "trivial_body" | "pass_through"> {
  if (!fn.body) return {};
  // Calling a generator runs none of its body: it is never "just passing a value on".
  if (!ts.isArrowFunction(fn) && fn.asteriskToken) return {};
  // Nothing to observe, whatever the parameters look like.
  if (ts.isBlock(fn.body) && fn.body.statements.length === 0) return { trivial_body: "empty" };
  const params: string[] = [];
  for (const p of fn.parameters) {
    // A default, destructured or rest parameter is already a decision about the input.
    if (!ts.isIdentifier(p.name) || p.initializer || p.dotDotDotToken) return {};
    if (p.name.text === "this") continue; // TS `this` parameter annotation
    params.push(p.name.text);
  }
  let returned: ts.Expression | undefined;
  if (ts.isBlock(fn.body)) {
    const statements = fn.body.statements;
    const firstStatement = statements[0];
    if (statements.length <= 2 && ts.isExpressionStatement(firstStatement)) {
      const e = stripWrappers(firstStatement.expression);
      const second = statements[1];
      const returnsThis =
        !second || (ts.isReturnStatement(second) && !!second.expression && stripWrappers(second.expression).kind === ts.SyntaxKind.ThisKeyword);
      if (isPlainAssignment(e) && returnsThis && ts.isPropertyAccessExpression(e.left) && isStoredValue(e.left)) {
        const right = stripWrappers(e.right);
        if (ts.isIdentifier(right) && params.includes(right.text)) return { trivial_body: "stores_parameter" };
      }
      return {};
    }
    if (statements.length !== 1 || !ts.isReturnStatement(firstStatement)) return {};
    if (!firstStatement.expression) return { trivial_body: "stored_value" };
    returned = firstStatement.expression;
  } else {
    returned = fn.body;
  }
  let value = stripWrappers(returned);
  if (isStoredValue(value)) return { trivial_body: "stored_value" };
  if (ts.isAwaitExpression(value)) value = stripWrappers(value.expression);
  if (!ts.isCallExpression(value) || value.questionDotToken) return {};
  const args = value.arguments.map((a) => stripWrappers(a));
  if (args.length !== params.length || !args.every((a, i) => ts.isIdentifier(a) && a.text === params[i])) return {};
  const callee = stripWrappers(value.expression);
  if (ts.isIdentifier(callee)) {
    // A callee that is one of the parameters is the caller's function, not a file-level one.
    if (params.includes(callee.text) || !topFunctionNames.has(callee.text)) return {};
    return { pass_through: { via: "free", callee: callee.text } };
  }
  if (
    ts.isPropertyAccessExpression(callee) &&
    callee.expression.kind === ts.SyntaxKind.ThisKeyword &&
    ts.isIdentifier(callee.name) &&
    !ts.isArrowFunction(fn) // an arrow has no `this` of its own
  ) {
    return { pass_through: { via: "this", callee: callee.name.text } };
  }
  return {};
}

/** Names of the file's top-level function bindings (declarations and `const f = fn`). */
export function topFunctionBindings(sf: ts.SourceFile): Set<string> {
  const out = new Set<string>();
  for (const stmt of sf.statements) {
    if (ts.isFunctionDeclaration(stmt) && stmt.name && stmt.body) out.add(stmt.name.text);
    else if (ts.isVariableStatement(stmt) && (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0) {
      for (const decl of stmt.declarationList.declarations) {
        if (ts.isIdentifier(decl.name) && decl.initializer && isFunctionValue(stripWrappers(decl.initializer))) out.add(decl.name.text);
      }
    }
  }
  return out;
}

/** Parse errors the parser itself recorded (syntax only; no type checking). */
export function parseErrorCount(sf: ts.SourceFile): number {
  return (sf as unknown as { parseDiagnostics?: readonly unknown[] }).parseDiagnostics?.length ?? 0;
}
