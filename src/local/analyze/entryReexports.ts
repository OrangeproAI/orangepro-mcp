import ts from "typescript";

// How a package's public entry file hands other files out through CommonJS
// property writes: `exports.name = require("./x")`. Only the spellings that can
// be read from syntax without guessing are followed; the others are returned so
// the analysis can disclose a re-export it did not follow (a private file and
// an unfollowed re-export must not look the same).

export interface EntryReexports {
  /** Relative module paths written as `exports.name = require("./x")` (directly, or through a variable bound once to it). */
  followed: string[];
  /** Relative re-exports made in a spelling that is not followed. */
  notFollowed: Array<{ path: string; line: number }>;
}

function stripParens(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur)) cur = cur.expression;
  return cur;
}

function isModuleExports(n: ts.Node): boolean {
  return ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "module" && n.name.text === "exports";
}

function isExportsIdentifier(n: ts.Node): boolean {
  return ts.isIdentifier(n) && n.text === "exports";
}

/** `require("<relative>")` exactly → the path, else null. */
function relativeRequire(e: ts.Expression): string | null {
  const cur = stripParens(e);
  if (!ts.isCallExpression(cur) || !ts.isIdentifier(cur.expression) || cur.expression.text !== "require" || cur.arguments.length !== 1) return null;
  const [arg] = cur.arguments;
  return ts.isStringLiteral(arg) && arg.text.startsWith(".") ? arg.text : null;
}

function chain(expr: ts.Expression): { targets: ts.Expression[]; value: ts.Expression } {
  const targets: ts.Expression[] = [];
  let cur = stripParens(expr);
  while (ts.isBinaryExpression(cur) && cur.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
    targets.push(cur.left);
    cur = stripParens(cur.right);
  }
  return { targets, value: cur };
}

function bindingNames(name: ts.BindingName, out: Set<string>): void {
  if (ts.isIdentifier(name)) out.add(name.text);
  else for (const el of name.elements) if (ts.isBindingElement(el)) bindingNames(el.name, out);
}

type FnLike = ts.FunctionDeclaration | ts.FunctionExpression | ts.ArrowFunction | ts.MethodDeclaration | ts.ConstructorDeclaration | ts.AccessorDeclaration;

function isFnLike(n: ts.Node): n is FnLike {
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

/** Names a function binds itself: parameters and declarations in its body (not in nested functions). */
function ownBindings(fn: FnLike): Set<string> {
  const out = new Set<string>();
  for (const p of fn.parameters) bindingNames(p.name, out);
  const visit = (node: ts.Node): void => {
    ts.forEachChild(node, (child) => {
      if (isFnLike(child)) {
        if (ts.isFunctionDeclaration(child) && child.name) out.add(child.name.text);
        return;
      }
      if (ts.isVariableDeclaration(child)) bindingNames(child.name, out);
      if (ts.isCatchClause(child) && child.variableDeclaration) bindingNames(child.variableDeclaration.name, out);
      visit(child);
    });
  };
  if (fn.body) visit(fn.body);
  return out;
}

/** Module-level names that are assigned somewhere (a same-named parameter or inner local is not a write). */
function assignedModuleNames(source: ts.SourceFile): Set<string> {
  const assigned = new Set<string>();
  const visit = (node: ts.Node, shadowed: ReadonlySet<string>): void => {
    let scope = shadowed;
    if (isFnLike(node)) {
      const own = ownBindings(node);
      if (own.size > 0) scope = new Set([...shadowed, ...own]);
    }
    let written: ts.Expression | null = null;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) written = node.left;
    else if (
      (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) &&
      (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)
    ) {
      written = node.operand;
    }
    if (written && ts.isIdentifier(written) && !scope.has(written.text)) assigned.add(written.text);
    ts.forEachChild(node, (child) => visit(child, scope));
  };
  visit(source, new Set());
  return assigned;
}

export function entryFileReexports(source: ts.SourceFile): EntryReexports {
  const lineOf = (node: ts.Node): number => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  // Top-level variables bound to exactly `require("<relative>")`.
  const declCounts = new Map<string, number>();
  const requireVars = new Map<string, string>();
  const otherTopNames = new Set<string>();
  const importedFrom = new Map<string, string>();
  for (const stmt of source.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue;
        declCounts.set(decl.name.text, (declCounts.get(decl.name.text) ?? 0) + 1);
        const required = decl.initializer ? relativeRequire(decl.initializer) : null;
        if (required) requireVars.set(decl.name.text, required);
      }
    } else if ((ts.isFunctionDeclaration(stmt) || ts.isClassDeclaration(stmt)) && stmt.name) {
      otherTopNames.add(stmt.name.text);
    } else if (
      ts.isImportDeclaration(stmt) &&
      stmt.importClause &&
      !stmt.importClause.isTypeOnly && // `import type { T }` hands no file out
      ts.isStringLiteral(stmt.moduleSpecifier) &&
      stmt.moduleSpecifier.text.startsWith(".")
    ) {
      const clause = stmt.importClause;
      if (clause.name) importedFrom.set(clause.name.text, stmt.moduleSpecifier.text);
      if (clause.namedBindings) {
        if (ts.isNamespaceImport(clause.namedBindings)) importedFrom.set(clause.namedBindings.name.text, stmt.moduleSpecifier.text);
        else for (const el of clause.namedBindings.elements) if (!el.isTypeOnly) importedFrom.set(el.name.text, stmt.moduleSpecifier.text);
      }
    }
  }
  const assigned = requireVars.size > 0 ? assignedModuleNames(source) : new Set<string>();
  // "Bound once": one top-level declaration with that initializer, never assigned.
  const boundOnce = (name: string): string | null => {
    const required = requireVars.get(name);
    if (!required || declCounts.get(name) !== 1 || otherTopNames.has(name) || assigned.has(name)) return null;
    return required;
  };
  const handedOut = (value: ts.Expression): string | null => relativeRequire(value) ?? (ts.isIdentifier(value) ? boundOnce(value.text) : null);

  // `exports.name = …` reaches the exported object only while `exports` still
  // names it: `module.exports = other` detaches every earlier and later write
  // through `exports`, unless the same statement re-binds `exports` too.
  // Local names of the exported object: `var kit = module.exports = {}`, `var kit = module.exports`,
  // or a top-level `module.exports = kit`.
  const exportedLocals = new Set<string>();
  for (const stmt of source.statements) {
    if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name) || !decl.initializer) continue;
        const { targets, value } = chain(decl.initializer);
        if (targets.some(isModuleExports) || isModuleExports(value) || isExportsIdentifier(value)) exportedLocals.add(decl.name.text);
      }
    } else if (ts.isExpressionStatement(stmt)) {
      const { targets, value } = chain(stmt.expression);
      if (targets.some(isModuleExports) && ts.isIdentifier(value)) exportedLocals.add(value.text);
    }
  }
  let generation = 0;
  let exportsGeneration = 0;
  const writes: Array<{ generation: number; path: string }> = [];
  const notFollowed: Array<{ path: string; line: number }> = [];
  const applyChain = (expr: ts.Expression, node: ts.Node): void => {
    const { targets, value } = chain(expr);
    if (targets.length === 0) return;
    if (targets.some(isModuleExports)) {
      generation++;
      if (targets.some(isExportsIdentifier)) exportsGeneration = generation;
      if (ts.isObjectLiteralExpression(value)) {
        for (const p of value.properties) {
          const init = ts.isPropertyAssignment(p) ? stripParens(p.initializer) : ts.isShorthandPropertyAssignment(p) ? p.name : null;
          const path = init ? handedOut(init) : null;
          if (path) notFollowed.push({ path, line: lineOf(p) });
        }
      } else if (ts.isPropertyAccessExpression(value)) {
        // `module.exports = require("./x").part`
        const inner = relativeRequire(value.expression);
        if (inner) notFollowed.push({ path: inner, line: lineOf(node) });
      }
      return;
    }
    if (targets.some(isExportsIdentifier)) {
      exportsGeneration = -1; // `exports = other`: no longer the exported object
      return;
    }
    for (const target of targets) {
      if (!ts.isPropertyAccessExpression(target)) continue;
      const onExports = isExportsIdentifier(target.expression);
      const onModuleExports = isModuleExports(target.expression);
      const path = handedOut(value);
      if (onExports || onModuleExports) {
        if (path) writes.push({ generation: onExports ? exportsGeneration : generation, path });
        else if (ts.isPropertyAccessExpression(value)) {
          const inner = relativeRequire(value.expression);
          if (inner) notFollowed.push({ path: inner, line: lineOf(node) });
        }
      } else if (path && ts.isIdentifier(target.expression) && exportedLocals.has(target.expression.text)) {
        notFollowed.push({ path, line: lineOf(node) }); // a write on a local alias of the export
      }
    }
  };
  for (const stmt of source.statements) {
    if (ts.isExpressionStatement(stmt)) applyChain(stmt.expression, stmt);
    else if (ts.isVariableStatement(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!decl.initializer) continue;
        applyChain(decl.initializer, stmt);
        // `var exports = module.exports = {}` (or `= module.exports`): the declared `exports` IS the exported object.
        const { targets, value } = chain(decl.initializer);
        if (ts.isIdentifier(decl.name) && decl.name.text === "exports" && (targets.some(isModuleExports) || isModuleExports(value))) exportsGeneration = generation;
      }
    } else if (ts.isExportDeclaration(stmt) && !stmt.moduleSpecifier && !stmt.isTypeOnly && stmt.exportClause && ts.isNamedExports(stmt.exportClause)) {
      for (const el of stmt.exportClause.elements) {
        if (el.isTypeOnly) continue;
        const from = importedFrom.get((el.propertyName ?? el.name).text);
        if (from) notFollowed.push({ path: from, line: lineOf(el) });
      }
    } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
      // `import z from "./x"; export default z`
      const subject = stripParens(stmt.expression);
      const from = ts.isIdentifier(subject) ? importedFrom.get(subject.text) : undefined;
      if (from) notFollowed.push({ path: from, line: lineOf(stmt) });
    }
  }
  const followed = [...new Set(writes.filter((w) => w.generation === generation).map((w) => w.path))];
  return { followed, notFollowed };
}
