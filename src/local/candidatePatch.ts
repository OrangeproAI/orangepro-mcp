import ts from "typescript";
import { insideRepoPath, ProbeFaultRefusal } from "./faultProbe.js";

// A3: the candidate test arrives as a unified diff. OrangePro applies it itself, from its own
// reading, and never through `git apply`: the one reading that is checked is the one that runs.
// The new test is then read on the syntax tree of the patched file, where the brief's rules that
// can be read from the code are checked.

type PatchRefusal = "candidate_invalid" | "assertion_invalid";

const refuse = (code: PatchRefusal, detail: string): never => {
  throw new ProbeFaultRefusal(code, detail, "verify-test");
};

interface Hunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: Array<{ kind: "context" | "added"; text: string }>;
  /** A `\ No newline at end of file` marker follows its last line, which is then the original's last line. */
  endsWithoutNewline: boolean;
}

export interface AdditivePatch {
  path: string;
  hunks: Hunk[];
}

export interface AppliedPatch {
  path: string;
  /** The patched file, byte for byte. */
  bytes: Buffer;
  /** Every added line, by its number in the patched file. */
  added: Array<{ line: number; text: string }>;
}

// Paths as `git diff` writes them without quoting: no spaces, quotes or escapes.
const PLAIN_PATH = /^[\w.@+~,=-]+(?:\/[\w.@+~,=-]+)*$/;
const GIT_METADATA = /^(?:new|deleted) file mode|^(?:rename|copy) (?:from|to) |^(?:dis)?similarity index|^old mode|^new mode|^Binary files|^GIT binary patch/;

/**
 * A unified diff that only adds lines to one existing file. Lines are read as bytes (latin1), so
 * the file's own bytes are kept exactly. Anything else is refused by name.
 */
export function parseAdditivePatch(patch: Buffer): AdditivePatch {
  const lines = patch.toString("latin1").split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  let i = 0;
  let gitHeader: string | null = null;
  for (; i < lines.length && !lines[i]!.startsWith("--- "); i++) {
    const line = lines[i]!;
    if (line.startsWith("diff --git ")) {
      if (gitHeader !== null) refuse("candidate_invalid", "the patch changes more than one file; it may add one test to one test file.");
      gitHeader = line;
    } else if (/^index [0-9a-f]+\.\.[0-9a-f]+(?: [0-7]{6})?$/.test(line)) {
      continue;
    } else if (GIT_METADATA.test(line)) {
      refuse("candidate_invalid", "the patch creates, deletes, renames or changes the mode of a file, or holds binary data; it may only add lines to an existing test file.");
    } else {
      refuse("candidate_invalid", `unexpected line before the file header: ${JSON.stringify(line.slice(0, 80))}`);
    }
  }
  const from = lines[i] ?? "";
  const to = lines[i + 1] ?? "";
  const a = /^--- a\/(.+)$/.exec(from);
  const b = /^\+\+\+ b\/(.+)$/.exec(to);
  if (!a || !b || a[1] !== b[1]) refuse("candidate_invalid", "the file header must read `--- a/<path>` and `+++ b/<path>` with the same path, as git diff writes it.");
  const path = b![1]!;
  if (!PLAIN_PATH.test(path) || !insideRepoPath(path) || path.split("/").includes(".")) {
    refuse("candidate_invalid", `${JSON.stringify(path)} is not a plain repository path (no spaces, quotes, escapes, "." or "..").`);
  }
  if (gitHeader !== null && gitHeader !== `diff --git a/${path} b/${path}`) refuse("candidate_invalid", "the `diff --git` line names another path than the `---` and `+++` lines.");
  i += 2;
  const hunks: Hunk[] = [];
  while (i < lines.length) {
    const header = lines[i]!;
    const m = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(?: .*)?$/.exec(header);
    if (!m) {
      if (header.startsWith("diff --git ") || header.startsWith("--- ")) refuse("candidate_invalid", "the patch changes more than one file; it may add one test to one test file.");
      refuse("candidate_invalid", `unexpected line where a hunk header should be: ${JSON.stringify(header.slice(0, 80))}`);
    }
    const hunk: Hunk = {
      oldStart: Number(m![1]),
      oldCount: m![2] === undefined ? 1 : Number(m![2]),
      newStart: Number(m![3]),
      newCount: m![4] === undefined ? 1 : Number(m![4]),
      lines: [],
      endsWithoutNewline: false
    };
    const n = hunks.length + 1;
    i++;
    let oldLeft = hunk.oldCount;
    let newLeft = hunk.newCount;
    while (oldLeft > 0 || newLeft > 0) {
      if (i >= lines.length) refuse("candidate_invalid", `hunk ${n} ends before the line counts in its header are met.`);
      const body = lines[i]!;
      if (body.startsWith("+")) {
        if (newLeft === 0) refuse("candidate_invalid", `hunk ${n} has more lines than its header counts.`);
        hunk.lines.push({ kind: "added", text: body.slice(1) });
        newLeft--;
      } else if (body.startsWith(" ") || body === "") {
        if (oldLeft === 0 || newLeft === 0) refuse("candidate_invalid", `hunk ${n} has more lines than its header counts.`);
        hunk.lines.push({ kind: "context", text: body.slice(1) });
        oldLeft--;
        newLeft--;
      } else if (body.startsWith("-")) {
        refuse("candidate_invalid", `the patch removes or changes an existing line in ${path}.`);
      } else if (body.startsWith("\\")) {
        refuse("candidate_invalid", `hunk ${n} has a "\\ No newline at end of file" marker before its last line: git would join two lines there.`);
      } else {
        refuse("candidate_invalid", `unexpected line in hunk ${n}: ${JSON.stringify(body.slice(0, 80))}`);
      }
      i++;
    }
    if (i < lines.length && lines[i]!.startsWith("\\")) {
      // Only after a context line, and only at the very end: the original's last line has no line feed.
      if (hunk.lines[hunk.lines.length - 1]?.kind !== "context" || i !== lines.length - 1) {
        refuse("candidate_invalid", `hunk ${n}'s "\\ No newline at end of file" marker does not follow the file's last line: git would join that line onto the next.`);
      }
      hunk.endsWithoutNewline = true;
      i++;
    }
    hunks.push(hunk);
  }
  if (hunks.length === 0) refuse("candidate_invalid", "the patch has no hunk.");
  if (!hunks.some((hunk) => hunk.lines.some((line) => line.kind === "added"))) refuse("candidate_invalid", "the patch adds nothing.");
  return { path, hunks };
}

/**
 * The file after the patch, built from the original's bytes and the patch's added lines. Every
 * hunk must sit exactly where its header says, with its context matching byte for byte: no
 * offset, no fuzz, nothing git would read differently.
 */
export function applyAdditivePatch(original: Buffer, patch: AdditivePatch): AppliedPatch {
  const text = original.toString("latin1");
  const finalNewline = text.endsWith("\n");
  const old = text.split("\n");
  if (finalNewline) old.pop();
  const out: string[] = [];
  const added: AppliedPatch["added"] = [];
  let next = 0;
  for (const [index, hunk] of patch.hunks.entries()) {
    const n = index + 1;
    const at = hunk.oldCount === 0 ? hunk.oldStart : hunk.oldStart - 1;
    if (at < next || at > old.length) refuse("candidate_invalid", `hunk ${n} starts at line ${hunk.oldStart}, which overlaps the hunk before it or lies past the end of ${patch.path}.`);
    while (next < at) out.push(old[next++]!);
    if (hunk.newCount > 0 && hunk.newStart !== out.length + 1) {
      refuse("candidate_invalid", `hunk ${n}'s line numbers do not match ${patch.path} (it says +${hunk.newStart}, the lines land at ${out.length + 1}); make the patch with git diff.`);
    }
    for (const line of hunk.lines) {
      if (line.kind === "context") {
        if (next >= old.length || old[next] !== line.text) {
          refuse("candidate_invalid", `hunk ${n}'s context does not match line ${next + 1} of ${patch.path}: the patch was not made against this file, or its line numbers are off; make it with git diff.`);
        }
        out.push(old[next++]!);
      } else {
        out.push(line.text);
        added.push({ line: out.length, text: line.text });
      }
    }
    if (hunk.endsWithoutNewline && (finalNewline || next !== old.length || n !== patch.hunks.length)) {
      refuse("candidate_invalid", `hunk ${n}'s "\\ No newline at end of file" marker does not match the end of ${patch.path}.`);
    }
  }
  while (next < old.length) out.push(old[next++]!);
  return { path: patch.path, bytes: Buffer.from(`${out.join("\n")}${finalNewline ? "\n" : ""}`, "latin1"), added };
}

// ── the new test, read on the syntax tree ──────────────────────────────────────────

// Calls that define tests or hooks: none may appear inside the new test.
const TEST_DEFINING = new Set(["it", "xit", "specify", "xspecify", "test", "describe", "xdescribe", "context", "xcontext", "suite", "before", "after", "beforeEach", "afterEach", "setup", "teardown", "suiteSetup", "suiteTeardown"]);
const SUITES = new Set(["describe", "context", "suite"]);
// Names a test of the oracle's behavior does not need, and through which a test could reach its runner,
// the module system or the code's own text instead of the behavior.
const OFF_LIMITS = new Set(["process", "globalThis", "global", "module", "exports", "require", "eval", "Function", "Reflect", "Proxy", "__dirname", "__filename"]);
const OFF_LIMITS_MEMBERS = new Set(["__proto__", "constructor", "caller", "callee", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__"]);
// Calls that change how the runner treats a test.
const RUNNER_CONTROL = new Set(["only", "skip", "retries"]);
const OBJECT_WRITERS = new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]);

export interface NewTest {
  /** First and last line of the new `it(…)` call. */
  start: number;
  end: number;
  /** Its full title as Mocha builds it (suite titles and its own, joined by spaces), or null when one of them is not a plain string. */
  fullTitle: string | null;
  /** Lines holding the called name of an assertion call inside the new test: where the runner reports its failure. */
  assertionLines: Set<number>;
}

function parsed(path: string, text: string): ts.SourceFile | null {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const diagnostics = (source as unknown as { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  return diagnostics.length === 0 ? source : null;
}

const stringValue = (node: ts.Node | undefined): string | null => (node && ts.isStringLiteralLike(node) ? node.text : null);

/** Modules a file loads by a literal name: require("x"), import("x"), import … from "x", import x = require("x"). */
export function modulesLoaded(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && ((ts.isIdentifier(node.expression) && node.expression.text === "require") || node.expression.kind === ts.SyntaxKind.ImportKeyword)) {
      const name = stringValue(node.arguments[0]);
      if (name !== null) names.add(name);
    } else if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      const name = stringValue(node.moduleSpecifier);
      if (name !== null) names.add(name);
    } else if (ts.isExternalModuleReference(node)) {
      const name = stringValue(node.expression);
      if (name !== null) names.add(name);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
}

/** The identifier an access chain starts from (`a` in `a.b[c].d`), or null when it starts from `this`, a call or a literal. */
function rootIdentifier(expr: ts.Expression): ts.Identifier | null {
  let at: ts.Expression = expr;
  for (;;) {
    if (ts.isPropertyAccessExpression(at) || ts.isElementAccessExpression(at) || ts.isNonNullExpression(at) || ts.isParenthesizedExpression(at)) at = at.expression;
    else return ts.isIdentifier(at) ? at : null;
  }
}

/** Whether this identifier refers to a binding (rather than naming a property or a label). */
function isReference(id: ts.Identifier): boolean {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === id) return false;
  if ((ts.isPropertyAssignment(p) || ts.isMethodDeclaration(p) || ts.isPropertyDeclaration(p) || ts.isGetAccessorDeclaration(p) || ts.isSetAccessorDeclaration(p)) && p.name === id) return false;
  if (ts.isBindingElement(p) && p.propertyName === id) return false;
  if (ts.isLabeledStatement(p) || ts.isBreakOrContinueStatement(p)) return false;
  return true;
}

const freshValue = (init: ts.Expression | undefined): boolean => {
  if (!init) return false;
  const e = ts.isParenthesizedExpression(init) ? init.expression : init;
  return (
    ts.isObjectLiteralExpression(e) ||
    ts.isArrayLiteralExpression(e) ||
    ts.isNewExpression(e) ||
    ts.isFunctionExpression(e) ||
    ts.isArrowFunction(e) ||
    ts.isClassExpression(e) ||
    (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression) && e.expression.expression.text === "Object" && e.expression.name.text === "create")
  );
};

/** Whether this call is an assertion: assert…(…), expect(…), .expect(…) (supertest), or a call on a chain that starts at one (expect(x).to.equal(…), x.should.equal(…)). */
function chainHasAssertion(expr: ts.Expression): boolean {
  let at: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(at)) {
      const callee = at.expression;
      if (ts.isIdentifier(callee) && (callee.text === "expect" || /^assert/i.test(callee.text))) return true;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "expect") return true;
      at = callee;
    } else if (ts.isPropertyAccessExpression(at)) {
      if (at.name.text === "should") return true;
      at = at.expression;
    } else if (ts.isElementAccessExpression(at) || ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at)) {
      at = at.expression;
    } else {
      return false;
    }
  }
}

function assertionNameNode(call: ts.CallExpression): ts.Node | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return callee.text === "expect" || /^assert/i.test(callee.text) ? callee : null;
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === "expect") return callee.name;
    if (ts.isIdentifier(callee.expression) && /^assert/i.test(callee.expression.text)) return callee.name;
    if (chainHasAssertion(callee.expression)) return callee.name;
  }
  return null;
}

/**
 * Reads the one new test the patch adds and checks the rules that can be read from the code:
 * exactly one new `it(…)`, every added line inside it, no nested test or hook, no .only/.skip/
 * .retries, no module the file did not already load, no name through which a test reaches its
 * runner or the code's text, and no change to anything the test did not create itself (so it can
 * neither replace the code under test nor a collaborator, nor change state other tests share).
 */
export function readNewTest(args: { path: string; patched: Buffer; original: Buffer; added: AppliedPatch["added"] }): NewTest {
  const text = args.patched.toString("utf8");
  if (/\r(?!\n)|\u2028|\u2029/.test(text)) {
    refuse("candidate_invalid", `${args.path} holds a line break other than \\n or \\r\\n (a lone carriage return, U+2028 or U+2029), so its line numbers cannot be bound to the runner's.`);
  }
  const source = parsed(args.path, text);
  if (!source) refuse("candidate_invalid", `${args.path} does not parse after the patch.`);
  const originalSource = parsed(args.path, args.original.toString("utf8"));
  if (!originalSource) refuse("candidate_invalid", `${args.path} does not parse as it is in the commit, so the new test cannot be read.`);
  const loaded = modulesLoaded(originalSource!);
  const src = source!;
  const lineOf = (pos: number): number => src.getLineAndCharacterOfPosition(pos).line + 1;
  const addedLines = new Set(args.added.map((entry) => entry.line));
  const startsOnAddedLine = (node: ts.Node): boolean => addedLines.has(lineOf(node.getStart(src)));

  // The new it(…) calls, and any runner control on the added lines.
  const newCalls: ts.CallExpression[] = [];
  const scan = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && startsOnAddedLine(node)) {
      const callee = node.expression;
      if (ts.isIdentifier(callee) && callee.text === "it") newCalls.push(node);
      if (ts.isPropertyAccessExpression(callee) && RUNNER_CONTROL.has(callee.name.text)) refuse("candidate_invalid", `the patch uses .${callee.name.text}(…) (${args.path}:${lineOf(callee.name.getStart(src))}).`);
    }
    ts.forEachChild(node, scan);
  };
  scan(src);
  if (newCalls.length !== 1) refuse("candidate_invalid", `the patch adds ${newCalls.length} it(…) calls; it must add exactly one.`);
  const call = newCalls[0]!;
  const start = lineOf(call.getStart(src));
  const end = lineOf(call.getEnd());
  for (let line = start; line <= end; line++) {
    if (!addedLines.has(line)) refuse("candidate_invalid", `the new it(…) call takes in line ${line}, which was already in ${args.path}.`);
  }
  const outside = args.added.find((entry) => entry.text.trim() !== "" && (entry.line < start || entry.line > end));
  if (outside) refuse("candidate_invalid", `${args.path}:${outside.line} is added outside the new it(…) call; everything the test needs goes inside it.`);

  // Where it sits: never inside another test or hook; its full title from the suites around it.
  const titles: Array<string | null> = [stringValue(call.arguments[0])];
  for (let node: ts.Node = call.parent; !ts.isSourceFile(node); node = node.parent) {
    if (!ts.isCallExpression(node)) continue;
    const callee = node.expression;
    const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : null;
    if (name === null || !TEST_DEFINING.has(name)) continue;
    if (!SUITES.has(name)) refuse("candidate_invalid", `the new test is inside another test or hook (${name}, line ${lineOf(node.getStart(src))}).`);
    titles.unshift(stringValue(node.arguments[0]));
  }
  const fullTitle = titles.every((title) => title !== null) ? titles.join(" ") : null;

  // What the new test declares itself, and whether the value is one it makes (a literal, `new …`, a function).
  const declared = new Map<string, boolean>();
  const declare = (name: ts.BindingName, fresh: boolean): void => {
    if (ts.isIdentifier(name)) declared.set(name.text, (declared.get(name.text) ?? true) && fresh);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) declare(element.name, false);
  };
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node)) declare(node.name, freshValue(node.initializer));
    else if (ts.isParameter(node)) declare(node.name, false);
    else if ((ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isClassDeclaration(node) || ts.isClassExpression(node)) && node.name) declare(node.name, true);
    ts.forEachChild(node, collect);
  };
  collect(call);

  const where = (node: ts.Node): string => `${args.path}:${lineOf(node.getStart(src))}`;
  const checkWrite = (target: ts.Expression): void => {
    const e = ts.isParenthesizedExpression(target) ? target.expression : target;
    if (ts.isObjectLiteralExpression(e)) {
      for (const prop of e.properties) {
        if (ts.isPropertyAssignment(prop)) checkWrite(prop.initializer);
        else if (ts.isShorthandPropertyAssignment(prop)) checkWrite(prop.name);
        else if (ts.isSpreadAssignment(prop)) checkWrite(prop.expression);
      }
    } else if (ts.isArrayLiteralExpression(e)) {
      for (const element of e.elements) if (!ts.isOmittedExpression(element)) checkWrite(ts.isSpreadElement(element) ? element.expression : element);
    } else if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      checkWrite(e.left);
    } else if (ts.isIdentifier(e)) {
      if (!declared.has(e.text)) refuse("candidate_invalid", `the new test assigns to ${e.text}, which it does not declare: other tests share it (${where(e)}).`);
    } else if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const root = rootIdentifier(e);
      if (!root || declared.get(root.text) !== true) {
        refuse("candidate_invalid", `the new test changes ${e.getText(src).slice(0, 80)}, which it did not create; a test may change only objects it makes itself, never the code under test or what it uses (${where(e)}).`);
      }
    } else {
      refuse("candidate_invalid", `the new test writes to an expression that cannot be checked (${where(e)}).`);
    }
  };

  const assertionLines = new Set<number>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && OFF_LIMITS.has(node.text) && isReference(node)) {
      const p = node.parent;
      const plainRequire = node.text === "require" && ts.isCallExpression(p) && p.expression === node && p.arguments.length === 1 && stringValue(p.arguments[0]) !== null;
      if (!plainRequire) refuse("candidate_invalid", `the new test uses ${node.text}, which a test of the oracle's behavior does not need (${where(node)}).`);
    }
    if (ts.isPropertyAccessExpression(node) && OFF_LIMITS_MEMBERS.has(node.name.text)) refuse("candidate_invalid", `the new test uses .${node.name.text} (${where(node)}).`);
    if (ts.isElementAccessExpression(node) && OFF_LIMITS_MEMBERS.has(stringValue(node.argumentExpression) ?? "")) refuse("candidate_invalid", `the new test uses [${JSON.stringify(stringValue(node.argumentExpression))}] (${where(node)}).`);
    if (ts.isWithStatement(node)) refuse("candidate_invalid", `the new test uses a with statement (${where(node)}).`);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads = (ts.isIdentifier(callee) && callee.text === "require") || callee.kind === ts.SyntaxKind.ImportKeyword;
      if (loads) {
        const name = stringValue(node.arguments[0]);
        if (name === null) refuse("candidate_invalid", `the new test loads a module named at run time (${where(node)}).`);
        if (!loaded.has(name!)) refuse("candidate_invalid", `the new test loads ${name}, which ${args.path} does not already use (${where(node)}).`);
      }
      const defining = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression.text : null;
      if (node !== call && defining !== null && TEST_DEFINING.has(defining)) refuse("candidate_invalid", `the new test defines another test or hook inside itself (${defining}, ${where(node)}).`);
      if (ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) && callee.expression.text === "Object" && OBJECT_WRITERS.has(callee.name.text)) {
        const first = node.arguments[0];
        const own = first && (freshValue(first) || (ts.isIdentifier(first) && declared.get(first.text) === true));
        if (!own) refuse("candidate_invalid", `the new test uses Object.${callee.name.text} on an object it did not create (${where(node)}).`);
      }
      const named = assertionNameNode(node);
      if (named) assertionLines.add(lineOf(named.getStart(src)));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) checkWrite(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) checkWrite(node.operand);
    if (ts.isDeleteExpression(node)) checkWrite(node.expression);
    ts.forEachChild(node, visit);
  };
  visit(call);
  return { start, end, fullTitle, assertionLines };
}
