/**
 * Language-agnostic symbol extraction via tree-sitter (web-tree-sitter WASM — no
 * native build, ships in the npm package). Grammars are LOADED ASYNC once
 * (preloadTreeSitter), then extraction is SYNC so it drops into the synchronous
 * analyzer walk. Replaces the fragile per-language regexes for non-TS languages.
 */
import { createRequire } from "node:module";
import { Parser, Language, type Node } from "web-tree-sitter";
import type { BehaviorContract } from "../behaviorContracts.js";
import { ExtractedSymbol, MAX_SYMBOLS_PER_FILE, SymbolExtraction } from "../symbols.js";
import { TS_LANG_CONFIGS, type TsLangConfig } from "./languages.js";
import { slugify } from "../../util/ids.js";
import { shortHash } from "../../util/hash.js";

const require = createRequire(import.meta.url);

let initPromise: Promise<void> | null = null;
const loaded = new Map<string, Language>();
const failed = new Set<string>();
const parsers = new Map<string, Parser>();

export interface TreeSitterStatus {
  /** Languages whose grammar is loaded and ready for AST extraction. */
  loaded: string[];
  /** Languages whose grammar load was ATTEMPTED and FAILED (extraction downgraded to regex). */
  failed: string[];
}

export interface TreeSitterImportBinding {
  local: string;
  module: string;
  imported?: string;
  kind: "module" | "named";
}

export interface TreeSitterRawCall {
  caller: string;
  callee: string;
  qualifier?: string;
  via: "free" | "qualified";
  shadowed: string[];
  /** Go only: receiver variable + base type of the enclosing method (`t` / `task` in `func (t *task) Run()`). */
  receiverVar?: string;
  receiverType?: string;
}

export interface TreeSitterGoProofCall extends TreeSitterRawCall {
  testName: string;
  assertion: "testing_fail" | "assert_helper";
  /**
   * True when this is a receiver-local METHOD call `p.M()` whose receiver var `p`
   * was declared by a bare same-package constructor `p := New(...)` in the test.
   * Routes the analyzer to same-package method resolution (not import resolution).
   * The oracle still re-verifies; package-name-uniqueness makes it fail-closed.
   */
  receiverLocal?: boolean;
  /**
   * The CONSTRUCTOR name that declared the receiver var (`p := New(...)` → "New").
   * Set only alongside receiverLocal. The analyzer resolves the ctor's declared
   * result type (goCtorResults) to PIN the receiver type, so same-named methods on
   * different receivers (A.M / B.M) can be disambiguated instead of refused.
   */
  receiverCtor?: string;
  /**
   * 1-based source line of the assertion CALL in the test file where this target was
   * witnessed (the line Go prints in the failing frame). Slice 2 uses it to bind a
   * runtime-named subtest's mutant failure to THIS exact assertion — a sibling subtest
   * asserting at a different line is rejected. Omitted when the line can't be pinned.
   */
  assertionLine?: number;
}

export interface TreeSitterPythonProofCall extends TreeSitterRawCall {
  /** Pytest nodeid suffix: `test_name` or `TestClass::test_name`. Structural metadata only. */
  testName: string;
  assertion: "pytest_assert";
  /**
   * For an invocation through one local instance (`obj = Cls(); obj.method()`),
   * the imported production class that uniquely owns the receiver. This remains
   * static association metadata; it never promotes a behavior to Proven.
   */
  instanceClass?: string;
  /**
   * Narrow structural receiver rule that made an instance/class association
   * possible. It is copied to proof-edge metadata so downstream consumers can
   * distinguish this static signal from dynamic proof.
   */
  associationRule?: PythonAssociationRule;
}

export type PythonAssociationRule =
  | "assigned_instance"
  | "module_assigned_instance"
  | "fixture_return"
  | "fixture_yield"
  | "fixture_annotation"
  | "parameter_annotation"
  | "unittest_setup"
  | "inline_constructor"
  | "class_static_method"
  /**
   * Receiver is deliberately unresolved, while the invoked method name is later
   * constrained to one imported, in-repo class owner. This is not an exact
   * constructor/type association and must retain its own detector provenance.
   */
  | "unique_method_name_import";

/** Direct in-repo bases as written on a Python class declaration. */
export interface TreeSitterPythonClassInfo {
  name: string;
  bases: string[];
  /** Methods explicitly decorated @classmethod or @staticmethod on this class. */
  classStaticMethods: string[];
}

export interface TreeSitterPythonDependency {
  /** Owner-qualified endpoint handler (`Controller.method`) or top-level function. */
  handler: string;
  /** Statically named dependency passed to FastAPI Depends(...). */
  dependency: string;
}

/** Machine-readable priority-only exclusion; display text is stored separately. */
export type RankingExclusionCode =
  | "python_structural_container"
  | "trivial_constructor"
  | "enum_declaration"
  | "thin_external_delegate"
  | "python_class_with_methods"
  | "data_shape_declaration";

export type PythonRankingExclusionCode =
  /** Legacy code (pre-0.2.46 graphs); new graphs emit python_trivial_constructor. */
  | "python_trivial_thread_local_initializer"
  | "python_trivial_constructor"
  | "python_stdlib_enum_declaration"
  | "python_data_shape_declaration"
  | "python_thin_external_delegate";

export interface TreeSitterPythonRankingExclusion {
  symbol: string;
  code: PythonRankingExclusionCode;
  reason: string;
}

export interface TreeSitterPythonThinDelegate {
  symbol: string;
  /** Local import binding (possibly reached through one exact module-level alias). */
  importLocal: string;
}

export interface TreeSitterPythonModuleAttribute {
  local: string;
  attribute: string;
}

export interface TreeSitterPythonConstructorChainCall {
  caller: string;
  /** Call function text without terminal arguments, e.g. `Store(db).table.delete`. */
  callee: string;
  /** Constructor binding as written at the head of the chain. */
  constructorLocal: string;
}

export interface TreeSitterJavaClassInfo {
  name: string;
  methods: string[];
}

export interface TreeSitterJavaProofCall {
  testName: string;
  className: string;
  callee: string;
  target_kind: "method" | "constructor";
  assertion: "junit4" | "junit5";
  shadowed: string[];
}

export interface TreeSitterStructure {
  moduleName?: string;
  packageName?: string;
  topLevelSymbols?: string[];
  imports: TreeSitterImportBinding[];
  calls: TreeSitterRawCall[];
  javaClasses?: TreeSitterJavaClassInfo[];
  javaProofCalls?: TreeSitterJavaProofCall[];
  goProofCalls?: TreeSitterGoProofCall[];
  pythonProofCalls?: TreeSitterPythonProofCall[];
  /** Exact class-method references patched or replaced by a mock in a Python test file. */
  pythonMockedMethods?: string[];
  /** Exact patch targets effective for each test, including reachable same-file fixtures. */
  pythonMocksByTest?: Record<string, string[]>;
  /** Tests with fixture selection too dynamic to establish a safe patch scope. */
  pythonUnknownMockScopeTests?: string[];
  pythonClasses?: TreeSitterPythonClassInfo[];
  pythonBehaviorContracts?: BehaviorContract[];
  pythonDependencies?: TreeSitterPythonDependency[];
  /** Exact AST-only declaration/initializer ranking exclusions. */
  pythonRankingExclusions?: TreeSitterPythonRankingExclusion[];
  /** Exact forwarding shapes; analyzer later proves the import is out-of-repo. */
  pythonThinDelegates?: TreeSitterPythonThinDelegate[];
  /** Non-call, direct module.attribute reads only; scorer consumes exact targets. */
  pythonModuleAttributes?: TreeSitterPythonModuleAttribute[];
  /** Exact direct constructor-chain call shapes; analyzer later binds the class. */
  pythonConstructorChainCalls?: TreeSitterPythonConstructorChainCall[];
  /**
   * Go only: top-level function name → base name of its SINGLE declared result
   * type (`func New(...) *Parser` → "Parser"). Captured ONLY when the result is a
   * bare or pointer type_identifier — multi-return, interface, qualified, and
   * generic results are OMITTED so constructor-based receiver pinning fails
   * closed on anything it cannot prove structurally.
   */
  goCtorResults?: Record<string, string>;
}

/** Resolve a grammar wasm shipped by the tree-sitter-wasms dependency. */
function grammarPath(wasm: string): string {
  return require.resolve(`tree-sitter-wasms/out/${wasm}`);
}

/**
 * Load the tree-sitter runtime + the grammars for `languages` (once; idempotent).
 * Never throws. Returns which languages loaded vs FAILED so the caller/analyzer can
 * surface a downgrade instead of silently serving shallow regex extraction.
 */
export async function preloadTreeSitter(languages: Iterable<string>): Promise<TreeSitterStatus> {
  const requested = [...new Set(languages)].filter((l) => TS_LANG_CONFIGS[l]);
  try {
    if (!initPromise) initPromise = Parser.init();
    await initPromise;
  } catch {
    // Runtime wasm failed → every requested grammar is unavailable.
    for (const language of requested) if (!loaded.has(language)) failed.add(language);
    return treeSitterStatus();
  }
  for (const language of requested) {
    if (loaded.has(language)) continue;
    try {
      loaded.set(language, await Language.load(grammarPath(TS_LANG_CONFIGS[language].wasm)));
      failed.delete(language);
    } catch {
      failed.add(language); // attempted + errored — distinct from "never preloaded"
    }
  }
  return treeSitterStatus();
}

/** Snapshot of which grammars are ready vs failed (for analysis metadata / warnings). */
export function treeSitterStatus(): TreeSitterStatus {
  return { loaded: [...loaded.keys()], failed: [...failed] };
}

/** True once a grammar for `language` is loaded and ready for sync extraction. */
export function treeSitterReady(language: string): boolean {
  return loaded.has(language);
}

/** True when a grammar load was ATTEMPTED and failed (vs simply never preloaded). */
export function treeSitterFailed(language: string): boolean {
  return failed.has(language);
}

/** Test-only: forget loaded grammars so a test can exercise the pre-preload (regex) path. */
export function __resetTreeSitterForTests(): void {
  loaded.clear();
  failed.clear();
  parsers.clear();
}

function parserFor(language: string): Parser | null {
  const lang = loaded.get(language);
  if (!lang) return null;
  let parser = parsers.get(language);
  if (!parser) {
    parser = new Parser();
    parser.setLanguage(lang);
    parsers.set(language, parser);
  }
  return parser;
}

// A trivial getter returns a bare field / `this.field` / `this`; never a call,
// arithmetic, or anything with behavior. Used to make boilerplate exclusion
// body-aware so `getOwner()` that calls a repository is NOT dropped.
const TRIVIAL_RETURN_TYPES = new Set(["identifier", "field_access", "this"]);
const RESERVED_SYMBOL_NAMES = new Set([
  "auto",
  "bool",
  "case",
  "char",
  "class",
  "const",
  "default",
  "define",
  "do",
  "double",
  "else",
  "enum",
  "extern",
  "float",
  "for",
  "goto",
  "if",
  "ifdef",
  "ifndef",
  "include",
  "inline",
  "int",
  "long",
  "namespace",
  "private",
  "protected",
  "public",
  "register",
  "return",
  "short",
  "signed",
  "sizeof",
  "static",
  "struct",
  "switch",
  "template",
  "typename",
  "typedef",
  "union",
  "unsigned",
  "void",
  "volatile",
  "while"
]);
const FUNCTION_DECLARATOR_TYPES = new Set(["function_declarator"]);

/** Statement children of a block, ignoring comments. */
function blockStatements(block: Node): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < block.namedChildCount; i++) {
    const c = block.namedChild(i);
    if (c && !/comment/.test(c.type)) out.push(c);
  }
  return out;
}

/**
 * AST-proven trivial accessor: an empty body, a single bare-field `return`, or a
 * single `this.field = param` assignment. Java-only for now (the motivating
 * entity-heavy case); other languages return false so a name match alone never
 * excludes a method. Abstract/interface methods (no body) are NOT trivial — they
 * are contract surface and stay countable.
 */
function isTrivialAccessorBody(methodNode: Node, language: string): boolean {
  if (language !== "java") return false;
  const body = methodNode.childForFieldName("body");
  if (!body || body.type !== "block") return false;
  const stmts = blockStatements(body);
  if (stmts.length === 0) return true; // empty body
  if (stmts.length !== 1) return false;
  const s = stmts[0];
  if (s.type === "return_statement") {
    const expr = s.namedChild(0);
    return !expr || TRIVIAL_RETURN_TYPES.has(expr.type); // return this.field / return field / return;
  }
  if (s.type === "expression_statement") {
    const assign = s.namedChild(0);
    if (assign?.type !== "assignment_expression") return false;
    return assign.childForFieldName("right")?.type === "identifier"; // this.field = param
  }
  return false;
}

function firstDescendantOfType(node: Node, types: Set<string>): Node | null {
  for (const child of namedChildren(node)) {
    if (types.has(child.type)) return child;
    const nested = firstDescendantOfType(child, types);
    if (nested) return nested;
  }
  return null;
}

function hasAncestorType(node: Node, type: string): boolean {
  let cur = node.parent;
  while (cur) {
    if (cur.type === type) return true;
    cur = cur.parent;
  }
  return false;
}

function shouldEmitSymbol(node: Node, language: string): boolean {
  if (language === "rust" && node.type === "function_signature_item") {
    return hasAncestorType(node, "trait_item");
  }
  return true;
}

function symbolName(node: Node, cfg: TsLangConfig): string | undefined {
  if (node.type === "function_definition" && cfg.nameNodeTypes) {
    const declarator = node.childForFieldName("declarator");
    const functionDeclarator = declarator?.type === "function_declarator" ? declarator : declarator ? firstDescendantOfType(declarator, FUNCTION_DECLARATOR_TYPES) : null;
    const fromDeclarator = functionDeclarator ? firstDescendantOfType(functionDeclarator, cfg.nameNodeTypes) : null;
    return fromDeclarator?.text;
  }
  if (["struct_specifier", "union_specifier", "enum_specifier", "class_specifier"].includes(node.type)) {
    if (!node.childForFieldName("body")) return undefined;
    return node.childForFieldName(cfg.nameField)?.text;
  }
  return node.childForFieldName(cfg.nameField)?.text ?? (cfg.nameNodeTypes ? firstDescendantOfType(node, cfg.nameNodeTypes)?.text : undefined);
}

function nodeLines(node: Node): Pick<ExtractedSymbol, "start_line" | "end_line"> {
  return { start_line: node.startPosition.row + 1, end_line: node.endPosition.row + 1 };
}

/**
 * Nearest lexical Python class for a function. A function boundary reached first
 * means this is a nested local function, not a class method.
 */
function pythonOwnerClass(node: Node): string | undefined {
  const owners: string[] = [];
  let parent = node.parent;
  while (parent) {
    if (parent.type === "function_definition" || parent.type === "lambda") return undefined;
    if (parent.type === "class_definition") {
      const name = parent.childForFieldName("name")?.text;
      if (name) owners.unshift(name);
    }
    parent = parent.parent;
  }
  return owners.length > 0 ? owners.join(".") : undefined;
}

function hasPythonFunctionAncestor(node: Node): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "function_definition" || parent.type === "lambda") return true;
    parent = parent.parent;
  }
  return false;
}

function pythonQualifiedFunctionName(node: Node): string | undefined {
  const name = functionName(node, "python");
  const owner = pythonOwnerClass(node);
  return name && owner ? `${owner}.${name}` : name;
}

/**
 * Extract class/function/method symbol metadata (names + a trivial-accessor flag —
 * never source bodies) from a tree-sitter-supported language. Sync; returns [] when
 * the grammar isn't loaded.
 */
export function extractTreeSitterSymbols(content: string, language: string): SymbolExtraction {
  const cfg: TsLangConfig | undefined = TS_LANG_CONFIGS[language];
  const parser = parserFor(language);
  if (!cfg || !parser) return { symbols: [], truncated: false };

  const tree = parser.parse(content);
  if (!tree) return { symbols: [], truncated: false };

  const byName = new Map<string, ExtractedSymbol>();
  let truncated = false;
  const add = (sym: ExtractedSymbol): void => {
    const existing = byName.get(sym.name);
    if (existing) {
      // Prefer a class over a method/function of the same name (rare collisions).
      if (existing.symbol_kind !== "class" && sym.symbol_kind === "class") byName.set(sym.name, sym);
      return;
    }
    if (byName.size >= MAX_SYMBOLS_PER_FILE) {
      truncated = true;
      return;
    }
    byName.set(sym.name, sym);
  };

  const walk = (node: Node): void => {
    let kind: ExtractedSymbol["symbol_kind"] | null = null;
    if (cfg.classTypes.has(node.type)) kind = "class";
    else if (cfg.methodTypes.has(node.type)) kind = "method";
    else if (cfg.functionTypes.has(node.type)) kind = "function";
    const pythonOwner = language === "python" && node.type === "function_definition" ? pythonOwnerClass(node) : undefined;
    if (pythonOwner && kind === "function") kind = "method";
    const localPythonDeclaration = language === "python" && (node.type === "function_definition" || node.type === "class_definition") && hasPythonFunctionAncestor(node);
    if (kind && !localPythonDeclaration && shouldEmitSymbol(node, language)) {
      const name = symbolName(node, cfg);
      if (name && !RESERVED_SYMBOL_NAMES.has(name)) {
        // Go methods mint receiver-qualified names (`Recv.M`, mirroring TS/JS
        // `Class.method` + member_of) so same-named methods on different receivers
        // stay distinct symbols; an underivable receiver falls back to the bare name.
        const recv = kind === "method" && language === "go" ? goReceiverBaseName(node) : language === "python" ? pythonOwner : undefined;
        const pythonClassOwner = kind === "class" && language === "python" ? pythonOwnerClass(node) : undefined;
        const emittedName = pythonClassOwner ? `${pythonClassOwner}.${name}` : name;
        add(
          kind === "method"
            ? { name: recv ? `${recv}.${name}` : name, ...(recv ? { member_of: recv } : {}), symbol_kind: kind, trivial_accessor: isTrivialAccessorBody(node, language), ...nodeLines(node) }
            : { name: emittedName, symbol_kind: kind, ...nodeLines(node) }
        );
      }
    }
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child) walk(child);
    }
  };
  walk(tree.rootNode);
  tree.delete();
  return { symbols: [...byName.values()], truncated };
}

function namedChildren(node: Node): Node[] {
  const out: Node[] = [];
  for (let i = 0; i < node.namedChildCount; i++) {
    const child = node.namedChild(i);
    if (child) out.push(child);
  }
  return out;
}

function stripQuotes(s: string): string {
  return s.replace(/^['"`<]/, "").replace(/['"`>]$/, "");
}

function lastDottedPart(s: string): string {
  const parts = s.split(/[./\\:]/).filter(Boolean);
  return parts[parts.length - 1] || s;
}

function collectNames(node: Node | null, out: Set<string>): void {
  if (!node) return;
  if (/^(identifier|package_identifier|field_identifier|simple_identifier)$/.test(node.type)) {
    out.add(node.text);
    return;
  }
  for (const child of namedChildren(node)) collectNames(child, out);
}

function localBindings(fn: Node, language: string): Set<string> {
  const out = new Set<string>();
  const params = fn.childForFieldName("parameters") ?? (language === "kotlin" ? namedChildren(fn).find((n) => n.type === "function_value_parameters") : null);
  if (params) {
    if (language === "python") {
      // Parameter annotations are references, not local bindings. Collecting every
      // identifier from `value: ImportedType` incorrectly shadowed the imported
      // production class and made an otherwise exact structural association fail.
      for (const parameter of namedChildren(params)) {
        if (parameter.type === "identifier") out.add(parameter.text);
        else {
          const name = parameter.childForFieldName("name") ?? namedChildren(parameter)[0] ?? null;
          if (name?.type === "identifier") out.add(name.text);
        }
      }
    }
    else {
      for (const child of namedChildren(params)) {
        if (/parameter/.test(child.type)) collectNames(child.childForFieldName("name") ?? child, out);
      }
    }
  }
  const body = fn.childForFieldName("body") ?? (language === "kotlin" ? namedChildren(fn).find((n) => n.type === "function_body") : null);
  const walk = (node: Node): void => {
    if (language === "python" && node.type === "assignment") collectNames(node.childForFieldName("left") ?? node.namedChild(0), out);
    if (language === "python" && (node.type === "function_definition" || node.type === "class_definition")) collectNames(node.childForFieldName("name"), out);
    if (language === "python" && node.type === "for_statement") collectNames(node.childForFieldName("left"), out);
    if (language === "python" && node.type === "for_in_clause") collectNames(node.childForFieldName("left"), out);
    if (language === "python" && node.type === "except_clause") collectNames(namedChildren(node).find((n) => n.type === "as_pattern") ?? null, out);
    if (language === "python" && node.type === "lambda") collectNames(node.childForFieldName("parameters"), out);
    if (language === "go" && (node.type === "short_var_declaration" || node.type === "var_spec")) collectNames(node.childForFieldName("name") ?? node.namedChild(0), out);
    if (language === "go" && node.type === "range_clause") collectNames(node.childForFieldName("left"), out);
    if (language === "java" && node.type === "variable_declarator") collectNames(node.childForFieldName("name"), out);
    if (language === "java" && node.type === "catch_formal_parameter") collectNames(node.childForFieldName("name"), out);
    if (language === "java" && node.type === "enhanced_for_statement") collectNames(node.childForFieldName("name"), out);
    if (language === "rust" && node.type === "let_declaration") collectNames(node.childForFieldName("pattern") ?? node.namedChild(0), out);
    if (language === "rust" && node.type === "for_expression") collectNames(node.childForFieldName("pattern"), out);
    if (language === "rust" && node.type === "closure_expression") collectNames(node.childForFieldName("parameters"), out);
    if (language === "csharp" && node.type === "variable_declarator") collectNames(node.childForFieldName("name") ?? node.namedChild(0), out);
    if (language === "csharp" && node.type === "declaration_expression") collectNames(node.childForFieldName("name"), out);
    if (language === "csharp" && node.type === "catch_declaration") collectNames(node.childForFieldName("name"), out);
    if (language === "csharp" && node.type === "for_each_statement") collectNames(node.childForFieldName("left"), out);
    if (language === "csharp" && node.type === "lambda_expression") {
      const lambdaParams = node.childForFieldName("parameters");
      if (lambdaParams) {
        for (const child of namedChildren(lambdaParams)) {
          if (/parameter/.test(child.type)) collectNames(child.childForFieldName("name") ?? child, out);
          else if (child.type === "identifier") collectNames(child, out);
        }
      } else {
        const first = namedChildren(node)[0];
        if (first?.type === "identifier") collectNames(first, out);
      }
    }
    if (language === "kotlin" && node.type === "variable_declaration") collectNames(node.childForFieldName("name") ?? node.namedChild(0), out);
    if (language === "kotlin" && node.type === "catch_block") collectNames(namedChildren(node).find((n) => n.type === "simple_identifier") ?? null, out);
    for (const child of namedChildren(node)) walk(child);
  };
  if (body) walk(body);
  return out;
}

function functionName(node: Node, language: string): string | undefined {
  const name = node.childForFieldName("name")?.text;
  if (!name && language === "kotlin") return namedChildren(node).find((n) => n.type === "simple_identifier")?.text;
  if (!name) return undefined;
  if (language === "go" && node.type === "method_declaration") return name;
  return name;
}

/**
 * Base receiver type name for a Go method declaration — `(p *Parser)` → "Parser",
 * `(g Generic[T])` → "Generic". Undefined when the receiver shape is underivable,
 * in which case callers fall back to the bare method name (the pre-qualified
 * behavior). NOT used for test-name extraction — suite test names must stay bare
 * (`^Test` gate at extractGoProofCalls).
 */
function goReceiverVarName(node: Node): string | undefined {
  const param = node.childForFieldName("receiver")?.namedChild(0);
  const name = param?.childForFieldName("name");
  return name?.type === "identifier" ? name.text : undefined;
}

function goReceiverBaseName(node: Node): string | undefined {
  const param = node.childForFieldName("receiver")?.namedChild(0);
  let t = param?.childForFieldName("type") ?? undefined;
  if (t && (t.type === "pointer_type" || t.type === "generic_type")) t = t.namedChild(0) ?? undefined;
  return t?.type === "type_identifier" ? t.text : undefined;
}

function javaPackage(root: Node): string | undefined {
  const pkg = namedChildren(root).find((n) => n.type === "package_declaration");
  return pkg ? namedChildren(pkg).find((n) => n.type.endsWith("identifier"))?.text : undefined;
}

function goPackage(root: Node): string | undefined {
  const pkg = namedChildren(root).find((n) => n.type === "package_clause");
  return pkg ? namedChildren(pkg).find((n) => n.type === "package_identifier")?.text : undefined;
}

/**
 * Top-level Go function name → base name of its single declared result type
 * (`func New(n int) *Parser` → "Parser"). ONLY a bare `type_identifier` (optionally
 * behind one `*`) is captured; multi-return (`parameter_list`), interface, qualified
 * (`pkg.T`), and generic results are omitted — constructor-based receiver pinning
 * must fail closed on any result it cannot prove structurally.
 */
function extractGoCtorResults(root: Node): Record<string, string> {
  const out: Record<string, string> = {};
  for (const child of namedChildren(root)) {
    if (child.type !== "function_declaration") continue;
    const name = child.childForFieldName("name")?.text;
    if (!name) continue;
    let r = child.childForFieldName("result") ?? undefined;
    if (r?.type === "pointer_type") r = r.namedChild(0) ?? undefined;
    if (r?.type === "type_identifier") out[name] = r.text;
  }
  return out;
}

function kotlinPackage(root: Node): string | undefined {
  const pkg = namedChildren(root).find((n) => n.type === "package_header");
  return pkg ? namedChildren(pkg).find((n) => n.type === "identifier")?.text : undefined;
}

function phpNamespace(root: Node): string | undefined {
  const ns = namedChildren(root).find((n) => n.type === "namespace_definition");
  const name = ns?.childForFieldName("name") ?? namedChildren(ns ?? root).find((n) => n.type === "namespace_name");
  return name?.text;
}

function csharpNamespace(root: Node): string | undefined {
  const ns = namedChildren(root).find((n) => n.type === "file_scoped_namespace_declaration" || n.type === "namespace_declaration");
  return ns?.childForFieldName("name")?.text;
}

function kotlinTopLevelSymbols(root: Node): string[] {
  const out = new Set<string>();
  for (const child of namedChildren(root)) {
    if (child.type === "function_declaration") {
      const name = functionName(child, "kotlin");
      if (name) out.add(name);
    } else if (child.type === "class_declaration" || child.type === "object_declaration") {
      const name = symbolName(child, TS_LANG_CONFIGS.kotlin);
      if (name) out.add(name);
    }
  }
  return [...out].sort();
}

function underPythonTypeCheckingGuard(node: Node): boolean {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "if_statement") {
      const condition = parent.childForFieldName("condition");
      const text = condition?.text.trim() ?? "";
      if (text === "TYPE_CHECKING" || /^[A-Za-z_]\w*\.TYPE_CHECKING$/.test(text)) return true;
    }
    if (parent.type === "function_definition" || parent.type === "class_definition") break;
    parent = parent.parent;
  }
  return false;
}

function extractImports(root: Node, language: string): TreeSitterImportBinding[] {
  const imports: TreeSitterImportBinding[] = [];
  const add = (binding: TreeSitterImportBinding): void => {
    if (!binding.local || !binding.module) return;
    imports.push(binding);
  };
  const walk = (node: Node): void => {
    if (language === "python" && (node.type === "import_statement" || node.type === "import_from_statement") && underPythonTypeCheckingGuard(node)) {
      return;
    }
    if (language === "java" && node.type === "import_declaration") {
      const spec = namedChildren(node).find((n) => n.type.endsWith("identifier"))?.text;
      if (spec && !spec.endsWith(".*")) add({ local: lastDottedPart(spec), module: spec, imported: lastDottedPart(spec), kind: "named" });
    } else if (language === "python" && node.type === "import_statement") {
      for (const child of namedChildren(node)) {
        const name = child.childForFieldName("name")?.text ?? child.text;
        const alias = child.childForFieldName("alias")?.text;
        if (name) add({ local: alias || lastDottedPart(name), module: name, kind: "module" });
      }
    } else if (language === "python" && node.type === "import_from_statement") {
      const kids = namedChildren(node);
      const moduleNode = kids.find((n) => n.type === "dotted_name" || n.type === "relative_import");
      const module = moduleNode?.text;
      if (module) {
        if (/\bimport\s+\*/.test(node.text)) add({ local: "*", module, imported: "*", kind: "named" });
        for (const child of kids) {
          if (child === moduleNode) continue;
          const imported = child.childForFieldName("name")?.text ?? (child.type === "identifier" || child.type === "dotted_name" ? child.text : undefined);
          const alias = child.childForFieldName("alias")?.text;
          if (imported === "*") add({ local: "*", module, imported, kind: "named" });
          else if (imported) add({ local: alias || imported, module, imported, kind: "named" });
        }
      }
    } else if (language === "go" && node.type === "import_spec") {
      const raw = node.childForFieldName("path")?.text;
      const module = raw ? stripQuotes(raw) : undefined;
      const alias = node.childForFieldName("name")?.text;
      if (module && alias !== "_" && alias !== ".") add({ local: alias || lastDottedPart(module), module, kind: "module" });
    } else if (language === "ruby" && node.type === "call") {
      const method = node.childForFieldName("method")?.text;
      if (method === "require_relative") {
        const str = namedChildren(node).find((n) => n.type === "argument_list")?.descendantsOfType("string_content")[0]?.text;
        if (str) add({ local: lastDottedPart(str), module: `./${str}`, kind: "module" });
      }
    } else if (language === "kotlin" && node.type === "import_header") {
      const spec = namedChildren(node).find((n) => n.type === "identifier")?.text;
      if (spec && !spec.endsWith(".*")) add({ local: lastDottedPart(spec), module: spec, imported: lastDottedPart(spec), kind: "named" });
    } else if (language === "rust" && node.type === "mod_item") {
      const name = node.childForFieldName("name")?.text;
      if (name && !node.childForFieldName("body")) add({ local: name, module: `./${name}`, kind: "module" });
    } else if (language === "rust" && node.type === "use_declaration") {
      const arg = node.childForFieldName("argument");
      if (arg && (arg.type === "scoped_identifier" || arg.type === "identifier")) {
        const module = arg.text.replace(/::/g, ".");
        const imported = lastDottedPart(module);
        add({ local: imported, module, imported, kind: "named" });
      }
    } else if (language === "php" && node.type === "namespace_use_clause") {
      const spec = namedChildren(node).find((n) => n.type === "qualified_name" || n.type === "namespace_name")?.text;
      if (spec) add({ local: lastDottedPart(spec), module: spec, imported: lastDottedPart(spec), kind: "named" });
    } else if (language === "csharp" && node.type === "using_directive") {
      const spec = namedChildren(node).find((n) => n.type === "qualified_name" || n.type === "identifier")?.text;
      if (spec) add({ local: lastDottedPart(spec), module: spec, kind: "module" });
    } else if ((language === "c" || language === "cpp") && node.type === "preproc_include") {
      const raw = node.childForFieldName("path")?.text;
      if (raw && !raw.startsWith("<")) {
        const module = stripQuotes(raw);
        add({ local: lastDottedPart(module), module, kind: "module" });
      }
    }
    for (const child of namedChildren(node)) walk(child);
  };
  walk(root);
  return imports;
}

function callParts(node: Node, language: string): { callee: string; qualifier?: string; via: "free" | "qualified" } | null {
  if (language === "java" && node.type === "method_invocation") {
    const nameNode = node.childForFieldName("name");
    const name = nameNode?.text;
    if (!name) return null;
    const kids = namedChildren(node);
    const qualifier = kids[0] !== nameNode && kids[0]?.type !== "argument_list" ? kids[0]?.text : undefined;
    return { callee: name, qualifier, via: qualifier ? "qualified" : "free" };
  }
  if (language === "python" && node.type === "call") {
    const fn = node.childForFieldName("function");
    if (!fn) return null;
    if (fn.type === "identifier") return { callee: fn.text, via: "free" };
    if (fn.type === "attribute") {
      const kids = namedChildren(fn);
      const callee = kids[kids.length - 1]?.text;
      const qualifier = kids.slice(0, -1).map((n) => n.text).join(".");
      return callee ? { callee, qualifier, via: "qualified" } : null;
    }
  }
  if (language === "go" && node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    if (!fn) return null;
    if (fn.type === "identifier") return { callee: fn.text, via: "free" };
    if (fn.type === "selector_expression") {
      const kids = namedChildren(fn);
      const callee = kids[kids.length - 1]?.text;
      const qualifier = kids.slice(0, -1).map((n) => n.text).join(".");
      return callee ? { callee, qualifier, via: "qualified" } : null;
    }
  }
  if (language === "rust" && node.type === "call_expression") {
    const fn = node.childForFieldName("function");
    if (!fn) return null;
    if (fn.type === "identifier") return { callee: fn.text, via: "free" };
    if (fn.type === "scoped_identifier") {
      const callee = fn.childForFieldName("name")?.text;
      const qualifier = fn.childForFieldName("path")?.text.replace(/::/g, ".");
      return callee && qualifier ? { callee, qualifier, via: "qualified" } : null;
    }
  }
  if (language === "kotlin" && node.type === "call_expression") {
    const fn = namedChildren(node).find((n) => n.type !== "call_suffix");
    if (!fn) return null;
    if (fn.type === "simple_identifier") return { callee: fn.text, via: "free" };
    if (fn.type === "navigation_expression") {
      const kids = namedChildren(fn);
      const suffix = kids[kids.length - 1];
      const suffixKids = suffix?.type === "navigation_suffix" ? namedChildren(suffix) : [];
      const callee = suffixKids[suffixKids.length - 1]?.text;
      const qualifier = kids.slice(0, -1).map((n) => n.text).join(".");
      return callee && qualifier ? { callee, qualifier, via: "qualified" } : null;
    }
  }
  if (language === "php") {
    if (node.type === "function_call_expression") {
      const fn = node.childForFieldName("function");
      return fn?.text ? { callee: fn.text, via: "free" } : null;
    }
    if (node.type === "scoped_call_expression") {
      const qualifier = node.childForFieldName("scope")?.text;
      const callee = node.childForFieldName("name")?.text;
      return callee && qualifier ? { callee, qualifier, via: "qualified" } : null;
    }
  }
  if (language === "csharp" && node.type === "invocation_expression") {
    const fn = node.childForFieldName("function");
    if (!fn) return null;
    if (fn.type === "identifier") return { callee: fn.text, via: "free" };
    if (fn.type === "member_access_expression") {
      const kids = namedChildren(fn);
      const callee = fn.childForFieldName("name")?.text ?? kids[kids.length - 1]?.text;
      const qualifier = (fn.childForFieldName("expression")?.text ?? kids.slice(0, -1).map((n) => n.text).join(".")).replace(/\?$/, "");
      return callee && qualifier ? { callee, qualifier, via: "qualified" } : null;
    }
  }
  return null;
}

const GO_TEST_FAIL_METHODS = new Set(["Error", "Errorf", "Fatal", "Fatalf", "Fail", "FailNow"]);
const GO_TESTIFY_ASSERT_MODULE = /^github\.com\/stretchr\/testify\/(?:v\d+\/)?(?:assert|require)$/;
const GO_TESTIFY_SUITE_MODULE = /^github\.com\/stretchr\/testify\/(?:v\d+\/)?suite$/;
const GO_ASSERT_METHODS = new Set([
  "Contains",
  "Equal",
  "Error",
  "ErrorIs",
  "False",
  "Len",
  "Nil",
  "NoError",
  "NotContains",
  "NotEqual",
  "NotNil",
  "NotZero",
  "True",
  "Zero"
]);

function selectorParts(node: Node): { qualifier: string; name: string } | null {
  if (node.type !== "selector_expression") return null;
  const kids = namedChildren(node);
  const name = kids[kids.length - 1]?.text;
  const qualifier = kids.slice(0, -1).map((n) => n.text).join(".");
  return qualifier && name ? { qualifier, name } : null;
}

function callFunctionSelector(node: Node): { qualifier: string; name: string } | null {
  if (node.type !== "call_expression") return null;
  const fn = node.childForFieldName("function");
  return fn ? selectorParts(fn) : null;
}

function containsIdentifier(node: Node | null, names: Set<string>): boolean {
  if (!node) return false;
  if ((node.type === "identifier" || node.type === "package_identifier") && names.has(node.text)) return true;
  return namedChildren(node).some((child) => containsIdentifier(child, names));
}

function goTestingParamNames(fn: Node): Set<string> {
  const out = new Set<string>();
  const params = fn.childForFieldName("parameters");
  collectGoTestingParamNames(params, out);
  return out;
}

function collectGoTestingParamNames(params: Node | null, out: Set<string>): void {
  if (!params) return;
  for (const child of namedChildren(params)) {
    if (!/parameter/.test(child.type)) continue;
    const type = child.childForFieldName("type")?.text ?? "";
    if (/testing\.[TB]\b/.test(type)) {
      const name = child.childForFieldName("name")?.text;
      if (name) out.add(name);
    }
  }
}

function goAssertLocals(imports: TreeSitterImportBinding[]): Set<string> {
  const out = new Set<string>();
  for (const i of imports) {
    if (GO_TESTIFY_ASSERT_MODULE.test(i.module)) out.add(i.local);
  }
  return out;
}

function goSuiteLocals(imports: TreeSitterImportBinding[]): Set<string> {
  const out = new Set<string>();
  for (const i of imports) {
    if (GO_TESTIFY_SUITE_MODULE.test(i.module)) out.add(i.local);
  }
  return out;
}

function goCanonicalSuiteTypes(root: Node, suiteLocals: Set<string>): Set<string> {
  const out = new Set<string>();
  const isSuiteType = (node: Node | null): boolean => {
    if (!node) return false;
    const text = node.text.replace(/^\*/, "");
    return [...suiteLocals].some((local) => text === `${local}.Suite`);
  };
  const walk = (node: Node): void => {
    if (node.type === "type_spec") {
      const name = node.childForFieldName("name")?.text;
      const typeNode = node.childForFieldName("type");
      if (name && typeNode?.type === "struct_type") {
        const embedsSuite = typeNode
          .descendantsOfType("field_declaration")
          .some((field) => Boolean(field && isSuiteType(field.childForFieldName("type"))));
        if (embedsSuite) out.add(name);
      }
    }
    for (const child of namedChildren(node)) walk(child);
  };
  walk(root);
  return out;
}

function goDotAssertMethods(root: Node): Set<string> {
  const out = new Set<string>();
  const walk = (node: Node): void => {
    if (node.type === "import_spec") {
      const raw = node.childForFieldName("path")?.text;
      const module = raw ? stripQuotes(raw) : undefined;
      const alias = node.childForFieldName("name")?.text;
      if (alias === "." && module && GO_TESTIFY_ASSERT_MODULE.test(module)) {
        for (const method of GO_ASSERT_METHODS) out.add(method);
      }
    }
    for (const child of namedChildren(node)) walk(child);
  };
  walk(root);
  return out;
}

function callExpressions(node: Node | null): Node[] {
  if (!node) return [];
  const out: Node[] = [];
  const walk = (cur: Node): void => {
    if (cur.type === "call_expression") out.push(cur);
    for (const child of namedChildren(cur)) walk(child);
  };
  walk(node);
  return out;
}

function goProductCallsIn(node: Node | null): Array<{ callee: string; qualifier?: string; via: "free" | "qualified" }> {
  return callExpressions(node).map((call) => callParts(call, "go")).filter((p): p is { callee: string; qualifier?: string; via: "free" | "qualified" } => Boolean(p));
}

function singleGoProductCallIn(node: Node | null): Array<{ callee: string; qualifier?: string; via: "free" | "qualified" }> {
  const calls = goProductCallsIn(node);
  return calls.length === 1 ? calls : [];
}

function hasGoTestingFailure(node: Node | null, testingParams: Set<string>): boolean {
  return callExpressions(node).some((call) => {
    const sel = callFunctionSelector(call);
    return Boolean(sel && testingParams.has(sel.qualifier) && GO_TEST_FAIL_METHODS.has(sel.name));
  });
}

/** 1-based source line of the first `t.Error*`/`t.Fatal*` call in a consequence (undefined if none). */
function goTestingFailureCallLine(node: Node | null, testingParams: Set<string>): number | undefined {
  const call = callExpressions(node).find((c) => {
    const sel = callFunctionSelector(c);
    return Boolean(sel && testingParams.has(sel.qualifier) && GO_TEST_FAIL_METHODS.has(sel.name));
  });
  return call ? call.startPosition.row + 1 : undefined;
}

function goAssertionCalls(node: Node | null, assertLocals: Set<string>, dotAssertMethods: Set<string>, shadowed: Set<string>): Node[] {
  return callExpressions(node).filter((call) => {
    const sel = callFunctionSelector(call);
    if (sel) return !shadowed.has(sel.qualifier) && assertLocals.has(sel.qualifier) && GO_ASSERT_METHODS.has(sel.name);
    const fn = call.childForFieldName("function");
    return Boolean(fn?.type === "identifier" && !shadowed.has(fn.text) && dotAssertMethods.has(fn.text));
  });
}

function goAssertionIdentifierArgs(assertion: Node, testingParams: Set<string>): string[] {
  const sel = callFunctionSelector(assertion);
  const name = sel?.name ?? assertion.childForFieldName("function")?.text;
  const args = namedChildren(assertion.childForFieldName("arguments") ?? assertion).filter((n) => n.type !== "comment");
  if (!name || args.length < 2) return [];
  if (!testingParams.has(args[0]?.text ?? "")) return [];
  const slots = name === "Equal" || name === "NotEqual" ? [args[1], args[2]] : [args[1]];
  return slots.filter((n): n is Node => n?.type === "identifier").map((n) => n.text);
}

function goAssertionSubject(assertion: Node, testingParams: Set<string>): Node | null {
  const sel = callFunctionSelector(assertion);
  const name = sel?.name ?? assertion.childForFieldName("function")?.text;
  const args = namedChildren(assertion.childForFieldName("arguments") ?? assertion).filter((n) => n.type !== "comment");
  if (!name || args.length < 2) return null;
  if (!testingParams.has(args[0]?.text ?? "")) return null;
  if (name === "Equal" || name === "NotEqual") return args[2] ?? null;
  return args[1] ?? null;
}

function goSuiteReceiver(fn: Node, suiteTypes: Set<string>): string | null {
  const receiver = fn.childForFieldName("receiver");
  const param = namedChildren(receiver ?? fn).find((n) => n.type === "parameter_declaration");
  const name = param?.childForFieldName("name")?.text;
  const type = param?.childForFieldName("type")?.text.replace(/^\*/, "");
  return name && type && suiteTypes.has(type) ? name : null;
}

function goSuiteAssertionCalls(node: Node | null, receiver: string, shadowed: Set<string>): Node[] {
  if (shadowed.has(receiver)) return [];
  return callExpressions(node).filter((call) => {
    const fn = call.childForFieldName("function");
    const sel = fn ? selectorParts(fn) : null;
    if (!sel || !GO_ASSERT_METHODS.has(sel.name)) return false;
    if (sel.qualifier === receiver) return true;
    const operand = fn?.childForFieldName("operand");
    const access = operand?.type === "call_expression" ? callFunctionSelector(operand) : null;
    return Boolean(access && access.qualifier === receiver && (access.name === "Require" || access.name === "Assert"));
  });
}

function goSuiteAssertionSubject(assertion: Node): Node | null {
  const sel = callFunctionSelector(assertion);
  const args = namedChildren(assertion.childForFieldName("arguments") ?? assertion).filter((n) => n.type !== "comment");
  if (!sel?.name || args.length < 1) return null;
  if (sel.name === "Equal" || sel.name === "NotEqual") return args[1] ?? null;
  return args[0] ?? null;
}

function goSubtestBody(
  stmt: Node,
  testingParams: Set<string>
): { body: Node; testingParams: Set<string>; subName?: string } | null {
  const call = callExpressions(stmt).find((c) => {
    const sel = callFunctionSelector(c);
    return Boolean(sel && testingParams.has(sel.qualifier) && sel.name === "Run");
  });
  if (!call) return null;
  const args = namedChildren(call.childForFieldName("arguments") ?? call);
  const fn = args.find((n) => n.type === "func_literal");
  const body = fn?.childForFieldName("body");
  if (!fn || !body) return null;
  const nextTestingParams = new Set(testingParams);
  collectGoTestingParamNames(fn.childForFieldName("parameters"), nextTestingParams);
  if (nextTestingParams.size <= testingParams.size) return null;
  // Only a STRING-LITERAL subtest name with no chars Go would rewrite in the `-run`
  // path (letters/digits/underscore) is recorded — that segment matches the go-test
  // JSON `Test` field verbatim (`TestX/sub`). A runtime name (`tc.Name`) or a literal
  // needing sanitization yields no subName → the caller keeps the parent `TestX`, whose
  // exact-match oracle safely refuses the runtime subtest frames rather than false-prove.
  const nameArg = args.find((n) => n.type !== "func_literal");
  // A double-quoted `interpreted_string_literal` text is the source token WITH quotes
  // (e.g. `"basic"`); strip them and accept only a `-run`-safe identifier segment.
  const raw = nameArg?.type === "interpreted_string_literal" ? nameArg.text : undefined;
  const inner = raw && raw.length >= 2 && raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : undefined;
  const subName = inner && /^[A-Za-z0-9_]+$/.test(inner) ? inner : undefined;
  return { body, testingParams: nextTestingParams, ...(subName ? { subName } : {}) };
}

function goShortVarCalls(stmt: Node): { names: Set<string>; calls: Array<{ callee: string; qualifier?: string; via: "free" | "qualified" }> } | null {
  if (stmt.type !== "short_var_declaration") return null;
  const names = new Set<string>();
  collectNames(stmt.childForFieldName("left") ?? stmt.namedChild(0), names);
  const calls = singleGoProductCallIn(stmt.childForFieldName("right") ?? namedChildren(stmt)[1] ?? null);
  return names.size && calls.length ? { names, calls } : null;
}

function extractGoProofCalls(root: Node, imports: TreeSitterImportBinding[]): TreeSitterGoProofCall[] {
  const out: TreeSitterGoProofCall[] = [];
  const seen = new Set<string>();
  // Var name → constructor name for locals declared in the CURRENT test func by a
  // bare same-package `x := New(...)` (single unqualified call). Reset per top-level
  // test func; marks a qualified proof-call `p.M()` as receiver-local AND carries
  // the ctor name so the analyzer can pin p's receiver type from New's result.
  let receiverLocals = new Map<string, string>();
  const assertLocals = goAssertLocals(imports);
  const dotAssertMethods = goDotAssertMethods(root);
  const suiteTypes = goCanonicalSuiteTypes(root, goSuiteLocals(imports));
  const add = (
    testName: string,
    shadowed: Set<string>,
    assertion: TreeSitterGoProofCall["assertion"],
    calls: Array<{ callee: string; qualifier?: string; via: "free" | "qualified" }>,
    assertionLine?: number
  ): void => {
    for (const c of calls) {
      const key = `${testName}|${c.qualifier ?? ""}|${c.callee}|${assertion}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const receiverCtor = c.via === "qualified" && !!c.qualifier && !c.qualifier.includes(".") ? receiverLocals.get(c.qualifier) : undefined;
      out.push({ caller: testName, testName, ...c, shadowed: [...shadowed], assertion, ...(assertionLine ? { assertionLine } : {}), ...(receiverCtor ? { receiverLocal: true, receiverCtor } : {}) });
    }
  };
  const processBlock = (block: Node, testName: string, testingParams: Set<string>, shadowed: Set<string>): void => {
    // ONE-HOP block-local dataflow: a standalone `x, err := F(...)` statement is
    // credited when a LATER statement in the SAME block checks a declared name
    // (if-fail condition or assert subject). This covers the dominant real-Go
    // idiom the if-initializer shape misses. Discipline kept: single product
    // call per statement (goShortVarCalls), last write wins, plain reassignment
    // invalidates, never crosses block boundaries. Metadata only — the dynamic
    // oracle still re-verifies every edge before anything is Proven.
    const pending = new Map<string, Array<{ callee: string; qualifier?: string; via: "free" | "qualified" }>>();
    // Deferred pending credits: witness lines are collected per call and flushed
    // after the block — one witness keeps its exact line (subtest binding),
    // several witnesses drop the line (the oracle's frame-line gate must never
    // refuse a real kill firing at a sibling check).
    const pendingHits = new Map<
      string,
      { assertion: TreeSitterGoProofCall["assertion"]; calls: Array<{ callee: string; qualifier?: string; via: "free" | "qualified" }>; lines: Set<number> }
    >();
    const hitPending = (
      assertion: TreeSitterGoProofCall["assertion"],
      calls: Array<{ callee: string; qualifier?: string; via: "free" | "qualified" }>,
      line: number | undefined
    ): void => {
      for (const c of calls) {
        const key = `${assertion}|${c.qualifier ?? ""}|${c.callee}`;
        const hit = pendingHits.get(key) ?? { assertion, calls: [c], lines: new Set<number>() };
        if (line !== undefined) hit.lines.add(line);
        pendingHits.set(key, hit);
      }
    };
    for (const stmt of blockStatements(block)) {
      for (const assertion of goAssertionCalls(stmt, assertLocals, dotAssertMethods, shadowed)) {
        const subject = goAssertionSubject(assertion, testingParams);
        add(testName, shadowed, "assert_helper", singleGoProductCallIn(subject), assertion.startPosition.row + 1);
        for (const argName of goAssertionIdentifierArgs(assertion, testingParams)) {
          if (pending.has(argName)) hitPending("assert_helper", pending.get(argName)!, assertion.startPosition.row + 1);
        }
      }
      if (stmt.type === "if_statement" && hasGoTestingFailure(stmt.childForFieldName("consequence"), testingParams)) {
        const condition = stmt.childForFieldName("condition");
        // Go reports the failing frame at the `t.Error*`/`t.Fatal*` CALL inside the
        // consequence, not the `if` line — bind the line there so the subtest gate matches.
        const failLine = goTestingFailureCallLine(stmt.childForFieldName("consequence"), testingParams);
        add(testName, shadowed, "testing_fail", singleGoProductCallIn(condition), failLine);
        const init = stmt.childForFieldName("initializer");
        const initCalls = init ? goShortVarCalls(init) : null;
        if (initCalls && containsIdentifier(condition, initCalls.names)) add(testName, shadowed, "testing_fail", initCalls.calls, failLine);
        for (const [name, calls] of pending) {
          if (containsIdentifier(condition, new Set([name]))) hitPending("testing_fail", calls, failLine);
        }
      }
      for (const child of namedChildren(stmt)) {
        if (child.type === "block") processBlock(child, testName, testingParams, shadowed);
      }
      const subtest = goSubtestBody(stmt, testingParams);
      if (subtest) {
        const subTestName = subtest.subName ? `${testName}/${subtest.subName}` : testName;
        processBlock(subtest.body, subTestName, subtest.testingParams, shadowed);
      }
      // Record declarations AFTER uses: a declaration is never its own check.
      const sv = stmt.type === "short_var_declaration" ? goShortVarCalls(stmt) : null;
      if (sv) {
        for (const name of sv.names) pending.set(name, sv.calls);
      }
      if (stmt.type === "short_var_declaration") {
        // A lone `x := New(...)` makes x a receiver-local: its type comes from a
        // same-package constructor, so `x.M()` targets a same-package method. This
        // check inspects the TOP-LEVEL RHS call directly (not goShortVarCalls, whose
        // single-product-call rule drops `New(strings.NewReader(...))` for its nested
        // arg — the real phcparser shape). Refuses composite literals, qualified/
        // imported calls, and multi-assign — none are receiver-locals.
        const rhsNames = new Set<string>();
        collectNames(stmt.childForFieldName("left") ?? stmt.namedChild(0), rhsNames);
        const rhs = stmt.childForFieldName("right");
        const rhsCalls = rhs ? namedChildren(rhs).filter((n) => n.type === "call_expression") : [];
        if (rhsNames.size === 1 && rhsCalls.length === 1) {
          const cp = callParts(rhsCalls[0], "go");
          if (cp && cp.via === "free") receiverLocals.set([...rhsNames][0], cp.callee);
        }
      } else if (stmt.type === "assignment_statement") {
        // Reassigning a receiver-local invalidates it too.
        const reassignedRl = new Set<string>();
        collectNames(stmt.childForFieldName("left") ?? stmt.namedChild(0), reassignedRl);
        for (const name of reassignedRl) receiverLocals.delete(name);
        // Plain reassignment kills the binding — the checked value is no longer F's.
        const reassigned = new Set<string>();
        collectNames(stmt.childForFieldName("left") ?? stmt.namedChild(0), reassigned);
        for (const name of reassigned) pending.delete(name);
      }
    }
    for (const hit of pendingHits.values()) {
      const line = hit.lines.size === 1 ? [...hit.lines][0] : undefined;
      add(testName, shadowed, hit.assertion, hit.calls, line);
    }
  };
  const processSuiteBlock = (block: Node, testName: string, receiver: string, shadowed: Set<string>): void => {
    for (const stmt of blockStatements(block)) {
      for (const assertion of goSuiteAssertionCalls(stmt, receiver, shadowed)) {
        add(testName, shadowed, "assert_helper", singleGoProductCallIn(goSuiteAssertionSubject(assertion)));
      }
      for (const child of namedChildren(stmt)) {
        if (child.type === "block") processSuiteBlock(child, testName, receiver, shadowed);
      }
    }
  };
  for (const child of namedChildren(root)) {
    if (child.type === "method_declaration") {
      const name = functionName(child, "go");
      if (!name || !/^Test[A-Z0-9_]/.test(name)) continue;
      const receiver = goSuiteReceiver(child, suiteTypes);
      const body = child.childForFieldName("body");
      if (!receiver || !body) continue;
      processSuiteBlock(body, name, receiver, localBindings(child, "go"));
      continue;
    }
    if (child.type !== "function_declaration") continue;
    const name = functionName(child, "go");
    if (!name || !/^Test[A-Z0-9_]/.test(name)) continue;
    const testingParams = goTestingParamNames(child);
    const body = child.childForFieldName("body");
    if (!testingParams.size || !body) continue;
    receiverLocals = new Map<string, string>();
    processBlock(body, name, testingParams, localBindings(child, "go"));
  }
  return out;
}

const JAVA_JUNIT_ASSERT_CLASSES = {
  junit4: "org.junit.Assert",
  junit5: "org.junit.jupiter.api.Assertions"
} as const;
const JAVA_JUNIT_TEST_ANNOTATIONS = new Set(["org.junit.Test", "org.junit.jupiter.api.Test"]);
const JAVA_ASSERT_ACTUAL_ARG = new Set([
  "assertArrayEquals",
  "assertEquals",
  "assertIterableEquals",
  "assertLinesMatch",
  "assertNotEquals",
  "assertNotSame",
  "assertSame"
]);
const JAVA_ASSERT_SUBJECT_ARG = new Set(["assertFalse", "assertNotNull", "assertNull", "assertTrue"]);
const JAVA_ASSERT_METHODS = new Set([...JAVA_ASSERT_ACTUAL_ARG, ...JAVA_ASSERT_SUBJECT_ARG]);
const JAVA_ASSERTJ_ASSERT_CLASS = "org.assertj.core.api.Assertions";

function addJavaAssertionImport(
  out: Map<string, Set<TreeSitterJavaProofCall["assertion"]>>,
  name: string,
  assertion: TreeSitterJavaProofCall["assertion"]
): void {
  if (!JAVA_ASSERT_METHODS.has(name)) return;
  let set = out.get(name);
  if (!set) out.set(name, (set = new Set()));
  set.add(assertion);
}

function javaJunitAssertImports(root: Node): Map<string, Set<TreeSitterJavaProofCall["assertion"]>> {
  const out = new Map<string, Set<TreeSitterJavaProofCall["assertion"]>>();
  for (const node of root.descendantsOfType("import_declaration")) {
    if (!node) continue;
    if (!/^import\s+static\b/.test(node.text)) continue;
    const spec = namedChildren(node).find((n) => n.type.endsWith("identifier"))?.text;
    if (!spec) continue;
    const star = namedChildren(node).some((n) => n.type === "asterisk");
    for (const [assertion, owner] of Object.entries(JAVA_JUNIT_ASSERT_CLASSES) as Array<[TreeSitterJavaProofCall["assertion"], string]>) {
      if (star && spec === owner) {
        for (const method of JAVA_ASSERT_METHODS) addJavaAssertionImport(out, method, assertion);
      } else if (!star && spec.startsWith(`${owner}.`)) {
        addJavaAssertionImport(out, lastDottedPart(spec), assertion);
      }
    }
  }
  return out;
}

/**
 * True when `assertThat` is statically imported from AssertJ (`org.assertj.core.api.Assertions`,
 * star or explicit) — the canonical Spring/Mockito unit assertion. AssertJ chains on a subject
 * (`assertThat(x).isEqualTo(...)`), so recognizing the `assertThat(x)` head lets the extractor see
 * the target call that produced `x`. Trust is unchanged: the emitted edge only NAMES a candidate
 * test; the frozen dynamic oracle still re-runs it and refuses/survives if the target isn't proven.
 */
function javaHasAssertjAssertThat(root: Node): boolean {
  for (const node of root.descendantsOfType("import_declaration")) {
    if (!node) continue;
    if (!/^import\s+static\b/.test(node.text)) continue;
    const spec = namedChildren(node).find((n) => n.type.endsWith("identifier"))?.text;
    if (!spec) continue;
    const star = namedChildren(node).some((n) => n.type === "asterisk");
    if (star && spec === JAVA_ASSERTJ_ASSERT_CLASS) return true;
    if (!star && spec === `${JAVA_ASSERTJ_ASSERT_CLASS}.assertThat`) return true;
  }
  return false;
}

/**
 * Map each declared FIELD name → its declared type simple name, for a test class. The declared
 * type IS the receiver's static type (no dataflow needed) — so `private PetTypeFormatter fmt;`
 * yields `fmt → PetTypeFormatter`. Used to resolve the className when an assertion's target call
 * has a field receiver (`this.fmt.method(...)` or the bare `fmt.method(...)`), the canonical
 * `@BeforeEach`/`@Autowired`-injected Spring unit shape.
 */
function javaFieldTypes(root: Node): Map<string, string> {
  const out = new Map<string, string>();
  for (const node of root.descendantsOfType("field_declaration")) {
    if (!node) continue;
    const className = simpleJavaClassName(node.childForFieldName("type")?.text);
    if (!className) continue;
    for (const child of namedChildren(node)) {
      if (child.type !== "variable_declarator") continue;
      const name = child.childForFieldName("name")?.text;
      // First declaration wins; a name declared with two different types is left unresolved
      // (fields don't legally redeclare, but guard against odd trees).
      if (name && !out.has(name)) out.set(name, className);
    }
  }
  return out;
}

function javaJunitTestAnnotationLocals(imports: TreeSitterImportBinding[]): Set<string> {
  const out = new Set<string>();
  for (const i of imports) {
    if (JAVA_JUNIT_TEST_ANNOTATIONS.has(i.module)) out.add(i.local);
  }
  return out;
}

function annotationName(node: Node): string | undefined {
  if (node.type !== "marker_annotation" && node.type !== "annotation") return undefined;
  return node.childForFieldName("name")?.text ?? namedChildren(node)[0]?.text;
}

function javaAnnotationNames(method: Node): string[] {
  const modifiers = namedChildren(method).find((n) => n.type === "modifiers");
  if (!modifiers) return [];
  const out: string[] = [];
  const walk = (node: Node): void => {
    const name = annotationName(node);
    if (name) out.push(name);
    for (const child of namedChildren(node)) walk(child);
  };
  walk(modifiers);
  return out;
}

function isJavaJunitTestMethod(method: Node, testAnnotationLocals: Set<string>): boolean {
  return javaAnnotationNames(method).some((name) => JAVA_JUNIT_TEST_ANNOTATIONS.has(name) || testAnnotationLocals.has(name));
}

function javaDeclaredMethodNames(root: Node): Set<string> {
  const out = new Set<string>();
  for (const method of root.descendantsOfType("method_declaration")) {
    if (!method) continue;
    const name = functionName(method, "java");
    if (name) out.add(name);
  }
  return out;
}

function javaClassInfos(root: Node): TreeSitterJavaClassInfo[] {
  const out: TreeSitterJavaClassInfo[] = [];
  const walk = (node: Node): void => {
    if (node.type === "class_declaration" || node.type === "interface_declaration" || node.type === "enum_declaration" || node.type === "record_declaration") {
      const name = node.childForFieldName("name")?.text;
      const body = node.childForFieldName("body");
      const methods = new Set<string>();
      if (body) {
        for (const child of namedChildren(body)) {
          if (child.type !== "method_declaration") continue;
          const method = functionName(child, "java");
          if (method) methods.add(method);
        }
      }
      if (name) out.push({ name, methods: [...methods].sort() });
    }
    for (const child of namedChildren(node)) walk(child);
  };
  walk(root);
  return out;
}

function hasAncestorTypeBefore(node: Node, stop: Node, type: string): boolean {
  let cur = node.parent;
  while (cur && cur.id !== stop.id) {
    if (cur.type === type) return true;
    cur = cur.parent;
  }
  return false;
}

function javaAssertionCalls(
  node: Node,
  assertImports: Map<string, Set<TreeSitterJavaProofCall["assertion"]>>,
  shadowed: Set<string>
): Array<{ call: Node; assertions: Set<TreeSitterJavaProofCall["assertion"]> }> {
  return node
    .descendantsOfType("method_invocation")
    .filter((call): call is Node => Boolean(call))
    .filter((call) => !hasAncestorTypeBefore(call, node, "lambda_expression"))
    .map((call) => {
      const name = call.childForFieldName("name")?.text;
      const object = call.childForFieldName("object");
      const assertions = name && !object && !shadowed.has(name) ? assertImports.get(name) : undefined;
      return assertions ? { call, assertions } : null;
    })
    .filter((v): v is { call: Node; assertions: Set<TreeSitterJavaProofCall["assertion"]> } => Boolean(v));
}

function javaAssertionSubject(call: Node, assertions: Set<TreeSitterJavaProofCall["assertion"]>): Node | null {
  const name = call.childForFieldName("name")?.text;
  const args = namedChildren(call.childForFieldName("arguments") ?? call).filter((n) => n.type !== "comment");
  if (!name) return null;
  if (JAVA_ASSERT_ACTUAL_ARG.has(name)) {
    if (args.length === 2) return args[1] ?? null;
    if (args.length === 3 && assertions.size === 1 && assertions.has("junit5")) return args[1] ?? null;
    return null;
  }
  if (JAVA_ASSERT_SUBJECT_ARG.has(name)) {
    if (args.length === 1) return args[0] ?? null;
    if (args.length === 2 && assertions.size === 1 && assertions.has("junit5")) return args[0] ?? null;
  }
  return null;
}

function javaCallLikeCount(node: Node | null): number {
  if (!node) return 0;
  let count = node.type === "method_invocation" || node.type === "object_creation_expression" ? 1 : 0;
  for (const child of namedChildren(node)) count += javaCallLikeCount(child);
  return count;
}

function simpleJavaClassName(text: string | undefined): string | null {
  return text && /^[A-Za-z_$][\w$]*$/.test(text) ? text : null;
}

function javaObjectCreationClassName(node: Node): string | null {
  if (node.type !== "object_creation_expression") return null;
  if (namedChildren(node).some((n) => n.type === "class_body")) return null;
  return simpleJavaClassName(node.childForFieldName("type")?.text);
}

/**
 * Resolve a method-invocation receiver `object` node to the target class simple name.
 * - `Foo.bar()` static-style: a class-shaped bare identifier → the identifier itself.
 * - `fmt.bar()` bare FIELD identifier → the field's declared type (from `fieldTypes`).
 * - `this.fmt.bar()` field access → the field's declared type.
 * A bare identifier that is a known field is resolved as a field (its declared type), NOT as a
 * class name — the field-type map is authoritative for receivers it knows.
 */
function javaReceiverClassName(object: Node | null, fieldTypes: Map<string, string>): string | null {
  if (!object) return null;
  if (object.type === "identifier") {
    const field = fieldTypes.get(object.text);
    return field ?? simpleJavaClassName(object.text);
  }
  if (object.type === "field_access" && object.childForFieldName("object")?.type === "this") {
    const fieldName = object.childForFieldName("field")?.text;
    return fieldName ? (fieldTypes.get(fieldName) ?? null) : null;
  }
  return null;
}

function javaDirectProofTarget(
  subject: Node | null,
  fieldTypes: Map<string, string>
): Pick<TreeSitterJavaProofCall, "className" | "callee" | "target_kind"> | null {
  if (!subject || javaCallLikeCount(subject) !== 1) return null;
  if (subject.type === "object_creation_expression") {
    const className = javaObjectCreationClassName(subject);
    return className ? { className, callee: className, target_kind: "constructor" } : null;
  }
  if (subject.type !== "method_invocation") return null;
  const callee = subject.childForFieldName("name")?.text;
  const className = javaReceiverClassName(subject.childForFieldName("object"), fieldTypes);
  return callee && className ? { className, callee, target_kind: "method" } : null;
}

function processJavaNestedBlocks(block: Node, testName: string, shadowed: Set<string>, processBlock: (block: Node, testName: string, shadowed: Set<string>) => void): void {
  const walk = (node: Node): void => {
    if (node.type === "lambda_expression") return;
    for (const child of namedChildren(node)) {
      if (child.type === "block") processBlock(child, testName, shadowed);
      else walk(child);
    }
  };
  walk(block);
}

/**
 * Map each local variable in a @Test method body → the single method_invocation that initialized
 * it (e.g. `String r = this.fmt.print(x);` → `r → this.fmt.print(x)`). Lets an AssertJ chain whose
 * subject is a local (`assertThat(r).isEqualTo(...)`) resolve back to the target call that produced
 * it. Only the DIRECT initializer of a `local_variable_declaration` is recorded; reassignment is
 * ignored (fail-closed: an ambiguous local simply yields no edge).
 */
function javaLocalVarInits(body: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  for (const decl of body.descendantsOfType("local_variable_declaration")) {
    if (!decl) continue;
    for (const child of namedChildren(decl)) {
      if (child.type !== "variable_declarator") continue;
      const name = child.childForFieldName("name")?.text;
      const value = child.childForFieldName("value");
      if (name && value && !out.has(name)) out.set(name, value);
    }
  }
  return out;
}

/**
 * The subject expression an AssertJ chain asserts on, i.e. the sole argument of the `assertThat(x)`
 * head of a chain. Returns null when it isn't an `assertThat(...)` call with exactly one argument.
 */
function javaAssertjSubjectArg(call: Node, shadowed: Set<string>): Node | null {
  if (call.childForFieldName("name")?.text !== "assertThat") return null;
  if (call.childForFieldName("object")) return null; // must be the bare imported free call
  if (shadowed.has("assertThat")) return null;
  const args = namedChildren(call.childForFieldName("arguments") ?? call).filter((n) => n.type !== "comment");
  return args.length === 1 ? (args[0] ?? null) : null;
}

function extractJavaProofCalls(root: Node, imports: TreeSitterImportBinding[]): TreeSitterJavaProofCall[] {
  const out: TreeSitterJavaProofCall[] = [];
  const seen = new Set<string>();
  const assertImports = javaJunitAssertImports(root);
  const hasAssertj = javaHasAssertjAssertThat(root);
  if (assertImports.size === 0 && !hasAssertj) return out;
  const fieldTypes = javaFieldTypes(root);
  const testAnnotationLocals = javaJunitTestAnnotationLocals(imports);
  const declaredMethods = javaDeclaredMethodNames(root);
  const add = (
    testName: string,
    shadowed: Set<string>,
    assertions: Set<TreeSitterJavaProofCall["assertion"]>,
    target: Pick<TreeSitterJavaProofCall, "className" | "callee" | "target_kind"> | null
  ): void => {
    if (!target || shadowed.has(target.className)) return;
    const assertion = assertions.has("junit5") ? "junit5" : "junit4";
    const key = `${testName}|${target.target_kind}|${target.className}|${target.callee}|${assertion}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ testName, ...target, assertion, shadowed: [...shadowed] });
  };
  // AssertJ edges carry no static junit4/5 flavor; label them junit5 so `add`'s dedup/hash key is
  // stable. The value only feeds the provenance hash + edge-props — never a trust decision (the
  // frozen oracle re-runs the test regardless).
  const assertjAssertions = new Set<TreeSitterJavaProofCall["assertion"]>(["junit5"]);
  const processBlock = (block: Node, testName: string, shadowed: Set<string>, localInits: Map<string, Node>): void => {
    for (const stmt of blockStatements(block)) {
      for (const assertion of javaAssertionCalls(stmt, assertImports, shadowed)) {
        add(testName, shadowed, assertion.assertions, javaDirectProofTarget(javaAssertionSubject(assertion.call, assertion.assertions), fieldTypes));
      }
      if (hasAssertj) {
        for (const call of stmt.descendantsOfType("method_invocation")) {
          if (!call || hasAncestorTypeBefore(call, stmt, "lambda_expression")) continue;
          const arg = javaAssertjSubjectArg(call, shadowed);
          if (!arg) continue;
          // Subject is either the target call directly (`assertThat(this.fmt.m(...))`) or a local
          // whose initializer is the target call (`String r = this.fmt.m(...); assertThat(r)...`).
          const subject = arg.type === "identifier" ? (localInits.get(arg.text) ?? null) : arg;
          add(testName, shadowed, assertjAssertions, javaDirectProofTarget(subject, fieldTypes));
        }
      }
      processJavaNestedBlocks(stmt, testName, shadowed, (b, t, s) => processBlock(b, t, s, localInits));
    }
  };
  for (const method of root.descendantsOfType("method_declaration")) {
    if (!method) continue;
    if (!isJavaJunitTestMethod(method, testAnnotationLocals)) continue;
    const name = functionName(method, "java");
    const body = method.childForFieldName("body");
    if (!name || !body) continue;
    const shadowed = localBindings(method, "java");
    for (const declared of declaredMethods) {
      shadowed.add(declared);
    }
    processBlock(body, name, shadowed, javaLocalVarInits(body));
  }
  return out;
}

const FASTAPI_HTTP_METHODS = new Set(["get", "post", "put", "patch", "delete", "options", "head", "trace"]);

function pythonStaticString(node: Node | null): string | null {
  if (!node || node.type !== "string") return null;
  const contents = node.descendantsOfType("string_content").filter((n): n is Node => Boolean(n));
  if (contents.length !== 1) return null;
  return contents[0]?.text ?? null;
}

function pythonDottedName(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "identifier" || node.type === "dotted_name") return node.text;
  if (node.type !== "attribute") return null;
  const object = pythonDottedName(node.childForFieldName("object"));
  const attribute = node.childForFieldName("attribute")?.text;
  return object && attribute ? `${object}.${attribute}` : null;
}

function pythonCallArguments(call: Node): Node[] {
  const args = call.childForFieldName("arguments");
  return args ? namedChildren(args).filter((n) => n.type !== "comment") : [];
}

function pythonKeywordArgument(call: Node, name: string): Node | null {
  for (const arg of pythonCallArguments(call)) {
    if (arg.type !== "keyword_argument" || arg.childForFieldName("name")?.text !== name) continue;
    return arg.childForFieldName("value") ?? namedChildren(arg)[1] ?? null;
  }
  return null;
}

function pythonPositionalArguments(call: Node): Node[] {
  return pythonCallArguments(call).filter((n) => n.type !== "keyword_argument" && n.type !== "list_splat" && n.type !== "dictionary_splat");
}

function pythonStaticHttpMethods(node: Node | null, fallback: string[] = ["GET"]): string[] | null {
  if (!node) return fallback;
  if (!new Set(["list", "tuple", "set"]).has(node.type)) return null;
  const elements = namedChildren(node).filter((child) => child.type !== "comment");
  if (elements.length === 0) return null;
  const methods = elements.map((element) => pythonStaticString(element));
  if (methods.some((method) => method === null)) return null;
  const normalized = methods.map((method) => method!.toLowerCase());
  return normalized.every((method) => FASTAPI_HTTP_METHODS.has(method)) ? normalized.map((method) => method.toUpperCase()) : null;
}

function normalizePythonRoutePath(...parts: string[]): string {
  const joined = parts.map((p) => p.trim().replace(/^\/+|\/+$/g, "")).filter(Boolean).join("/");
  return joined ? `/${joined}` : "/";
}

function pythonImportedFromFastapi(imports: TreeSitterImportBinding[], local: string, imported: string): boolean {
  return imports.some((b) => b.local === local && b.module === "fastapi" && b.kind === "named" && b.imported === imported);
}

function pythonCallIsFastapiConstructor(call: Node, imports: TreeSitterImportBinding[], imported: "APIRouter" | "FastAPI"): boolean {
  const parts = callParts(call, "python");
  if (!parts) return false;
  if (!parts.qualifier) return pythonImportedFromFastapi(imports, parts.callee, imported);
  if (parts.callee !== imported) return false;
  const root = parts.qualifier.split(".")[0] ?? "";
  return imports.some((b) => b.local === root && b.kind === "module" && b.module === "fastapi");
}

interface PythonFastapiReceiver {
  kind: "app" | "router";
  prefix: string;
  prefixResolved: boolean;
  boundAt: number;
}

function pythonBindingTargetNames(target: Node | null): string[] {
  if (!target) return [];
  if (target.type === "identifier") return [target.text];
  if (!new Set(["pattern_list", "tuple_pattern", "list_pattern", "tuple", "list"]).has(target.type)) return [];
  return namedChildren(target).flatMap((child) => pythonBindingTargetNames(child));
}

function pythonFastapiReceivers(root: Node, imports: TreeSitterImportBinding[]): Map<string, PythonFastapiReceiver> {
  const mutationCount = new Map<string, number>();
  const candidates = new Map<string, PythonFastapiReceiver>();
  const mutations: Node[] = [];
  for (const type of ["assignment", "annotated_assignment", "augmented_assignment", "delete_statement"]) {
    mutations.push(...root.descendantsOfType(type).filter((node): node is Node => Boolean(node)));
  }
  mutations.sort((a, b) => a.startIndex - b.startIndex);
  for (const assignment of mutations) {
    if (!pythonDirectModuleExecution(assignment)) continue;
    const left = assignment.childForFieldName("left");
    const targets = assignment.type === "delete_statement"
      ? namedChildren(assignment).flatMap((child) => pythonBindingTargetNames(child))
      : pythonBindingTargetNames(left);
    for (const target of targets) mutationCount.set(target, (mutationCount.get(target) ?? 0) + 1);
    const right = assignment.childForFieldName("right");
    if (left?.type !== "identifier") continue;
    const kind = right?.type === "call" && pythonCallIsFastapiConstructor(right, imports, "APIRouter")
      ? "router"
      : right?.type === "call" && pythonCallIsFastapiConstructor(right, imports, "FastAPI")
        ? "app"
        : null;
    if (!kind || right?.type !== "call") continue;
    const prefixNode = kind === "router" ? pythonKeywordArgument(right, "prefix") : null;
    const staticPrefix = pythonStaticString(prefixNode);
    candidates.set(left.text, {
      kind,
      prefix: staticPrefix ?? "",
      prefixResolved: !prefixNode || staticPrefix !== null,
      boundAt: assignment.startIndex
    });
  }
  const out = new Map<string, PythonFastapiReceiver>();
  for (const [name, receiver] of candidates) if (mutationCount.get(name) === 1) out.set(name, receiver);
  return out;
}

const PYTHON_NONDETERMINISTIC_SCOPES = new Set([
  "function_definition", "class_definition", "if_statement", "for_statement", "while_statement",
  "try_statement", "with_statement", "match_statement", "lambda", "list_comprehension",
  "dictionary_comprehension", "set_comprehension", "generator_expression"
]);

function pythonDirectModuleExecution(node: Node): boolean {
  let parent = node.parent;
  while (parent) {
    if (PYTHON_NONDETERMINISTIC_SCOPES.has(parent.type)) return false;
    if (parent.type === "module") return true;
    parent = parent.parent;
  }
  return false;
}

function pythonRouterIncludePrefixes(root: Node, receivers: Map<string, PythonFastapiReceiver>): Map<string, Set<string>> {
  const out = new Map<string, Set<string>>();
  for (const call of root.descendantsOfType("call")) {
    if (!call || !pythonDirectModuleExecution(call)) continue;
    const parts = callParts(call, "python");
    const app = parts?.qualifier?.split(".")[0];
    if (!parts || parts.callee !== "include_router" || !app || receivers.get(app)?.kind !== "app") continue;
    const router = pythonDottedName(pythonPositionalArguments(call)[0] ?? null);
    if (!router || !receivers.has(router) || receivers.get(app)!.boundAt >= call.startIndex || receivers.get(router)!.boundAt >= call.startIndex) continue;
    const includePrefix = pythonStaticString(pythonKeywordArgument(call, "prefix"));
    if (includePrefix === null && pythonKeywordArgument(call, "prefix")) continue;
    let prefixes = out.get(router);
    if (!prefixes) out.set(router, (prefixes = new Set()));
    prefixes.add(includePrefix ?? "");
  }
  return out;
}

function makePythonBehaviorContract(input: {
  file: string;
  method: string;
  path: string;
  handler?: string;
  prefixStatus: "resolved" | "unresolved";
  prefix: string;
}): BehaviorContract {
  const identityInput = `${input.method}|${input.path}|${input.file}|${input.handler ?? ""}`;
  return {
    id: `endpoint:${slugify(`${input.method}-${input.path}-${input.file}-${input.handler ?? ""}`)}-${shortHash(identityInput)}`,
    title: `${input.method} ${input.path}`,
    kind: "http_endpoint",
    framework: "fastapi",
    method: input.method,
    path: input.path,
    file: input.file,
    handler: input.handler,
    route_prefix_status: input.prefixStatus,
    ...(input.prefix ? { route_prefix: input.prefix } : {}),
    source: "framework"
  };
}

function dedupePythonContracts(contracts: BehaviorContract[]): BehaviorContract[] {
  const seen = new Set<string>();
  return contracts.filter((contract) => {
    const key = `${contract.method}|${contract.path}|${contract.handler ?? ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function pythonDirectModuleHandlers(root: Node): Set<string> {
  const counts = new Map<string, number>();
  for (const fn of root.descendantsOfType("function_definition")) {
    if (!fn || hasPythonFunctionAncestor(fn)) continue;
    const declaration = fn.parent?.type === "decorated_definition" ? fn.parent : fn;
    if (declaration.parent?.type !== "module") continue;
    const name = pythonQualifiedFunctionName(fn);
    if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
  }
  for (const type of ["assignment", "annotated_assignment", "augmented_assignment", "delete_statement"]) {
    for (const mutation of root.descendantsOfType(type)) {
      if (!mutation || !pythonDirectModuleExecution(mutation)) continue;
      const left = mutation.childForFieldName("left");
      const targets = mutation.type === "delete_statement"
        ? namedChildren(mutation).flatMap((child) => pythonBindingTargetNames(child))
        : pythonBindingTargetNames(left);
      for (const target of targets) if (counts.has(target)) counts.set(target, counts.get(target)! + 1);
    }
  }
  return new Set([...counts].filter(([, count]) => count === 1).map(([name]) => name));
}

function extractPythonBehaviorContracts(
  root: Node,
  imports: TreeSitterImportBinding[],
  file: string
): BehaviorContract[] {
  const receivers = pythonFastapiReceivers(root, imports);
  if (receivers.size === 0) return [];
  const directHandlers = pythonDirectModuleHandlers(root);
  const includes = pythonRouterIncludePrefixes(root, receivers);
  const out: BehaviorContract[] = [];
  const add = (receiverName: string, method: string, routePath: string, registrationAt: number, handler?: string): void => {
    const receiver = receivers.get(receiverName);
    if (!receiver || receiver.boundAt >= registrationAt) return;
    const includePrefixes = receiver.kind === "app" ? new Set([""]) : includes.get(receiverName);
    const prefixes = includePrefixes && includePrefixes.size > 0 ? [...includePrefixes] : [""];
    const status: "resolved" | "unresolved" =
      receiver.prefixResolved && (receiver.kind === "app" || Boolean(includePrefixes?.size)) ? "resolved" : "unresolved";
    for (const includePrefix of prefixes) {
      const prefix = normalizePythonRoutePath(includePrefix, receiver.prefix);
      const normalizedPrefix = prefix === "/" ? "" : prefix;
      out.push(
        makePythonBehaviorContract({
          file,
          method: method.toUpperCase(),
          path: normalizePythonRoutePath(normalizedPrefix, routePath),
          handler,
          prefixStatus: status,
          prefix: normalizedPrefix
        })
      );
    }
  };

  for (const fn of root.descendantsOfType("function_definition")) {
    if (!fn || hasPythonFunctionAncestor(fn)) continue;
    const handler = pythonQualifiedFunctionName(fn);
    const decorated = fn.parent?.type === "decorated_definition" ? fn.parent : null;
    if (!handler || !directHandlers.has(handler) || !decorated || decorated.parent?.type !== "module") continue;
    for (const decorator of namedChildren(decorated).filter((n) => n.type === "decorator")) {
      const call = namedChildren(decorator).find((n) => n.type === "call");
      const parts = call ? callParts(call, "python") : null;
      const receiver = parts?.qualifier?.split(".")[0];
      const route = call ? pythonStaticString(pythonPositionalArguments(call)[0] ?? null) : null;
      if (!call || !parts || !receiver || route === null) continue;
      if (FASTAPI_HTTP_METHODS.has(parts.callee)) {
        add(receiver, parts.callee, route, call.startIndex, handler);
      } else if (parts.callee === "api_route") {
        const methods = pythonStaticHttpMethods(pythonKeywordArgument(call, "methods"));
        if (!methods) continue;
        for (const method of methods) add(receiver, method, route, call.startIndex, handler);
      }
    }
  }

  for (const call of root.descendantsOfType("call")) {
    if (!call || !pythonDirectModuleExecution(call)) continue;
    const parts = callParts(call, "python");
    const receiver = parts?.qualifier?.split(".")[0];
    if (!parts || parts.callee !== "add_api_route" || !receiver || !receivers.has(receiver)) continue;
    const positional = pythonPositionalArguments(call);
    const route = pythonStaticString(positional[0] ?? null);
    const handler = pythonDottedName(positional[1] ?? null);
    if (route === null || !handler || !directHandlers.has(handler)) continue;
    const methods = pythonStaticHttpMethods(pythonKeywordArgument(call, "methods"));
    if (!methods) continue;
    for (const method of methods) add(receiver, method, route, call.startIndex, handler);
  }
  return dedupePythonContracts(out);
}

function isFastapiDependsCall(call: Node, imports: TreeSitterImportBinding[]): boolean {
  const parts = callParts(call, "python");
  if (!parts) return false;
  if (!parts.qualifier) {
    return pythonImportedFromFastapi(imports, parts.callee, "Depends") || pythonImportedFromFastapi(imports, parts.callee, "Security");
  }
  if (parts.callee !== "Depends" && parts.callee !== "Security") return false;
  const root = parts.qualifier.split(".")[0] ?? "";
  return imports.some((b) => b.local === root && b.kind === "module" && b.module === "fastapi");
}

function extractPythonDependencies(
  root: Node,
  imports: TreeSitterImportBinding[],
  acceptedHandlers: Set<string>
): TreeSitterPythonDependency[] {
  const out: TreeSitterPythonDependency[] = [];
  const seen = new Set<string>();
  const receivers = pythonFastapiReceivers(root, imports);
  const directHandlers = pythonDirectModuleHandlers(root);
  const addFromNode = (handler: string, node: Node | null): void => {
    if (!node) return;
    const calls = [...(node.type === "call" ? [node] : []), ...node.descendantsOfType("call").filter((n): n is Node => Boolean(n))];
    for (const call of calls) {
      if (!isFastapiDependsCall(call, imports)) continue;
      const dependency = pythonDottedName(pythonPositionalArguments(call)[0] ?? null);
      if (!dependency) continue;
      const key = `${handler}|${dependency}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ handler, dependency });
    }
  };
  for (const fn of root.descendantsOfType("function_definition")) {
    if (!fn || hasPythonFunctionAncestor(fn)) continue;
    const handler = pythonQualifiedFunctionName(fn);
    const params = fn.childForFieldName("parameters");
    const declaration = fn.parent?.type === "decorated_definition" ? fn.parent : fn;
    if (!handler || !params || !directHandlers.has(handler) || declaration.parent?.type !== "module" || !acceptedHandlers.has(handler)) continue;
    addFromNode(handler, params);
    const decorated = fn.parent?.type === "decorated_definition" ? fn.parent : null;
    for (const decorator of decorated ? namedChildren(decorated).filter((n) => n.type === "decorator") : []) {
      const routeCall = namedChildren(decorator).find((n) => n.type === "call");
      const parts = routeCall ? callParts(routeCall, "python") : null;
      const receiver = parts?.qualifier?.split(".")[0];
      if (!routeCall || !parts || !receiver || !receivers.has(receiver) || receivers.get(receiver)!.boundAt >= routeCall.startIndex) continue;
      if (!FASTAPI_HTTP_METHODS.has(parts.callee) && (parts.callee !== "api_route" || !pythonStaticHttpMethods(pythonKeywordArgument(routeCall, "methods")))) continue;
      addFromNode(handler, pythonKeywordArgument(routeCall, "dependencies"));
    }
  }
  for (const call of root.descendantsOfType("call")) {
    if (!call || !pythonDirectModuleExecution(call)) continue;
    const parts = callParts(call, "python");
    const receiver = parts?.qualifier?.split(".")[0];
    if (!parts || parts.callee !== "add_api_route" || !receiver || !receivers.has(receiver) || receivers.get(receiver)!.boundAt >= call.startIndex) continue;
    const positional = pythonPositionalArguments(call);
    const route = pythonStaticString(positional[0] ?? null);
    const handler = pythonDottedName(positional[1] ?? null);
    const methods = pythonStaticHttpMethods(pythonKeywordArgument(call, "methods"));
    if (route !== null && handler && methods && directHandlers.has(handler) && acceptedHandlers.has(handler)) {
      addFromNode(handler, pythonKeywordArgument(call, "dependencies"));
    }
  }
  return out;
}

function directPythonAssertCall(assertion: Node): { callee: string; qualifier?: string; via: "free" | "qualified" } | null {
  const subject = namedChildren(assertion)[0];
  if (!subject) return null;
  const actual = subject.type === "comparison_operator" ? singlePythonComparisonCall(subject) : subject;
  if (actual?.type !== "call") return null;
  return callParts(actual, "python");
}

function singlePythonComparisonCall(comparison: Node): Node | null {
  const calls = namedChildren(comparison).filter((child) => child.type === "call");
  return calls.length === 1 ? calls[0] ?? null : null;
}

function pythonDirectAssignment(stmt: Node): { target: Node; value: Node } | null {
  const assignment = stmt.type === "assignment" || stmt.type === "annotated_assignment"
    ? stmt
    : namedChildren(stmt).find((child) => child.type === "assignment" || child.type === "annotated_assignment");
  if (!assignment) return null;
  const target = assignment.childForFieldName("left");
  const value = assignment.childForFieldName("right");
  return target && value ? { target, value } : null;
}

function pythonSingleCall(node: Node): Node | null {
  const calls = [...(node.type === "call" ? [node] : []), ...node.descendantsOfType("call").filter((call): call is Node => Boolean(call))];
  const unique = [...new Map(calls.map((call) => [`${call.startIndex}:${call.endIndex}`, call])).values()];
  return unique.length === 1 ? unique[0] ?? null : null;
}

function pythonExactCall(node: Node | null): Node | null {
  if (!node) return null;
  if (node.type === "call") return node;
  if (node.type === "await" || node.type === "parenthesized_expression") {
    const children = namedChildren(node);
    return children.length === 1 ? pythonExactCall(children[0] ?? null) : null;
  }
  return null;
}

function pythonDirectAssertedResult(assertion: Node, results: ReadonlyMap<string, unknown>): string | null {
  const subject = namedChildren(assertion)[0];
  if (subject?.type !== "comparison_operator") return null;
  const operands = namedChildren(subject);
  if (operands.length !== 2) return null;
  const candidates = operands.filter((operand) => operand.type === "identifier" && results.has(operand.text));
  if (candidates.length !== 1) return null;
  const name = candidates[0]!.text;
  const occurrences = subject.descendantsOfType("identifier")
    .filter((identifier): identifier is Node => Boolean(identifier))
    .filter((identifier) => identifier.text === name);
  return occurrences.length === 1 ? name : null;
}

function pythonLexicalNodes(root: Node): Node[] {
  const out: Node[] = [];
  const visit = (node: Node): void => {
    for (const child of namedChildren(node)) {
      if (child.type === "function_definition" || child.type === "class_definition" || child.type === "lambda") continue;
      out.push(child);
      visit(child);
    }
  };
  visit(root);
  return out;
}

function pythonBindingNames(node: Node): string[] {
  if (node.type === "assignment" || node.type === "annotated_assignment" || node.type === "augmented_assignment" || node.type === "named_expression") {
    const target = node.childForFieldName("left") ?? node.childForFieldName("name");
    if (target?.type === "attribute") {
      const dotted = pythonDottedName(target);
      return dotted ? [dotted.split(".")[0] ?? dotted] : [];
    }
    return target ? pythonBindingTargetNames(target) : [];
  }
  if (node.type === "for_statement") {
    const target = node.childForFieldName("left");
    return target ? pythonBindingTargetNames(target) : [];
  }
  if (node.type === "delete_statement") {
    return namedChildren(node).flatMap((target) => {
      if (target.type === "attribute") {
        const dotted = pythonDottedName(target);
        return dotted ? [dotted.split(".")[0] ?? dotted] : [];
      }
      return pythonBindingTargetNames(target);
    });
  }
  return [];
}

type PythonReceiverBinding = { classRef: string; rule: PythonAssociationRule; assignedAt: number };

function pythonClassRefFromConstructor(value: Node | null): string | null {
  if (!value) return null;
  const constructor = pythonExactCall(value);
  if (!constructor) return null;
  const ref = pythonDottedName(constructor.childForFieldName("function"));
  // A result-producing method such as `subject.work()` is not a constructor and
  // must never become a second tracked receiver. Accept only a bare imported
  // class or one module-qualified class terminal.
  return ref && /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(ref) && pythonLooksLikeClassRef(ref) ? ref : null;
}

function pythonLooksLikeClassRef(ref: string): boolean {
  const terminal = ref.split(".").pop() ?? "";
  return /^_*[A-Z][A-Za-z0-9_]*$/.test(terminal);
}

function pythonReceiverKey(node: Node | null): string | null {
  if (!node) return null;
  if (node.type === "identifier") return node.text;
  if (node.type !== "attribute") return null;
  const object = node.childForFieldName("object");
  const attribute = node.childForFieldName("attribute")?.text;
  return object?.type === "identifier" && object.text === "self" && attribute && /^[A-Za-z_]\w*$/.test(attribute)
    ? `self.${attribute}`
    : null;
}

function pythonMethodCall(node: Node): { call: { callee: string; qualifier?: string; via: "free" | "qualified" }; receiver: Node } | null {
  if (node.type !== "call") return null;
  const fn = node.childForFieldName("function");
  if (fn?.type !== "attribute") return null;
  const receiver = fn.childForFieldName("object");
  const call = callParts(node, "python");
  return receiver && call ? { call, receiver } : null;
}

function directPythonAssertCallNode(assertion: Node): Node | null {
  const subject = namedChildren(assertion)[0];
  if (!subject) return null;
  const actual = subject.type === "comparison_operator" ? singlePythonComparisonCall(subject) : subject;
  return actual?.type === "call" ? actual : null;
}

function pythonFixtureDecorator(node: Node): boolean {
  return /^@pytest\.fixture(?:\(|$)/.test(node.text.trim());
}

function pythonTypeRef(node: Node | null): string | null {
  const text = node?.text ?? "";
  return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)?$/.test(text) ? text : null;
}

function pythonCanonicalImportedRef(ref: string | null | undefined, imports: TreeSitterImportBinding[]): string | undefined {
  if (!ref) return undefined;
  const parts = ref.split(".");
  const binding = imports.find((candidate) => candidate.local === parts[0]);
  if (!binding) return ref;
  const importedBase = binding.kind === "module"
    ? binding.module
    : [binding.module, binding.imported].filter(Boolean).join(".");
  return [importedBase, ...parts.slice(1)].filter(Boolean).join(".");
}

function pythonMockedMethodReference(value: string): string | null {
  return /^[A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+$/.test(value) ? value : null;
}

/**
 * Exact patch/replacement targets only. This is intentionally syntax-only: the
 * analyzer resolves these references to an in-repo method before suppressing a
 * proof edge, so a dependency mock or unrelated class attribute remains inert.
 */
function pythonMockedMethods(root: Node, imports: TreeSitterImportBinding[]): string[] {
  const out = new Set<string>();
  const exactReceiverClass = (context: Node, receiver: string): string | null => {
    if (!/^[A-Za-z_]\w*$/.test(receiver)) return null;
    let fn: Node | null = context;
    while (fn && fn.type !== "function_definition") fn = fn.parent;
    const body = fn?.childForFieldName("body");
    if (!body) return null;
    const refs = pythonLexicalNodes(body)
      .filter((node) => node.type === "assignment" || node.type === "annotated_assignment")
      .map(pythonDirectAssignment)
      .filter((assignment): assignment is { target: Node; value: Node } => Boolean(assignment?.target.type === "identifier" && assignment.target.text === receiver))
      .map((assignment) => pythonClassRefFromConstructor(assignment.value))
      .filter((ref): ref is string => Boolean(ref));
    return refs.length === 1 ? refs[0]! : null;
  };
  const canonicalReceiver = (context: Node, receiver: string): string => exactReceiverClass(context, receiver) ?? receiver;
  const addObjectMethod = (context: Node, object: Node | null, method: Node | null): void => {
    const rawReceiver = pythonDottedName(object);
    const receiver = rawReceiver ? canonicalReceiver(context, rawReceiver) : null;
    const name = pythonStaticString(method);
    const ref = receiver && name && /^[A-Za-z_]\w*$/.test(name) ? `${receiver}.${name}` : null;
    if (ref) out.add(ref);
  };
  for (const call of root.descendantsOfType("call")) {
    if (!call) continue;
    const fn = pythonDottedName(call.childForFieldName("function"));
    const canonicalFn = pythonCanonicalImportedRef(fn, imports);
    const args = pythonPositionalArguments(call);
    if (canonicalFn === "unittest.mock.patch.object" || fn === "mocker.patch.object") {
      addObjectMethod(call, args[0] ?? null, args[1] ?? null);
      continue;
    }
    if (fn === "setattr" || fn === "monkeypatch.setattr") {
      // pytest's two-argument form accepts one fully qualified dotted target:
      // `monkeypatch.setattr("package.module.Class.method", replacement)`.
      const dotted = pythonStaticString(args[0] ?? null);
      const exact = dotted ? pythonMockedMethodReference(dotted) : null;
      if (exact) out.add(exact);
      else addObjectMethod(call, args[0] ?? null, args[1] ?? null);
      continue;
    }
    if (canonicalFn === "unittest.mock.patch" || fn === "mocker.patch") {
      const ref = pythonStaticString(args[0] ?? null);
      const exact = ref ? pythonMockedMethodReference(ref) : null;
      if (exact) out.add(exact);
    }
  }
  for (const assignment of root.descendantsOfType("assignment").filter((node): node is Node => Boolean(node))) {
    const rawTarget = pythonDottedName(assignment.childForFieldName("left"));
    const targetParts = rawTarget?.split(".") ?? [];
    const target = targetParts.length > 1
      ? [canonicalReceiver(assignment, targetParts[0]!), ...targetParts.slice(1)].join(".")
      : rawTarget;
    const value = pythonExactCall(assignment.childForFieldName("right"));
    const mockFactory = value ? pythonCanonicalImportedRef(pythonDottedName(value.childForFieldName("function")), imports) : undefined;
    if (target && /^(?:unittest\.mock|mocker)\.(?:Mock|MagicMock|AsyncMock)$/.test(mockFactory ?? "")) {
      const exact = pythonMockedMethodReference(target);
      if (exact) out.add(exact);
    }
  }
  return [...out].sort();
}

/** Same-file pytest fixture dependencies are traversed by name, not by file membership. */
function pythonScopedMockMethods(root: Node, imports: TreeSitterImportBinding[]): {
  byTest: Record<string, string[]>; unknown: string[]
} {
  type Fixture = { owner: string | null; name: string; mocks: string[]; dependencies: string[]; autouse: boolean; unknown: boolean };
  const fixtures = new Map<string, Fixture>();
  const tests: Array<{ name: string; fn: Node; owner: string | null; decorators: Node[] }> = [];
  const decoratorsOf = (node: Node): Node[] => node.parent?.type === "decorated_definition"
    ? namedChildren(node.parent).filter((child) => child.type === "decorator") : [];
  const params = (fn: Node): string[] => {
    const node = fn.childForFieldName("parameters");
    if (!node) return [];
    return namedChildren(node).flatMap((param) => {
      if (param.type === "identifier") return [param.text];
      if (["typed_parameter", "default_parameter", "typed_default_parameter"].includes(param.type)) {
        const name = param.childForFieldName("name") ?? namedChildren(param)[0];
        return name?.type === "identifier" ? [name.text] : [];
      }
      return [];
    }).filter((name) => name !== "self" && name !== "cls");
  };
  const finiteParametrizedNames = (decorators: Node[], parameter: string): string[] | null => {
    const parametrizations = decorators.map((decorator) => decorator.text.trim())
      .filter((text) => text.startsWith("@pytest.mark.parametrize("));
    if (parametrizations.length !== 1) return null;
    const match = /^@pytest\.mark\.parametrize\(\s*(['"])([A-Za-z_]\w*)\1\s*,\s*\[([\s\S]*?)\]\s*,?\s*\)$/s.exec(parametrizations[0]!);
    if (!match || match[2] !== parameter) return null;
    const values = match[3]!.split(",").map((part) => part.trim()).filter(Boolean);
    if (values.length === 0) return null;
    const names = values.map((part) => /^(['"])([A-Za-z_]\w*)\1$/.exec(part)?.[2] ?? null);
    return names.every((name): name is string => Boolean(name)) ? names : null;
  };
  const dynamic = (fn: Node, decorators: Node[] = []): { names: string[]; unknown: boolean } => {
    const names: string[] = [];
    let unknown = false;
    for (const call of fn.descendantsOfType("call")) {
      if (!call || pythonDottedName(call.childForFieldName("function")) !== "request.getfixturevalue") continue;
      const args = pythonPositionalArguments(call);
      const name = args.length === 1 ? pythonStaticString(args[0] ?? null) : null;
      if (name && /^[A-Za-z_]\w*$/.test(name)) names.push(name);
      else {
        const parameter = args.length === 1 && args[0]?.type === "identifier" ? args[0].text : null;
        const selected = parameter && params(fn).includes("request") && params(fn).includes(parameter)
          ? finiteParametrizedNames(decorators, parameter) : null;
        if (selected) names.push(...selected);
        else unknown = true;
      }
    }
    return { names, unknown };
  };
  const usefixtures = (decorators: Node[]): { names: string[]; unknown: boolean } => {
    const names: string[] = [];
    let unknown = false;
    for (const decorator of decorators) {
      const text = decorator.text.trim();
      if (!/^@pytest\.mark\.usefixtures\(/.test(text)) continue;
      const match = text.match(/^@pytest\.mark\.usefixtures\((.*)\)$/s);
      if (!match) { unknown = true; continue; }
      names.push(...[...match[1]!.matchAll(/(['"])([A-Za-z_]\w*)\1/g)].map((value) => value[2]!));
      unknown ||= Boolean(match[1]!.replace(/(['"])[A-Za-z_]\w*\1/g, "").replace(/[\s,]/g, ""));
    }
    return { names, unknown };
  };
  for (const fn of root.descendantsOfType("function_definition")) {
    if (!fn || pythonNearestFunction(fn)) continue;
    const name = fn.childForFieldName("name")?.text;
    if (!name) continue;
    const enclosing = fn.parent?.type === "decorated_definition" ? fn.parent : fn;
    const classNode = enclosing.parent?.type === "block" && enclosing.parent.parent?.type === "class_definition" ? enclosing.parent.parent : null;
    const owner = classNode?.childForFieldName("name")?.text ?? null;
    const decorators = decoratorsOf(fn);
    const fixtureDecorator = decorators.find((decorator) => /^@pytest\.fixture(?:\(|$)/.test(decorator.text.trim()) ||
      (/^@fixture(?:\(|$)/.test(decorator.text.trim()) && imports.some((binding) =>
        binding.local === "fixture" && binding.module === "pytest" && binding.imported === "fixture")));
    if (fixtureDecorator) {
      const text = fixtureDecorator.text.trim();
      const alias = text.match(/\bname\s*=\s*(['"])([A-Za-z_]\w*)\1/);
      const fixtureName = alias?.[2] ?? name;
      const selected = dynamic(fn);
      fixtures.set(`${owner ?? ""}::${fixtureName}`, {
        owner, name: fixtureName, mocks: [...new Set([
          ...pythonMockedMethods(fn, imports),
          ...decorators.flatMap((decorator) => pythonMockedMethods(decorator, imports))
        ])],
        dependencies: [...params(fn), ...selected.names], autouse: /\bautouse\s*=\s*True\b/.test(text), unknown: selected.unknown
      });
    }
    if (/^test_[A-Za-z0-9_]*$/.test(name)) tests.push({
      name: owner ? `${owner}::${name}` : name, fn, owner,
      decorators: [...decorators, ...(classNode ? decoratorsOf(classNode) : [])]
    });
  }
  const moduleMocks = namedChildren(root)
    .filter((node) => !["function_definition", "class_definition", "decorated_definition"].includes(node.type))
    .flatMap((node) => pythonMockedMethods(node, imports));
  const byTest: Record<string, string[]> = {};
  const unknown: string[] = [];
  for (const test of tests) {
    const mocks = new Set([...moduleMocks, ...pythonMockedMethods(test.fn, imports)]);
    for (const decorator of test.decorators) for (const ref of pythonMockedMethods(decorator, imports)) mocks.add(ref);
    const selected = usefixtures(test.decorators);
    const requested = dynamic(test.fn, test.decorators);
    let uncertain = selected.unknown || requested.unknown;
    for (const name of requested.names) {
      if (!fixtures.has(`${test.owner ?? ""}::${name}`) && !fixtures.has(`::${name}`)) uncertain = true;
    }
    const seen = new Set<string>();
    const visit = (name: string): void => {
      const fixture = fixtures.get(`${test.owner ?? ""}::${name}`) ?? fixtures.get(`::${name}`);
      if (!fixture) return;
      const key = `${fixture.owner ?? ""}::${fixture.name}`;
      if (seen.has(key)) return;
      seen.add(key);
      uncertain ||= fixture.unknown;
      for (const ref of fixture.mocks) mocks.add(ref);
      for (const dependency of fixture.dependencies) visit(dependency);
    };
    for (const name of [...params(test.fn), ...selected.names, ...requested.names]) visit(name);
    for (const fixture of fixtures.values()) if (fixture.autouse && (!fixture.owner || fixture.owner === test.owner)) visit(fixture.name);
    byTest[test.name] = [...mocks].sort();
    if (uncertain) unknown.push(test.name);
  }
  return { byTest, unknown };
}

function pythonFixtureBindings(root: Node): Map<string, { classRef: string; rule: PythonAssociationRule }> {
  const out = new Map<string, { classRef: string; rule: PythonAssociationRule }>();
  for (const decorated of root.descendantsOfType("decorated_definition")) {
    if (!decorated || decorated.parent?.type !== "module") continue;
    if (!namedChildren(decorated).some((child) => child.type === "decorator" && pythonFixtureDecorator(child))) continue;
    const fn = namedChildren(decorated).find((child) => child.type === "function_definition");
    const name = fn?.childForFieldName("name")?.text;
    const body = fn?.childForFieldName("body");
    if (!name || !body) continue;
    const values = blockStatements(body).flatMap((statement) => {
      if (statement.type === "return_statement") return [statement.namedChild(0) ?? null];
      if (statement.type === "expression_statement" && statement.namedChild(0)?.type === "yield") return [statement.namedChild(0)?.namedChild(0) ?? null];
      return [];
    });
    const direct = values.length === 1 ? pythonClassRefFromConstructor(values[0] ?? null) : null;
    const directRule: PythonAssociationRule | null = values.length === 1 && values[0]?.parent?.type === "return_statement"
      ? "fixture_return"
      : values.length === 1 ? "fixture_yield" : null;
    const annotated = pythonTypeRef(fn.childForFieldName("return_type"));
    if (direct && annotated && direct !== annotated) continue;
    if (direct && directRule) out.set(name, { classRef: direct, rule: directRule });
    else if (!direct && values.length === 0 && annotated) out.set(name, { classRef: annotated, rule: "fixture_annotation" });
  }
  return out;
}

function pythonTestFixtureReceiver(
  testFunction: Node | null,
  fixtures: ReadonlyMap<string, { classRef: string; rule: PythonAssociationRule }>
): Map<string, PythonReceiverBinding> | null {
  const parameters = testFunction?.childForFieldName("parameters");
  if (!parameters) return new Map();
  const values = namedChildren(parameters).filter((node) => node.type === "identifier" || node.type === "typed_parameter");
  const receivers = new Map<string, PythonReceiverBinding>();
  for (const parameter of values) {
    const name = parameter.type === "identifier" ? parameter.text : parameter.childForFieldName("name")?.text ?? parameter.namedChild(0)?.text;
    if (!name || name === "self" || name === "cls") continue;
    const fixture = fixtures.get(name);
    const annotation = parameter.type === "typed_parameter" ? pythonTypeRef(parameter.childForFieldName("type")) : null;
    // A pytest parameter annotated with one plain class reference is a structural
    // fixture/type producer in its own right (the provider may live in conftest).
    // If an in-file fixture exists it must agree exactly; disagreement is unsafe.
    if (!fixture && !annotation) continue;
    if (fixture && annotation && annotation !== fixture.classRef) return null;
    if (receivers.size > 0) return null; // one unambiguous fixture receiver only
    receivers.set(name, { classRef: annotation ?? fixture!.classRef, rule: annotation ? "parameter_annotation" : fixture!.rule, assignedAt: -1 });
  }
  return receivers;
}

function pythonSetupReceivers(classNode: Node | null): Map<string, PythonReceiverBinding> | null {
  const out = new Map<string, PythonReceiverBinding>();
  if (!classNode) return out;
  const body = classNode.childForFieldName("body");
  if (!body) return out;
  for (const method of namedChildren(body).filter((node) => node.type === "function_definition")) {
    const methodName = method.childForFieldName("name")?.text;
    if (methodName !== "setUp" && methodName !== "setup_method") continue;
    const methodBody = method.childForFieldName("body");
    if (!methodBody) return null;
    for (const statement of blockStatements(methodBody)) {
      const assignment = pythonDirectAssignment(statement);
      if (!assignment || assignment.target.type !== "attribute") continue;
      const receiver = pythonReceiverKey(assignment.target);
      const classRef = pythonClassRefFromConstructor(assignment.value);
      // Setup frequently initializes unrelated module state (`settings.flag = ...`)
      // or scalar test state (`self.started_at = ...`). Neither establishes a
      // receiver, so it must not veto a separate exact local-instance binding.
      // Once a receiver is established, however, an unsupported reassignment or
      // nested attribute write still invalidates that receiver conservatively.
      if (!receiver) {
        const target = pythonDottedName(assignment.target);
        if (target && [...out.keys()].some((known) => target.startsWith(`${known}.`))) return null;
        continue;
      }
      if (!classRef) {
        if (out.has(receiver)) return null;
        continue;
      }
      if (out.has(receiver)) return null;
      out.set(receiver, { classRef, rule: "unittest_setup", assignedAt: assignment.target.startIndex });
    }
  }
  return out;
}

function pythonStructuralReceiver(callNode: Node, receivers: ReadonlyMap<string, PythonReceiverBinding>): PythonReceiverBinding | null {
  const method = pythonMethodCall(callNode);
  if (!method) return null;
  const bound = receivers.get(pythonReceiverKey(method.receiver) ?? "");
  if (bound) return bound;
  const inline = pythonClassRefFromConstructor(method.receiver);
  if (inline) return { classRef: inline, rule: "inline_constructor", assignedAt: method.receiver.startIndex };
  const classRef = pythonDottedName(method.receiver);
  // A lower-case receiver is an ordinary module/object call (`calc.add()`), not
  // a structural class/static receiver. Retain the existing exact module-function
  // lane for those calls rather than guessing that any attribute is a class method.
  return classRef && pythonLooksLikeClassRef(classRef)
    ? { classRef, rule: "class_static_method", assignedAt: method.receiver.startIndex }
    : null;
}

/** True when an asserted call uses a receiver form owned by the structural lane. */
function pythonStructuralReceiverSyntax(callNode: Node): boolean {
  const method = pythonMethodCall(callNode);
  if (!method) return false;
  // A lower-case receiver may be an imported module (`calc.add()`), which is
  // owned by the legacy exact module-import lane. Stored/local receivers still
  // pass through that lane harmlessly (they cannot resolve as a module/class)
  // when the structural association guards decline them.
  const classRef = pythonDottedName(method.receiver);
  return Boolean(classRef && pythonLooksLikeClassRef(classRef));
}

function pythonMentionsReceiverInArguments(callNode: Node, receiver: string): boolean {
  const args = callNode.childForFieldName("arguments");
  return args ? pythonMentionsReceiver(args, receiver) : false;
}

/** Exact receiver reference in an expression; strings/comments never constitute escape. */
function pythonMentionsReceiver(node: Node, receiver: string): boolean {
  const candidates = [node, ...node.descendantsOfType("identifier"), ...node.descendantsOfType("attribute")];
  return candidates.some((candidate) => pythonReceiverKey(candidate) === receiver);
}

function pythonStructuralAssociationProofCalls(
  block: Node,
  testFunction: Node,
  imports: TreeSitterImportBinding[],
  fixtures: ReadonlyMap<string, { classRef: string; rule: PythonAssociationRule }>,
  setup: ReadonlyMap<string, PythonReceiverBinding> | null
): Array<{
  assertion: Node;
  call: { callee: string; qualifier?: string; via: "free" | "qualified" };
  instanceClass?: string;
  associationRule: PythonAssociationRule;
}> {
  const fixtureReceivers = pythonTestFixtureReceiver(testFunction, fixtures);
  if (!fixtureReceivers || setup === null) return [];
  const lexicalNodes = pythonLexicalNodes(block);
  const assignments = lexicalNodes
    .filter((node) => node.type === "assignment" || node.type === "annotated_assignment")
    .map(pythonDirectAssignment)
    .filter((v): v is { target: Node; value: Node } => Boolean(v));
  const assertions = lexicalNodes.filter((node) => node.type === "assert_statement");

  const receivers = new Map<string, PythonReceiverBinding>();
  for (const [name, binding] of fixtureReceivers) receivers.set(name, binding);
  for (const [name, binding] of setup) {
    if (receivers.has(name)) return [];
    receivers.set(name, binding);
  }
  const writes = new Map<string, number>();
  for (const { target } of assignments) {
    const key = pythonReceiverKey(target);
    if (key) writes.set(key, (writes.get(key) ?? 0) + 1);
  }
  for (const { target, value } of assignments) {
    if (target.type !== "identifier") continue;
    const classRef = pythonClassRefFromConstructor(value);
    if (!classRef || (writes.get(target.text) ?? 0) !== 1 || receivers.has(target.text)) continue;
    receivers.set(target.text, { classRef, rule: classRef.includes(".") ? "module_assigned_instance" : "assigned_instance", assignedAt: target.startIndex });
  }
  for (const { target } of assignments) {
    if (target.type !== "identifier") continue;
    if ([...receivers.values()].some((receiver) => receiver.classRef === target.text)) return [];
  }

  // Any write/alias to a tracked receiver, or passing it to a helper/setter, is
  // receiver escape. Attribute replacement is narrower: it invalidates only that
  // exact receiver method, so mocking one dependency hook cannot erase an unrelated
  // invocation on the same production object.
  const replacedMethods = new Set<string>();
  for (const { target, value } of assignments) {
    const targetKey = pythonReceiverKey(target);
    if (targetKey && receivers.has(targetKey) && !(target.type === "identifier" && receivers.get(targetKey)?.assignedAt === target.startIndex)) return [];
    if (target.type === "attribute") {
      const dotted = pythonDottedName(target);
      if (dotted) {
        for (const receiver of receivers.keys()) {
          if (dotted.startsWith(`${receiver}.`)) replacedMethods.add(dotted);
        }
      }
    }
    if (target.type === "identifier" && (receivers.has(value.text) || receivers.has(pythonReceiverKey(value) ?? ""))) return [];
    const exactReceiverMethodResult = (() => {
      const call = pythonExactCall(value);
      const method = call ? pythonMethodCall(call) : null;
      const receiver = method ? pythonReceiverKey(method.receiver) : null;
      return Boolean(receiver && receivers.has(receiver));
    })();
    if (
      target.type === "identifier" &&
      !exactReceiverMethodResult &&
      [...receivers.keys()].some((receiver) => pythonMentionsReceiver(value, receiver))
    ) return [];
  }
  for (const mutation of lexicalNodes.filter((node) => node.type === "augmented_assignment")) {
    if ([...receivers.keys()].some((receiver) => new RegExp(`(^|[^A-Za-z0-9_])${receiver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9_])`).test(mutation.text))) return [];
  }
  for (const deleted of lexicalNodes.filter((node) => node.type === "delete_statement")) {
    if ([...receivers.keys()].some((receiver) => new RegExp(`(^|[^A-Za-z0-9_])${receiver.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?:$|[^A-Za-z0-9_])`).test(deleted.text))) return [];
  }
  for (const callNode of lexicalNodes.filter((node) => node.type === "call")) {
    const method = pythonMethodCall(callNode);
    if (method && pythonStructuralReceiver(callNode, receivers)) continue;
    for (const receiver of receivers.keys()) if (pythonMentionsReceiverInArguments(callNode, receiver)) return [];
  }

  const relevant = lexicalNodes
    .filter((node) => node.type === "call")
    .map((node) => ({ node, method: pythonMethodCall(node), receiver: pythonStructuralReceiver(node, receivers) }))
    .filter((v): v is { node: Node; method: { call: { callee: string; qualifier?: string; via: "free" | "qualified" }; receiver: Node }; receiver: PythonReceiverBinding } => {
      if (!v.method || !v.receiver) return false;
      const receiver = pythonReceiverKey(v.method.receiver);
      return !receiver || !replacedMethods.has(`${receiver}.${v.method.call.callee}`);
    });
  if (relevant.length > 0) {
    // Exact constructor/type/setup/class origins make every direct invocation an
    // Association. Assertion count and result plumbing are proof concerns, not
    // association concerns. Analyzer-side class/MRO resolution still fails closed.
    return relevant.map((target) => ({
      assertion: assertions[0] ?? target.node,
      call: target.method.call,
      instanceClass: target.receiver.classRef,
      associationRule: target.receiver.rule
    }));
  }

  // Preserve the deliberately narrow unresolved-receiver fallback. Unlike exact
  // constructor/type receivers, it still requires one assertion and one call.
  if (assertions.length !== 1) return [];
  const testParameters = new Set<string>();
  const parameters = testFunction.childForFieldName("parameters");
  for (const parameter of parameters ? namedChildren(parameters) : []) {
    const name = parameter.type === "identifier" ? parameter.text : parameter.childForFieldName("name")?.text ?? parameter.namedChild(0)?.text;
    if (name) testParameters.add(name);
  }

  // The only deliberately unresolved lane: one lower-case local receiver, one
  // direct method invocation, and the same one-assertion/result guards above.
  // Capitalized class syntax, inline constructors, fixtures, setup properties,
  // and any otherwise resolved receiver were handled by `relevant` above and
  // therefore cannot reach this lane.
  const unresolved = lexicalNodes
    .filter((node) => node.type === "call")
    .map((node) => ({ node, method: pythonMethodCall(node) }))
    .filter((v): v is { node: Node; method: { call: { callee: string; qualifier?: string; via: "free" | "qualified" }; receiver: Node } } =>
      Boolean(
        v.method &&
        v.method.receiver.type === "identifier" &&
        /^[a-z_][A-Za-z0-9_]*$/.test(v.method.receiver.text) &&
        v.method.receiver.text !== "self" &&
        v.method.receiver.text !== "cls" &&
        !testParameters.has(v.method.receiver.text) &&
        // An imported lower-case name can be an exact module receiver
        // (`calc.add()`); leave that to the legacy import-resolution lane.
        !imports.some((binding) => binding.local === v.method?.receiver.text)
      )
    );
  if (unresolved.length !== 1) return [];
  const target = unresolved[0]!;
  const results = new Map<string, typeof target>();
  for (const { target: resultName, value } of assignments) {
    if (resultName.type !== "identifier" || writes.get(resultName.text) !== 1) continue;
    const call = pythonExactCall(value);
    if (call?.id === target.node.id) results.set(resultName.text, target);
  }
  const direct = directPythonAssertCallNode(assertions[0]!);
  if (direct?.id === target.node.id) {
    return [{ assertion: assertions[0]!, call: target.method.call, associationRule: "unique_method_name_import" }];
  }
  const observed = pythonDirectAssertedResult(assertions[0]!, results);
  const result = observed ? results.get(observed) : undefined;
  return result
    ? [{ assertion: assertions[0]!, call: result.method.call, associationRule: "unique_method_name_import" }]
    : [];
}

function extractPythonProofCalls(root: Node, imports: TreeSitterImportBinding[]): TreeSitterPythonProofCall[] {
  const out: TreeSitterPythonProofCall[] = [];
  const seen = new Set<string>();
  const fixtures = pythonFixtureBindings(root);
  const add = (
    testName: string,
    shadowed: Set<string>,
    call: { callee: string; qualifier?: string; via: "free" | "qualified" } | null,
    instanceClass?: string,
    associationRule?: PythonAssociationRule
  ): void => {
    if (!call) return;
    const key = `${testName}|${instanceClass ?? ""}|${call.qualifier ?? ""}|${call.callee}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      caller: testName,
      testName,
      ...call,
      shadowed: [...shadowed],
      assertion: "pytest_assert",
      ...(instanceClass ? { instanceClass } : {}),
      ...(associationRule ? { associationRule } : {})
    });
  };
  const processBlock = (block: Node, testFunction: Node, testName: string, shadowed: Set<string>, setup: ReadonlyMap<string, PythonReceiverBinding> | null): void => {
    // A direct `ImportedClass.method(...)` call is invocation-backed Association
    // even when the test stores its result, has multiple assertions, or mocks an
    // unrelated dependency. Analyzer-side resolution still requires an exact
    // in-repo class import and a declared @classmethod/@staticmethod, and exact
    // target mocks are suppressed before any hard edge is emitted.
    for (const callNode of pythonLexicalNodes(block).filter((node) => node.type === "call")) {
      const method = pythonMethodCall(callNode);
      if (!method) continue;
      const classRef = pythonDottedName(method.receiver);
      if (classRef && pythonLooksLikeClassRef(classRef)) {
        add(testName, shadowed, method.call, classRef, "class_static_method");
      }
    }
    const associatedCalls = pythonStructuralAssociationProofCalls(block, testFunction, imports, fixtures, setup);
    for (const associated of associatedCalls) {
      add(testName, shadowed, associated.call, associated.instanceClass, associated.associationRule);
    }
    for (const stmt of blockStatements(block)) {
      if (stmt.type === "assert_statement") {
        const directNode = directPythonAssertCallNode(stmt);
        const direct = directPythonAssertCall(stmt);
        // Structural receiver syntax must be resolved only by the static-association
        // lane above. The legacy direct-call lane does not know MRO/decorators and
        // would otherwise turn `Cls.instance_method()` into a false confirmation.
        const structurallyAssociated = Boolean(direct && associatedCalls.some((associated) =>
          // Preserve the legacy same-package convention path for inline constructors
          // with no explicit import. The structural class origin is exact, but the
          // analyzer cannot resolve that class owner from this association alone.
          associated.associationRule !== "inline_constructor" &&
          associated.call.callee === direct.callee &&
          associated.call.qualifier === direct.qualifier &&
          associated.call.via === direct.via
        ));
        if ((!directNode || !pythonStructuralReceiverSyntax(directNode)) && !structurallyAssociated) add(testName, shadowed, direct);
      }
      if (stmt.type === "function_definition" || stmt.type === "class_definition" || stmt.type === "lambda") continue;
      for (const child of namedChildren(stmt)) {
        if (child.type === "block") processBlock(child, testFunction, testName, shadowed, setup);
      }
    }
  };
  const walk = (node: Node, insideFunction: boolean, testClass: { name: string; node: Node } | null): void => {
    if (!insideFunction && node.type === "class_definition") {
      const name = node.childForFieldName("name")?.text;
      const superclasses = node.childForFieldName("superclasses");
      const bases = superclasses ? namedChildren(superclasses).map((base) => base.text) : [];
      const isTestClass = Boolean(name && (/^Test[A-Za-z0-9_]*$/.test(name) || bases.some((base) => /(?:^|\.)TestCase$/.test(base))));
      const nextTestClass = name && isTestClass ? { name, node } : null;
      for (const child of namedChildren(node)) walk(child, false, nextTestClass);
      return;
    }
    if (node.type === "function_definition") {
      const name = functionName(node, "python");
      const body = node.childForFieldName("body");
      if (name && /^test_[A-Za-z0-9_]*$/.test(name) && body) {
        processBlock(body, node, testClass ? `${testClass.name}::${name}` : name, localBindings(node, "python"), pythonSetupReceivers(testClass?.node ?? null));
      }
      if (insideFunction) return;
    }
    for (const child of namedChildren(node)) walk(child, insideFunction || node.type === "function_definition", testClass);
  };
  walk(root, false, null);
  return out;
}

function pythonClassInfos(root: Node): TreeSitterPythonClassInfo[] {
  const out: TreeSitterPythonClassInfo[] = [];
  for (const node of root.descendantsOfType("class_definition")) {
    if (!node || hasPythonFunctionAncestor(node)) continue;
    const name = node.childForFieldName("name")?.text;
    const superclasses = node.childForFieldName("superclasses");
    const bases = superclasses
      ? namedChildren(superclasses).map(pythonDottedName).filter((base): base is string => Boolean(base))
      : [];
    const body = node.childForFieldName("body");
    const classStaticMethods = body
      ? namedChildren(body)
          .filter((member) => member.type === "decorated_definition")
          .filter((member) => namedChildren(member).some((child) => child.type === "decorator" && /^@(?:class|static)method$/.test(child.text.trim())))
          .map((member) => namedChildren(member).find((child) => child.type === "function_definition"))
          .map((method) => method?.childForFieldName("name")?.text)
          .filter((method): method is string => Boolean(method))
      : [];
    if (name) out.push({ name, bases, classStaticMethods: [...new Set(classStaticMethods)].sort() });
  }
  return out;
}

const PYTHON_ENUM_TYPES = new Set(["Enum", "IntEnum", "StrEnum", "Flag", "IntFlag"]);

type PythonImportOrigin = { module: string; imported?: string; kind: "module" | "named" };

/** Import bindings that are still exact immediately before one direct module statement. */
function pythonImportsBefore(root: Node, stopAt: number): Map<string, PythonImportOrigin> {
  const bindings = new Map<string, PythonImportOrigin>();
  const invalidate = (name: string): void => { if (name) bindings.delete(name); };
  for (const statement of namedChildren(root)) {
    if (statement.startIndex >= stopAt) break;
    if (statement.type === "import_statement" || statement.type === "import_from_statement") {
      for (const binding of extractImports(statement, "python")) {
        bindings.set(binding.local, { module: binding.module, imported: binding.imported, kind: binding.kind });
      }
      continue;
    }
    if (statement.type === "function_definition" || statement.type === "class_definition") {
      invalidate(statement.childForFieldName("name")?.text ?? "");
      continue;
    }
    if (statement.type === "decorated_definition") {
      const declaration = namedChildren(statement).find((child) => child.type === "function_definition" || child.type === "class_definition");
      invalidate(declaration?.childForFieldName("name")?.text ?? "");
      continue;
    }
    if (statement.type === "assignment" || statement.type === "annotated_assignment" || statement.type === "augmented_assignment") {
      for (const name of pythonBindingTargetNames(statement.childForFieldName("left"))) invalidate(name);
      continue;
    }
    if (statement.type === "delete_statement") {
      for (const child of namedChildren(statement)) for (const name of pythonBindingTargetNames(child)) invalidate(name);
    }
  }
  return bindings;
}

function pythonBaseIsStdlib(
  base: Node,
  bindings: Map<string, PythonImportOrigin>,
  module: string | readonly string[],
  allowed: Set<string>
): boolean {
  const modules = typeof module === "string" ? [module] : module;
  const dotted = pythonDottedName(base);
  if (!dotted) return false;
  const parts = dotted.split(".");
  if (parts.length === 1) {
    const binding = bindings.get(parts[0]!);
    return Boolean(binding?.kind === "named" && modules.includes(binding.module) && binding.imported && allowed.has(binding.imported));
  }
  if (parts.length === 2 && allowed.has(parts[1]!)) {
    const binding = bindings.get(parts[0]!);
    return Boolean(binding?.kind === "module" && modules.includes(binding.module));
  }
  return false;
}

function pythonClassHasMethod(node: Node): boolean {
  const body = node.childForFieldName("body");
  if (!body) return false;
  const visit = (current: Node): boolean => {
    if (current !== body && current.type === "class_definition") return false;
    if (current.type === "function_definition") return true;
    return namedChildren(current).some(visit);
  };
  return namedChildren(body).some(visit);
}

function pythonParameterNames(fn: Node): string[] | null {
  const params = fn.childForFieldName("parameters");
  if (!params) return null;
  const out: string[] = [];
  for (const parameter of namedChildren(params)) {
    if (parameter.type === "identifier") {
      out.push(parameter.text);
      continue;
    }
    if (parameter.type === "default_parameter" || parameter.type === "typed_parameter" || parameter.type === "typed_default_parameter") {
      const name = parameter.childForFieldName("name") ?? namedChildren(parameter)[0] ?? null;
      if (name?.type !== "identifier") return null;
      out.push(name.text);
      continue;
    }
    // Splat/pattern/separator shapes are not bare forwarding parameters.
    return null;
  }
  return out;
}

function pythonLiteralOrParameter(node: Node | null, params: Set<string>): boolean {
  if (!node) return false;
  if (node.type === "identifier") return params.has(node.text);
  // An f-string with {interpolation} computes a value; only plain literals qualify.
  if ((node.type === "string" || node.type === "concatenated_string") && node.descendantsOfType("interpolation").length > 0) return false;
  return new Set(["none", "true", "false", "integer", "float", "string", "concatenated_string"]).has(node.type);
}

function pythonDocstringStatement(statement: Node): boolean {
  if (statement.type !== "expression_statement") return false;
  const expression = namedChildren(statement)[0];
  return expression?.type === "string" || expression?.type === "concatenated_string";
}

function pythonSuperInitStatement(statement: Node, params: Set<string> = new Set()): boolean {
  if (statement.type !== "expression_statement") return false;
  const call = namedChildren(statement)[0];
  if (call?.type !== "call") return false;
  // super().__init__(...) may only FORWARD this constructor's own parameters or
  // literals (positionally or by keyword). Any computed argument is behavior.
  const forwardsOnly = pythonCallArguments(call).every((arg) =>
    arg.type === "keyword_argument"
      ? pythonLiteralOrParameter(arg.childForFieldName("value"), params)
      : pythonLiteralOrParameter(arg, params));
  if (!forwardsOnly) return false;
  const fn = call.childForFieldName("function");
  if (fn?.type !== "attribute" || fn.childForFieldName("attribute")?.text !== "__init__") return false;
  const receiver = fn.childForFieldName("object");
  if (receiver?.type !== "call" || pythonCallArguments(receiver).length !== 0) return false;
  return receiver.childForFieldName("function")?.type === "identifier" && receiver.childForFieldName("function")?.text === "super";
}

function pythonTrivialSelfAssignment(statement: Node, params: Set<string>): boolean {
  if (statement.type !== "expression_statement") return false;
  const assignment = namedChildren(statement)[0];
  if (assignment?.type !== "assignment") return false;
  const left = assignment.childForFieldName("left");
  if (left?.type !== "attribute" || left.childForFieldName("object")?.type !== "identifier" || left.childForFieldName("object")?.text !== "self") return false;
  return pythonLiteralOrParameter(assignment.childForFieldName("right"), params);
}

function pythonTrivialInitializer(classNode: Node): string | null {
  const body = classNode.childForFieldName("body");
  if (!body) return null;
  const methods = namedChildren(body).flatMap((statement) => {
    if (statement.type === "function_definition") return [statement];
    if (statement.type === "decorated_definition") {
      const fn = namedChildren(statement).find((child) => child.type === "function_definition");
      return fn ? [fn] : [];
    }
    return [];
  }).filter((fn) => fn.childForFieldName("name")?.text === "__init__");
  if (methods.length !== 1) return null;
  const fn = methods[0]!;
  const paramsList = pythonParameterNames(fn);
  const fnBody = fn.childForFieldName("body");
  if (!paramsList || !fnBody) return null;
  const params = new Set(paramsList);
  const statements = blockStatements(fnBody);
  for (let i = 0; i < statements.length; i++) {
    const statement = statements[i]!;
    if (i === 0 && pythonDocstringStatement(statement)) continue;
    if (statement.type === "pass_statement" || pythonSuperInitStatement(statement, params) || pythonTrivialSelfAssignment(statement, params)) continue;
    return null;
  }
  return pythonQualifiedFunctionName(fn) ?? null;
}

const PYTHON_TYPING_SHAPES = new Set(["TypedDict", "NamedTuple", "Protocol"]);
const PYTHON_TYPING_MODULES = ["typing", "typing_extensions"] as const;
const PYTHON_PYDANTIC_SHAPES = new Set(["BaseModel"]);
const PYTHON_PYDANTIC_MODULES = ["pydantic", "pydantic.main", "pydantic.v1"] as const;
const PYTHON_DATACLASS_MODULES = ["dataclasses", "pydantic.dataclasses"] as const;

/** `@dataclass`, `@dataclass(...)`, `@dataclasses.dataclass(...)` (stdlib or pydantic's drop-in). */
function pythonIsStdlibDataclassDecorator(decorator: Node, bindings: Map<string, PythonImportOrigin>): boolean {
  let expression: Node | null = namedChildren(decorator)[0] ?? null;
  if (expression?.type === "call") expression = expression.childForFieldName("function");
  return Boolean(expression && pythonBaseIsStdlib(expression, bindings, PYTHON_DATACLASS_MODULES, new Set(["dataclass"])));
}

/** Class body holds only field declarations: annotations (with or without a default),
 *  plain attribute assignments, a docstring, or `pass`. No methods, no nested classes,
 *  no statements that run logic. */
function pythonFieldOnlyBody(classNode: Node): boolean {
  const body = classNode.childForFieldName("body");
  if (!body) return false;
  const statements = blockStatements(body);
  if (statements.length === 0) return false;
  return statements.every((statement, index) => {
    if (statement.type === "pass_statement") return true;
    if (index === 0 && pythonDocstringStatement(statement)) return true;
    if (statement.type !== "expression_statement") return false;
    const inner = namedChildren(statement);
    // A lambda in a field value (e.g. custom JSON encoders) is behavior, not data.
    return inner.length === 1 && inner[0]!.type === "assignment" && inner[0]!.childForFieldName("left")?.type === "identifier"
      && inner[0]!.descendantsOfType("lambda").length === 0;
  });
}

function extractPythonDeclarationRankingExclusions(root: Node): TreeSitterPythonRankingExclusion[] {
  const out: TreeSitterPythonRankingExclusion[] = [];
  for (const classNode of root.descendantsOfType("class_definition")) {
    if (!classNode || hasPythonFunctionAncestor(classNode)) continue;
    // Module-level classes only (decorated or not): nested-class symbol names are
    // not guaranteed to line up with the analyzer's symbol table.
    const decorated = classNode.parent?.type === "decorated_definition" ? classNode.parent : null;
    if ((decorated ?? classNode).parent?.type !== "module") continue;
    const name = classNode.childForFieldName("name")?.text;
    if (!name) continue;
    const bases = classNode.childForFieldName("superclasses");
    const bindings = pythonImportsBefore(root, (decorated ?? classNode).startIndex);
    const baseNodes = bases ? namedChildren(bases) : [];
    const hasMethod = pythonClassHasMethod(classNode);
    if (baseNodes.some((base) => pythonBaseIsStdlib(base, bindings, "enum", PYTHON_ENUM_TYPES)) && !hasMethod) {
      out.push({
        symbol: name,
        code: "python_stdlib_enum_declaration",
        reason: "Standard-library enum declaration without methods — retained in the graph but excluded from priority ranking."
      });
      continue;
    }
    // Data-shape declarations: a TypedDict/NamedTuple/Protocol, a pydantic model, or a
    // stdlib @dataclass whose body only declares fields. No method ⇒ no behavior to test.
    if (!hasMethod && pythonFieldOnlyBody(classNode)) {
      const typedShape = baseNodes.some((base) =>
        pythonBaseIsStdlib(base, bindings, PYTHON_TYPING_MODULES, PYTHON_TYPING_SHAPES) ||
        pythonBaseIsStdlib(base, bindings, PYTHON_PYDANTIC_MODULES, PYTHON_PYDANTIC_SHAPES));
      const dataclassShape = Boolean(decorated) && namedChildren(decorated!).some((child) =>
        child.type === "decorator" && pythonIsStdlibDataclassDecorator(child, bindings));
      if (typedShape || dataclassShape) {
        out.push({
          symbol: name,
          code: "python_data_shape_declaration",
          reason: "Data-shape declaration (fields only, no methods) — retained in the graph but excluded from priority ranking."
        });
        continue;
      }
    }
    // Trivial constructor on ANY class: the body only stores parameters/literals on
    // self, forwards parameters/literals to super().__init__, or passes.
    const initializer = pythonTrivialInitializer(classNode);
    if (initializer) {
      out.push({
        symbol: initializer,
        code: "python_trivial_constructor",
        reason: "Trivial constructor (stores or forwards its parameters only) — retained in the graph but excluded from priority ranking."
      });
    }
  }
  return out;
}

function pythonModuleImportAliases(root: Node): Map<string, string> {
  const importCounts = new Map<string, number>();
  const importLocals = new Set<string>();
  for (const statement of namedChildren(root)) {
    if (statement.type !== "import_statement" && statement.type !== "import_from_statement") continue;
    for (const binding of extractImports(statement, "python")) {
      importCounts.set(binding.local, (importCounts.get(binding.local) ?? 0) + 1);
      importLocals.add(binding.local);
    }
  }
  const writeCounts = new Map<string, number>();
  const directAliases = new Map<string, string>();
  for (const type of ["assignment", "annotated_assignment", "augmented_assignment", "delete_statement"]) {
    for (const mutation of root.descendantsOfType(type)) {
      if (!mutation) continue;
      let parent = mutation.parent;
      let moduleScoped = false;
      while (parent) {
        if (parent.type === "function_definition" || parent.type === "class_definition" || parent.type === "lambda") break;
        if (parent.type === "module") { moduleScoped = true; break; }
        parent = parent.parent;
      }
      if (!moduleScoped) continue;
      const targets = mutation.type === "delete_statement"
        ? namedChildren(mutation).flatMap((child) => pythonBindingTargetNames(child))
        : pythonBindingTargetNames(mutation.childForFieldName("left"));
      for (const target of targets) writeCounts.set(target, (writeCounts.get(target) ?? 0) + 1);
      if (!pythonDirectModuleExecution(mutation) || mutation.type !== "assignment") continue;
      const left = mutation.childForFieldName("left");
      const right = mutation.childForFieldName("right");
      if (left?.type === "identifier" && right?.type === "identifier") directAliases.set(left.text, right.text);
    }
  }
  const out = new Map<string, string>();
  for (const local of importLocals) {
    if (importCounts.get(local) === 1 && (writeCounts.get(local) ?? 0) === 0) out.set(local, local);
  }
  for (const [alias, importedLocal] of directAliases) {
    if ((writeCounts.get(alias) ?? 0) === 1 && out.get(importedLocal) === importedLocal) out.set(alias, importedLocal);
  }
  return out;
}

function extractPythonThinDelegates(root: Node): TreeSitterPythonThinDelegate[] {
  const out: TreeSitterPythonThinDelegate[] = [];
  const imports = pythonModuleImportAliases(root);
  for (const fn of root.descendantsOfType("function_definition")) {
    if (!fn || hasPythonFunctionAncestor(fn)) continue;
    const symbol = pythonQualifiedFunctionName(fn);
    const params = pythonParameterNames(fn);
    const body = fn.childForFieldName("body");
    if (!symbol || !params || !body) continue;
    const statements = blockStatements(body);
    if (statements.length > 0 && pythonDocstringStatement(statements[0]!)) statements.shift();
    if (statements.length !== 1 || statements[0]!.type !== "return_statement") continue;
    const expression = namedChildren(statements[0]!)[0];
    if (expression?.type !== "call") continue;
    const fnNode = expression.childForFieldName("function");
    if (fnNode?.type !== "attribute") continue;
    const receiver = fnNode.childForFieldName("object");
    if (receiver?.type !== "identifier" || localBindings(fn, "python").has(receiver.text)) continue;
    const importLocal = imports.get(receiver.text);
    if (!importLocal) continue;
    const args = pythonCallArguments(expression);
    if (args.length !== params.length || args.some((arg, index) => arg.type !== "identifier" || arg.text !== params[index])) continue;
    out.push({ symbol, importLocal });
  }
  return out;
}

function pythonNearestFunction(node: Node): Node | null {
  let parent = node.parent;
  while (parent) {
    if (parent.type === "function_definition") return parent;
    parent = parent.parent;
  }
  return null;
}

function pythonDirectFunctionStatement(call: Node, owner: Node): boolean {
  // A direct call may be awaited and assigned before it becomes a function-body
  // statement. Unwrap only the exact RHS, never a call nested in an argument,
  // condition, comprehension, or another callable's result.
  let expression: Node = call;
  if (expression.parent?.type === "await") expression = expression.parent;
  if (expression.parent?.type === "assignment") {
    const assignment = expression.parent;
    const right = assignment.childForFieldName("right");
    const left = assignment.childForFieldName("left");
    if (left?.type !== "identifier" || right?.startIndex !== expression.startIndex || right?.endIndex !== expression.endIndex) return false;
    expression = assignment;
  }
  const statement = expression.parent;
  if (!statement || (statement.type !== "expression_statement" && statement.type !== "return_statement")) return false;
  const body = statement.parent;
  const parent = body?.parent;
  // web-tree-sitter may return distinct JS wrappers for the same native node, so
  // object identity is not a valid ancestry test. Compare the exact AST span.
  return body?.type === "block"
    && parent?.type === owner.type
    && parent.startIndex === owner.startIndex
    && parent.endIndex === owner.endIndex;
}

function pythonConstructorChain(call: Node): { constructorLocal: string; callee: string } | null {
  const fn = call.childForFieldName("function");
  if (fn?.type !== "attribute") return null;
  let receiver = fn.childForFieldName("object");
  let attributes = 0;
  while (receiver?.type === "attribute") {
    attributes++;
    receiver = receiver.childForFieldName("object");
  }
  // At least one persistence/object field between constructor and terminal.
  if (attributes < 1 || receiver?.type !== "call") return null;
  const constructorFn = receiver.childForFieldName("function");
  if (constructorFn?.type !== "identifier") return null;
  const terminalArgs = call.childForFieldName("arguments");
  const constructorArgs = receiver.childForFieldName("arguments");
  if (terminalArgs?.descendantsOfType("call").some(Boolean) || constructorArgs?.descendantsOfType("call").some(Boolean)) return null;
  return { constructorLocal: constructorFn.text, callee: fn.text };
}

function extractPythonConstructorChainCalls(root: Node): TreeSitterPythonConstructorChainCall[] {
  const out: TreeSitterPythonConstructorChainCall[] = [];
  for (const call of root.descendantsOfType("call")) {
    if (!call) continue;
    const owner = pythonNearestFunction(call);
    if (!owner || hasPythonFunctionAncestor(owner) || !pythonDirectFunctionStatement(call, owner)) continue;
    const shape = pythonConstructorChain(call);
    const caller = pythonQualifiedFunctionName(owner);
    if (shape && caller) out.push({ caller, ...shape });
  }
  return out;
}

function extractPythonModuleAttributes(root: Node, imports: TreeSitterImportBinding[]): TreeSitterPythonModuleAttribute[] {
  const counts = new Map<string, number>();
  for (const binding of imports) counts.set(binding.local, (counts.get(binding.local) ?? 0) + 1);
  const modules = new Set(imports.filter((binding) => binding.kind === "module" && counts.get(binding.local) === 1).map((binding) => binding.local));
  const globalWrites = new Set(root.descendantsOfType("assignment")
    .filter((assignment) => assignment?.parent?.type === "module")
    .map((assignment) => assignment!.childForFieldName("left")?.text).filter((name): name is string => Boolean(name)));
  const boundLocals = new Map<number, Set<string>>();
  const out: TreeSitterPythonModuleAttribute[] = [];
  for (const attr of root.descendantsOfType("attribute")) {
    if (!attr || attr.parent?.type === "call" && attr.parent.childForFieldName("function")?.startIndex === attr.startIndex && attr.parent.childForFieldName("function")?.endIndex === attr.endIndex) continue;
    if (attr.parent?.type === "attribute" && attr.parent.childForFieldName("object") === attr) continue;
    const object = attr.childForFieldName("object");
    const name = attr.childForFieldName("attribute");
    if (object?.type !== "identifier" || !name || !modules.has(object.text)) continue;
    const fn = pythonNearestFunction(attr);
    if (fn) {
      let bindings = boundLocals.get(fn.startIndex);
      if (!bindings) boundLocals.set(fn.startIndex, (bindings = localBindings(fn, "python")));
      if (bindings.has(object.text)) continue;
    }
    // Never count a reassigned global alias or a module-level class/function with
    // the same binding. Ambiguity fails closed rather than guessing an origin.
    if (globalWrites.has(object.text)) continue;
    out.push({ local: object.text, attribute: name.text });
  }
  return out;
}

export function extractTreeSitterStructure(content: string, language: string, relPath = ""): TreeSitterStructure {
  const parser = parserFor(language);
  if (!parser) return { imports: [], calls: [] };
  const tree = parser.parse(content);
  if (!tree) return { imports: [], calls: [] };
  const root = tree.rootNode;
  const calls: TreeSitterRawCall[] = [];
  const callerReceivers = new Map<string, { receiverVar: string; receiverType: string }>();
  const isCallableNode = (node: Node): boolean =>
    (language === "java" && node.type === "method_declaration") ||
    (language === "python" && node.type === "function_definition") ||
    (language === "go" && (node.type === "function_declaration" || node.type === "method_declaration")) ||
    (language === "kotlin" && node.type === "function_declaration") ||
    (language === "rust" && node.type === "function_item") ||
    (language === "php" && (node.type === "function_definition" || node.type === "method_declaration")) ||
    (language === "csharp" && node.type === "method_declaration");
  const visit = (node: Node, caller: string | null, shadowed: Set<string>, insideFunction: boolean): void => {
    let nextCaller = caller;
    let nextShadowed = shadowed;
    let nextInsideFunction = insideFunction;
    if (isCallableNode(node)) {
      if (insideFunction) {
        nextCaller = null; // nested function body: calls belong to an un-emitted local symbol
        nextShadowed = new Set();
        nextInsideFunction = true;
      } else {
        let name = functionName(node, language);
        // Go method symbols are receiver-qualified — attribute calls to the
        // qualified caller so Layer-1 edges keep matching the emitted symbol.
        if (name && language === "go" && node.type === "method_declaration") {
          const recv = goReceiverBaseName(node);
          if (recv) {
            name = `${recv}.${name}`;
            const rv = goReceiverVarName(node);
            if (rv) callerReceivers.set(name, { receiverVar: rv, receiverType: recv });
          }
        }
        if (name && language === "python" && node.type === "function_definition") {
          name = pythonQualifiedFunctionName(node) ?? name;
        }
        if (name) {
          nextCaller = name;
          nextShadowed = localBindings(node, language);
          nextInsideFunction = true;
        }
      }
    }
    const parts = callParts(node, language);
    if (nextCaller && parts) {
      calls.push({ caller: nextCaller, ...parts, shadowed: [...nextShadowed], ...(callerReceivers.get(nextCaller) ?? {}) });
    }
    for (const child of namedChildren(node)) visit(child, nextCaller, nextShadowed, nextInsideFunction);
  };
  visit(root, null, new Set(), false);
  const imports = extractImports(root, language);
  const pythonBehaviorContracts = language === "python" ? extractPythonBehaviorContracts(root, imports, relPath) : undefined;
  const pythonDependencies = language === "python"
    ? extractPythonDependencies(root, imports, new Set((pythonBehaviorContracts ?? []).map((contract) => contract.handler).filter((handler): handler is string => Boolean(handler))))
    : undefined;
  const pythonMockScopes = language === "python" ? pythonScopedMockMethods(root, imports) : undefined;
  const result = {
    ...(language === "java" ? { packageName: javaPackage(root), javaClasses: javaClassInfos(root), javaProofCalls: extractJavaProofCalls(root, imports) } : {}),
    ...(language === "go" ? { packageName: goPackage(root), goCtorResults: extractGoCtorResults(root) } : {}),
    ...(language === "kotlin" ? { packageName: kotlinPackage(root), topLevelSymbols: kotlinTopLevelSymbols(root) } : {}),
    ...(language === "php" ? { moduleName: phpNamespace(root) } : {}),
    ...(language === "csharp" ? { moduleName: csharpNamespace(root) } : {}),
    imports,
    calls,
    ...(language === "go" ? { goProofCalls: extractGoProofCalls(root, imports) } : {}),
    ...(language === "python" ? {
      pythonProofCalls: extractPythonProofCalls(root, imports),
      pythonMockedMethods: pythonMockedMethods(root, imports),
      pythonMocksByTest: pythonMockScopes!.byTest,
      pythonUnknownMockScopeTests: pythonMockScopes!.unknown,
      pythonClasses: pythonClassInfos(root),
      pythonBehaviorContracts,
      pythonDependencies,
      pythonRankingExclusions: extractPythonDeclarationRankingExclusions(root),
      pythonThinDelegates: extractPythonThinDelegates(root),
      pythonModuleAttributes: extractPythonModuleAttributes(root, imports),
      pythonConstructorChainCalls: extractPythonConstructorChainCalls(root)
    } : {})
  };
  tree.delete();
  return result;
}
