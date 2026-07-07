/**
 * Language-agnostic symbol extraction via tree-sitter (web-tree-sitter WASM — no
 * native build, ships in the npm package). Grammars are LOADED ASYNC once
 * (preloadTreeSitter), then extraction is SYNC so it drops into the synchronous
 * analyzer walk. Replaces the fragile per-language regexes for non-TS languages.
 */
import { createRequire } from "node:module";
import { Parser, Language, type Node } from "web-tree-sitter";
import { ExtractedSymbol, MAX_SYMBOLS_PER_FILE, SymbolExtraction } from "../symbols.js";
import { TS_LANG_CONFIGS, type TsLangConfig } from "./languages.js";

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
}

export interface TreeSitterGoProofCall extends TreeSitterRawCall {
  testName: string;
  assertion: "testing_fail" | "assert_helper";
  /**
   * 1-based source line of the assertion CALL in the test file where this target was
   * witnessed (the line Go prints in the failing frame). Slice 2 uses it to bind a
   * runtime-named subtest's mutant failure to THIS exact assertion — a sibling subtest
   * asserting at a different line is rejected. Omitted when the line can't be pinned.
   */
  assertionLine?: number;
}

export interface TreeSitterPythonProofCall extends TreeSitterRawCall {
  testName: string;
  assertion: "pytest_assert";
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
    if (kind && shouldEmitSymbol(node, language)) {
      const name = symbolName(node, cfg);
      if (name && !RESERVED_SYMBOL_NAMES.has(name)) {
        add(
          kind === "method"
            ? { name, symbol_kind: kind, trivial_accessor: isTrivialAccessorBody(node, language), ...nodeLines(node) }
            : { name, symbol_kind: kind, ...nodeLines(node) }
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
    if (language === "python") collectNames(params, out);
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

function javaPackage(root: Node): string | undefined {
  const pkg = namedChildren(root).find((n) => n.type === "package_declaration");
  return pkg ? namedChildren(pkg).find((n) => n.type.endsWith("identifier"))?.text : undefined;
}

function goPackage(root: Node): string | undefined {
  const pkg = namedChildren(root).find((n) => n.type === "package_clause");
  return pkg ? namedChildren(pkg).find((n) => n.type === "package_identifier")?.text : undefined;
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

function extractImports(root: Node, language: string): TreeSitterImportBinding[] {
  const imports: TreeSitterImportBinding[] = [];
  const add = (binding: TreeSitterImportBinding): void => {
    if (!binding.local || !binding.module) return;
    imports.push(binding);
  };
  const walk = (node: Node): void => {
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
      out.push({ caller: testName, testName, ...c, shadowed: [...shadowed], assertion, ...(assertionLine ? { assertionLine } : {}) });
    }
  };
  const processBlock = (block: Node, testName: string, testingParams: Set<string>, shadowed: Set<string>): void => {
    for (const stmt of blockStatements(block)) {
      for (const assertion of goAssertionCalls(stmt, assertLocals, dotAssertMethods, shadowed)) {
        add(testName, shadowed, "assert_helper", singleGoProductCallIn(goAssertionSubject(assertion, testingParams)), assertion.startPosition.row + 1);
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
      }
      for (const child of namedChildren(stmt)) {
        if (child.type === "block") processBlock(child, testName, testingParams, shadowed);
      }
      const subtest = goSubtestBody(stmt, testingParams);
      if (subtest) {
        const subTestName = subtest.subName ? `${testName}/${subtest.subName}` : testName;
        processBlock(subtest.body, subTestName, subtest.testingParams, shadowed);
      }
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

function extractPythonProofCalls(root: Node): TreeSitterPythonProofCall[] {
  const out: TreeSitterPythonProofCall[] = [];
  const seen = new Set<string>();
  const add = (
    testName: string,
    shadowed: Set<string>,
    call: { callee: string; qualifier?: string; via: "free" | "qualified" } | null
  ): void => {
    if (!call) return;
    const key = `${testName}|${call.qualifier ?? ""}|${call.callee}`;
    if (seen.has(key)) return;
    seen.add(key);
    out.push({ caller: testName, testName, ...call, shadowed: [...shadowed], assertion: "pytest_assert" });
  };
  const processBlock = (block: Node, testName: string, shadowed: Set<string>): void => {
    for (const stmt of blockStatements(block)) {
      if (stmt.type === "assert_statement") add(testName, shadowed, directPythonAssertCall(stmt));
      if (stmt.type === "function_definition" || stmt.type === "class_definition" || stmt.type === "lambda") continue;
      for (const child of namedChildren(stmt)) {
        if (child.type === "block") processBlock(child, testName, shadowed);
      }
    }
  };
  const walk = (node: Node, insideFunction: boolean): void => {
    if (node.type === "function_definition") {
      const name = functionName(node, "python");
      const body = node.childForFieldName("body");
      if (name && /^test_/.test(name) && body) processBlock(body, name, localBindings(node, "python"));
      if (insideFunction) return;
    }
    for (const child of namedChildren(node)) walk(child, insideFunction || node.type === "function_definition");
  };
  walk(root, false);
  return out;
}

export function extractTreeSitterStructure(content: string, language: string): TreeSitterStructure {
  const parser = parserFor(language);
  if (!parser) return { imports: [], calls: [] };
  const tree = parser.parse(content);
  if (!tree) return { imports: [], calls: [] };
  const root = tree.rootNode;
  const calls: TreeSitterRawCall[] = [];
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
        const name = functionName(node, language);
        if (name) {
          nextCaller = name;
          nextShadowed = localBindings(node, language);
          nextInsideFunction = true;
        }
      }
    }
    const parts = callParts(node, language);
    if (nextCaller && parts) {
      calls.push({ caller: nextCaller, ...parts, shadowed: [...nextShadowed] });
    }
    for (const child of namedChildren(node)) visit(child, nextCaller, nextShadowed, nextInsideFunction);
  };
  visit(root, null, new Set(), false);
  const imports = extractImports(root, language);
  const result = {
    ...(language === "java" ? { packageName: javaPackage(root), javaClasses: javaClassInfos(root), javaProofCalls: extractJavaProofCalls(root, imports) } : {}),
    ...(language === "go" ? { packageName: goPackage(root) } : {}),
    ...(language === "kotlin" ? { packageName: kotlinPackage(root), topLevelSymbols: kotlinTopLevelSymbols(root) } : {}),
    ...(language === "php" ? { moduleName: phpNamespace(root) } : {}),
    ...(language === "csharp" ? { moduleName: csharpNamespace(root) } : {}),
    imports,
    calls,
    ...(language === "go" ? { goProofCalls: extractGoProofCalls(root, imports) } : {}),
    ...(language === "python" ? { pythonProofCalls: extractPythonProofCalls(root) } : {})
  };
  tree.delete();
  return result;
}
