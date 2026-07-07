/**
 * Per-language tree-sitter config table (graphify-modeled). Adding a language is a
 * config entry here + its grammar wasm — NO new parsing code. Generic AST walk in
 * engine.ts reads these node-type sets and the name field.
 *
 * TS/JS are intentionally ABSENT: they stay on the TypeScript compiler path
 * (collectTsJsExports), which the resolver + confirmer depend on. tree-sitter is
 * for the NON-TS languages where hand-written regexes were fragile or absent.
 */
export interface TsLangConfig {
  /** Grammar wasm filename under tree-sitter-wasms/out/. */
  wasm: string;
  /** AST node types that are a class/type behavior surface. */
  classTypes: Set<string>;
  /** AST node types that are a free function behavior surface. */
  functionTypes: Set<string>;
  /** AST node types that are a method (receiver/class member) behavior surface. */
  methodTypes: Set<string>;
  /** Field name carrying the symbol's identifier on those nodes. */
  nameField: string;
  /** Fallback identifier node types for grammars that do not expose a `name` field. */
  nameNodeTypes?: Set<string>;
}

export const TS_LANG_CONFIGS: Record<string, TsLangConfig> = {
  java: {
    wasm: "tree-sitter-java.wasm",
    classTypes: new Set(["class_declaration", "interface_declaration", "enum_declaration", "record_declaration"]),
    functionTypes: new Set(),
    // method_declaration only — constructors are not a separately-tested behavior.
    methodTypes: new Set(["method_declaration"]),
    nameField: "name"
  },
  python: {
    wasm: "tree-sitter-python.wasm",
    classTypes: new Set(["class_definition"]),
    // Python methods are also function_definition (nested in a class); both count
    // as callable behaviors, so a single type covers free functions + methods.
    functionTypes: new Set(["function_definition"]),
    methodTypes: new Set(),
    nameField: "name"
  },
  go: {
    wasm: "tree-sitter-go.wasm",
    // Go "types" (structs/interfaces) are declared via type_spec.
    classTypes: new Set(["type_spec"]),
    functionTypes: new Set(["function_declaration"]),
    // Receiver methods (`func (r *Repo) Save()`) — the exact surface the regex missed.
    methodTypes: new Set(["method_declaration"]),
    nameField: "name"
  },
  ruby: {
    wasm: "tree-sitter-ruby.wasm",
    classTypes: new Set(["class", "module"]),
    functionTypes: new Set(),
    methodTypes: new Set(["method", "singleton_method"]),
    nameField: "name"
  },
  kotlin: {
    wasm: "tree-sitter-kotlin.wasm",
    classTypes: new Set(["class_declaration", "object_declaration"]),
    functionTypes: new Set(["function_declaration"]),
    methodTypes: new Set(),
    nameField: "name",
    nameNodeTypes: new Set(["simple_identifier", "type_identifier"])
  },
  rust: {
    wasm: "tree-sitter-rust.wasm",
    classTypes: new Set(["struct_item", "enum_item", "trait_item"]),
    functionTypes: new Set(["function_item", "function_signature_item"]),
    methodTypes: new Set(),
    nameField: "name"
  },
  php: {
    wasm: "tree-sitter-php.wasm",
    classTypes: new Set(["class_declaration", "interface_declaration", "trait_declaration", "enum_declaration"]),
    functionTypes: new Set(["function_definition"]),
    methodTypes: new Set(["method_declaration"]),
    nameField: "name"
  },
  csharp: {
    wasm: "tree-sitter-c_sharp.wasm",
    classTypes: new Set([
      "class_declaration",
      "interface_declaration",
      "struct_declaration",
      "enum_declaration",
      "record_declaration",
      "record_struct_declaration"
    ]),
    functionTypes: new Set(),
    methodTypes: new Set(["method_declaration"]),
    nameField: "name"
  },
  swift: {
    wasm: "tree-sitter-swift.wasm",
    classTypes: new Set(["class_declaration", "protocol_declaration", "enum_declaration"]),
    functionTypes: new Set(["function_declaration", "protocol_function_declaration"]),
    methodTypes: new Set(),
    nameField: "name"
  },
  c: {
    wasm: "tree-sitter-c.wasm",
    classTypes: new Set(["struct_specifier", "union_specifier", "enum_specifier"]),
    functionTypes: new Set(["function_definition"]),
    methodTypes: new Set(),
    nameField: "name",
    nameNodeTypes: new Set(["identifier", "type_identifier"])
  },
  cpp: {
    wasm: "tree-sitter-cpp.wasm",
    classTypes: new Set(["class_specifier", "struct_specifier", "union_specifier", "enum_specifier"]),
    functionTypes: new Set(["function_definition"]),
    methodTypes: new Set(),
    nameField: "name",
    nameNodeTypes: new Set(["identifier", "type_identifier"])
  }
};

/** Languages handled by the tree-sitter path (everything not on the TS compiler path). */
export function isTreeSitterLanguage(language: string): boolean {
  return Object.prototype.hasOwnProperty.call(TS_LANG_CONFIGS, language);
}

export function treeSitterLanguages(): string[] {
  return Object.keys(TS_LANG_CONFIGS);
}
