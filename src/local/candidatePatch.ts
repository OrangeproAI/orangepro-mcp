import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
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
 * offset and no fuzz. `gitAppliedBytes` then checks that git reads the patch the same way.
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

// ── git, as the person who applies the patch will run it ─────────────────────────

/**
 * What `git apply -p1` makes of the patch on the original bytes, in a scratch folder git cannot see
 * out of, with no user or system configuration: the bytes, or null when git refuses it. The stored
 * patch is what is delivered, so it must give, under git, exactly the bytes that were verified.
 */
export function gitAppliedBytes(path: string, original: Buffer, patch: Buffer): Buffer | null {
  const scratch = mkdtempSync(join(tmpdir(), "opro-git-apply-"));
  try {
    const file = join(scratch, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, original);
    const env = { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: scratch, LANG: "C", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CEILING_DIRECTORIES: dirname(scratch) };
    const result = spawnSync("git", ["-c", "core.hooksPath=/dev/null", "apply", "-p1", "--whitespace=nowarn", "-"], { cwd: scratch, env, input: patch, encoding: "buffer" });
    if (result.status !== 0 || /Skipped patch/.test(result.stderr?.toString() ?? "")) return null;
    return readFileSync(file);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

// ── the new test, read on the syntax tree ──────────────────────────────────────────

// Calls that define tests or hooks: none may appear inside the new test.
const TEST_DEFINING = new Set(["it", "xit", "specify", "xspecify", "test", "describe", "xdescribe", "context", "xcontext", "suite", "before", "after", "beforeEach", "afterEach", "setup", "teardown", "suiteSetup", "suiteTeardown"]);
const SUITES = new Set(["describe", "context", "suite"]);
// Names through which a test could reach its runner or the module system rather than the behavior.
const OFF_LIMITS = new Set(["process", "globalThis", "global", "module", "exports", "require", "eval", "Function", "Reflect", "Proxy"]);
const OFF_LIMITS_MEMBERS = new Set(["__proto__", "constructor", "caller", "callee", "__defineGetter__", "__defineSetter__", "__lookupGetter__", "__lookupSetter__", "captureStackTrace", "prepareStackTrace"]);
// Members no test may write, on any object: they decide where a failure seems to come from.
const WRITE_FORBIDDEN = new Set(["stack", "stackTraceLimit", "prepareStackTrace", "captureStackTrace", "__proto__"]);
// Calls that change how the runner treats a test.
const RUNNER_CONTROL = new Set(["only", "skip", "retries"]);
const OBJECT_WRITERS = new Set(["assign", "defineProperty", "defineProperties", "setPrototypeOf"]);
// Built-in constructors whose `new` always makes a new object.
const SAFE_CONSTRUCTORS = new Set([
  "Error", "TypeError", "RangeError", "SyntaxError", "ReferenceError", "EvalError", "URIError", "AggregateError",
  "Date", "Map", "Set", "WeakMap", "WeakSet", "Array", "RegExp", "URL", "URLSearchParams", "Promise", "ArrayBuffer", "DataView",
  "Int8Array", "Uint8Array", "Uint8ClampedArray", "Int16Array", "Uint16Array", "Int32Array", "Uint32Array", "Float32Array", "Float64Array", "BigInt64Array", "BigUint64Array"
]);
// Modules whose functions are assertions when a file destructures or imports them.
const ASSERTION_MODULES = /^(?:node:)?assert(?:\/strict)?$|^chai$|^should$|^expect(?:\.js)?$|^power-assert$|^unexpected$/;

export interface NewTest {
  /** First and last line of the new `it(…)` call. */
  start: number;
  end: number;
  /** Its full title as Mocha builds it (suite titles and its own, joined by spaces), or null when one of them is not a plain string. */
  fullTitle: string | null;
  /** Where an assertion call inside the new test names its check, as V8 reports it: line → the 1-based columns on that line. */
  assertionPositions: Map<number, Set<number>>;
}

const stringValue = (node: ts.Node | undefined): string | null => (node && ts.isStringLiteralLike(node) ? node.text : null);

/** A literal member name, also when spelled as concatenated literals (`'constr' + 'uctor'`). */
function constantName(node: ts.Node | undefined): string | null {
  if (!node) return null;
  if (ts.isStringLiteralLike(node) || ts.isNumericLiteral(node)) return node.text;
  if (ts.isParenthesizedExpression(node)) return constantName(node.expression);
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = constantName(node.left);
    const right = constantName(node.right);
    return left !== null && right !== null ? left + right : null;
  }
  return null;
}

/** The file as one program, so names can be resolved by scope. Null when it does not parse. */
function programFor(path: string, text: string): { source: ts.SourceFile; checker: ts.TypeChecker } | null {
  const fileName = `/opro-virtual/${path}`;
  const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, true);
  const options: ts.CompilerOptions = { allowJs: true, noLib: true, noResolve: true, noEmit: true, types: [], target: ts.ScriptTarget.Latest };
  const host: ts.CompilerHost = {
    getSourceFile: (name) => (name === fileName ? source : undefined),
    getDefaultLibFileName: () => "/opro-virtual/lib.d.ts",
    writeFile: () => undefined,
    getCurrentDirectory: () => "/opro-virtual",
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
    fileExists: (name) => name === fileName,
    readFile: (name) => (name === fileName ? text : undefined)
  };
  const program = ts.createProgram({ rootNames: [fileName], options, host });
  if (program.getSyntacticDiagnostics(source).length > 0) return null;
  return { source, checker: program.getTypeChecker() };
}

/** Whether a file's text parses, as JavaScript or TypeScript by its extension. */
export function parsesAs(path: string, text: string): boolean {
  return programFor(path, text) !== null;
}

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

/** Names the file binds from an assertion module: `const { strictEqual } = require('assert')`, `import { expect } from 'chai'`. */
function assertionNames(source: ts.SourceFile): Set<string> {
  const names = new Set<string>();
  const moduleOf = (init: ts.Expression | undefined): string | null => {
    let at = init;
    while (at && (ts.isPropertyAccessExpression(at) || ts.isParenthesizedExpression(at))) at = at.expression;
    return at && ts.isCallExpression(at) && ts.isIdentifier(at.expression) && at.expression.text === "require" ? stringValue(at.arguments[0]) : null;
  };
  const bind = (name: ts.BindingName): void => {
    if (ts.isIdentifier(name)) names.add(name.text);
    else for (const element of name.elements) if (!ts.isOmittedExpression(element)) bind(element.name);
  };
  const visit = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ASSERTION_MODULES.test(moduleOf(node.initializer) ?? "")) bind(node.name);
    if (ts.isImportDeclaration(node) && ASSERTION_MODULES.test(stringValue(node.moduleSpecifier) ?? "") && node.importClause) {
      if (node.importClause.name) names.add(node.importClause.name.text);
      const bindings = node.importClause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) names.add(bindings.name.text);
      if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.add(element.name.text);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return names;
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

const isFunctionLike = (node: ts.Node): boolean => ts.isFunctionExpression(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node) || ts.isConstructorDeclaration(node);

const isAssertionName = (name: string, bound: Set<string>): boolean => name === "expect" || name === "should" || /^assert/i.test(name) || bound.has(name);

/** Whether an access chain continues from an assertion: `expect(x)`, `.should`, `assert`, a bound name or `.expect(…)`. */
function chainHasAssertion(expr: ts.Expression, bound: Set<string>): boolean {
  let at: ts.Expression = expr;
  for (;;) {
    if (ts.isCallExpression(at)) {
      const callee = at.expression;
      if (ts.isIdentifier(callee) && isAssertionName(callee.text, bound)) return true;
      if (ts.isPropertyAccessExpression(callee) && callee.name.text === "expect") return true;
      at = callee;
    } else if (ts.isPropertyAccessExpression(at)) {
      if (at.name.text === "should" || at.name.text === "assert") return true;
      at = at.expression;
    } else if (ts.isIdentifier(at)) {
      return /^assert/i.test(at.text) || bound.has(at.text);
    } else if (ts.isElementAccessExpression(at) || ts.isParenthesizedExpression(at) || ts.isNonNullExpression(at)) {
      at = at.expression;
    } else {
      return false;
    }
  }
}

/** Whether this call is an assertion: assert…(…), expect(…), should(…), a name bound from an assertion module, `.expect(…)` (supertest), or a call on a chain from one (`expect(x).to.equal(…)`, `sinon.assert.calledOnce(…)`). */
function assertionNameNode(call: ts.CallExpression, bound: Set<string>): ts.Node | null {
  const callee = call.expression;
  if (ts.isIdentifier(callee)) return isAssertionName(callee.text, bound) ? callee : null;
  if (ts.isPropertyAccessExpression(callee)) {
    if (callee.name.text === "expect") return callee.name;
    if (chainHasAssertion(callee.expression, bound)) return callee.name;
  }
  return null;
}

/**
 * Reads the one new test the patch adds and checks the rules that can be read from the code:
 * exactly one new `it(…)` statement, every added line inside it (blank lines only right beside it),
 * no nested test or hook, no .only/.skip/.retries in any spelling, no module the file did not already
 * load, no name through which a test reaches its runner or the module system, and no change to
 * anything the test did not make itself. Names are resolved by scope.
 */
export function readNewTest(args: { path: string; patched: Buffer; original: Buffer; added: AppliedPatch["added"] }): NewTest {
  const text = args.patched.toString("utf8");
  if (/\r(?!\n)|\u2028|\u2029/.test(text)) {
    refuse("candidate_invalid", `${args.path} holds a line break other than \\n or \\r\\n (a lone carriage return, U+2028 or U+2029), so its line numbers cannot be bound to the runner's.`);
  }
  const program = programFor(args.path, text);
  if (!program) refuse("candidate_invalid", `${args.path} does not parse after the patch.`);
  const original = programFor(args.path, args.original.toString("utf8"));
  if (!original) refuse("candidate_invalid", `${args.path} does not parse as it is in the commit, so the new test cannot be read.`);
  const loaded = modulesLoaded(original!.source);
  const { source: src, checker } = program!;
  const bound = assertionNames(src);
  const lineOf = (pos: number): number => src.getLineAndCharacterOfPosition(pos).line + 1;
  const columnOf = (pos: number): number => src.getLineAndCharacterOfPosition(pos).character + 1;
  const addedLines = new Set(args.added.map((entry) => entry.line));
  const startsOnAddedLine = (node: ts.Node): boolean => addedLines.has(lineOf(node.getStart(src)));
  const where = (node: ts.Node): string => `${args.path}:${lineOf(node.getStart(src))}`;

  // The new it(…) calls, and runner control on the added lines in any spelling.
  const newCalls: ts.CallExpression[] = [];
  const scan = (node: ts.Node): void => {
    if (startsOnAddedLine(node)) {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "it") newCalls.push(node);
      const member = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? constantName(node.argumentExpression) : null;
      if (member !== null && RUNNER_CONTROL.has(member)) refuse("candidate_invalid", `the patch uses .${member} (${where(node)}).`);
    }
    ts.forEachChild(node, scan);
  };
  scan(src);
  if (newCalls.length !== 1) refuse("candidate_invalid", `the patch adds ${newCalls.length} it(…) calls; it must add exactly one.`);
  const call = newCalls[0]!;
  // A statement of its own, wholly new: it cannot take over a chained call of an existing statement.
  const statement = call.parent;
  if (!ts.isExpressionStatement(statement) || statement.expression !== call) refuse("candidate_invalid", `the new it(…) call is not a statement of its own (${where(call)}).`);
  const start = lineOf(statement.getStart(src));
  const end = lineOf(statement.getEnd());
  for (let line = start; line <= end; line++) {
    if (!addedLines.has(line)) refuse("candidate_invalid", `the new it(…) call takes in line ${line}, which was already in ${args.path}.`);
  }
  // Blank added lines only right beside the new statement; nothing else outside it.
  const byLine = new Map(args.added.map((entry) => [entry.line, entry.text]));
  let before = start - 1;
  while (byLine.has(before) && byLine.get(before)!.trim() === "") before--;
  let after = end + 1;
  while (byLine.has(after) && byLine.get(after)!.trim() === "") after++;
  const outside = args.added.find((entry) => entry.line <= before || entry.line >= after);
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

  // What the test declares itself, resolved by scope, and which of those hold an object it made.
  const symbolOf = (id: ts.Identifier): ts.Symbol | undefined =>
    ts.isShorthandPropertyAssignment(id.parent) && id.parent.name === id ? checker.getShorthandAssignmentValueSymbol(id.parent) : checker.getSymbolAtLocation(id);
  const inside = (decl: ts.Node): boolean => decl.getStart(src) >= call.getStart(src) && decl.end <= call.end;
  const isLocal = (id: ts.Identifier): boolean => {
    const decls = symbolOf(id)?.declarations ?? [];
    return decls.length > 0 && decls.every(inside);
  };
  const freshValue = (init: ts.Expression | undefined): boolean => {
    if (!init) return false;
    const e = ts.isParenthesizedExpression(init) ? init.expression : init;
    // A write may only ever reach a direct member of the made object (checkWrite), so what a literal holds does not matter.
    if (ts.isFunctionExpression(e) || ts.isArrowFunction(e) || ts.isClassExpression(e) || ts.isRegularExpressionLiteral(e) || ts.isObjectLiteralExpression(e) || ts.isArrayLiteralExpression(e)) return true;
    if (ts.isNewExpression(e)) {
      if (!ts.isIdentifier(e.expression) || symbolOf(e.expression)) return false;
      // `new Object(x)` returns x itself when x is an object.
      return e.expression.text === "Object" ? (e.arguments?.length ?? 0) === 0 : SAFE_CONSTRUCTORS.has(e.expression.text);
    }
    if (ts.isCallExpression(e) && ts.isPropertyAccessExpression(e.expression) && ts.isIdentifier(e.expression.expression)) {
      return e.expression.expression.text === "Object" && e.expression.name.text === "create" && !symbolOf(e.expression.expression);
    }
    return false;
  };
  const fresh = new Set<ts.Symbol>();
  const reassigned = new Set<ts.Symbol>();
  const collect = (node: ts.Node): void => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && freshValue(node.initializer)) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) fresh.add(symbol);
    } else if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node)) && node.name) {
      const symbol = checker.getSymbolAtLocation(node.name);
      if (symbol) fresh.add(symbol);
    }
    const target = ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment ? node.left
      : (ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken) ? node.operand
      : (ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer) ? node.initializer
      : null;
    if (target && ts.isIdentifier(target)) {
      const symbol = symbolOf(target);
      if (symbol) reassigned.add(symbol);
    }
    ts.forEachChild(node, collect);
  };
  collect(call);
  for (const symbol of reassigned) fresh.delete(symbol);
  const madeHere = (id: ts.Identifier): boolean => {
    const symbol = symbolOf(id);
    return symbol !== undefined && fresh.has(symbol) && (symbol.declarations ?? []).every(inside);
  };

  const RULE = `a test may change only what it declares itself, and only direct members (\`local.name\` or \`local['name']\`, one level) of a local it makes itself: an object or array literal, a function or class, Object.create(…), new Object() with no argument, or new ${[...SAFE_CONSTRUCTORS].join(", ")}; never a value it gets from a call it did not make or from outside the test`;
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
      if (!isLocal(e)) refuse("candidate_invalid", `the new test assigns to ${e.text}, which it does not declare: other tests share it (${where(e)}); ${RULE}.`);
    } else if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) {
      const member = ts.isPropertyAccessExpression(e) ? e.name.text : constantName(e.argumentExpression);
      if (member === null) refuse("candidate_invalid", `the new test writes a member named at run time (${where(e)}); ${RULE}.`);
      if (WRITE_FORBIDDEN.has(member!)) refuse("candidate_invalid", `the new test writes .${member} (${where(e)}), which decides where a failure seems to come from.`);
      // One level only: the object written to is itself a local the test made, never something reached through it.
      let owner: ts.Expression = e.expression;
      while (ts.isParenthesizedExpression(owner) || ts.isNonNullExpression(owner)) owner = owner.expression;
      if (!ts.isIdentifier(owner) || !madeHere(owner)) refuse("candidate_invalid", `the new test changes ${e.getText(src).slice(0, 80)} (${where(e)}); ${RULE}.`);
    } else {
      refuse("candidate_invalid", `the new test writes to an expression that cannot be checked (${where(e)}).`);
    }
  };
  const itCallback = call.arguments.find((argument) => ts.isFunctionExpression(argument) || ts.isArrowFunction(argument));

  const assertionPositions = new Map<number, Set<number>>();
  const visit = (node: ts.Node): void => {
    if (ts.isIdentifier(node) && OFF_LIMITS.has(node.text) && isReference(node)) {
      const p = node.parent;
      const plainRequire = node.text === "require" && ts.isCallExpression(p) && p.expression === node && p.arguments.length === 1 && stringValue(p.arguments[0]) !== null;
      if (!plainRequire) refuse("candidate_invalid", `the new test uses ${node.text}, which a test of the oracle's behavior does not need (${where(node)}).`);
    }
    const member = ts.isPropertyAccessExpression(node) ? node.name.text : ts.isElementAccessExpression(node) ? constantName(node.argumentExpression) : null;
    if (member !== null && OFF_LIMITS_MEMBERS.has(member)) refuse("candidate_invalid", `the new test uses .${member} (${where(node)}).`);
    if (member !== null && OBJECT_WRITERS.has(member)) {
      // Only as the direct callee of a call whose first argument the test made itself.
      const p = node.parent;
      const first = ts.isCallExpression(p) && p.expression === node ? p.arguments[0] : undefined;
      const own = first !== undefined && (freshValue(first) || (ts.isIdentifier(first) && madeHere(first)));
      if (!own) refuse("candidate_invalid", `the new test uses .${member} on an object it did not make (${where(node)}).`);
      // The names it defines are checked like a write: named in the code, and none that shapes a failure's origin.
      const second = (p as ts.CallExpression).arguments[1];
      if (member === "defineProperty") {
        const key = constantName(second);
        if (key === null) refuse("candidate_invalid", `the new test defines a member named at run time (${where(node)}).`);
        if (WRITE_FORBIDDEN.has(key!)) refuse("candidate_invalid", `the new test defines .${key} (${where(node)}), which decides where a failure seems to come from.`);
      }
      if (member === "defineProperties" && !(second && ts.isObjectLiteralExpression(second))) refuse("candidate_invalid", `the new test uses .defineProperties with names it does not spell out in a literal (${where(node)}).`);
    }
    if (ts.isObjectLiteralExpression(node)) {
      // A literal the test makes may not carry a member that shapes where a failure seems to come from (a forged stack).
      for (const prop of node.properties) {
        if (ts.isSpreadAssignment(prop) || !prop.name) continue;
        const key = ts.isIdentifier(prop.name) || ts.isPrivateIdentifier(prop.name) ? prop.name.text : ts.isComputedPropertyName(prop.name) ? constantName(prop.name.expression) : constantName(prop.name);
        if (key === null) refuse("candidate_invalid", `the new test makes an object with a member named at run time (${where(prop)}).`);
        if (WRITE_FORBIDDEN.has(key!)) refuse("candidate_invalid", `the new test makes an object with a ${key} member (${where(prop)}), which decides where a failure seems to come from.`);
      }
    }
    if (ts.isPropertyAccessExpression(node) && !(ts.isCallExpression(node.parent) && node.parent.expression === node) && chainHasAssertion(node.expression, bound)) {
      // A property assertion (`expect(x).to.be.true`, `x.should.be.true`) throws from a getter, and V8 reports the `.` before the name.
      const dot = node.getChildren(src).find((child) => child.kind === ts.SyntaxKind.DotToken || child.kind === ts.SyntaxKind.QuestionDotToken);
      if (dot) {
        const pos = dot.getStart(src);
        const line = lineOf(pos);
        if (!assertionPositions.has(line)) assertionPositions.set(line, new Set());
        assertionPositions.get(line)!.add(columnOf(pos));
      }
    }
    if (ts.isBindingElement(node)) {
      const key = node.propertyName ? (ts.isIdentifier(node.propertyName) ? node.propertyName.text : ts.isComputedPropertyName(node.propertyName) ? constantName(node.propertyName.expression) : constantName(node.propertyName)) : ts.isIdentifier(node.name) ? node.name.text : null;
      if (node.propertyName && key === null) refuse("candidate_invalid", `the new test destructures a member named at run time (${where(node)}).`);
      if (key !== null && (OFF_LIMITS_MEMBERS.has(key) || OBJECT_WRITERS.has(key))) refuse("candidate_invalid", `the new test takes ${key} out of an object (${where(node)}).`);
    }
    if (node.kind === ts.SyntaxKind.ThisKeyword) {
      // `this` in the it callback is Mocha's context; inside any other non-arrow function it may be the global object.
      let owner: ts.Node = node.parent;
      while (!isFunctionLike(owner) && !ts.isSourceFile(owner)) owner = owner.parent;
      if (owner !== itCallback) refuse("candidate_invalid", `the new test uses this inside a nested function (${where(node)}).`);
    }
    if (ts.isWithStatement(node)) refuse("candidate_invalid", `the new test uses a with statement (${where(node)}).`);
    if (ts.isCallExpression(node)) {
      const callee = node.expression;
      const loads = (ts.isIdentifier(callee) && callee.text === "require") || callee.kind === ts.SyntaxKind.ImportKeyword;
      if (loads) {
        const name = stringValue(node.arguments[0]);
        if (name === null) refuse("candidate_invalid", `the new test loads a module named at run time (${where(node)}).`);
        if (!loaded.has(name!)) refuse("candidate_invalid", `the new test loads ${name}, which ${args.path} does not already use (${where(node)}).`);
      }
      // Mocha's test and hook functions are globals: a name the file declares (`var after = require('after')`) is not one.
      const definingId = ts.isIdentifier(callee) ? callee : ts.isPropertyAccessExpression(callee) && ts.isIdentifier(callee.expression) ? callee.expression : null;
      if (node !== call && definingId !== null && TEST_DEFINING.has(definingId.text) && (symbolOf(definingId)?.declarations ?? []).length === 0) {
        refuse("candidate_invalid", `the new test defines another test or hook inside itself (${definingId.text}, ${where(node)}).`);
      }
      const named = assertionNameNode(node, bound);
      if (named) {
        const pos = named.getStart(src);
        const line = lineOf(pos);
        if (!assertionPositions.has(line)) assertionPositions.set(line, new Set());
        assertionPositions.get(line)!.add(columnOf(pos));
      }
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) checkWrite(node.left);
    if ((ts.isPrefixUnaryExpression(node) || ts.isPostfixUnaryExpression(node)) && (node.operator === ts.SyntaxKind.PlusPlusToken || node.operator === ts.SyntaxKind.MinusMinusToken)) checkWrite(node.operand);
    if (ts.isDeleteExpression(node)) checkWrite(node.expression);
    if ((ts.isForInStatement(node) || ts.isForOfStatement(node)) && !ts.isVariableDeclarationList(node.initializer)) checkWrite(node.initializer);
    ts.forEachChild(node, visit);
  };
  visit(call);
  return { start, end, fullTitle, assertionPositions };
}
