// Confirmed-coverage confirmer (Phase 4.2 / Gate 2). False-confirm-safe by
// construction: a (test, behavior) pair is CONFIRMED only when the TypeScript
// TypeChecker proves the test exercises + asserts the behavior's REAL exported
// binding. Every ambiguity, heuristic, or unresolved hop downgrades to INFERRED
// (or NONE). Under-confirming is the desired failure mode.
//
// The five conjuncts (ALL must hold — see private/spikes/gate-specs-digest.md
// §confirmed-semantics):
//   1. Terminal-binding resolution — a runtime import in the test resolves
//      (through renames + barrels, via getSymbolAtLocation+getAliasedSymbol) to
//      the terminal file that DEFINES the behavior's exported binding.
//   2. Runtime import, not type-only.
//   3. Runtime reference of that binding (call callee / new / JSX render /
//      render(...) arg) — a bare mention is not a use.
//   4. The reference is in a live position — NOT a mock factory, string/snapshot,
//      type position, import line, or skipped/disabled block.
//   5. An assertion (or an allow-listed self-asserting helper) accompanies the
//      runtime use in the same test block.
//
// Confirmation NEVER originates from symbols.ts regex, basename-stem matching, or
// describe-name matching — those can only ever yield INFERRED/NONE. This module
// is the SOLE producer of hard TESTED_BY/COVERS edges.

import ts from "typescript";
import path from "node:path";
import { loadTsConfigFor, resolveImport } from "../resolve/resolver.js";
import { walkBarrel } from "../resolve/barrelWalker.js";
import { isSelfAssertingCallee } from "./selfAssert.js";

export type CoverageVerdict = "confirmed" | "inferred" | "none";

export interface ConfirmVerdict {
  verdict: CoverageVerdict;
  /** Plain reason — the rejected conjunct for negatives, "all 5 conjuncts" for confirmed. */
  reason: string;
  /** Which conjunct failed (1-5), when the verdict is not confirmed. */
  rejected_conjunct?: 1 | 2 | 3 | 4 | 5 | 6;
}

export interface ConfirmProgram {
  program: ts.Program;
  checker: ts.TypeChecker;
}

const norm = (p: string): string => path.resolve(p);

/**
 * Build a TypeChecker Program over a bounded file set (PR-diff-scoped at PR time;
 * the test+source closure for a full analyze — never silently whole-repo). Honors
 * the anchor file's nearest tsconfig (NodeNext OR bundler) so resolution matches
 * the target repo. JSX is preserved and emit/lib-checks are off — we only read
 * symbols, never compile.
 */
export function buildConfirmProgram(absFiles: string[], anchorFile: string): ConfirmProgram {
  const base = loadTsConfigFor(anchorFile).options;
  const options: ts.CompilerOptions = {
    ...base,
    noEmit: true,
    allowJs: true,
    checkJs: false,
    skipLibCheck: true,
    // Preserve needs no jsx-runtime resolution; tag identities still bind.
    jsx: ts.JsxEmit.Preserve,
    module: base.module ?? ts.ModuleKind.NodeNext,
    moduleResolution: base.moduleResolution ?? ts.ModuleResolutionKind.NodeNext,
    // Don't require @types to be resolvable from the scanned tree.
    types: []
  };
  const rootNames = [...new Set(absFiles.map(norm))];
  const program = ts.createProgram(rootNames, options);
  return { program, checker: program.getTypeChecker() };
}

/** Callee text: "expect", "cy.contains", or just "should" for a chained base.
 * Element access with a string-literal key (`describe["skipIf"]`) is normalized to
 * the dot form so it cannot evade the marker sets purely by bracket notation. */
function calleeText(call: ts.CallExpression): string {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) {
    const base = ts.isIdentifier(e.expression) ? e.expression.text + "." : "";
    return base + e.name.text;
  }
  if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
    const base = ts.isIdentifier(e.expression) ? e.expression.text + "." : "";
    return base + e.argumentExpression.text;
  }
  return "";
}

const MOCK_CALLEES = new Set([
  "vi.mock",
  "jest.mock",
  "vi.doMock",
  "jest.doMock",
  "vi.mocked",
  "jest.mocked",
  "vi.importActual",
  "jest.requireActual"
]);
const MODULE_MOCK_CALLEES = new Set(["vi.mock", "jest.mock", "vi.doMock", "jest.doMock", "jest.unstable_mockModule"]);
const RENDER_CALLEES = new Set(["render", "mount", "renderHook", "create"]);

// Runner markers that make a test/suite block NON-live: skipped, todo, or expected to
// FAIL (`test.fails`/`it.failing` passing means the behavior is still WRONG), plus the
// conditional `skipIf`/`runIf` (which we cannot evaluate). Detected ANYWHERE in the
// callee chain so chained/parametrized forms (`describe.skip.each(...)`) are caught.
const DISABLED_RUNNER_MARKERS = new Set(["skip", "todo", "fails", "failing", "skipIf", "runIf"]);
const RUNNER_ROOTS = new Set(["it", "test", "specify", "describe", "context", "fit", "fdescribe"]);

/** Root identifier + member names along a (possibly chained/parametrized) call's callee:
 * `describe.skip.each([...])(...)` -> {root:"describe", members:{skip,each}}. */
function runnerCalleeChain(call: ts.CallExpression): { root: string; members: Set<string> } {
  const members = new Set<string>();
  let e: ts.Expression = call.expression;
  for (;;) {
    if (ts.isPropertyAccessExpression(e)) {
      members.add(e.name.text);
      e = e.expression;
    } else if (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression)) {
      members.add(e.argumentExpression.text);
      e = e.expression;
    } else if (ts.isCallExpression(e)) {
      e = e.expression;
    } else break;
  }
  return { root: ts.isIdentifier(e) ? e.text : "", members };
}

/** True when `call` is a test/suite runner that is skipped / todo / expected-to-fail. */
function isDisabledRunnerCall(call: ts.CallExpression): boolean {
  const { root, members } = runnerCalleeChain(call);
  if (root === "xit" || root === "xdescribe" || root === "xtest") return true;
  if (!RUNNER_ROOTS.has(root)) return false;
  for (const m of members) if (DISABLED_RUNNER_MARKERS.has(m)) return true;
  return false;
}

/** The module specifier of a `vi.mock(...)`/`jest.mock(...)` first arg: a string literal,
 * OR a dynamic `import("./x")` call (`vi.mock(import("./x"), factory)`). */
function mockSpecifier(arg: ts.Expression | undefined): string | null {
  if (!arg) return null;
  if (ts.isStringLiteralLike(arg)) return arg.text;
  if (ts.isCallExpression(arg) && arg.expression.kind === ts.SyntaxKind.ImportKeyword) {
    const s = arg.arguments[0];
    if (s && ts.isStringLiteralLike(s)) return s.text;
  }
  return null;
}

// A Jest/Vitest/jest-dom/jest-extended matcher METHOD name. An ALLOW-list of the
// matcher naming conventions, NOT a denylist of `to*` built-ins: a denylist is
// provably open-ended (ES keeps adding `to*` value methods — toWellFormed/toSorted/
// toHex/toBase64/toArray/Temporal.to*), so an unknown `to*` would over-confirm
// (UNSAFE). These prefixes cover essentially every real matcher (toBe*, toHave*,
// toEqual*, toContain*, toMatch*, toThrow*, toReturn*, toResolve/Reject, toInclude*,
// toStartWith/toEndWith, toSatisfy, toStrictEqual) and collide with NO ECMAScript
// built-in `to*` method, so impostors (.toString/.toFixed/.toHex/.toArray/…)
// UNDER-confirm — the safe failure mode. A custom matcher with a novel non-`to`
// name also under-confirms (rare, safe).
const MATCHER_NAME = /^to(Be|Have|Equal|StrictEqual|Contain|Match|Throw|Return|Resolve|Reject|Include|StartWith|EndWith|Satisfy)/;
// Matchers whose 2nd+ arguments are MEANINGFUL comparands and must all be observed:
// the spy call/return families (variadic expected args), toHaveProperty(path, value),
// and the jest-dom toHaveAttribute(name, value). Every other matcher is single-comparand
// — a 2nd+ arg is ignored, so a use there is not asserted (`expect(x).toBe(x, use())`);
// see observedArgs. (An unmodelled custom multi-comparand matcher UNDER-confirms a use
// in its 2nd+ arg — the safe failure mode.)
const VARIADIC_MATCHER =
  /^to(HaveBeenCalledWith|HaveBeenLastCalledWith|HaveBeenNthCalledWith|HaveReturnedWith|HaveLastReturnedWith|HaveNthReturnedWith|ReturnWith|LastReturnedWith|NthReturnedWith|HaveProperty|HaveAttribute)/;

/**
 * A bare `expect(x)` is NOT an assertion — in Jest/Vitest it records nothing until
 * a matcher runs. Only a complete matcher CALL chain asserts: `expect(x).toBe(y)`,
 * `await expect(p).resolves.toEqual(z)`, `expect(() => f()).toThrow()`,
 * `expect(x).not.toBeNull()`, `render(...); expect(el).toBeVisible()`. Walk up the
 * property-access chain rooted at the `expect(...)` call and return the INVOKED
 * matcher CALL (the CallExpression whose callee property is a {@link MATCHER_NAME}),
 * or null. A bare reference, an un-invoked `.toBe` getter, or a non-matcher call
 * (`.toString()`, `.then()`, `.toHex()`) does NOT qualify.
 *
 * Deliberately Jest/Vitest-shaped (the product's TS/JS target): chai property-style
 * (`expect(x).to.be.true`) and custom non-convention matchers UNDER-confirm — the
 * safe failure mode. The expect() call stays the assertion site (so relatedness
 * reads its argument); the matcher call's args are also observed (it carries the
 * expected/comparand value).
 */
function expectMatcherCall(expectCall: ts.CallExpression): ts.CallExpression | null {
  let n: ts.Node = expectCall;
  while (n.parent) {
    const acc = n.parent;
    let member: string | undefined;
    if (ts.isPropertyAccessExpression(acc) && acc.expression === n) member = acc.name.text;
    else if (ts.isElementAccessExpression(acc) && acc.expression === n && ts.isStringLiteralLike(acc.argumentExpression)) {
      member = acc.argumentExpression.text;
    } else break;
    if (member !== undefined && acc.parent && ts.isCallExpression(acc.parent) && acc.parent.expression === acc && MATCHER_NAME.test(member)) {
      return acc.parent;
    }
    n = acc;
  }
  return null;
}

// Modules whose `assert` IS a real assertion. A LOCAL function named `assert`
// (or any non-imported / non-trusted `assert*`) asserts nothing structurally and
// must not fake evidence — mirrors the FRAMEWORK trust applied to render/screen.
// (`node:assert` covers `node:assert/strict`; `assert` covers `assert/strict`.)
const TRUSTED_ASSERT_PKGS = ["node:assert", "assert", "chai"];

// How many leading arguments of a node:assert/chai assert call are COMPARANDS (the
// rest — a trailing failure MESSAGE — is never compared, so a use smuggled there is
// not asserted). Bare `assert(v[,msg])` / unknown methods default to 1.
const ASSERT_COMPARANDS: Record<string, number> = {
  ok: 1,
  equal: 2,
  notEqual: 2,
  strictEqual: 2,
  notStrictEqual: 2,
  deepEqual: 2,
  notDeepEqual: 2,
  deepStrictEqual: 2,
  notDeepStrictEqual: 2,
  match: 2,
  doesNotMatch: 2,
  throws: 1,
  doesNotThrow: 1,
  rejects: 1,
  doesNotReject: 1,
  ifError: 1,
  fail: 0 // assert.fail([message]) — its sole arg is the failure message, never a comparand
};

// Matchers / assert methods that INVOKE a callback argument (so a use inside that
// callback DOES execute and is asserted): `expect(() => f()).toThrow()`,
// `assert.throws(() => f())`. For all other matchers a function-expression argument
// is inspected as a value (the function object), not executed.
const INVOKING_EXPECT_MATCHER = /^(toThrow|toThrowError)/;
const INVOKING_ASSERT_METHODS = new Set(["throws", "doesNotThrow", "rejects", "doesNotReject"]);
// Test-runtime wrappers that SYNCHRONOUSLY invoke their callback argument, so a render
// inside their callback genuinely executes — `act(() => render(<X/>))`, `waitFor(...)`.
const INVOKING_WRAPPER_CALLEES = new Set(["act", "waitFor", "waitForElementToBeRemoved"]);

/** The root identifier of a call's callee chain: `assert.equal(...)` / `assert["equal"](...)`
 * -> `assert`. Descends both dot and string-keyed element access (symmetric with calleeText). */
function calleeRootId(call: ts.CallExpression): ts.Identifier | null {
  let e: ts.Expression = call.expression;
  while (ts.isPropertyAccessExpression(e) || (ts.isElementAccessExpression(e) && ts.isStringLiteralLike(e.argumentExpression))) {
    e = e.expression;
  }
  return ts.isIdentifier(e) ? e : null;
}

type AssertionKind = "expect" | "assert" | "selfassert";

/**
 * The syntactic shape of an assertion call (BEFORE trust/import gating, which the
 * walk applies):
 *   - "expect": a complete `expect(...)` matcher CALL chain (bare expect rejected).
 *   - "assert": an `assert*(...)` call (gated to a trusted module in the walk).
 *   - "selfassert": a self-asserting framework query (getBy…/findBy…/should/…) —
 *     observes a RENDER effect only, never a value call (enforced in observesUse).
 */
function assertionKind(call: ts.CallExpression): AssertionKind | null {
  const c = calleeText(call);
  if (!c) return null;
  if (/(^|\.)expect(\.(soft|poll))?$/.test(c)) return expectMatcherCall(call) ? "expect" : null;
  if (/(^|\.)assert([.A-Z]|$)/.test(c)) return "assert";
  return isSelfAssertingCallee(c) ? "selfassert" : null;
}

// Test-LEAF runner roots — the callback passed to one of these is a test block, incl.
// parametrized/chained forms (`it.each(rows)(name, cb)`, `it.only`, `it.skip`). NOT
// describe/context (grouping). Disabled markers (skip/fails/…) still downgrade via
// isDisabledRunnerCall in classifyAncestors.
const TEST_LEAF_ROOTS = new Set(["it", "test", "specify", "fit", "xit"]);

/**
 * Nearest enclosing TEST CALLBACK — the arrow/function passed to an it()/test()
 * leaf. Returns null when the node is NOT inside any test callback (e.g. module
 * top-level, or a beforeEach). This is the conjunct-5 scope: scoping to the
 * test-runner callback (rather than any arrow, or the whole source file) (a)
 * closes the top-level false-confirm — an unrelated top-level assertion can no
 * longer satisfy a top-level use — and (b) lets a runtime use nested in a
 * `.map(...)` / `waitFor(...)` callback still match an assertion in the SAME
 * it() block (recall), while keeping sibling it() blocks isolated.
 */
function enclosingTestBlock(node: ts.Node): ts.Node | null {
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent && ts.isCallExpression(n.parent)) {
      const call = n.parent;
      if (call.arguments.includes(n as ts.Expression) && TEST_LEAF_ROOTS.has(runnerCalleeChain(call).root)) return n;
    }
    n = n.parent;
  }
  return null;
}

interface Ancestors {
  inImportOrExport: boolean;
  inTypeContext: boolean;
  inMockFactory: boolean;
  inSkipped: boolean;
}

function classifyAncestors(node: ts.Node): Ancestors {
  let inImportOrExport = false;
  let inTypeContext = false;
  let inMockFactory = false;
  let inSkipped = false;
  let n: ts.Node | undefined = node.parent;
  while (n) {
    if (
      ts.isImportDeclaration(n) ||
      ts.isImportClause(n) ||
      ts.isImportSpecifier(n) ||
      ts.isNamespaceImport(n) ||
      ts.isExportDeclaration(n) ||
      ts.isExportSpecifier(n)
    ) {
      inImportOrExport = true;
    }
    // Only a TYPE NODE is type context. An `as`/`satisfies`/`<T>` cast is NOT — its
    // EXPRESSION side runs at runtime (`saveUser() as string` calls saveUser); only the
    // cast's `.type` node (a TypeNode, caught here) is type-only.
    if (
      ts.isTypeNode(n) ||
      ts.isTypeQueryNode(n) ||
      ts.isTypeReferenceNode(n) ||
      ts.isTypeAliasDeclaration(n)
    ) {
      inTypeContext = true;
    }
    if (ts.isCallExpression(n)) {
      if (MOCK_CALLEES.has(calleeText(n))) inMockFactory = true;
      if (isDisabledRunnerCall(n)) inSkipped = true;
    }
    n = n.parent;
  }
  return { inImportOrExport, inTypeContext, inMockFactory, inSkipped };
}

type UseKind = "value" | "render";

/**
 * The binding source of a runtime-used local: the module its DECLARING import
 * resolves to (per-binding, not aggregated per-behavior), the imported name, and
 * whether it was a type-only import. This is what conjunct 1/2/4 are evaluated
 * against for the binding ACTUALLY exercised.
 */
interface BindingSource {
  file: string;
  importedName: string; // source name before any `as`, or "default" / "*"
  typeOnly: boolean;
}

/**
 * The runtime-use kind of `id`, or null. `value` = a call/new whose RESULT is a
 * value (`X(...)`, `new X()`); `render` = a JSX instantiation (`<X/>`) whose
 * EFFECT is the rendered DOM. A bare `render(X)` arg is NOT classified here — it
 * is only a render use when the render helper resolves to a real test framework
 * (handled in the walk), since a local `render` may never call its argument.
 */
function runtimeUseKind(id: ts.Identifier): UseKind | null {
  const p = id.parent;
  if (!p) return null;
  if (ts.isCallExpression(p) && p.expression === id) return "value"; // X(...)
  if (ts.isNewExpression(p) && p.expression === id) return "value"; // new X(...)
  if ((ts.isJsxOpeningElement(p) || ts.isJsxSelfClosingElement(p)) && p.tagName === id) return "render"; // <X/>
  return null;
}

function isRuntimeUse(id: ts.Identifier): boolean {
  return runtimeUseKind(id) !== null;
}

/** The call/new/JSX expression that `id` is the head of (the "use expression"). */
function useExpressionOf(id: ts.Identifier): ts.Node {
  return id.parent;
}

/** True if `target` is `root` or anywhere in its subtree. */
function nodeContains(root: ts.Node, target: ts.Node): boolean {
  if (root === target) return true;
  let found = false;
  const walk = (n: ts.Node): void => {
    if (found) return;
    if (n === target) {
      found = true;
      return;
    }
    ts.forEachChild(n, walk);
  };
  ts.forEachChild(root, walk);
  return found;
}

// Higher-order methods whose callback's RETURN value flows into the method's result (so
// a use inside the callback genuinely contributes to the asserted value). ONLY these are
// descended. EXCLUDED on purpose: forEach (returns undefined), filter/find/some/every
// (the callback is a PREDICATE — the result holds the ORIGINAL elements, not the
// callback's return), sort (comparator), finally (return ignored) — descending those
// would equate "executed" with "asserted" (the use runs but its value is discarded).
const HOF_CALLBACK_METHODS = new Set(["map", "flatMap", "reduce", "reduceRight", "then", "catch"]);
// then/catch run their callback only on a real thenable; the rest are array methods.
const PROMISE_HOF_METHODS = new Set(["then", "catch"]);

/** Internal TypeChecker predicates (not in the public typings) used to recognise built-in
 * array/tuple receivers; guarded with `?.` so a checker without them falls back to the
 * symbol-name check. */
interface InternalTypeChecker {
  isArrayType?(t: ts.Type): boolean;
  isTupleType?(t: ts.Type): boolean;
}

/** Whether `recv.<method>(cb)` actually INVOKES `cb`: only when the receiver is provably a
 * built-in Array/ReadonlyArray/tuple (array methods) or a Promise (then/catch). A custom
 * object with a method merely NAMED `map`/`then` can ignore its callback, so it must not
 * count as invoking (Codex round-6). */
function hofReceiverInvokes(receiver: ts.Expression, method: string, checker: ts.TypeChecker): boolean {
  const t = checker.getNonNullableType(checker.getTypeAtLocation(receiver));
  const constituents = t.isUnion() ? t.types : [t];
  const names = new Set<string>();
  for (const ty of constituents) {
    const sym = ty.getSymbol() ?? ty.aliasSymbol;
    if (sym) names.add(sym.getName());
  }
  if (PROMISE_HOF_METHODS.has(method)) return names.has("Promise");
  if (names.has("Array") || names.has("ReadonlyArray")) return true;
  const ic = checker as unknown as InternalTypeChecker;
  return constituents.some((ty) => Boolean(ic.isArrayType?.(ty) || ic.isTupleType?.(ty)));
}

/** True when `fn` is a function-expression passed as a callback to a known invoking
 * higher-order method (`arr.map(fn)` / `promise.then(fn)` / `Array.from(xs, fn)`). When a
 * `checker` is supplied, `arr.map`-style calls require the receiver to be a built-in
 * array/promise — a method merely NAMED map/then on a custom object does NOT invoke. */
function isInvokedCallback(fn: ts.Node, checker?: ts.TypeChecker): boolean {
  const p = fn.parent;
  if (!p || !ts.isCallExpression(p) || !p.arguments.includes(fn as ts.Expression)) return false;
  const callee = p.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    if (HOF_CALLBACK_METHODS.has(callee.name.text)) {
      return checker ? hofReceiverInvokes(callee.expression, callee.name.text, checker) : true;
    }
    if (ts.isIdentifier(callee.expression) && callee.expression.text === "Array" && callee.name.text === "from") {
      // `Array.from(source, mapFn)` invokes ONLY arg1 (the map callback); arg0 is the
      // array-like SOURCE, never called. And the `Array` root must be the global, not a
      // local `const Array = { from: … }` spoof.
      if (p.arguments[1] !== fn) return false;
      return checker ? isGlobalBinding(callee.expression, checker) : true;
    }
  }
  return false;
}

/** True when identifier `id` resolves to a GLOBAL declared only in lib `.d.ts` files (e.g.
 * the built-in `Array`) — a user-declared shadow (`const Array = …`) has a declaration in a
 * real source file and is rejected; an unresolved binding is also rejected (no trust). */
function isGlobalBinding(id: ts.Identifier, checker: ts.TypeChecker): boolean {
  const sym = checker.getSymbolAtLocation(id);
  const decls = sym?.getDeclarations() ?? [];
  return decls.length > 0 && decls.every((d) => d.getSourceFile().isDeclarationFile);
}

/**
 * Does `target`'s VALUE flow to the value of `arg`? Structural containment, with two
 * value-discarding boundaries excluded:
 *   - a non-final operand of a comma/sequence expression (`(use(), x)` → only x flows);
 *   - a function expression whose body is NOT executed for `arg`'s value. A function is
 *     descended only when the matcher invokes it (`intoFns`: toThrow/poll/assert.throws)
 *     or it is a callback to a known invoking higher-order method ({@link isInvokedCallback}:
 *     `[...].map(u => use(u))`). A function merely STORED — expect's arg
 *     (`expect(() => use()).toBeInstanceOf(Function)`), a ternary/logical operand
 *     (`expect(cond ? (() => use()) : null)…`), an array/object literal — is inspected as
 *     a VALUE (the function object), never run, so its body use is NOT observed.
 * This is the WRAPPED relatedness signal: the use is observed only when its result can
 * reach the asserted value.
 *
 * Known heuristic limit (conjunct 5): still structural, not full dataflow / reachability.
 * Residual over-confirms that need value/return/reachability tracking remain and are
 * deliberately NOT closed — a never-taken branch (`false && use()`, dead ternary arm); a
 * wrapping literal whose matcher asserts a value-INDEPENDENT property
 * (`expect([use(), x]).toHaveLength(2)`, a negated `expect(x).not.toBe(use())`); an IIFE
 * whose return discards the use (`expect((() => { use(); return 1 })()).toBe(1)`); a use in
 * a NESTED un-invoked function under an invoking matcher (`expect(() => () => use()).toThrow()`);
 * a tagged template that drops substitutions. Each is CONSTRUCTED nonsense never seen in
 * real code (the 10-repo sweep is unaffected); closing them would cost recall on genuine
 * invoked callbacks (`[1,2].map(x => use(x))`, `expect(() => use()).toThrow()`).
 */
function flowsInto(arg: ts.Node, target: ts.Node, intoFns: boolean, invoked: (fn: ts.Node) => boolean): boolean {
  if (arg === target) return true;
  if (ts.isParenthesizedExpression(arg)) return flowsInto(arg.expression, target, intoFns, invoked);
  if (ts.isBinaryExpression(arg) && arg.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return flowsInto(arg.right, target, intoFns, invoked);
  }
  if (ts.isArrowFunction(arg) || ts.isFunctionExpression(arg)) {
    // A function is executed for arg's value ONLY when it is an invoked HOF callback, or
    // the matcher invokes it (intoFns) AND it is a concise-body arrow `() => use(...)`.
    // A block body (extra statements / an explicit `throw`) is ambiguous — the asserted
    // throw may not be the use (`expect(() => { use(); throw e }).toThrow()`) — so
    // under-confirm. Otherwise the function is a STORED value, never run.
    const conciseInvoked = intoFns && ts.isArrowFunction(arg) && !ts.isBlock(arg.body);
    if (!invoked(arg) && !conciseInvoked) return false;
    // Descend ONLY the value-producing nodes (concise body / `return` expressions): a
    // side-effect statement in a block body is DISCARDED, not asserted
    // (`map(() => { use(); return 1 })` asserts 1, not use()).
    return functionValueExpressions(arg).some((v) => flowsInto(v, target, intoFns, invoked));
  }
  let found = false;
  ts.forEachChild(arg, (c) => {
    if (!found && flowsInto(c, target, intoFns, invoked)) found = true;
  });
  return found;
}

/** The expression(s) whose value becomes a function's RETURN value: a concise arrow body,
 * or the block body's top-level `return` expressions (NOT those in nested functions). A
 * side-effect statement's value is discarded and is not included. */
function functionValueExpressions(fn: ts.ArrowFunction | ts.FunctionExpression): ts.Node[] {
  if (ts.isArrowFunction(fn) && !ts.isBlock(fn.body)) return [fn.body];
  const out: ts.Node[] = [];
  const walk = (n: ts.Node): void => {
    if (ts.isReturnStatement(n)) {
      if (n.expression) out.push(n.expression);
      return;
    }
    if (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) return;
    ts.forEachChild(n, walk);
  };
  walk(fn.body);
  return out;
}

const DOM_QUERY_RE = /^(get|find|query)(All)?By[A-Z]/;
// Render helpers / DOM-query receivers are trusted ONLY when imported from these.
const FRAMEWORK_RENDER_PKGS = ["@testing-library/", "enzyme", "@vue/test-utils", "@solidjs/testing-library"];
const FRAMEWORK_DOM_PKGS = ["@testing-library/", "@vue/test-utils"];
const NEST_TESTING_PKGS = ["@nestjs/testing"];
// Packages that export act/waitFor (callback-INVOKING wrappers). A locally-defined `act`
// that ignores its callback must not make a dead render look live (Codex round-6).
const INVOKING_WRAPPER_PKGS = ["@testing-library/", "@vue/test-utils", "react-dom", "react", "preact/test-utils"];

interface RuntimeUse {
  /** The runtime-used binding identifier. */
  node: ts.Identifier;
  /** The call/new/JSX expression the binding heads. */
  useExpr: ts.Node;
  kind: UseKind;
  /** The enclosing it()/test() callback (conjunct-5 scope). */
  block: ts.Node;
  /** The import source of THIS binding (per-binding conjunct-1/2/4 evaluation). */
  src: BindingSource | null;
  /**
   * For a render use, the actual framework render()/mount() CALL that mounts this
   * binding — its position (NOT the JSX tag / const initializer) is what the
   * render-effect ordering check must compare against.
   */
  renderCall?: ts.CallExpression | null;
}

interface AssertionSite {
  call: ts.CallExpression;
  block: ts.Node;
  kind: AssertionKind;
}

interface BehaviorState {
  importedRuntime: boolean;
  importedType: boolean;
  collision: boolean; // a same-named binding/ref that does NOT resolve to the terminal impl
  importSources: BindingSource[];
  runtimeUses: RuntimeUse[];
  nonRuntimeReasons: Set<string>;
}

function newState(): BehaviorState {
  return {
    importedRuntime: false,
    importedType: false,
    collision: false,
    importSources: [],
    runtimeUses: [],
    nonRuntimeReasons: new Set()
  };
}

/**
 * Classify every (behaviorName -> verdict) for one (test, impl) pair in a single
 * AST walk. `behaviorNames` are the exported binding names in `implAbsPath` that
 * are candidate behaviors (the impl file's denominator-eligible CodeSymbols).
 */
export function confirmBehaviors(
  ctx: ConfirmProgram,
  testAbsPath: string,
  implAbsPath: string,
  behaviorNames: string[]
): Map<string, ConfirmVerdict> {
  const { program, checker } = ctx;
  const out = new Map<string, ConfirmVerdict>();
  const nameSet = new Set(behaviorNames);
  const memberTargetsByClass = new Map<string, string[]>();
  for (const name of behaviorNames) {
    const dot = name.indexOf(".");
    if (dot <= 0) continue;
    const cls = name.slice(0, dot);
    const list = memberTargetsByClass.get(cls);
    if (list) list.push(name);
    else memberTargetsByClass.set(cls, [name]);
  }
  const testSf = program.getSourceFile(norm(testAbsPath));
  if (!testSf) {
    for (const n of behaviorNames) out.set(n, { verdict: "none", reason: "test file not in the confirmer program" });
    return out;
  }
  const implNorm = norm(implAbsPath);

  // Resolve an identifier's binding to a terminal export name in implAbsPath, or
  // null. Follows aliases (renames, re-export barrels) to the defining file.
  const resolvedTargetName = (id: ts.Node): string | null => {
    let sym: ts.Symbol | undefined = checker.getSymbolAtLocation(id);
    if (!sym) return null;
    if (sym.flags & ts.SymbolFlags.Alias) {
      try {
        sym = checker.getAliasedSymbol(sym);
      } catch {
        return null; // unresolvable/ambiguous alias — not a single terminal
      }
    }
    const decls = sym.getDeclarations() ?? [];
    if (decls.length === 0) return null;
    // Every value declaration must live in the terminal impl file. A symbol whose
    // declarations span multiple files (ambiguous re-export) is NOT a single terminal.
    const declFiles = new Set(decls.map((d) => norm(d.getSourceFile().fileName)));
    if (declFiles.size !== 1 || !declFiles.has(implNorm)) return null;
    let name = sym.getName();
    if (name === "default") {
      // `export default function Foo(){}` / `class Foo{}` is recorded in the
      // denominator under its DECLARED name (symbols.ts), but the symbol's name is
      // "default". Recover the declared name so the confirmer matches the behavior
      // (otherwise every default export is systematically un-confirmable).
      const valueDecl = sym.valueDeclaration ?? decls[0];
      if (valueDecl && (ts.isFunctionDeclaration(valueDecl) || ts.isClassDeclaration(valueDecl)) && valueDecl.name) {
        name = valueDecl.name.text;
      }
    }
    return nameSet.has(name) || memberTargetsByClass.has(name) ? name : null;
  };

  const states = new Map<string, BehaviorState>();
  for (const n of behaviorNames) states.set(n, newState());
  const stateFor = (name: string): BehaviorState => states.get(name) as BehaviorState;
  const targetNamesForResolved = (name: string): string[] => {
    const out: string[] = [];
    if (nameSet.has(name)) out.push(name);
    for (const member of memberTargetsByClass.get(name) ?? []) out.push(member);
    return out;
  };

  // The ImportDeclaration that declared a local binding identifier (or null).
  const importDeclOf = (id: ts.Identifier): ts.ImportDeclaration | null => {
    const sym = checker.getSymbolAtLocation(id);
    const spec = (sym?.getDeclarations() ?? []).find(
      (d) => ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d)
    );
    if (!spec) return null;
    let n: ts.Node | undefined = spec;
    while (n && !ts.isImportDeclaration(n)) n = n.parent;
    return n && ts.isImportDeclaration(n) ? n : null;
  };
  // The import source of the binding `id` ACTUALLY refers to (per-binding).
  const importSourceOf = (id: ts.Identifier): BindingSource | null => {
    const sym = checker.getSymbolAtLocation(id);
    const spec = (sym?.getDeclarations() ?? []).find(
      (d) => ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d)
    );
    const decl = importDeclOf(id);
    if (!spec || !decl || !ts.isStringLiteralLike(decl.moduleSpecifier)) return null;
    const r = resolveImport(decl.moduleSpecifier.text, testAbsPath);
    if (!r.resolvedFileName) return null;
    const clauseTypeOnly = !!decl.importClause?.isTypeOnly;
    let importedName = "default";
    let elTypeOnly = false;
    if (ts.isImportSpecifier(spec)) {
      importedName = (spec.propertyName ?? spec.name).text;
      elTypeOnly = !!spec.isTypeOnly;
    } else if (ts.isNamespaceImport(spec)) {
      importedName = "*";
    }
    return { file: norm(r.resolvedFileName), importedName, typeOnly: clauseTypeOnly || elTypeOnly };
  };
  // Was the local binding `id` imported from one of `pkgs`? (Trust gate for render
  // helpers / DOM-query receivers so a LOCAL `render`/`screen` cannot fake evidence.)
  const importedFromPkg = (id: ts.Identifier, pkgs: string[]): boolean => {
    const decl = importDeclOf(id);
    if (!decl || !ts.isStringLiteralLike(decl.moduleSpecifier)) return false;
    const s = decl.moduleSpecifier.text;
    return pkgs.some((p) => (p.endsWith("/") ? s.startsWith(p) : s === p || s.startsWith(p + "/")));
  };
  // An `assert*` call is a real assertion only when its callee root identifier is
  // imported from a trusted assert module — a local/non-imported `assert` is a no-op
  // structurally and must not confirm. (node:assert/strict & assert/strict covered
  // by the prefix match in importedFromPkg.)
  const isTrustedAssert = (call: ts.CallExpression): boolean => {
    const root = calleeRootId(call);
    return !!root && importedFromPkg(root, TRUSTED_ASSERT_PKGS);
  };
  // Conjunct 1 (terminal-binding), per binding: a direct import to impl, or a
  // re-export that the barrel walker follows to exactly ONE covered terminal that
  // IS the impl. Type-only and ambiguous/namespace/default barrels are NOT clean.
  const cleanBindingSource = (src: BindingSource): boolean => {
    if (src.typeOnly) return false;
    if (src.file === implNorm) return true;
    if (src.importedName === "*" || src.importedName === "default") return false;
    const w = walkBarrel(src.file, src.importedName);
    return w.status === "terminal" && w.covered && norm(w.terminalFile ?? "") === implNorm;
  };

  // Conjunct 4: ALL modules resolved from a vi.mock/jest.mock specifier — a
  // binding is mocked if its impl OR its own import-source module (e.g. a
  // re-export barrel the test imports through) is mocked.
  const mockedFiles = new Set<string>();
  // Raw mocked module specifier STRINGS (`vi.mock("@testing-library/react")`) — used to
  // detect a mocked FRAMEWORK package without relying on node_modules resolution.
  const mockedSpecifiers = new Set<string>();
  const assertions: AssertionSite[] = [];
  // Number of framework render()/mount() calls per test block (render-effect ambiguity).
  const renderCallsByBlock = new Map<ts.Node, number>();

  // ---- imports: record runtime/type binding to the terminal impl + collisions ----
  const visitImports = (node: ts.Node): void => {
    if (ts.isImportDeclaration(node) && node.importClause && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const clause = node.importClause;
      const clauseTypeOnly = !!clause.isTypeOnly;
      const r = resolveImport(node.moduleSpecifier.text, testAbsPath);
      const specifierFile = r.resolvedFileName ? norm(r.resolvedFileName) : null;
      const consider = (localId: ts.Identifier, elTypeOnly: boolean, importedName: string): void => {
        const directMemberClass = specifierFile === implNorm && memberTargetsByClass.has(importedName) ? importedName : null;
        const resolved = resolvedTargetName(localId) ?? directMemberClass;
        const typeOnly = clauseTypeOnly || elTypeOnly;
        if (resolved) {
          const targetNames = targetNamesForResolved(resolved);
          for (const targetName of targetNames) {
          const st = stateFor(targetName);
          if (typeOnly) st.importedType = true;
          else st.importedRuntime = true;
          if (specifierFile) st.importSources.push({ file: specifierFile, importedName, typeOnly });
          }
        } else if (nameSet.has(localId.text)) {
          // A binding whose LOCAL name matches a behavior but resolves elsewhere
          // (helper file) or nowhere (ambiguous barrel): name matches, identity does not.
          stateFor(localId.text).collision = true;
        }
      };
      if (clause.name) consider(clause.name, false, "default");
      const named = clause.namedBindings;
      if (named && ts.isNamespaceImport(named)) consider(named.name, false, "*");
      else if (named && ts.isNamedImports(named)) {
        for (const el of named.elements) consider(el.name, !!el.isTypeOnly, (el.propertyName ?? el.name).text);
      }
    }
    ts.forEachChild(node, visitImports);
  };
  visitImports(testSf);

  // The PRE-ALIAS imported name of a binding (`import { screen as scr }` -> "screen"),
  // or undefined for a non-import. Read straight off the import specifier so it works
  // even when the framework package does not resolve in the scanned tree.
  const importedSourceName = (id: ts.Identifier): string | undefined => {
    const sym = checker.getSymbolAtLocation(id);
    const spec = (sym?.getDeclarations() ?? []).find(
      (d) => ts.isImportSpecifier(d) || ts.isImportClause(d) || ts.isNamespaceImport(d)
    );
    if (!spec) return undefined;
    if (ts.isImportSpecifier(spec)) return (spec.propertyName ?? spec.name).text;
    if (ts.isNamespaceImport(spec)) return "*";
    return "default"; // import clause (default import)
  };
  // A render exercise observed by an EFFECT assertion: a DOM query (get/find/queryBy*)
  // whose receiver is a FRAMEWORK-imported `screen`/`within` (a local `screen` object
  // cannot fake this). Match the IMPORTED name, not the local text, so an aliased
  // `import { screen as scr }` (idiomatic testing-library) still counts.
  const isFrameworkDomBinding = (id: ts.Identifier): boolean => {
    const n = importedSourceName(id);
    return (n === "screen" || n === "within") && importedFromPkg(id, FRAMEWORK_DOM_PKGS);
  };
  const receiverIsFrameworkDom = (expr: ts.Expression): boolean => {
    if (ts.isIdentifier(expr)) return isFrameworkDomBinding(expr);
    if (ts.isCallExpression(expr) && ts.isIdentifier(expr.expression)) return isFrameworkDomBinding(expr.expression);
    return false;
  };
  const isFrameworkQuery = (call: ts.CallExpression): boolean =>
    ts.isPropertyAccessExpression(call.expression) &&
    DOM_QUERY_RE.test(call.expression.name.text) &&
    receiverIsFrameworkDom(call.expression.expression);
  const isFrameworkEffect = (call: ts.CallExpression): boolean => {
    if (isFrameworkQuery(call)) return true; // self-assert: screen.findByRole(...)
    if (!/(^|\.)expect$|(^|\.)assert([.A-Z]|$)/.test(calleeText(call))) return false;
    let ok = false;
    const walk = (n: ts.Node): void => {
      if (ok) return;
      if (ts.isCallExpression(n) && isFrameworkQuery(n)) {
        ok = true;
        return;
      }
      ts.forEachChild(n, walk);
    };
    for (const arg of call.arguments) walk(arg);
    return ok;
  };
  const isNestTestingModuleCall = (call: ts.CallExpression): boolean => {
    const e = call.expression;
    return (
      ts.isPropertyAccessExpression(e) &&
      e.name.text === "createTestingModule" &&
      ts.isIdentifier(e.expression) &&
      importedFromPkg(e.expression, NEST_TESTING_PKGS)
    );
  };

  // A JSX <X/> tag is a REAL render use only when the element is passed to a framework
  // render()/mount() — a bare `const el = <X/>` just constructs an element object (the
  // component function is never invoked), so it is a value, not a rendered component.
  //
  // Crucially the element must be the DIRECT rendered element. `render(<Shell><X/></Shell>)`
  // does NOT mount <X/>: a wrapper may ignore its children, so a nested tag under another
  // JSX element under-confirms (we cannot prove the wrapper renders it). We confirm only
  // when <X/> is a direct argument of the trusted render call, or when <X/> is the
  // initializer of a `const` that itself flows directly into a trusted render call.
  const elementOfTag = (id: ts.Identifier): ts.JsxSelfClosingElement | ts.JsxElement | null => {
    const p = id.parent;
    if (ts.isJsxSelfClosingElement(p) && p.tagName === id) return p;
    if (ts.isJsxOpeningElement(p) && p.tagName === id && ts.isJsxElement(p.parent)) return p.parent;
    return null;
  };
  const isFrameworkRenderCall = (call: ts.CallExpression): boolean =>
    ts.isIdentifier(call.expression) &&
    RENDER_CALLEES.has(call.expression.text) &&
    importedFromPkg(call.expression, FRAMEWORK_RENDER_PKGS);
  // A function boundary that actually RUNS when the test executes: a callback to a known
  // invoking HOF (.map/.forEach/… via isInvokedCallback), an IIFE, or a test-runtime
  // wrapper that synchronously calls its callback (act/waitFor). A function merely STORED
  // (`const doRender = () => render(<X/>)`) does NOT run, so anything inside it is dead.
  const isInvokedFunctionBoundary = (fn: ts.Node): boolean => {
    if (isInvokedCallback(fn, checker)) return true;
    const par = fn.parent;
    if (!par) return false;
    if (ts.isCallExpression(par) && par.expression === fn) return true; // (fn)()
    if (ts.isParenthesizedExpression(par) && par.parent && ts.isCallExpression(par.parent) && par.parent.expression === par)
      return true; // (fn)()
    // A test-runtime wrapper (act/waitFor) invokes its callback ONLY when it is the real
    // imported helper — a local no-op `act` that drops its callback must not count.
    if (ts.isCallExpression(par) && par.arguments.includes(fn as ts.Expression)) {
      const e = par.expression;
      if (ts.isIdentifier(e) && INVOKING_WRAPPER_CALLEES.has(e.text) && importedFromPkg(e, INVOKING_WRAPPER_PKGS)) return true;
      if (
        ts.isPropertyAccessExpression(e) &&
        INVOKING_WRAPPER_CALLEES.has(e.name.text) &&
        ts.isIdentifier(e.expression) &&
        importedFromPkg(e.expression, INVOKING_WRAPPER_PKGS)
      )
        return true; // React.act(...)
    }
    return false;
  };
  // Whether `node` executes when its enclosing test block runs — the path up to `block`
  // crosses no uninvoked function boundary. A render inside a stored thunk is NOT live.
  const isLivePosition = (node: ts.Node, block: ts.Node): boolean => {
    let n: ts.Node | undefined = node.parent;
    while (n && n !== block) {
      if (
        (ts.isArrowFunction(n) || ts.isFunctionExpression(n) || ts.isFunctionDeclaration(n)) &&
        !isInvokedFunctionBoundary(n)
      ) {
        return false;
      }
      n = n.parent;
    }
    return n === block;
  };
  // A framework render() call counts only when it actually executes in its test block.
  const renderCallIsLive = (call: ts.CallExpression): boolean => {
    const blk = enclosingTestBlock(call);
    return blk != null && isLivePosition(call, blk);
  };
  // The trusted render call that takes `el` as a DIRECT argument — `render(<X/>)`.
  const frameworkRenderArgCall = (el: ts.Node): ts.CallExpression | null => {
    const p = el.parent;
    return p && ts.isCallExpression(p) && p.arguments.includes(el as ts.Expression) && isFrameworkRenderCall(p) ? p : null;
  };
  // The trusted render call that passes `sym` (a const bound to a JSX element) as a DIRECT
  // argument somewhere in scope — `const ui = <X/>; render(ui)`. A nested use
  // (`render(<Shell>{ui}</Shell>)`) is NOT direct and stays ambiguous.
  const constElementRenderCall = (sym: ts.Symbol, scope: ts.Node): ts.CallExpression | null => {
    let hit: ts.CallExpression | null = null;
    const walk = (n: ts.Node): void => {
      if (hit) return;
      if (
        ts.isCallExpression(n) &&
        isFrameworkRenderCall(n) &&
        n.arguments.some((a) => ts.isIdentifier(a) && checker.getSymbolAtLocation(a) === sym)
      ) {
        hit = n;
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(scope);
    return hit;
  };
  // Returns the framework render()/mount() call that actually mounts the JSX tag `id`,
  // or null when the element is never directly rendered (a bare element object, or a tag
  // nested under another JSX element whose parent may ignore children).
  const jsxRenderCall = (id: ts.Identifier): ts.CallExpression | null => {
    const el = elementOfTag(id);
    if (!el) return null;
    const direct = frameworkRenderArgCall(el); // render(<X/>)
    if (direct) return renderCallIsLive(direct) ? direct : null;
    const p = el.parent;
    if (ts.isVariableDeclaration(p) && ts.isIdentifier(p.name) && p.initializer === el) {
      const list = p.parent;
      if (list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0) {
        const sym = checker.getSymbolAtLocation(p.name);
        if (sym) {
          const call = constElementRenderCall(sym, enclosingTestBlock(el) ?? testSf);
          if (call && renderCallIsLive(call)) return call;
        }
      }
    }
    return null;
  };

  // ---- module mocks + assertions + runtime refs ----
  let hasNestTestingModuleHarness = false;
  const unsafeMemberTargets = new Set<string>();
  const NEST_DI_ASSOCIATED_REASON =
    "NestJS TestingModule DI target proof is associated-only until alias-closure verification lands";
  type NestInstanceBinding = { className: string; src: BindingSource | null; fromNest: boolean };
  type WrapperInstanceBinding = { classDecl: ts.ClassDeclaration; fields: Map<string, NestInstanceBinding> };
  const instanceBindings = new Map<ts.Symbol, NestInstanceBinding>();
  const objectPropertyBindings = new Map<ts.Symbol, Map<string, NestInstanceBinding>>();
  const arrayElementBindings = new Map<ts.Symbol, Map<number, NestInstanceBinding>>();
  const mapEntryBindings = new Map<ts.Symbol, Map<string, NestInstanceBinding>>();
  const wrapperInstanceBindings = new Map<ts.Symbol, WrapperInstanceBinding>();
  const constructorBindings = new Map<ts.Symbol, string>();
  const prototypeBindings = new Map<ts.Symbol, string>();
  const mutatorAliases = new Map<ts.Symbol, string>();
  const unwrapExpression = (expr: ts.Expression): ts.Expression => {
    let current = expr;
    while (
      ts.isParenthesizedExpression(current) ||
      ts.isAsExpression(current) ||
      ts.isTypeAssertionExpression(current) ||
      ts.isNonNullExpression(current) ||
      ts.isSatisfiesExpression(current) ||
      ts.isAwaitExpression(current)
    ) {
      current = current.expression;
    }
    return current;
  };
  const numericIndex = (expr: ts.Expression): number | null => {
    const index = unwrapExpression(expr);
    if (ts.isNumericLiteral(index)) return Number(index.text);
    if (ts.isStringLiteralLike(index) && /^\d+$/.test(index.text)) return Number(index.text);
    return null;
  };
  const constArrayElement = (expr: ts.Expression, index: number, seen = new Set<ts.Symbol>()): ts.Expression | null => {
    const source = unwrapExpression(expr);
    if (ts.isArrayLiteralExpression(source)) {
      const el = source.elements[index];
      return el && ts.isExpression(el) ? el : null;
    }
    if (!ts.isIdentifier(source)) return null;
    const sym = checker.getSymbolAtLocation(source);
    if (!sym || seen.has(sym)) return null;
    seen.add(sym);
    for (const decl of sym.getDeclarations() ?? []) {
      if (
        ts.isVariableDeclaration(decl) &&
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        checker.getSymbolAtLocation(decl.name) === sym
      ) {
        const list = decl.parent;
        if (!ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) continue;
        const initializer = unwrapExpression(decl.initializer);
        if (ts.isArrayLiteralExpression(initializer)) {
          const el = initializer.elements[index];
          return el && ts.isExpression(el) ? el : null;
        }
        return constArrayElement(initializer, index, seen);
      }
    }
    return null;
  };
  const classNameFromElementToken = (expr: ts.ElementAccessExpression): string | null => {
    const index = numericIndex(expr.argumentExpression);
    if (index === null) return null;
    const el = constArrayElement(expr.expression, index);
    return el ? classNameFromToken(el) : null;
  };
  const classNameFromToken = (expr: ts.Expression): string | null => {
    const token = unwrapExpression(expr);
    if (ts.isElementAccessExpression(token)) return classNameFromElementToken(token);
    if (ts.isIdentifier(token)) {
      const src = importSourceOf(token);
      return (
        resolvedTargetName(token) ??
        (src && cleanBindingSource(src) && memberTargetsByClass.has(src.importedName) ? src.importedName : null) ??
        classNameFromLocalAlias(token)
      );
    }
    return null;
  };
  const mentionedTargetClasses = (node: ts.Node): Set<string> => {
    const out = new Set<string>();
    const walk = (n: ts.Node): void => {
      if (ts.isIdentifier(n)) {
        const className = classNameFromToken(n);
        if (className && memberTargetsByClass.has(className)) out.add(className);
      }
      ts.forEachChild(n, walk);
    };
    walk(node);
    return out;
  };
  const markMentionedTargetClassesUnsafe = (node: ts.Node): void => {
    for (const className of mentionedTargetClasses(node)) markClassUnsafe(className);
  };
  const insideNestTestingModuleCall = (node: ts.Node): boolean => {
    let current: ts.Node | undefined = node.parent;
    while (current) {
      if (ts.isCallExpression(current) && isNestTestingModuleCall(current)) return true;
      current = current.parent;
    }
    return false;
  };
  function classNameFromLocalAlias(id: ts.Identifier, seen = new Set<ts.Symbol>()): string | null {
    const sym = checker.getSymbolAtLocation(id);
    if (!sym || seen.has(sym)) return null;
    seen.add(sym);
    for (const decl of sym.getDeclarations() ?? []) {
      if (
        ts.isVariableDeclaration(decl) &&
        ts.isIdentifier(decl.name) &&
        decl.initializer &&
        checker.getSymbolAtLocation(decl.name) === sym
      ) {
        const target = classNameFromToken(decl.initializer);
        if (target) return target;
      }
    }
    return null;
  };
  const markClassUnsafe = (className: string | null): void => {
    if (!className) return;
    for (const targetName of memberTargetsByClass.get(className) ?? []) unsafeMemberTargets.add(targetName);
  };
  const propName = (name: ts.PropertyName): string | null => {
    if (ts.isIdentifier(name) || ts.isStringLiteralLike(name) || ts.isNumericLiteral(name)) return name.text;
    return null;
  };
  const propertyAccessName = (expr: ts.PropertyAccessExpression | ts.ElementAccessExpression): string | null => {
    if (ts.isPropertyAccessExpression(expr)) return expr.name.text;
    const arg = unwrapExpression(expr.argumentExpression);
    return ts.isStringLiteralLike(arg) || ts.isNumericLiteral(arg) ? arg.text : null;
  };
  const literalKey = (expr: ts.Expression): string | null => {
    const value = unwrapExpression(expr);
    if (ts.isStringLiteralLike(value) || ts.isNumericLiteral(value)) return value.text;
    if (!ts.isIdentifier(value)) return null;
    const sym = checker.getSymbolAtLocation(value);
    for (const decl of sym?.getDeclarations() ?? []) {
      if (!ts.isVariableDeclaration(decl) || !decl.initializer) continue;
      const list = decl.parent;
      if (!list || !ts.isVariableDeclarationList(list) || (list.flags & ts.NodeFlags.Const) === 0) continue;
      const init = unwrapExpression(decl.initializer);
      if (ts.isStringLiteralLike(init) || ts.isNumericLiteral(init)) return init.text;
    }
    return null;
  };
  const markTargetMemberUnsafe = (receiver: ts.Expression, method: string | null): void => {
    const className = classNameForMutableReceiver(receiver);
    if (!className) return;
    if (!method || method === "__proto__") {
      markClassUnsafe(className);
      return;
    }
    if (nameSet.has(`${className}.${method}`)) unsafeMemberTargets.add(`${className}.${method}`);
  };
  const classNameFromNestGetCall = (expr: ts.Expression): string | null => {
    return bindingFromNestGetCall(expr)?.className ?? null;
  };
  function bindingFromNestGetCall(expr: ts.Expression): NestInstanceBinding | null {
    const call = unwrapExpression(expr);
    if (
      !ts.isCallExpression(call) ||
      !ts.isPropertyAccessExpression(call.expression) ||
      call.expression.name.text !== "get" ||
      call.arguments.length === 0
    ) {
      return null;
    }
    const className = classNameFromToken(call.arguments[0]);
    if (!className || !memberTargetsByClass.has(className)) return null;
    const token = unwrapExpression(call.arguments[0]);
    const src = ts.isIdentifier(token) ? importSourceOf(token) : null;
    return { className, src, fromNest: true };
  }
  function sameClassBinding(bindings: Array<NestInstanceBinding | null>): NestInstanceBinding | null {
    const concrete = bindings.filter((b): b is NestInstanceBinding => !!b);
    if (concrete.length === 0) return null;
    const first = concrete[0];
    return concrete.every((b) => b.className === first.className) ? first : null;
  }
  function bindingFromObjectProperty(owner: ts.Expression, name: string): NestInstanceBinding | null {
    const value = unwrapExpression(owner);
    if (ts.isIdentifier(value)) {
      const sym = checker.getSymbolAtLocation(value);
      const wrapper = sym ? wrapperInstanceBindings.get(sym) : undefined;
      const wrapperField = wrapper?.fields.get(name);
      if (wrapperField) return wrapperField;
      return (sym ? objectPropertyBindings.get(sym)?.get(name) : null) ?? null;
    }
    if (ts.isObjectLiteralExpression(value)) {
      for (const prop of value.properties) {
        if (ts.isPropertyAssignment(prop) && propName(prop.name) === name) return bindingFromNestInstanceExpr(prop.initializer);
        if (ts.isGetAccessor(prop) && propName(prop.name) === name && prop.body) return bindingReturnedByBody(prop.body, []);
      }
    }
    return null;
  }
  function bindingFromArrayElement(owner: ts.Expression, index: number): NestInstanceBinding | null {
    const value = unwrapExpression(owner);
    if (ts.isIdentifier(value)) {
      const sym = checker.getSymbolAtLocation(value);
      return (sym ? arrayElementBindings.get(sym)?.get(index) : null) ?? null;
    }
    if (ts.isArrayLiteralExpression(value)) {
      const el = value.elements[index];
      return el && ts.isExpression(el) ? bindingFromNestInstanceExpr(el) : null;
    }
    if (
      ts.isCallExpression(value) &&
      (calleeText(value) === "Object.values" || mutatorNameFromExpr(value.expression) === "Object.values") &&
      value.arguments.length > 0
    ) {
      const bindings = objectLiteralValueBindings(value.arguments[0]);
      return bindings[index] ?? sameClassBinding(bindings) ?? null;
    }
    return null;
  }
  function bindingFromMapGet(call: ts.CallExpression): NestInstanceBinding | null {
    if (!ts.isPropertyAccessExpression(unwrapExpression(call.expression))) return null;
    const callee = unwrapExpression(call.expression) as ts.PropertyAccessExpression;
    if (callee.name.text !== "get" || call.arguments.length === 0) return null;
    const key = literalKey(call.arguments[0]);
    const receiver = unwrapExpression(callee.expression);
    if (!key || !ts.isIdentifier(receiver)) return null;
    const sym = checker.getSymbolAtLocation(receiver);
    return (sym ? mapEntryBindings.get(sym)?.get(key) : null) ?? null;
  }
  function bindingFromNestInstanceExpr(expr: ts.Expression): NestInstanceBinding | null {
    const receiver = unwrapExpression(expr);
    if (ts.isIdentifier(receiver)) {
      const sym = checker.getSymbolAtLocation(receiver);
      const binding = sym ? instanceBindings.get(sym) : undefined;
      return binding ?? null;
    }
    if (ts.isConditionalExpression(receiver)) {
      return sameClassBinding([bindingFromNestInstanceExpr(receiver.whenTrue), bindingFromNestInstanceExpr(receiver.whenFalse)]);
    }
    if (
      ts.isBinaryExpression(receiver) &&
      (receiver.operatorToken.kind === ts.SyntaxKind.BarBarToken ||
        receiver.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken ||
        receiver.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken)
    ) {
      return sameClassBinding([bindingFromNestInstanceExpr(receiver.left), bindingFromNestInstanceExpr(receiver.right)]);
    }
    if (ts.isPropertyAccessExpression(receiver)) return bindingFromObjectProperty(receiver.expression, receiver.name.text);
    if (ts.isElementAccessExpression(receiver)) {
      const index = numericIndex(receiver.argumentExpression);
      if (index !== null) return bindingFromArrayElement(receiver.expression, index);
      const key = literalKey(receiver.argumentExpression);
      return key ? bindingFromObjectProperty(receiver.expression, key) : null;
    }
    if (ts.isCallExpression(receiver)) {
      const nest = bindingFromNestGetCall(receiver);
      if (nest) return nest;
      const map = bindingFromMapGet(receiver);
      if (map) return map;
      if (calleeText(receiver) === "Promise.resolve" && receiver.arguments.length > 0) return bindingFromNestInstanceExpr(receiver.arguments[0]);
      return bindingFromPassThroughCall(receiver);
    }
    return bindingFromNestGetCall(receiver);
  }
  const classNameFromNestInstanceExpr = (expr: ts.Expression): string | null => bindingFromNestInstanceExpr(expr)?.className ?? null;
  const classNameFromConstructorExpr = (expr: ts.Expression): string | null => {
    const receiver = unwrapExpression(expr);
    if (ts.isIdentifier(receiver)) {
      const sym = checker.getSymbolAtLocation(receiver);
      return (sym ? constructorBindings.get(sym) : null) ?? classNameFromToken(receiver);
    }
    if (ts.isPropertyAccessExpression(receiver) && receiver.name.text === "constructor") {
      return classNameFromNestInstanceExpr(receiver.expression);
    }
    return null;
  };
  const classNameFromPrototypeExpr = (expr: ts.Expression): string | null => {
    const receiver = unwrapExpression(expr);
    if (ts.isIdentifier(receiver)) {
      const sym = checker.getSymbolAtLocation(receiver);
      return sym ? prototypeBindings.get(sym) ?? null : null;
    }
    if (ts.isPropertyAccessExpression(receiver)) {
      if (receiver.name.text === "prototype") return classNameFromConstructorExpr(receiver.expression);
      if (receiver.name.text === "__proto__") return classNameFromNestInstanceExpr(receiver.expression);
    }
    if (
      ts.isCallExpression(receiver) &&
      (mutatorNameFromExpr(receiver.expression) === "Object.getPrototypeOf" ||
        mutatorNameFromExpr(receiver.expression) === "Reflect.getPrototypeOf" ||
        calleeText(receiver) === "Object.getPrototypeOf" ||
        calleeText(receiver) === "Reflect.getPrototypeOf") &&
      receiver.arguments.length > 0
    ) {
      return classNameFromNestInstanceExpr(receiver.arguments[0]);
    }
    return null;
  };
  function bindingReturnedByBody(body: ts.ConciseBody, args: readonly ts.Expression[]): NestInstanceBinding | null {
    const bindingFromReturnExpr = (expr: ts.Expression): NestInstanceBinding | null => {
      const ret = unwrapExpression(expr);
      if (ts.isIdentifier(ret)) {
        const sym = checker.getSymbolAtLocation(ret);
        const paramIndex = sym
          ? args.findIndex((_, index) => {
              const fn = body.parent;
              return (
                (ts.isFunctionExpression(fn) || ts.isArrowFunction(fn) || ts.isFunctionDeclaration(fn) || ts.isMethodDeclaration(fn)) &&
                !!fn.parameters[index] &&
                ts.isIdentifier(fn.parameters[index].name) &&
                checker.getSymbolAtLocation(fn.parameters[index].name) === sym
              );
            })
          : -1;
        if (paramIndex >= 0) return bindingFromNestInstanceExpr(args[paramIndex]);
      }
      return bindingFromNestInstanceExpr(ret);
    };
    if (ts.isExpression(body)) return bindingFromReturnExpr(body);
    let out: NestInstanceBinding | null = null;
    const walk = (n: ts.Node): void => {
      if (out) return;
      if (ts.isReturnStatement(n) && n.expression) {
        out = bindingFromReturnExpr(n.expression);
        return;
      }
      ts.forEachChild(n, walk);
    };
    walk(body);
    return out;
  }
  const bindingFromPassThroughCall = (expr: ts.Expression): NestInstanceBinding | null => {
    const call = unwrapExpression(expr);
    if (!ts.isCallExpression(call)) return null;
    const fn = functionDeclForCallee(call.expression);
    if (!fn?.body) return null;
    return bindingReturnedByBody(fn.body, call.arguments);
  };
  const classNameForMutableReceiver = (expr: ts.Expression): string | null =>
    classNameFromNestInstanceExpr(expr) ?? classNameFromPrototypeExpr(expr);
  const objectProp = (obj: ts.ObjectLiteralExpression, name: string): ts.Expression | null => {
    for (const p of obj.properties) {
      if (!ts.isPropertyAssignment(p) || propName(p.name) !== name) continue;
      return p.initializer;
    }
    return null;
  };
  function objectLiteralValueBindings(expr: ts.Expression): Array<NestInstanceBinding | null> {
    const value = unwrapExpression(expr);
    if (!ts.isObjectLiteralExpression(value)) return [];
    const out: Array<NestInstanceBinding | null> = [];
    for (const prop of value.properties) {
      if (ts.isPropertyAssignment(prop)) out.push(bindingFromNestInstanceExpr(prop.initializer));
      else if (ts.isShorthandPropertyAssignment(prop)) {
        const valueSym = checker.getShorthandAssignmentValueSymbol(prop);
        out.push(valueSym ? instanceBindings.get(valueSym) ?? null : bindingFromNestInstanceExpr(prop.name));
      }
      else if (ts.isSpreadAssignment(prop)) out.push(...objectLiteralValueBindings(prop.expression));
      else if (ts.isGetAccessor(prop) && prop.body) out.push(bindingReturnedByBody(prop.body, []));
    }
    return out;
  }
  function classDeclarationForNewExpression(expr: ts.NewExpression): ts.ClassDeclaration | null {
    if (!ts.isIdentifier(expr.expression)) return null;
    const sym = checker.getSymbolAtLocation(expr.expression);
    for (const decl of sym?.getDeclarations() ?? []) {
      if (ts.isClassDeclaration(decl)) return decl;
    }
    return null;
  }
  function wrapperFieldsForNewExpression(expr: ts.NewExpression): WrapperInstanceBinding | null {
    const classDecl = classDeclarationForNewExpression(expr);
    if (!classDecl) return null;
    const ctor = classDecl.members.find(ts.isConstructorDeclaration);
    if (!ctor?.body) return null;
    const paramSymbols = ctor.parameters.map((param) => (ts.isIdentifier(param.name) ? checker.getSymbolAtLocation(param.name) ?? null : null));
    const fields = new Map<string, NestInstanceBinding>();
    const walk = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const left = unwrapExpression(n.left);
        const right = unwrapExpression(n.right);
        if (
          ts.isPropertyAccessExpression(left) &&
          left.expression.kind === ts.SyntaxKind.ThisKeyword &&
          ts.isIdentifier(right)
        ) {
          const paramIndex = paramSymbols.findIndex((sym) => sym && checker.getSymbolAtLocation(right) === sym);
          const arg = paramIndex >= 0 ? expr.arguments?.[paramIndex] : undefined;
          const binding = arg ? bindingFromNestInstanceExpr(arg) : null;
          if (binding) fields.set(left.name.text, binding);
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(ctor.body);
    return fields.size > 0 ? { classDecl, fields } : null;
  }
  function recordObjectPropertyBindings(id: ts.Identifier, expr: ts.Expression): void {
    const sym = checker.getSymbolAtLocation(id);
    if (!sym) return;
    const value = unwrapExpression(expr);
    if (!ts.isObjectLiteralExpression(value)) return;
    const props = new Map<string, NestInstanceBinding>();
    for (const prop of value.properties) {
      if (ts.isPropertyAssignment(prop)) {
        const name = propName(prop.name);
        const binding = bindingFromNestInstanceExpr(prop.initializer);
        if (name && binding) props.set(name, binding);
      } else if (ts.isShorthandPropertyAssignment(prop)) {
        const valueSym = checker.getShorthandAssignmentValueSymbol(prop);
        const binding = valueSym ? instanceBindings.get(valueSym) ?? null : bindingFromNestInstanceExpr(prop.name);
        if (binding) props.set(prop.name.text, binding);
      } else if (ts.isGetAccessor(prop) && prop.body) {
        const name = propName(prop.name);
        const binding = bindingReturnedByBody(prop.body, []);
        if (name && binding) props.set(name, binding);
      } else if (ts.isSpreadAssignment(prop)) {
        const spread = unwrapExpression(prop.expression);
        if (ts.isIdentifier(spread)) {
          const spreadSym = checker.getSymbolAtLocation(spread);
          for (const [key, binding] of objectPropertyBindings.get(spreadSym!) ?? []) props.set(key, binding);
        }
      }
    }
    if (props.size > 0) objectPropertyBindings.set(sym, props);
  }
  function recordArrayElementBindings(id: ts.Identifier, expr: ts.Expression): void {
    const sym = checker.getSymbolAtLocation(id);
    if (!sym) return;
    const value = unwrapExpression(expr);
    if (!ts.isArrayLiteralExpression(value)) return;
    const elements = new Map<number, NestInstanceBinding>();
    value.elements.forEach((element, index) => {
      if (!ts.isExpression(element)) return;
      const binding = bindingFromNestInstanceExpr(element);
      if (binding) elements.set(index, binding);
    });
    if (elements.size > 0) arrayElementBindings.set(sym, elements);
  }
  function recordMapEntryBindings(id: ts.Identifier, expr: ts.Expression): void {
    const sym = checker.getSymbolAtLocation(id);
    if (!sym) return;
    const value = unwrapExpression(expr);
    if (!ts.isNewExpression(value) || !ts.isIdentifier(value.expression) || value.expression.text !== "Map" || !value.arguments?.length) return;
    const entries = unwrapExpression(value.arguments[0]);
    if (!ts.isArrayLiteralExpression(entries)) return;
    const map = new Map<string, NestInstanceBinding>();
    for (const entry of entries.elements) {
      const tuple = ts.isExpression(entry) ? unwrapExpression(entry) : null;
      if (!tuple || !ts.isArrayLiteralExpression(tuple) || tuple.elements.length < 2) continue;
      const keyExpr = tuple.elements[0];
      const valueExpr = tuple.elements[1];
      if (!ts.isExpression(keyExpr) || !ts.isExpression(valueExpr)) continue;
      const key = literalKey(keyExpr);
      const binding = bindingFromNestInstanceExpr(valueExpr);
      if (key && binding) map.set(key, binding);
    }
    if (map.size > 0) mapEntryBindings.set(sym, map);
  }
  function recordWrapperInstanceBinding(id: ts.Identifier, expr: ts.Expression): void {
    const sym = checker.getSymbolAtLocation(id);
    const value = unwrapExpression(expr);
    if (!sym || !ts.isNewExpression(value)) return;
    const binding = wrapperFieldsForNewExpression(value);
    if (binding) wrapperInstanceBindings.set(sym, binding);
  }
  function recordContainerBindings(id: ts.Identifier, expr: ts.Expression): void {
    recordObjectPropertyBindings(id, expr);
    recordArrayElementBindings(id, expr);
    recordMapEntryBindings(id, expr);
    recordWrapperInstanceBinding(id, expr);
  }
  const markObjectLiteralMembersUnsafe = (className: string, obj: ts.ObjectLiteralExpression): void => {
    for (const p of obj.properties) {
      if (ts.isSpreadAssignment(p)) {
        markClassUnsafe(className);
        continue;
      }
      const name = "name" in p ? propName(p.name) : null;
      if (!name) {
        markClassUnsafe(className);
        continue;
      }
      if (nameSet.has(`${className}.${name}`)) unsafeMemberTargets.add(`${className}.${name}`);
    }
  };
  function mutatorNameFromExpr(expr: ts.Expression): string | null {
    const callee = unwrapExpression(expr);
    if (ts.isIdentifier(callee)) {
      const sym = checker.getSymbolAtLocation(callee);
      return sym ? mutatorAliases.get(sym) ?? null : null;
    }
    if (ts.isPropertyAccessExpression(callee)) {
      const root = unwrapExpression(callee.expression);
      if (ts.isIdentifier(root) && (root.text === "Object" || root.text === "Reflect" || root.text === "jest")) {
        return `${root.text}.${callee.name.text}`;
      }
      if (callee.name.text === "__defineGetter__" || callee.name.text === "__defineSetter__") return callee.name.text;
    }
    if (ts.isElementAccessExpression(callee)) {
      const root = unwrapExpression(callee.expression);
      const key = unwrapExpression(callee.argumentExpression);
      if (ts.isIdentifier(root) && ts.isStringLiteralLike(key) && (root.text === "Object" || root.text === "Reflect" || root.text === "jest")) {
        return `${root.text}.${key.text}`;
      }
    }
    return null;
  }
  const bindMutatorAlias = (id: ts.Identifier, expr: ts.Expression): void => {
    const name = mutatorNameFromExpr(expr);
    if (!name) return;
    const sym = checker.getSymbolAtLocation(id);
    if (sym) mutatorAliases.set(sym, name);
  };
  const isAssignmentOperatorKind = (kind: ts.SyntaxKind): boolean =>
    kind >= ts.SyntaxKind.FirstAssignment && kind <= ts.SyntaxKind.LastAssignment;
  const hasNestSubstitution = (obj: ts.ObjectLiteralExpression): boolean =>
    ["useValue", "useClass", "useFactory", "useExisting"].some((name) => objectProp(obj, name) !== null);
  const markNestProviderSubstitution = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node) && hasNestSubstitution(node)) {
      const provide = objectProp(node, "provide");
      const className = provide ? classNameFromToken(provide) : null;
      if (className) markClassUnsafe(className);
      else markMentionedTargetClassesUnsafe(provide ?? node);
    }
  };
  function functionDeclForCallee(expr: ts.Expression): ts.FunctionLikeDeclaration | null {
    const callee = unwrapExpression(expr);
    if (!ts.isIdentifier(callee)) return null;
    const sym = checker.getSymbolAtLocation(callee);
    for (const decl of sym?.getDeclarations() ?? []) {
      if (ts.isFunctionDeclaration(decl) || ts.isFunctionExpression(decl) || ts.isArrowFunction(decl) || ts.isMethodDeclaration(decl)) {
        return decl;
      }
      if (ts.isVariableDeclaration(decl) && decl.initializer) {
        const init = unwrapExpression(decl.initializer);
        if (ts.isFunctionExpression(init) || ts.isArrowFunction(init)) return init;
      }
    }
    return null;
  }
  const classNamesContainedInExpression = (expr: ts.Expression, out = new Set<string>()): Set<string> => {
    const value = unwrapExpression(expr);
    const direct = classNameForMutableReceiver(value);
    if (direct) out.add(direct);
    if (ts.isObjectLiteralExpression(value)) {
      for (const prop of value.properties) {
        if (ts.isPropertyAssignment(prop)) classNamesContainedInExpression(prop.initializer, out);
        else if (ts.isSpreadAssignment(prop)) classNamesContainedInExpression(prop.expression, out);
      }
    } else if (ts.isArrayLiteralExpression(value)) {
      for (const el of value.elements) if (ts.isExpression(el)) classNamesContainedInExpression(el, out);
    }
    return out;
  };
  const functionMutatesParameter = (fn: ts.FunctionLikeDeclaration, index: number, seen = new Set<ts.FunctionLikeDeclaration>()): boolean => {
    if (seen.has(fn)) return false;
    seen.add(fn);
    const param = fn.parameters[index];
    if (!param || !ts.isIdentifier(param.name)) return false;
    const paramSym = checker.getSymbolAtLocation(param.name);
    if (!paramSym || !fn.body) return false;
    let mutates = false;
    const isParamRef = (expr: ts.Expression): boolean => {
      const receiver = unwrapExpression(expr);
      return ts.isIdentifier(receiver) && checker.getSymbolAtLocation(receiver) === paramSym;
    };
    const isParamDerived = (expr: ts.Expression): boolean => {
      const value = unwrapExpression(expr);
      if (isParamRef(value)) return true;
      if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) return isParamDerived(value.expression);
      if (
        ts.isCallExpression(value) &&
        (mutatorNameFromExpr(value.expression) === "Object.getPrototypeOf" || mutatorNameFromExpr(value.expression) === "Reflect.getPrototypeOf") &&
        value.arguments.length > 0
      ) {
        return isParamDerived(value.arguments[0]);
      }
      return false;
    };
    const walk = (n: ts.Node): void => {
      if (mutates) return;
      if (ts.isBinaryExpression(n) && isAssignmentOperatorKind(n.operatorToken.kind)) {
        const left = unwrapExpression(n.left);
        const right = unwrapExpression(n.right);
        if (ts.isIdentifier(left) && isParamDerived(right)) {
          mutates = true;
          return;
        }
        if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && isParamRef(left.expression)) {
          mutates = true;
          return;
        }
        if ((ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) && isParamDerived(left.expression)) {
          mutates = true;
          return;
        }
      }
      if (ts.isCallExpression(n)) {
        const name = mutatorNameFromExpr(n.expression);
        if (
          name &&
          n.arguments.length > 0 &&
          isParamRef(n.arguments[0]) &&
          (name === "Object.assign" ||
            name === "Object.defineProperty" ||
            name === "Reflect.defineProperty" ||
            name === "Reflect.set" ||
            name === "Object.defineProperties" ||
            name === "Object.setPrototypeOf" ||
            name === "Reflect.setPrototypeOf" ||
            /(^|\.)replaceProperty$/.test(name))
        ) {
          mutates = true;
          return;
        }
        const called = functionDeclForCallee(n.expression);
        if (called) {
          for (let argIndex = 0; argIndex < n.arguments.length; argIndex += 1) {
            if (isParamDerived(n.arguments[argIndex]) && functionMutatesParameter(called, argIndex, seen)) {
              mutates = true;
              return;
            }
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(fn.body);
    return mutates;
  };
  const markHelperMutation = (node: ts.CallExpression): void => {
    const fn = functionDeclForCallee(node.expression);
    if (!fn) return;
    node.arguments.forEach((arg, index) => {
      if (!functionMutatesParameter(fn, index)) return;
      const classes = classNamesContainedInExpression(arg);
      const directCtor = classNameFromConstructorExpr(arg);
      if (directCtor) classes.add(directCtor);
      for (const className of classes) markClassUnsafe(className);
    });
  };
  const markWrapperMethodMutation = (node: ts.CallExpression): void => {
    const callee = unwrapExpression(node.expression);
    if (!ts.isPropertyAccessExpression(callee)) return;
    const receiver = unwrapExpression(callee.expression);
    if (!ts.isIdentifier(receiver)) return;
    const receiverSym = checker.getSymbolAtLocation(receiver);
    const wrapper = receiverSym ? wrapperInstanceBindings.get(receiverSym) : undefined;
    if (!wrapper) return;
    const method = wrapper.classDecl.members.find((member): member is ts.MethodDeclaration => {
      return ts.isMethodDeclaration(member) && !!member.name && propName(member.name) === callee.name.text;
    });
    if (!method?.body) return;
    const classForThisProp = (expr: ts.Expression): string | null => {
      const value = unwrapExpression(expr);
      if (
        ts.isPropertyAccessExpression(value) &&
        value.expression.kind === ts.SyntaxKind.ThisKeyword
      ) {
        return wrapper.fields.get(value.name.text)?.className ?? null;
      }
      if (ts.isPropertyAccessExpression(value) || ts.isElementAccessExpression(value)) return classForThisProp(value.expression);
      return null;
    };
    const walk = (n: ts.Node): void => {
      if (ts.isBinaryExpression(n) && isAssignmentOperatorKind(n.operatorToken.kind)) {
        const left = unwrapExpression(n.left);
        if (ts.isPropertyAccessExpression(left) || ts.isElementAccessExpression(left)) {
          const className = classForThisProp(left.expression);
          const memberName = propertyAccessName(left);
          if (className && memberName) {
            if (nameSet.has(`${className}.${memberName}`)) unsafeMemberTargets.add(`${className}.${memberName}`);
            else markClassUnsafe(className);
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(method.body);
  };
  const markTupleMutationSeed = (expr: ts.Expression): void => {
    const root = unwrapExpression(expr);
    if (!ts.isArrayLiteralExpression(root)) return;
    const scan = (arr: ts.ArrayLiteralExpression): void => {
      for (const element of arr.elements) {
        if (!ts.isExpression(element)) continue;
        const e = unwrapExpression(element);
        if (ts.isArrayLiteralExpression(e)) {
          const className = e.elements.find((el): el is ts.Expression => ts.isExpression(el) && !!classNameForMutableReceiver(el));
          const method = e.elements
            .filter((el): el is ts.Expression => ts.isExpression(el))
            .map((el) => {
              const v = unwrapExpression(el);
              return ts.isStringLiteralLike(v) || ts.isNumericLiteral(v) ? v.text : null;
            })
            .find((v): v is string => !!v);
          const hasFn = e.elements.some((el) => ts.isExpression(el) && (ts.isArrowFunction(unwrapExpression(el)) || ts.isFunctionExpression(unwrapExpression(el))));
          const resolvedClass = className ? classNameForMutableReceiver(className) : null;
          if (resolvedClass && hasFn) {
            if (method && nameSet.has(`${resolvedClass}.${method}`)) unsafeMemberTargets.add(`${resolvedClass}.${method}`);
            else markClassUnsafe(resolvedClass);
          }
          scan(e);
        }
      }
    };
    scan(root);
  };
  const markSpyOrPatch = (node: ts.CallExpression): void => {
    const c = mutatorNameFromExpr(node.expression) ?? calleeText(node);
    if (c === "overrideProvider" && node.arguments.length > 0) {
      const className = classNameFromToken(node.arguments[0]);
      if (className) markClassUnsafe(className);
      else markMentionedTargetClassesUnsafe(node.arguments[0]);
    }
    if (!isNestTestingModuleCall(node) && insideNestTestingModuleCall(node)) {
      markMentionedTargetClassesUnsafe(node);
    }
    markHelperMutation(node);
    markWrapperMethodMutation(node);
    const calleeExpr = unwrapExpression(node.expression);
    if (ts.isPropertyAccessExpression(calleeExpr) && calleeExpr.name.text === "push" && node.arguments.length > 0) {
      const receiver = unwrapExpression(calleeExpr.expression);
      const binding = bindingFromNestInstanceExpr(node.arguments[0]);
      if (binding && ts.isIdentifier(receiver)) {
        const sym = checker.getSymbolAtLocation(receiver);
        if (sym) {
          const existing = arrayElementBindings.get(sym) ?? new Map<number, NestInstanceBinding>();
          const next = existing.size === 0 ? 0 : Math.max(...existing.keys()) + 1;
          existing.set(next, binding);
          arrayElementBindings.set(sym, existing);
        }
      }
    }
    if (ts.isPropertyAccessExpression(unwrapExpression(node.expression)) && (unwrapExpression(node.expression) as ts.PropertyAccessExpression).name.text === "set") {
      const receiver = unwrapExpression((unwrapExpression(node.expression) as ts.PropertyAccessExpression).expression);
      const key = node.arguments.length > 0 ? literalKey(node.arguments[0]) : null;
      const value = node.arguments[1] ? bindingFromNestInstanceExpr(node.arguments[1]) : null;
      if (key && value && ts.isIdentifier(receiver)) {
        const sym = checker.getSymbolAtLocation(receiver);
        if (sym) {
          const existing = mapEntryBindings.get(sym) ?? new Map<string, NestInstanceBinding>();
          existing.set(key, value);
          mapEntryBindings.set(sym, existing);
        }
      }
    }
    if (c === "Object.assign" && node.arguments.length > 1) {
      const className = classNameForMutableReceiver(node.arguments[0]);
      if (className) {
        for (const arg of node.arguments.slice(1)) {
          const source = unwrapExpression(arg);
          if (!ts.isObjectLiteralExpression(source)) {
            markClassUnsafe(className);
            continue;
          }
          markObjectLiteralMembersUnsafe(className, source);
        }
      }
    }
    if (c === "Object.defineProperties" && node.arguments.length > 1) {
      const className = classNameForMutableReceiver(node.arguments[0]);
      const descriptors = unwrapExpression(node.arguments[1]);
      if (className && ts.isObjectLiteralExpression(descriptors)) markObjectLiteralMembersUnsafe(className, descriptors);
      else if (className) markClassUnsafe(className);
    }
    if (
      (c === "Object.defineProperty" || c === "Reflect.defineProperty" || c === "Reflect.set" || /(^|\.)replaceProperty$/.test(c)) &&
      node.arguments.length > 1
    ) {
      const methodArg = unwrapExpression(node.arguments[1]);
      const method = ts.isStringLiteralLike(methodArg) || ts.isNumericLiteral(methodArg) ? methodArg.text : null;
      markTargetMemberUnsafe(node.arguments[0], method);
    }
    if ((c === "Object.setPrototypeOf" || c === "Reflect.setPrototypeOf") && node.arguments.length > 0) {
      markClassUnsafe(classNameForMutableReceiver(node.arguments[0]));
    }
    if ((c === "__defineGetter__" || c === "__defineSetter__") && ts.isPropertyAccessExpression(unwrapExpression(node.expression)) && node.arguments.length > 0) {
      const receiver = unwrapExpression(node.expression) as ts.PropertyAccessExpression;
      const methodArg = unwrapExpression(node.arguments[0]);
      const method = ts.isStringLiteralLike(methodArg) || ts.isNumericLiteral(methodArg) ? methodArg.text : null;
      markTargetMemberUnsafe(receiver.expression, method);
    }
    if (/(^|\.)spyOn$/.test(c) && node.arguments.length >= 2 && ts.isStringLiteralLike(node.arguments[1])) {
      markTargetMemberUnsafe(node.arguments[0], node.arguments[1].text);
    }
  };
  const markMemberAssignment = (node: ts.BinaryExpression): void => {
    if (!isAssignmentOperatorKind(node.operatorToken.kind)) return;
    const left = unwrapExpression(node.left);
    if (!ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return;
    const memberName = propertyAccessName(left);
    markTargetMemberUnsafe(left.expression, memberName);
  };
  const recordMemberAliasAssignment = (node: ts.BinaryExpression): void => {
    if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) return;
    const left = unwrapExpression(node.left);
    if (!ts.isPropertyAccessExpression(left) && !ts.isElementAccessExpression(left)) return;
    const binding = bindingFromNestInstanceExpr(node.right);
    if (!binding) return;
    const receiver = unwrapExpression(left.expression);
    if (!ts.isIdentifier(receiver)) return;
    const sym = checker.getSymbolAtLocation(receiver);
    if (!sym) return;
    if (ts.isPropertyAccessExpression(left)) {
      const existing = objectPropertyBindings.get(sym) ?? new Map<string, NestInstanceBinding>();
      existing.set(left.name.text, binding);
      objectPropertyBindings.set(sym, existing);
      return;
    }
    const index = numericIndex(left.argumentExpression);
    const key = index === null ? literalKey(left.argumentExpression) : null;
    if (index !== null) {
      const existing = arrayElementBindings.get(sym) ?? new Map<number, NestInstanceBinding>();
      existing.set(index, binding);
      arrayElementBindings.set(sym, existing);
    } else if (key) {
      const existing = objectPropertyBindings.get(sym) ?? new Map<string, NestInstanceBinding>();
      existing.set(key, binding);
      objectPropertyBindings.set(sym, existing);
    }
  };
  const classBindingFromExpr = (expr: ts.Expression, requireNest: boolean): { className: string; src: BindingSource | null; fromNest: boolean } | null => {
    const value = unwrapExpression(expr);
    if (ts.isIdentifier(value)) {
      const sym = checker.getSymbolAtLocation(value);
      const binding = sym ? instanceBindings.get(sym) : undefined;
      if (binding) return binding;
    }
    if (ts.isNewExpression(value) && ts.isIdentifier(value.expression)) {
      const src = importSourceOf(value.expression);
      const resolved = classNameFromToken(value.expression);
      if (!resolved || !memberTargetsByClass.has(resolved)) return null;
      return { className: resolved, src, fromNest: false };
    }
    const nestClass = classNameFromNestGetCall(value);
    if (nestClass) {
      if (requireNest && !hasNestTestingModuleHarness) return null;
      const call = unwrapExpression(value) as ts.CallExpression;
      const token = unwrapExpression(call.arguments[0]);
      const src = ts.isIdentifier(token) ? importSourceOf(token) : null;
      return { className: nestClass, src, fromNest: true };
    }
    return bindingFromNestInstanceExpr(value);
  };
  const maybeBindInstance = (name: ts.Identifier, expr: ts.Expression): void => {
    const binding = classBindingFromExpr(expr, true);
    if (!binding) return;
    const sym = checker.getSymbolAtLocation(name);
    if (sym) instanceBindings.set(sym, binding);
  };
  const maybeBindDerivedIdentity = (name: ts.Identifier, expr: ts.Expression): void => {
    bindMutatorAlias(name, expr);
    const sym = checker.getSymbolAtLocation(name);
    if (!sym) return;
    const ctorClass = classNameFromConstructorExpr(expr);
    if (ctorClass) constructorBindings.set(sym, ctorClass);
    const protoClass = classNameFromPrototypeExpr(expr);
    if (protoClass) prototypeBindings.set(sym, protoClass);
  };
  const bindArrayPatternElements = (pattern: ts.ArrayBindingPattern, initializer: ts.Expression): void => {
    const source = unwrapExpression(initializer);
    if (!ts.isArrayLiteralExpression(source)) return;
    pattern.elements.forEach((element, index) => {
      if (!ts.isBindingElement(element) || !ts.isIdentifier(element.name)) return;
      const value = source.elements[index];
      if (value && ts.isExpression(value)) {
        maybeBindInstance(element.name, value);
        maybeBindDerivedIdentity(element.name, value);
      }
    });
  };
  const memberUseForReceiver = (id: ts.Identifier): { targetName: string; use: RuntimeUse } | null => {
    const p = id.parent;
    if (!p || !ts.isPropertyAccessExpression(p) || p.expression !== id || !ts.isIdentifier(p.name)) return null;
    const call = p.parent;
    if (!call || !ts.isCallExpression(call) || call.expression !== p) return null;
    const sym = checker.getSymbolAtLocation(id);
    const binding = sym ? instanceBindings.get(sym) : undefined;
    if (!binding) return null;
    const targetName = `${binding.className}.${p.name.text}`;
    if (!nameSet.has(targetName)) return null;
    if (binding.fromNest) {
      stateFor(targetName).nonRuntimeReasons.add(NEST_DI_ASSOCIATED_REASON);
      return null;
    }
    if (unsafeMemberTargets.has(targetName)) {
      stateFor(targetName).nonRuntimeReasons.add("NestJS provider or target method is substituted/mocked");
      return null;
    }
    const tb = enclosingTestBlock(call);
    if (!tb) {
      stateFor(targetName).nonRuntimeReasons.add("runtime use is outside any test block");
      return null;
    }
    return {
      targetName,
      use: {
        node: p.name,
        useExpr: call,
        kind: "value",
        block: tb,
        src: binding.src,
      }
    };
  };
  const memberUseForCall = (call: ts.CallExpression): { targetName: string; use: RuntimeUse } | null => {
    const callee = unwrapExpression(call.expression);
    if (!ts.isPropertyAccessExpression(callee)) return null;
    if (!ts.isIdentifier(callee.name)) return null;
    const method = callee.name.text;
    const binding = bindingFromNestInstanceExpr(callee.expression);
    if (!binding) return null;
    const targetName = `${binding.className}.${method}`;
    if (!nameSet.has(targetName)) return null;
    if (binding.fromNest) {
      stateFor(targetName).nonRuntimeReasons.add(NEST_DI_ASSOCIATED_REASON);
      return null;
    }
    if (unsafeMemberTargets.has(targetName)) {
      stateFor(targetName).nonRuntimeReasons.add("NestJS provider or target method is substituted/mocked");
      return null;
    }
    const tb = enclosingTestBlock(call);
    if (!tb) {
      stateFor(targetName).nonRuntimeReasons.add("runtime use is outside any test block");
      return null;
    }
    return {
      targetName,
      use: {
        node: callee.name,
        useExpr: call,
        kind: "value",
        block: tb,
        src: binding.src,
      }
    };
  };
  const helperMemberUsesForCall = (call: ts.CallExpression): Array<{ targetName: string; use: RuntimeUse }> => {
    const fn = functionDeclForCallee(call.expression);
    if (!fn?.body) return [];
    const body = fn.body;
    const out: Array<{ targetName: string; use: RuntimeUse }> = [];
    fn.parameters.forEach((param, index) => {
      if (!ts.isIdentifier(param.name)) return;
      const arg = call.arguments[index];
      const binding = arg ? bindingFromNestInstanceExpr(arg) : null;
      if (!binding) return;
      const paramSym = checker.getSymbolAtLocation(param.name);
      if (!paramSym) return;
      if (binding.fromNest) {
        const markNestDiUse = (n: ts.Node): void => {
          if (ts.isCallExpression(n)) {
            const callee = unwrapExpression(n.expression);
            if (
              ts.isPropertyAccessExpression(callee) &&
              ts.isIdentifier(callee.name) &&
              ts.isIdentifier(unwrapExpression(callee.expression)) &&
              checker.getSymbolAtLocation(unwrapExpression(callee.expression) as ts.Identifier) === paramSym
            ) {
              const targetName = `${binding.className}.${callee.name.text}`;
              if (nameSet.has(targetName)) stateFor(targetName).nonRuntimeReasons.add(NEST_DI_ASSOCIATED_REASON);
            }
          }
          ts.forEachChild(n, markNestDiUse);
        };
        markNestDiUse(body);
        return;
      }
      const walk = (n: ts.Node): void => {
        if (ts.isCallExpression(n)) {
          const callee = unwrapExpression(n.expression);
          if (
            ts.isPropertyAccessExpression(callee) &&
            ts.isIdentifier(callee.name) &&
            ts.isIdentifier(unwrapExpression(callee.expression)) &&
            checker.getSymbolAtLocation(unwrapExpression(callee.expression) as ts.Identifier) === paramSym
          ) {
            const targetName = `${binding.className}.${callee.name.text}`;
            if (nameSet.has(targetName) && !unsafeMemberTargets.has(targetName)) {
              const tb = enclosingTestBlock(call);
              if (tb) {
                out.push({
                  targetName,
                  use: {
                    node: ts.isIdentifier(unwrapExpression(call.expression)) ? (unwrapExpression(call.expression) as ts.Identifier) : callee.name,
                    useExpr: call,
                    kind: "value",
                    block: tb,
                    src: binding.src,
                  }
                });
              }
            }
          }
        }
        ts.forEachChild(n, walk);
      };
      walk(body);
    });
    return out;
  };

  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const c = calleeText(node);
      if (isNestTestingModuleCall(node)) hasNestTestingModuleHarness = true;
      markSpyOrPatch(node);
      const callMemberUse = memberUseForCall(node);
      if (callMemberUse) stateFor(callMemberUse.targetName).runtimeUses.push(callMemberUse.use);
      for (const helperUse of helperMemberUsesForCall(node)) stateFor(helperUse.targetName).runtimeUses.push(helperUse.use);
      if (MODULE_MOCK_CALLEES.has(c)) {
        const spec = mockSpecifier(node.arguments[0]);
        if (spec) {
          mockedSpecifiers.add(spec);
          const r = resolveImport(spec, testAbsPath);
          if (r.resolvedFileName) mockedFiles.add(norm(r.resolvedFileName));
        }
      }
      // Count framework render()/mount() calls per test block — a render effect can only
      // be tied to a SINGLE render in the block (multiple distinct renders are ambiguous).
      if (isFrameworkRenderCall(node)) {
        const rb = enclosingTestBlock(node);
        // Only LIVE renders count — an uninvoked nested render must not create the use AND
        // satisfy the "exactly one render" check (Codex round-5).
        if (rb && isLivePosition(node, rb)) renderCallsByBlock.set(rb, (renderCallsByBlock.get(rb) ?? 0) + 1);
      }
      const aKind = assertionKind(node);
      // An `assert*` call counts ONLY when its callee resolves to a trusted assert
      // module (node:assert/chai); a LOCAL no-op `assert` cannot fake evidence.
      if (aKind && (aKind !== "assert" || isTrustedAssert(node))) {
        const tb = enclosingTestBlock(node);
        if (tb) assertions.push({ call: node, block: tb, kind: aKind });
      }
    }
    markNestProviderSubstitution(node);
    if (ts.isVariableDeclaration(node) && node.initializer) {
      markTupleMutationSeed(node.initializer);
      if (ts.isIdentifier(node.name)) {
        recordContainerBindings(node.name, node.initializer);
        maybeBindInstance(node.name, node.initializer);
        maybeBindDerivedIdentity(node.name, node.initializer);
      } else if (ts.isArrayBindingPattern(node.name)) {
        bindArrayPatternElements(node.name, node.initializer);
      }
    } else if (ts.isBinaryExpression(node)) {
      markMemberAssignment(node);
      recordMemberAliasAssignment(node);
      if (
        node.operatorToken.kind !== ts.SyntaxKind.EqualsToken &&
        isAssignmentOperatorKind(node.operatorToken.kind) &&
        ts.isIdentifier(node.left)
      ) {
        const sym = checker.getSymbolAtLocation(node.left);
        const binding = sym ? instanceBindings.get(sym) : undefined;
        if (sym && binding) {
          markClassUnsafe(binding.className);
          instanceBindings.delete(sym);
        }
      }
      if (node.operatorToken.kind !== ts.SyntaxKind.EqualsToken) {
        ts.forEachChild(node, visit);
        return;
      }
      if (!ts.isIdentifier(node.left)) {
        ts.forEachChild(node, visit);
        return;
      }
      const sym = checker.getSymbolAtLocation(node.left);
      const binding = classBindingFromExpr(node.right, true);
      if (binding && sym) instanceBindings.set(sym, binding);
      else if (sym && instanceBindings.has(sym)) instanceBindings.delete(sym);
      if (ts.isIdentifier(node.left)) maybeBindDerivedIdentity(node.left, node.right);
    }
    if (ts.isIdentifier(node)) {
      const anc = classifyAncestors(node);
      const memberUse = !anc.inImportOrExport && !anc.inTypeContext && !anc.inSkipped && !anc.inMockFactory ? memberUseForReceiver(node) : null;
      if (memberUse) {
        stateFor(memberUse.targetName).runtimeUses.push(memberUse.use);
        return;
      }
      const target = resolvedTargetName(node);
      if (target && !anc.inImportOrExport) {
        const targetNames = targetNamesForResolved(target);
        let kind = runtimeUseKind(node);
        // A bare JSX <X/> only counts as a render use when actually framework-rendered;
        // remember WHICH render call mounts it (its position drives the ordering check).
        let renderCall: ts.CallExpression | null = null;
        if (kind === "render") {
          renderCall = jsxRenderCall(node);
          if (!renderCall) kind = null;
        }
        // render-arg (`render(X)`) is a render use ONLY when the render helper
        // resolves to a real test framework — a local `render` may ignore its arg.
        if (!kind) {
          const p = node.parent;
          if (
            p &&
            ts.isCallExpression(p) &&
            p.arguments.includes(node as ts.Expression) &&
            isFrameworkRenderCall(p) &&
            renderCallIsLive(p)
          ) {
            kind = "render";
            renderCall = p;
          }
        }
        for (const targetName of targetNames) {
        const st = stateFor(targetName);
        if (anc.inTypeContext) st.nonRuntimeReasons.add("used only in a type position");
        else if (anc.inMockFactory) st.nonRuntimeReasons.add("used only inside a mock factory");
        else if (anc.inSkipped) st.nonRuntimeReasons.add("used only inside a skipped/disabled test");
        else if (kind) {
          const tb = enclosingTestBlock(node);
          if (tb) st.runtimeUses.push({ node, useExpr: useExpressionOf(node), kind, block: tb, src: importSourceOf(node), renderCall });
          else st.nonRuntimeReasons.add("runtime use is outside any test block");
        } else if (isExpectArg(node)) st.nonRuntimeReasons.add("passed to expect() but never called (shallow)");
        else st.nonRuntimeReasons.add("referenced but not called/rendered");
        }
      } else if (!target && nameSet.has(node.text) && !anc.inImportOrExport && isRuntimeUse(node)) {
        // a same-named binding used at runtime that does NOT resolve to the terminal impl
        stateFor(node.text).collision = true;
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(testSf);

  // If the test MOCKS a framework package that provides render/screen/act, those helpers
  // are fakes — render() mounts nothing and screen returns seeded values — so a
  // render-effect confirmation is bogus. Detected by raw mocked specifier string (no
  // node_modules resolution needed). Value-flow confirmations are unaffected.
  const FRAMEWORK_TRUST_PKGS = [...FRAMEWORK_RENDER_PKGS, ...FRAMEWORK_DOM_PKGS, ...INVOKING_WRAPPER_PKGS];
  const frameworkMocked = [...mockedSpecifiers].some((s) =>
    FRAMEWORK_TRUST_PKGS.some((p) => (p.endsWith("/") ? s.startsWith(p) : s === p || s.startsWith(p + "/")))
  );

  // Conjunct 5 (relatedness): a runtime use is "observed" only when an in-block
  // assertion is structurally connected to it — the result is WRAPPED by the
  // assertion (`expect(call())`), BOUND to a CONST the assertion references AFTER
  // the call (`const r = call(); expect(r)`), or the use is a render exercise
  // observed by a framework effect assertion (`render(<X/>); expect(screen…)`). A
  // co-located unrelated assertion, or a reassigned `let`, does NOT confirm.
  const enclosingAssertedConstVar = (useExpr: ts.Node, block: ts.Node): ts.Identifier | null => {
    let n: ts.Node | undefined = useExpr.parent;
    while (n && n !== block) {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && nodeContains(n.initializer, useExpr)) {
        const list = n.parent; // a let/var could be reassigned before the assertion — only const is safe.
        return list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 ? n.name : null;
      }
      n = n.parent;
    }
    return null;
  };
  const argsReferenceSymbol = (args: readonly ts.Expression[], sym: ts.Symbol): boolean => {
    let found = false;
    const walk = (n: ts.Node): void => {
      if (found) return;
      if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === sym) {
        found = true;
        return;
      }
      ts.forEachChild(n, walk);
    };
    for (const arg of args) walk(arg);
    return found;
  };
  // The trailing method of a call's callee: `assert.ok` -> "ok", bare `assert(...)` -> "".
  const trailingMethod = (call: ts.CallExpression): string => {
    const ct = calleeText(call);
    return ct.includes(".") ? ct.slice(ct.lastIndexOf(".") + 1) : "";
  };
  // The arguments whose value the assertion observes: expect() observes its FIRST
  // argument PLUS the matcher call's arguments (the expected/comparand value, e.g.
  // `expect(actual).toEqual(use())`), but NOT expect's ignored 2nd+ argument; a
  // trusted assert observes its COMPARANDS only, never the trailing failure message
  // (`assert.ok(true, \`${use()}\`)` does not assert `use()`).
  const observedArgs = (a: AssertionSite): readonly ts.Expression[] => {
    if (a.kind === "expect") {
      const first = a.call.arguments.length > 0 ? [a.call.arguments[0]] : [];
      const m = expectMatcherCall(a.call);
      if (!m) return first;
      // A single-comparand matcher (toBe/toEqual/toContain/…) IGNORES a 2nd+ argument,
      // so a use there is not asserted (`expect(x).toBe(x, use())`); only the variadic
      // call/return families assert every argument.
      const mArgs = VARIADIC_MATCHER.test(calleeText(m)) ? m.arguments : m.arguments.slice(0, 1);
      return [...first, ...mArgs];
    }
    if (a.kind === "assert") {
      const count = ASSERT_COMPARANDS[trailingMethod(a.call)] ?? 1;
      return a.call.arguments.slice(0, count);
    }
    return a.call.arguments;
  };
  const constInitializerForIdentifier = (id: ts.Identifier, block: ts.Node): ts.Expression | null => {
    const sym = checker.getSymbolAtLocation(id);
    if (!sym) return null;
    for (const decl of sym.getDeclarations() ?? []) {
      if (
        ts.isVariableDeclaration(decl) &&
        ts.isIdentifier(decl.name) &&
        checker.getSymbolAtLocation(decl.name) === sym &&
        decl.initializer &&
        nodeContains(block, decl)
      ) {
        const list = decl.parent;
        return list && ts.isVariableDeclarationList(list) && (list.flags & ts.NodeFlags.Const) !== 0 ? decl.initializer : null;
      }
    }
    return null;
  };
  const receiverSymbolOfCall = (expr: ts.Node): ts.Symbol | null => {
    const call = unwrapExpression(expr as ts.Expression);
    if (!ts.isCallExpression(call) || !ts.isPropertyAccessExpression(call.expression)) return null;
    const receiver = unwrapExpression(call.expression.expression);
    return ts.isIdentifier(receiver) ? checker.getSymbolAtLocation(receiver) ?? null : null;
  };
  const expressionContainsLaterCallOnReceiver = (expr: ts.Expression, receiver: ts.Symbol, after: number): boolean => {
    let found = false;
    const walk = (n: ts.Node): void => {
      if (found) return;
      if (ts.isCallExpression(n) && n.getStart() > after) {
        const callee = unwrapExpression(n.expression);
        if (ts.isPropertyAccessExpression(callee)) {
          const recv = unwrapExpression(callee.expression);
          if (ts.isIdentifier(recv) && checker.getSymbolAtLocation(recv) === receiver) {
            found = true;
            return;
          }
        }
      }
      ts.forEachChild(n, walk);
    };
    walk(expr);
    return found;
  };
  const observesSameNestReceiverAfter = (u: RuntimeUse, a: AssertionSite): boolean => {
    if (u.block !== a.block || u.kind !== "value" || a.kind === "selfassert") return false;
    const receiver = receiverSymbolOfCall(u.useExpr);
    if (!receiver) return false;
    const args = observedArgs(a);
    for (const arg of args) {
      if (expressionContainsLaterCallOnReceiver(arg, receiver, u.useExpr.getStart())) return true;
      const value = ts.isIdentifier(unwrapExpression(arg)) ? constInitializerForIdentifier(unwrapExpression(arg) as ts.Identifier, u.block) : null;
      if (value && expressionContainsLaterCallOnReceiver(value, receiver, u.useExpr.getStart())) return true;
    }
    return false;
  };
  // Whether the assertion INVOKES a function-expression argument (a use inside that
  // callback therefore executes): expect(() => f()).toThrow(), expect.poll(() => f()),
  // assert.throws(() => f()).
  const assertionInvokesCallback = (a: AssertionSite): boolean => {
    if (a.kind === "expect") {
      if (/(^|\.)expect\.poll$/.test(calleeText(a.call))) return true; // poll re-runs its callback
      const m = expectMatcherCall(a.call);
      return !!m && INVOKING_EXPECT_MATCHER.test(calleeText(m));
    }
    if (a.kind === "assert") return INVOKING_ASSERT_METHODS.has(trailingMethod(a.call));
    return false;
  };
  // Checker-gated HOF-callback test (built-in array/promise receivers only) for flowsInto.
  const invokedCallback = (fn: ts.Node): boolean => isInvokedCallback(fn, checker);
  const observesUse = (u: RuntimeUse, a: AssertionSite): boolean => {
    if (u.block !== a.block) return false;
    // A self-assert query (getBy…/findBy…/should/…) observes a RENDER effect ONLY
    // (selfAssert.ts) — it never observes a plain value call via its arguments. The
    // WRAPPED and BOUND-const value paths apply only to expect/assert assertions AND a
    // VALUE use (a render use — a JSX element — is observed only by the render-effect
    // path below, never by asserting the element object itself).
    if (a.kind !== "selfassert" && u.kind === "value") {
      const args = observedArgs(a);
      const intoFns = assertionInvokesCallback(a);
      if (args.some((arg) => flowsInto(arg, u.useExpr, intoFns, invokedCallback))) return true; // WRAPPED (value flows in)
      const varName = enclosingAssertedConstVar(u.useExpr, u.block); // BOUND const + referenced after
      if (varName && a.call.getStart() > u.node.getStart()) {
        const sym = checker.getSymbolAtLocation(varName);
        if (sym && argsReferenceSymbol(args, sym)) return true;
      }
      if (observesSameNestReceiverAfter(u, a)) return true;
    }
    // render EFFECT-observed: the actual render() CALL must PRECEDE the effect assertion
    // (a `const ui = <X/>` declared early but render(ui)'d AFTER the assertion observes only
    // pre-render DOM), and the block must contain EXACTLY ONE framework render() call —
    // multiple distinct renders cannot be tied to the effect (a garbage 2nd component would
    // pass), and zero means nothing was actually rendered to the DOM.
    const renderPos = (u.renderCall ?? u.node).getStart();
    if (
      u.kind === "render" &&
      !frameworkMocked &&
      isFrameworkEffect(a.call) &&
      renderPos < a.call.getStart() &&
      renderCallsByBlock.get(u.block) === 1
    ) {
      return true;
    }
    return false;
  };

  const implMocked = mockedFiles.has(implNorm);
  const srcMocked = (s: BindingSource): boolean => implMocked || mockedFiles.has(s.file);
  for (const name of behaviorNames) {
    const st = stateFor(name);
    // CONFIRMED iff some runtime use's OWN binding is a clean, non-mocked terminal
    // AND that same use is observed by a related assertion — all evaluated against
    // the binding actually exercised (per-binding, not aggregated per-behavior).
    const confirmed = st.runtimeUses.some(
      (u) => u.src != null && cleanBindingSource(u.src) && !srcMocked(u.src) && assertions.some((a) => observesUse(u, a))
    );
    if (confirmed) {
      if (hasNestTestingModuleHarness) {
        out.set(name, {
          verdict: "inferred",
          reason: "NestJS TestingModule harness: assertion observed on a real binding, but provider substitution via alias/container escape cannot be ruled out; treated as associated signal only",
          rejected_conjunct: 6
        });
        continue;
      }
      out.set(name, { verdict: "confirmed", reason: "runtime use of the real binding, observed by a related assertion (all 5 conjuncts)" });
      continue;
    }
    const importedToImpl = st.importedRuntime || st.importedType;
    if (!importedToImpl) {
      out.set(
        name,
        st.collision
          ? { verdict: "inferred", reason: "a binding with this name resolves to a non-terminal/other module, not the implementation", rejected_conjunct: 1 }
          : { verdict: "none", reason: "no structural link from this test to this behavior" }
      );
      continue;
    }
    if (st.importedType && !st.importedRuntime) {
      out.set(name, { verdict: "inferred", reason: "type-only import — no runtime value is exercised", rejected_conjunct: 2 });
      continue;
    }
    if (implMocked || st.importSources.some((s) => mockedFiles.has(s.file))) {
      out.set(name, { verdict: "inferred", reason: "the imported module is mocked — the test does not hit real code", rejected_conjunct: 4 });
      continue;
    }
    if (!st.importSources.some((s) => cleanBindingSource(s))) {
      out.set(name, {
        verdict: "inferred",
        reason: "imported through a re-export that does not follow to a single terminal definition (ambiguous or non-terminal)",
        rejected_conjunct: 1
      });
      continue;
    }
    if (st.runtimeUses.length === 0) {
      const reason = st.nonRuntimeReasons.size > 0 ? [...st.nonRuntimeReasons].join("; ") : "imported but never used at runtime";
      const conj: 3 | 4 = [...st.nonRuntimeReasons].some((r) => r.includes("mock") || r.includes("skipped")) ? 4 : 3;
      out.set(name, { verdict: "inferred", reason, rejected_conjunct: conj });
      continue;
    }
    // Runtime uses + a clean import both exist, but no clean-binding use is observed
    // (the exercised binding is the ambiguous/mocked one, or no assertion is connected).
    out.set(name, {
      verdict: "inferred",
      reason: "the behavior is exercised but no assertion consumes its result or observes its rendered effect via the real binding",
      rejected_conjunct: 5
    });
  }
  return out;
}

/** `expect(X)` with X the bare binding — a shallow reference, not a runtime use. */
function isExpectArg(id: ts.Identifier): boolean {
  const p = id.parent;
  return !!p && ts.isCallExpression(p) && p.arguments.includes(id as ts.Expression) && /(^|\.)expect$/.test(calleeText(p));
}

/** Single-pair convenience wrapper (used by the golden-fixture gate test). */
export function confirmPair(
  ctx: ConfirmProgram,
  testAbsPath: string,
  implAbsPath: string,
  behaviorName: string
): ConfirmVerdict {
  return (
    confirmBehaviors(ctx, testAbsPath, implAbsPath, [behaviorName]).get(behaviorName) ?? {
      verdict: "none",
      reason: "behavior not evaluated"
    }
  );
}

// --------------------------- analyzer integration ---------------------------

export interface ConfirmCandidate {
  testRel: string;
  testAbs: string;
  implRel: string;
  implAbs: string;
}

export interface ConfirmedEdge {
  testRel: string;
  implRel: string;
  behaviorName: string;
  /** sym:<implRel>#<name> — the CodeSymbol the COVERS edge targets. */
  symId: string;
  reason: string;
}

export interface ConfirmerInput {
  candidates: ConfirmCandidate[];
  /** Denominator-eligible CodeSymbol names per impl relPath. */
  symbolsByImpl: Map<string, string[]>;
  /** Existing CodeSymbol external_ids — a confirmed symbol absent here was capped out (4.4: downgrade, never COVERS-to-file). */
  existingSymIds: Set<string>;
  /** Anchor file for tsconfig resolution (repo root or any in-tree file). */
  anchorFile: string;
}

export interface ConfirmerOutput {
  confirmations: ConfirmedEdge[];
  /** (test, behavior) pairs evaluated. */
  attempted: number;
  /** Confirmed-by-rule but the impl symbol was capped out of the graph → downgraded to INFERRED. */
  capped_downgrades: number;
}

/**
 * Run the confirmer over every candidate (test -> impl) pair (the resolver-derived
 * MAY_RELATE_TO links). For each denominator-eligible exported symbol of the impl
 * file, classify the pair and, on CONFIRMED, record a hard COVERS/TESTED_BY edge —
 * UNLESS the symbol was capped out of the graph, in which case it is downgraded to
 * INFERRED (4.4: COVERS stays symbol-precise, never falls back to the file).
 */
export function runConfirmer(input: ConfirmerInput): ConfirmerOutput {
  const { candidates, symbolsByImpl, existingSymIds, anchorFile } = input;
  const confirmations: ConfirmedEdge[] = [];
  let attempted = 0;
  let capped_downgrades = 0;
  if (candidates.length === 0) return { confirmations, attempted, capped_downgrades };

  const absFiles = new Set<string>();
  for (const c of candidates) {
    absFiles.add(c.testAbs);
    absFiles.add(c.implAbs);
  }
  const ctx = buildConfirmProgram([...absFiles], anchorFile);

  const seen = new Set<string>(); // dedup (testRel|symId)
  for (const c of candidates) {
    const names = symbolsByImpl.get(c.implRel);
    if (!names || names.length === 0) continue;
    const verdicts = confirmBehaviors(ctx, c.testAbs, c.implAbs, names);
    for (const [name, v] of verdicts) {
      attempted++;
      if (v.verdict !== "confirmed") continue;
      const symId = `sym:${c.implRel}#${name}`;
      if (!existingSymIds.has(symId)) {
        capped_downgrades++; // symbol exists in source but was capped out — downgrade, don't COVERS-to-file
        continue;
      }
      const key = `${c.testRel}|${symId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      confirmations.push({ testRel: c.testRel, implRel: c.implRel, behaviorName: name, symId, reason: v.reason });
    }
  }
  return { confirmations, attempted, capped_downgrades };
}
