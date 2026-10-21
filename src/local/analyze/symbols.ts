import ts from "typescript";
import { redactSecrets } from "../util/redact.js";
import {
  bodyTraits,
  findExportShapes,
  isDocumentedPrivate,
  parseErrorCount,
  topFunctionBindings,
  type ExistingSymbol,
  type ExportShape,
  type ExportShapeResult,
  type FunctionLikeNode,
  type NotSupportedEntry,
  type PassThrough,
  type SeenBy,
  type ShapeForm,
  type TrivialBody
} from "./exportShapes.js";

export interface ExtractedSymbol {
  name: string;
  symbol_kind: "function" | "class" | "const" | "method";
  /** 1-based source line where the declaration starts, when the extractor can prove it. */
  start_line?: number;
  /** 1-based source line where the declaration ends, when the extractor can prove it. */
  end_line?: number;
  /** For `const` only: the AST PROVED the initializer is a function (callable). */
  callable?: boolean;
  /**
   * AST proved the method body is a trivial accessor — a bare field return,
   * a single `this.field = param` assignment, or empty. Drives body-aware
   * boilerplate exclusion so a method that merely LOOKS like a getter by name
   * (e.g. `getOwner()` that calls a repository) is never dropped. Only set by
   * the tree-sitter extractor; undefined on the regex fallback path.
   */
  trivial_accessor?: boolean;
  /**
   * For a TS/JS class member: the owning class name. The symbol's `name` is the
   * qualified `Class.method` (unique + yields `sym:file#Class.method`). Member
   * symbols count in the denominator but are NEVER fed to the exported-binding
   * confirmer (a method is not an exported binding), so they stay candidate /
   * has-test, not hard-confirmed, until a member-aware confirmer exists.
   */
  member_of?: string;
  /**
   * TS/JS only: which of the five export shapes (exportShapes.ts) made this
   * symbol visible. Absent for the declaration-based rules — a symbol both
   * produce keeps the declaration-based record and gains only `aliases`.
   */
  seen_by?: SeenBy;
  /** TS/JS only: how a `seen_by` function is written (drives caller identity and proof routing). */
  shape_form?: ShapeForm;
  /** TS/JS only: other public names of the same function (`Owner.alias` for members, else the exported name). */
  aliases?: string[];
  /** TS/JS only: the last JSDoc block before the definition tags it `@private` / `@internal`. */
  documented_private?: boolean;
  /** TS/JS only: the AST proved the body merely moves a value (empty, returns a stored value, stores a parameter). */
  trivial_body?: TrivialBody;
  /** TS/JS only: the body is one `return callee(<own parameters, in order>)`. */
  pass_through?: PassThrough;
  /**
   * TS/JS only, `false` when a function made visible by reference is NOT exported
   * under its own name (`export { impl as run }`): another file can import `run`,
   * never `impl`.
   */
  own_name_exported?: boolean;
  /**
   * TS/JS only: the symbol's name is an export KEY, not a module binding
   * (`exports.send = function () {}`): a free call `send()` in the same file does
   * not call it.
   */
  unbound_name?: boolean;
}

export const MAX_SYMBOLS_PER_FILE = 1000;
const MAX_TEST_NAMES_PER_FILE = 60;

// Extraction is LANGUAGE-AWARE: TS/JS use the AST (collectTsJsExports), and the
// regex families below run ONLY for their own language — a regex must never see
// another language's source. Otherwise a TS file with `func Ghost(` in a comment
// or `"public class Fake"` in a string would mint phantom Go/Java behaviors.
// Legacy fallback caveat: when a tree-sitter grammar is unavailable, this regex
// path is intentionally shallow. It may undercount methods/classes, but it never
// claims the richer AST denominator.
type RegexLang = "python" | "go" | "java";
const SYMBOL_PATTERNS_BY_LANG: Record<RegexLang, Array<{ re: RegExp; kind: ExtractedSymbol["symbol_kind"] }>> = {
  // Python: module-level defs are functions; indented defs are methods (a class
  // still counts once — methods do not multiply the class itself).
  python: [
    { re: /^(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm, kind: "function" },
    { re: /^[ \t]+(?:async\s+)?def\s+([A-Za-z_][\w]*)\s*\(/gm, kind: "method" },
    { re: /^\s*class\s+([A-Za-z_][\w]*)\s*[:(]/gm, kind: "class" }
  ],
  // Line-anchored (with /m): defense-in-depth alongside comment/string blanking,
  // and avoids substring matches like `myfunc Foo(`.
  go: [{ re: /^\s*func\s+([A-Z][\w]*)\s*\(/gm, kind: "function" }],
  // Allow leading annotations on the same line (`@Entity public class X`,
  // `@Getter @Setter public class Y`) — idiomatic Spring/JPA/Lombok.
  java: [{ re: /^\s*(?:@\w+(?:\([^)]*\))?\s+)*public\s+(?:static\s+)?class\s+([A-Za-z_][\w]*)/gm, kind: "class" }]
};

/** Which extractor family a classified language (from classify.languageOf) uses. */
function symbolLangFamily(language?: string): "tsjs" | RegexLang | "none" {
  // `|| "typescript"` (not `??`) so an empty-string language also defaults to TS.
  switch ((language || "typescript").toLowerCase()) {
    case "typescript":
    case "javascript":
      return "tsjs";
    case "python":
      return "python";
    case "go":
      return "go";
    case "java":
      return "java";
    default:
      return "none";
  }
}

interface LexRules {
  lineComment: string;
  blockComment?: readonly [string, string];
  strings: ReadonlyArray<{ open: string; close: string; escape: boolean; multiline: boolean }>;
}

// Per-language comment + string/docstring grammar. Triple-quoted Python strings
// are listed BEFORE the single-char ones so the longer delimiter wins.
const LEX_BY_LANG: Record<RegexLang, LexRules> = {
  python: {
    lineComment: "#",
    strings: [
      // escape:true — Python honors `\"""` inside a triple, so the escaped
      // delimiter must NOT close the string early.
      { open: '"""', close: '"""', escape: true, multiline: true },
      { open: "'''", close: "'''", escape: true, multiline: true },
      { open: '"', close: '"', escape: true, multiline: false },
      { open: "'", close: "'", escape: true, multiline: false }
    ]
  },
  go: {
    lineComment: "//",
    blockComment: ["/*", "*/"],
    strings: [
      { open: "`", close: "`", escape: false, multiline: true }, // raw string (no escapes)
      { open: '"', close: '"', escape: true, multiline: false },
      { open: "'", close: "'", escape: true, multiline: false } // rune
    ]
  },
  java: {
    lineComment: "//",
    blockComment: ["/*", "*/"],
    strings: [
      { open: '"""', close: '"""', escape: true, multiline: true }, // text block (Java 15+, honors escapes) — must precede the single "
      { open: '"', close: '"', escape: true, multiline: false },
      { open: "'", close: "'", escape: true, multiline: false } // char
    ]
  }
};

/**
 * Blank out comment and string/docstring contents (preserving newlines) so the
 * plain-text Python/Go/Java symbol regexes never match `def`/`class`/`func`
 * inside a docstring, comment, or string literal — the same comment/string
 * safety the TS/JS AST path gets for free. A small conservative lexer, not a
 * full parser: over-blanking a malformed literal only loses a symbol, never
 * invents one.
 */
function blankCommentsAndStrings(content: string, family: RegexLang): string {
  const rules = LEX_BY_LANG[family];
  const n = content.length;
  const out: string[] = new Array(n);
  const blankRange = (from: number, to: number): void => {
    for (let k = from; k < to; k++) out[k] = content[k] === "\n" ? "\n" : " ";
  };
  let i = 0;
  while (i < n) {
    if (content.startsWith(rules.lineComment, i)) {
      let j = i;
      while (j < n && content[j] !== "\n") j++;
      blankRange(i, j);
      i = j;
      continue;
    }
    if (rules.blockComment && content.startsWith(rules.blockComment[0], i)) {
      const close = rules.blockComment[1];
      const found = content.indexOf(close, i + rules.blockComment[0].length);
      const j = found === -1 ? n : found + close.length;
      blankRange(i, j);
      i = j;
      continue;
    }
    let matched = false;
    for (const s of rules.strings) {
      if (!content.startsWith(s.open, i)) continue;
      let j = i + s.open.length;
      while (j < n) {
        if (s.escape && content[j] === "\\") {
          j += 2;
          continue;
        }
        if (!s.multiline && content[j] === "\n") break; // unterminated single-line literal
        if (content.startsWith(s.close, j)) {
          j += s.close.length;
          break;
        }
        j++;
      }
      blankRange(i, Math.min(j, n));
      i = Math.min(j, n);
      matched = true;
      break;
    }
    if (matched) continue;
    out[i] = content[i];
    i++;
  }
  return out.join("");
}

/** Parens / as / satisfies / angle-bracket assertions are transparent wrappers —
 *  unwrapping them is still PROOF of callability, not evaluation. */
function unwrapInitializer(e: ts.Expression): ts.Expression {
  let cur = e;
  for (;;) {
    if (ts.isParenthesizedExpression(cur)) cur = cur.expression;
    else if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur)) cur = cur.expression;
    else return cur;
  }
}

interface SymbolTraits {
  documented_private: boolean;
  trivial_body?: TrivialBody;
  pass_through?: PassThrough;
}

/** Parse-local node references for span reporting; never serialized. */
interface SymbolSite {
  sf: ts.SourceFile;
  /** Node whose text is "the definition": the top-level statement, the property, or the declaration. */
  anchor: ts.Node;
  fn?: FunctionLikeNode;
  targets?: string[];
  ownerBinding?: ExportShape["ownerBinding"];
}

interface TsJsSymbol {
  kind: ExtractedSymbol["symbol_kind"];
  callable: boolean;
  member_of?: string;
  start_line?: number;
  end_line?: number;
  seen_by?: SeenBy;
  shape_form?: ShapeForm;
  aliases?: string[];
  /** `null` = the two grammar passes disagreed, so nothing is claimed. */
  traits?: SymbolTraits | null;
  site?: SymbolSite;
  own_name_exported?: boolean;
  /** Every record of the name came from an export key, none from a declaration. */
  unbound_name?: boolean;
}

interface TsJsExtraction {
  symbols: Map<string, TsJsSymbol>;
  notSupported: NotSupportedEntry[];
}

interface RecordSource {
  sf: ts.SourceFile;
  anchor: ts.Node;
  fn?: FunctionLikeNode;
  /** The name recorded is an export key (`exports.name = function`), not a declaration's own name. */
  exportKey?: boolean;
}

function hasExportModifier(n: ts.FunctionDeclaration | ts.ClassDeclaration | ts.VariableStatement): boolean {
  return n.modifiers?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword) ?? false;
}

/**
 * The LOCAL identifier a `export default <expr>` ultimately wraps, or null.
 *  - `export default Foo`                       → "Foo"
 *  - `export default connect(mapState)(Foo)`    → "Foo" (HOC: the LAST arg of the
 *    OUTERMOST call, recursively — so inner-call args like mapState are never
 *    mistaken for the subject)
 *  - `export default memo(Foo)` / `injectIntl(connect(...)(Foo))` → "Foo"
 * Conservative: anonymous defaults, object/JSX/member expressions → null. The
 * CALLER still requires the name to be a locally-declared callable before
 * recording it, so an imported or non-behavior subject is never counted.
 */
function defaultSubject(expr: ts.Expression): string | null {
  let cur: ts.Expression = unwrapInitializer(expr);
  for (let depth = 0; depth < 8; depth++) {
    if (ts.isIdentifier(cur)) return cur.text;
    if (ts.isCallExpression(cur) && cur.arguments.length > 0) {
      cur = unwrapInitializer(cur.arguments[cur.arguments.length - 1]);
      continue;
    }
    return null;
  }
  return null;
}

/**
 * Conservative ALLOWLIST for a const that is the subject of a default export.
 * A default export is the file's primary behavior, but NOT every non-literal
 * const is behavior — `require('./x').default` re-export shims, `new Foo()`
 * singletons, and `createRoutes(...)` config objects are values, not testable
 * behavior surface. Counts ONLY:
 *   - an arrow/function-expression const (a function, any case), or
 *   - a PascalCase const wrapped by a call or tagged template — the React
 *     component idiom (forwardRef/memo/styled/connect/HOC) — EXCLUDING bare
 *     `require(...)` CommonJS shims.
 * Everything else (new-expressions, property access, lowercase call results,
 * plain literals) is skipped.
 */
function isComponentLikeConst(name: string, init: ts.Expression | undefined): boolean {
  if (!init) return false;
  if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) return true;
  if (!/^[A-Z]/.test(name)) return false; // component wrappers are PascalCase
  if (ts.isTaggedTemplateExpression(init)) return true; // styled.div``
  if (ts.isCallExpression(init)) {
    if (ts.isIdentifier(init.expression) && init.expression.text === "require") return false; // CommonJS shim
    return true; // forwardRef(...) / memo(...) / connect(...)(X) / menuItem(Impl) / …
  }
  return false; // new Foo(), require(...).default (property access), etc.
}

/**
 * Exported TS/JS symbols from the AST — comment- and string-safe by
 * construction (the parser sees structure, not text). Exported function and
 * class declarations, and exported const bindings (callability proven per
 * declarator, so declaration lists keep every callable). Interfaces, type
 * aliases, and enums are intentionally NOT behavior. Parses under BOTH grammars
 * and unions — `<T>(v) => v` is an arrow in .ts but JSX in .tsx and this layer
 * never sees the filename; call-wrapped factories (memo(() => {}), styled(...))
 * stay non-callable, which is the documented v1 policy.
 */
function collectTsJsExports(content: string): TsJsExtraction {
  const acc = new Map<string, TsJsSymbol>();
  const nodeLines = (sf: ts.SourceFile, node: ts.Node): Pick<ExtractedSymbol, "start_line" | "end_line"> => ({
    start_line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
    end_line: sf.getLineAndCharacterOfPosition(node.getEnd()).line + 1
  });
  const topFunctionsBySf = new Map<ts.SourceFile, Set<string>>();
  const traitsOf = (src: RecordSource | undefined): SymbolTraits | undefined => {
    if (!src?.fn) return undefined;
    let topFns = topFunctionsBySf.get(src.sf);
    if (!topFns) {
      topFns = topFunctionBindings(src.sf);
      topFunctionsBySf.set(src.sf, topFns);
    }
    return { documented_private: isDocumentedPrivate(src.sf, src.anchor), ...bodyTraits(src.fn, topFns) };
  };
  const record = (
    name: string,
    kind: ExtractedSymbol["symbol_kind"],
    callable: boolean,
    member_of?: string,
    lines?: Pick<ExtractedSymbol, "start_line" | "end_line">,
    src?: RecordSource
  ): void => {
    const prev = acc.get(name);
    // A grammar pass with parse errors mis-reads where functions start and end (plain
    // TS on a file with JSX). It may still NAME the symbol, as 0.2.58 does, but its
    // spans and body judgements are never used: those come from a clean pass or not at all.
    const trusted = src !== undefined && parseErrorCount(src.sf) === 0 ? src : undefined;
    const traits = traitsOf(trusted);
    const site: SymbolSite | undefined = trusted ? { sf: trusted.sf, anchor: trusted.anchor, ...(trusted.fn ? { fn: trusted.fn } : {}) } : undefined;
    const exportKey = src?.exportKey === true;
    if (!prev) {
      acc.set(name, {
        kind,
        callable,
        ...(member_of ? { member_of } : {}),
        ...(lines?.start_line ? { start_line: lines.start_line } : {}),
        ...(lines?.end_line ? { end_line: lines.end_line } : {}),
        ...(traits ? { traits } : {}),
        ...(site ? { site } : {}),
        ...(exportKey ? { unbound_name: true } : {})
      });
      return;
    }
    // Traits are claimed only when every record of the name agrees on them.
    const mergedTraits =
      prev.traits === undefined ? traits : traits === undefined || JSON.stringify(prev.traits) === JSON.stringify(traits) ? prev.traits : null;
    // OR callability across the two grammar passes; prefer a real fn/class kind.
    acc.set(name, {
      kind: prev.kind === "const" && kind !== "const" ? kind : prev.kind,
      callable: prev.callable || callable,
      ...(prev.member_of ?? member_of ? { member_of: prev.member_of ?? member_of } : {}),
      ...(prev.start_line ?? lines?.start_line ? { start_line: prev.start_line ?? lines?.start_line } : {}),
      ...(prev.end_line ?? lines?.end_line ? { end_line: prev.end_line ?? lines?.end_line } : {}),
      ...(mergedTraits !== undefined ? { traits: mergedTraits } : {}),
      // An overload signature is recorded first and has no body: the definition is the one that does.
      ...(prev.site ?? site ? { site: prev.site?.fn || !site?.fn ? (prev.site ?? site) : site } : {}),
      ...(prev.unbound_name && exportKey ? { unbound_name: true } : {})
    });
  };
  // Methods of a class body → qualified `Class.method` member symbols. Only the
  // PUBLIC surface counts — `private`/`protected` (and JS `#private`) members are
  // internal, mirroring the export-surface boundary that keeps module-private
  // functions out of the denominator. Constructor + get/set accessors excluded.
  // Recorded once per class (the two grammar passes would otherwise duplicate).
  const membersDone = new Set<string>();
  const isInternalMember = (m: ts.MethodDeclaration): boolean => {
    if (ts.isPrivateIdentifier(m.name)) return true; // JS `#method`
    return (
      ts.canHaveModifiers(m) &&
      (ts.getModifiers(m)?.some(
        (mod) => mod.kind === ts.SyntaxKind.PrivateKeyword || mod.kind === ts.SyntaxKind.ProtectedKeyword
      ) ??
        false)
    );
  };
  // Public methods with a runtime BODY: abstract methods, ambient declarations,
  // and overload SIGNATURES have none — they are contracts, not testable
  // behavior. The overload IMPLEMENTATION (which has the body) still counts.
  const publicMethods = (node: ts.ClassDeclaration): Array<ts.MethodDeclaration & { name: ts.Identifier }> => {
    // A `declare class` declares an ambient shape — none of its members have a
    // runtime implementation to test.
    if (ts.canHaveModifiers(node) && ts.getModifiers(node)?.some((mod) => mod.kind === ts.SyntaxKind.DeclareKeyword)) return [];
    const out: Array<ts.MethodDeclaration & { name: ts.Identifier }> = [];
    for (const m of node.members) {
      if (ts.isMethodDeclaration(m) && m.body && m.name && ts.isIdentifier(m.name) && m.name.text !== "constructor" && !isInternalMember(m)) {
        out.push(m as ts.MethodDeclaration & { name: ts.Identifier });
      }
    }
    return out;
  };
  const recordClassMethods = (sourceFile: ts.SourceFile, node: ts.ClassDeclaration, className: string): void => {
    if (membersDone.has(className)) {
      // Recorded once, as 0.2.58 does. A later pass adds no member; it may only supply
      // the definition site of a member the first pass named from a failed parse.
      for (const m of publicMethods(node)) {
        const memberName = `${className}.${m.name.text}`;
        const known = acc.get(memberName);
        if (known && !known.site) record(memberName, "method", false, className, nodeLines(sourceFile, m), { sf: sourceFile, anchor: m, fn: m });
      }
      return;
    }
    membersDone.add(className);
    for (const m of publicMethods(node)) {
      record(`${className}.${m.name.text}`, "method", false, className, nodeLines(sourceFile, m), { sf: sourceFile, anchor: m, fn: m });
    }
  };
  const passes = [ts.ScriptKind.TS, ts.ScriptKind.TSX].map((scriptKind) =>
    ts.createSourceFile(scriptKind === ts.ScriptKind.TS ? "symbols.ts" : "symbols.tsx", content, ts.ScriptTarget.Latest, false, scriptKind)
  );
  for (const sf of passes) {
    // Local declarations (exported OR not) so `const X = …; export default X` —
    // the common React component shape — resolves to its real subject. Default
    // exports (`export default <expr>`) are collected and resolved after the
    // pass, since the subject const may be declared before OR after them.
    // Local declarations eligible to be a default-export behavior subject:
    // functions/classes always; consts only when component-like (isComponentLikeConst).
    const localDecls = new Map<
      string,
      { kind: ExtractedSymbol["symbol_kind"]; eligible: boolean; callable: boolean; lines?: Pick<ExtractedSymbol, "start_line" | "end_line">; src: RecordSource }
    >();
    const classNodes = new Map<string, ts.ClassDeclaration>(); // for default-subject member extraction
    const defaultExprs: ts.Expression[] = [];
    const commonJsAssignments: Array<{ exportName: string | null; expression: ts.Expression; statement: ts.Statement }> = [];
    for (const stmt of sf.statements) {
      if (ts.isFunctionDeclaration(stmt) && stmt.name) {
        const lines = nodeLines(sf, stmt);
        const src: RecordSource = { sf, anchor: stmt, ...(stmt.body ? { fn: stmt } : {}) };
        localDecls.set(stmt.name.text, { kind: "function", eligible: true, callable: true, lines, src });
        if (hasExportModifier(stmt)) record(stmt.name.text, "function", false, undefined, lines, src);
      } else if (ts.isClassDeclaration(stmt) && stmt.name) {
        // A `declare class` is an ambient TYPE shape with no runtime implementation
        // to test — skip it entirely (neither the class node nor its members are
        // behavior, and it must not become a default-export subject).
        if (ts.canHaveModifiers(stmt) && ts.getModifiers(stmt)?.some((mod) => mod.kind === ts.SyntaxKind.DeclareKeyword)) continue;
        const lines = nodeLines(sf, stmt);
        const src: RecordSource = { sf, anchor: stmt };
        localDecls.set(stmt.name.text, { kind: "class", eligible: true, callable: true, lines, src });
        classNodes.set(stmt.name.text, stmt);
        if (hasExportModifier(stmt)) {
          record(stmt.name.text, "class", false, undefined, lines, src);
          recordClassMethods(sf, stmt, stmt.name.text); // exported class → its methods are behaviors
        }
      } else if (ts.isVariableStatement(stmt) && (stmt.declarationList.flags & ts.NodeFlags.Const) !== 0) {
        const exported = hasExportModifier(stmt); // const only (match prior scope; not let/var)
        for (const decl of stmt.declarationList.declarations) {
          if (!ts.isIdentifier(decl.name)) continue;
          const init = decl.initializer ? unwrapInitializer(decl.initializer) : undefined;
          const callable = !!init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init));
          const lines = nodeLines(sf, decl);
          const src: RecordSource = { sf, anchor: stmt, ...(init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? { fn: init } : {}) };
          localDecls.set(decl.name.text, { kind: "const", eligible: isComponentLikeConst(decl.name.text, init), callable, lines, src });
          if (exported) record(decl.name.text, "const", callable, undefined, lines, src); // regular exports keep the strict callable rule
        }
      } else if (ts.isExportAssignment(stmt) && !stmt.isExportEquals) {
        // `export default <expr>` — NOT `export = …` (CommonJS). Re-export barrels
        // (`export { default } from './x'`) are ExportDeclarations, never collected.
        defaultExprs.push(stmt.expression);
      } else if (ts.isExpressionStatement(stmt) && ts.isBinaryExpression(stmt.expression) && stmt.expression.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        let assignment: ts.BinaryExpression | undefined = stmt.expression;
        while (assignment) {
          const left = assignment.left;
          if (ts.isPropertyAccessExpression(left)) {
            const directDefault = ts.isIdentifier(left.expression) && left.expression.text === "module" && left.name.text === "exports";
            const namedOnExports = ts.isIdentifier(left.expression) && left.expression.text === "exports";
            const namedOnModule = ts.isPropertyAccessExpression(left.expression)
              && ts.isIdentifier(left.expression.expression)
              && left.expression.expression.text === "module"
              && left.expression.name.text === "exports";
            if (directDefault) commonJsAssignments.push({ exportName: null, expression: assignment.right, statement: stmt });
            else if (namedOnExports || namedOnModule) commonJsAssignments.push({ exportName: left.name.text, expression: assignment.right, statement: stmt });
          }
          assignment = ts.isBinaryExpression(assignment.right) && assignment.right.operatorToken.kind === ts.SyntaxKind.EqualsToken
            ? assignment.right
            : undefined;
        }
      }
    }
    // A default export is the file's primary behavior. Record its LOCAL subject
    // only when it is a function/class or a component-like const — skips require()
    // re-export shims, new-expression singletons, config objects, and any
    // non-local (imported) subject. Conservative: no phantom behavior.
    for (const expr of defaultExprs) {
      const name = defaultSubject(expr);
      if (!name) continue;
      const d = localDecls.get(name);
      if (!d || !d.eligible) continue;
      record(name, d.kind, d.kind === "const", undefined, d.lines, d.src); // component-like const → callable
      if (d.kind === "class") {
        const node = classNodes.get(name);
        if (node) recordClassMethods(sf, node, name); // default-exported class → its methods
      }
    }
    // CommonJS public surface, judged by the same AST-backed callable bar as ESM:
    // module.exports = localFn, exports.name = localFn, or an inline function.
    // Re-export shims and config/object assignments remain excluded.
    for (const assignment of commonJsAssignments) {
      const expr = unwrapInitializer(assignment.expression);
      if (ts.isIdentifier(expr)) {
        const d = localDecls.get(expr.text);
        if (!d || !d.callable) continue;
        record(expr.text, d.kind, d.kind === "const", undefined, d.lines, d.src);
        if (d.kind === "class") {
          const node = classNodes.get(expr.text);
          if (node) recordClassMethods(sf, node, expr.text);
        }
      } else if (ts.isFunctionExpression(expr) || ts.isArrowFunction(expr)) {
        const name = assignment.exportName ?? (ts.isFunctionExpression(expr) && expr.name ? expr.name.text : undefined);
        if (name) record(name, "function", false, undefined, nodeLines(sf, expr), { sf, anchor: assignment.statement, fn: expr, exportKey: true });
      } else if (ts.isClassExpression(expr) && expr.name) {
        record(expr.name.text, "class", false, undefined, nodeLines(sf, expr));
      }
    }
  }

  // The five export shapes (exportShapes.ts), on top of what the rules above
  // emit. A grammar pass with parse errors is ignored; when both are clean they
  // must agree, otherwise the file gains no new symbols (hard symbols cannot guess).
  const existing = new Map<string, ExistingSymbol>();
  for (const [name, sym] of acc) existing.set(name, { kind: sym.kind, callable: sym.callable });
  const shapeRuns = passes.map((sf) => {
    let result: ExportShapeResult;
    let scanned = true;
    try {
      result = findExportShapes(sf, existing);
    } catch {
      // A scan that could not finish (a pathologically deep file) is not a clean answer.
      result = { shapes: [], notSupported: [] };
      scanned = false;
    }
    return { sf, clean: scanned && parseErrorCount(sf) === 0, result };
  });
  const signature = (run: (typeof shapeRuns)[number]): string =>
    JSON.stringify([
      run.result.shapes.map((sh) => [sh.name, sh.form, sh.kind, sh.aliases, sh.node.getStart(run.sf), sh.node.getEnd(), sh.anchor.getStart(run.sf)]),
      run.result.notSupported
    ]);
  const cleanRuns = shapeRuns.filter((run) => run.clean);
  const chosen = cleanRuns.length === 1 || (cleanRuns.length === 2 && signature(cleanRuns[0]) === signature(cleanRuns[1])) ? cleanRuns[0] : null;
  const notSupported: NotSupportedEntry[] = [];
  if (!chosen) {
    if (shapeRuns.some((run) => run.result.shapes.length > 0)) notSupported.push({ code: "parse_disagreement", start_line: 1, end_line: 1 });
    return { symbols: acc, notSupported };
  }
  const sf = chosen.sf;
  notSupported.push(...chosen.result.notSupported);
  const addAliases = (sym: TsJsSymbol, aliases: readonly string[]): void => {
    if (aliases.length === 0) return;
    sym.aliases = [...new Set([...(sym.aliases ?? []), ...aliases])];
  };
  for (const shape of chosen.result.shapes) {
    const prev = acc.get(shape.name);
    if (prev) {
      // A declaration-based rule (or an earlier shape) already emits this name:
      // that record stays exactly as it is and only gains the extra public names.
      addAliases(prev, shape.aliases);
      continue;
    }
    if (ts.isClassDeclaration(shape.node)) {
      acc.set(shape.name, {
        kind: "class",
        callable: false,
        ...nodeLines(sf, shape.node),
        seen_by: shape.seenBy,
        shape_form: shape.form,
        ...(shape.aliases.length ? { aliases: [...shape.aliases] } : {}),
        site: { sf, anchor: shape.anchor }
      });
      for (const m of publicMethods(shape.node)) {
        const memberName = `${shape.name}.${m.name.text}`;
        if (acc.has(memberName)) continue;
        const src: RecordSource = { sf, anchor: m, fn: m };
        const traits = traitsOf(src);
        acc.set(memberName, {
          kind: "method",
          callable: false,
          member_of: shape.name,
          ...nodeLines(sf, m),
          seen_by: shape.seenBy,
          ...(traits ? { traits } : {}),
          site: { sf, anchor: m, fn: m }
        });
      }
      continue;
    }
    const fn = shape.node;
    const traits = traitsOf({ sf, anchor: shape.anchor, fn });
    acc.set(shape.name, {
      kind: shape.kind,
      callable: shape.kind === "const",
      ...(shape.memberOf ? { member_of: shape.memberOf } : {}),
      ...nodeLines(sf, shape.declaration ?? fn),
      seen_by: shape.seenBy,
      shape_form: shape.form,
      ...(shape.aliases.length ? { aliases: [...shape.aliases] } : {}),
      ...(shape.ownNameExported === false ? { own_name_exported: false } : {}),
      ...(traits ? { traits } : {}),
      site: {
        sf,
        anchor: shape.anchor,
        fn,
        ...(shape.targets ? { targets: shape.targets } : {}),
        ...(shape.ownerBinding ? { ownerBinding: shape.ownerBinding } : {})
      }
    });
  }
  return { symbols: acc, notSupported };
}

// Cheap gate: any "export" followed by whitespace or `{` (so `export\tfunction`,
// `export\nclass` and `export{ a }` are NOT skipped), or a CommonJS export.
const TSJS_EXPORT_GATE_RE = /export[\s{]|module\s*\.\s*exports|exports\s*\./;

export interface SymbolExtraction {
  symbols: ExtractedSymbol[];
  /** True when MAX_SYMBOLS_PER_FILE cut real candidates — callers must disclose. */
  truncated: boolean;
  /** TS/JS only: export shapes the extractor deliberately does not turn into symbols. Omitted when empty. */
  not_supported?: NotSupportedEntry[];
}

/** Serializable extras a TS/JS symbol carries beyond name/kind/lines. */
function tsJsExtras(sym: TsJsSymbol): Partial<ExtractedSymbol> {
  return {
    ...(sym.seen_by ? { seen_by: sym.seen_by } : {}),
    ...(sym.shape_form ? { shape_form: sym.shape_form } : {}),
    ...(sym.aliases?.length ? { aliases: sym.aliases } : {}),
    ...(sym.traits?.documented_private ? { documented_private: true } : {}),
    ...(sym.traits?.trivial_body ? { trivial_body: sym.traits.trivial_body } : {}),
    ...(sym.traits?.pass_through ? { pass_through: sym.traits.pass_through } : {}),
    ...(sym.own_name_exported === false ? { own_name_exported: false } : {}),
    ...(sym.unbound_name ? { unbound_name: true } : {})
  };
}

/**
 * Cheap, safe symbol metadata. Names only — never signatures or bodies.
 * LANGUAGE-AWARE: only the extractor for `language` (from classify.languageOf)
 * runs, so another language's regex can never mint phantom symbols from a
 * comment or string. Defaults to TS/JS when language is omitted.
 */
export function extractSymbolsWithMeta(content: string, language?: string): SymbolExtraction {
  const byName = new Map<string, ExtractedSymbol>();
  let truncated = false;
  let notSupported: NotSupportedEntry[] = [];
  const lineOf = (index: number): number => content.slice(0, Math.max(0, index)).split(/\r?\n/).length;
  const consider = (
    name: string,
    kind: ExtractedSymbol["symbol_kind"],
    callable?: boolean,
    member_of?: string,
    lines?: Pick<ExtractedSymbol, "start_line" | "end_line">,
    extras?: Partial<ExtractedSymbol>
  ): void => {
    const existing = byName.get(name);
    if (existing) {
      // Prefer a real declaration over a const match (a name that surfaces as
      // both a const and a fn/class collapses to the fn/class).
      if (existing.symbol_kind === "const" && kind !== "const") byName.set(name, { name, symbol_kind: kind });
      return;
    }
    if (byName.size >= MAX_SYMBOLS_PER_FILE) {
      truncated = true;
      return;
    }
    const sym: ExtractedSymbol =
      kind === "const" ? { name, symbol_kind: kind, callable: callable ?? false } : { name, symbol_kind: kind };
    if (lines?.start_line) sym.start_line = lines.start_line;
    if (lines?.end_line) sym.end_line = lines.end_line;
    if (member_of) sym.member_of = member_of;
    if (extras) Object.assign(sym, extras);
    byName.set(name, sym);
  };
  const family = symbolLangFamily(language);
  if (family === "tsjs") {
    // TS/JS from the AST — comment/string-safe.
    if (TSJS_EXPORT_GATE_RE.test(content)) {
      const extraction = collectTsJsExports(content);
      for (const [name, sym] of extraction.symbols) consider(name, sym.kind, sym.callable, sym.member_of, sym, tsJsExtras(sym));
      notSupported = extraction.notSupported;
    }
  } else if (family !== "none") {
    // Blank comments/strings/docstrings first so a `def`/`class`/`func` inside
    // them can never mint a phantom symbol (mirrors the AST safety for TS/JS).
    const code = blankCommentsAndStrings(content, family);
    for (const { re, kind } of SYMBOL_PATTERNS_BY_LANG[family]) {
      re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = re.exec(code)) !== null) {
        if (m[1]) consider(m[1], kind, undefined, undefined, { start_line: lineOf(m.index), end_line: lineOf(m.index) });
      }
    }
  }
  return { symbols: [...byName.values()], truncated, ...(notSupported.length ? { not_supported: notSupported } : {}) };
}

export function extractSymbols(content: string, language?: string): ExtractedSymbol[] {
  return extractSymbolsWithMeta(content, language).symbols;
}

/** Where one TS/JS symbol is defined, as half-open UTF-16 offsets into the content. */
export interface FunctionSite {
  name: string;
  symbol_kind: ExtractedSymbol["symbol_kind"];
  member_of?: string;
  seen_by?: SeenBy;
  shape_form?: ShapeForm;
  aliases?: string[];
  /** How the owner is bound, for a member made visible by an export shape. */
  owner_binding?: string;
  /** Assignment targets written before the function, as source text (`res.set`, `View.prototype.render`). */
  targets?: string[];
  /** The definition: the top-level statement, the object-literal property, or the declaration. */
  statement: [number, number];
  /** The function-like node (absent for a class). */
  fn?: [number, number];
  /** How the function-like node is written. */
  fn_kind?: "declaration" | "expression" | "arrow" | "method";
  /** For a method: its name is written as a plain identifier (`name(…) {`), not a string, number or computed key. */
  key_is_identifier?: boolean;
  /** The `{ … }` body (absent for an expression-bodied arrow). */
  body?: [number, number];
  start_line?: number;
  end_line?: number;
}

/**
 * Exact definition spans for every TS/JS symbol the extractor emits for
 * `content`, re-derived from the source — so a caller can bind a symbol to its
 * bytes without trusting anything stored on a graph node.
 */
export function listFunctionSites(content: string): { sites: FunctionSite[]; not_supported: NotSupportedEntry[] } {
  if (!TSJS_EXPORT_GATE_RE.test(content)) return { sites: [], not_supported: [] };
  const extraction = collectTsJsExports(content);
  const sites: FunctionSite[] = [];
  for (const [name, sym] of extraction.symbols) {
    const site = sym.site;
    if (!site) continue;
    const span = (node: ts.Node): [number, number] => [node.getStart(site.sf), node.getEnd()];
    const body = site.fn?.body && ts.isBlock(site.fn.body) ? site.fn.body : undefined;
    sites.push({
      name,
      symbol_kind: sym.kind,
      ...(sym.member_of ? { member_of: sym.member_of } : {}),
      ...(sym.seen_by ? { seen_by: sym.seen_by } : {}),
      ...(sym.shape_form ? { shape_form: sym.shape_form } : {}),
      ...(sym.aliases?.length ? { aliases: sym.aliases } : {}),
      ...(site.ownerBinding ? { owner_binding: site.ownerBinding } : {}),
      ...(site.targets ? { targets: site.targets } : {}),
      statement: span(site.anchor),
      ...(site.fn
        ? {
            fn: span(site.fn),
            fn_kind: ts.isArrowFunction(site.fn)
              ? ("arrow" as const)
              : ts.isFunctionExpression(site.fn)
                ? ("expression" as const)
                : ts.isMethodDeclaration(site.fn)
                  ? ("method" as const)
                  : ("declaration" as const),
            ...(ts.isMethodDeclaration(site.fn) ? { key_is_identifier: ts.isIdentifier(site.fn.name) } : {})
          }
        : {}),
      ...(body ? { body: span(body) } : {}),
      ...(sym.start_line ? { start_line: sym.start_line } : {}),
      ...(sym.end_line ? { end_line: sym.end_line } : {})
    });
  }
  return { sites, not_supported: extraction.notSupported };
}

const TEST_NAME_PATTERNS: RegExp[] = [
  /(?:describe|it|test)\s*\(\s*["'`]([^"'`]{1,160})["'`]/g,
  /def\s+(test_[A-Za-z0-9_]{1,120})\s*\(/g,
  /func\s+(Test[A-Za-z0-9_]{1,120})\s*\(/g
];

/** Extract human-readable test names (behavior hints) from a test file. */
export function extractTestNames(content: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const re of TEST_NAME_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(content)) !== null) {
      const name = redactSecrets(m[1].trim());
      if (!name || seen.has(name)) continue;
      seen.add(name);
      out.push(name);
      if (out.length >= MAX_TEST_NAMES_PER_FILE) return out;
    }
  }
  return out;
}
