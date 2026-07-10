#!/usr/bin/env node
// java-mutate.mjs — AST-based body replacer for the Java dynamic-proof spike (J-1).
//
// Locates ONE simplest-shape method `[modifiers] ReturnType name(params) { ... }`
// by exact name via tree-sitter Java (the SAME grammar the static layer already
// uses — tree-sitter-wasms + web-tree-sitter, no new dependency) and replaces its
// BODY with a signature-derived, type-compatible sentinel by splicing the body
// block's byte range. Invoked by java-dynamic-proof-spike.mjs (the product Java
// proof path); it writes ONLY the mutated file inside the sandbox copy — no graph
// or product artifacts.
//
// J-1 scope is the SIMPLEST SHAPE ONLY: a concrete non-void, non-type-variable
// return type, EXACTLY one top-level `return <expr>;` (no nested return in an
// if/loop/try, no second return anywhere), no generics, and no overload ambiguity.
// Everything else is refused with a distinct reason (deferred to J-2), never
// silently mutated — the sentinel replaces the whole body, so a method with more
// than one exit shape or an unknown (type-variable) return is not safe to mutate.
//
// Modes:
//   sentinel   — replace the body with `{ return <wrong-but-compiling value>; }`.
//                The sentinel is a FIXED value derived from the declared return
//                type, so it can only ever cause a FALSE SURVIVE, never a false
//                Proven — the trust bias is safe by construction.
//   equivalent — leave the body byte-for-byte unchanged (the original source is
//                re-written) so a value-only test still passes -> the orchestrator
//                classifies it associated_survived.
//
// Exit codes (distinct, so the Node orchestrator can classify precisely):
//   0  ok, mutated file written
//   2  usage / IO / parse error
//   3  ambiguous: more than one method with that name (overloads)
//   4  not found: no method with that name
//   5  out of scope: void, constructor, generic, or no single concrete return
//      (J-2), refused in J-1
//   6  not mutable: could not derive a type-compatible sentinel for the return type
//
// Like the Go helper, it prints a stable MUTATE_ERROR:<code> marker to stderr so a
// caller that cannot see the process status can still classify.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

function fail(code, message) {
  process.stderr.write(`MUTATE_ERROR:${code}\n`);
  process.stderr.write(`${message}\n`);
  process.exit(code);
}

function parseArgs(argv) {
  const args = { mode: "sentinel" };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (!arg.startsWith("--")) fail(2, `unexpected positional argument: ${arg}`);
    const key = arg.slice(2);
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) fail(2, `missing value for ${arg}`);
    args[key] = value;
    i += 1;
  }
  if (!args.file || !args.func) {
    fail(2, "usage: node java-mutate.mjs --file <path> --func <name> [--out <path>] [--mode sentinel|equivalent]");
  }
  if (args.mode !== "sentinel" && args.mode !== "equivalent") {
    fail(2, "--mode must be sentinel or equivalent");
  }
  return args;
}

/** Load tree-sitter + the Java grammar exactly as the static analyzer does. */
async function loadJavaParser() {
  const { Parser, Language } = require("web-tree-sitter");
  await Parser.init();
  const wasm = require.resolve("tree-sitter-wasms/out/tree-sitter-java.wasm");
  const language = await Language.load(wasm);
  const parser = new Parser();
  parser.setLanguage(language);
  return parser;
}

// A method is J-1 SIMPLEST-SHAPE when: it is a real method_declaration (not a
// constructor — those are a distinct node type and never match here), its return
// type is a concrete non-void, non-type-variable type, it declares no type
// parameters (no generics), and its body is EXACTLY one top-level `return <expr>;`
// — no nested return (inside an if/loop/try/lambda) and no second return anywhere.
// Anything else is out of scope for J-1: the sentinel replaces the WHOLE body, so a
// method whose real control flow has more than one exit shape (or a return buried in
// a branch) is not a value we can safely mutate 0->1.
function topLevelReturns(body) {
  // Direct named children of the body block that are return statements.
  return body.namedChildren.filter((c) => c.type === "return_statement");
}

function allReturns(body) {
  // Every return anywhere in the body — nested ones included.
  return body.descendantsOfType("return_statement");
}

// The set of type-parameter names in scope for a method: its own `<T>` plus every
// enclosing class/interface `<T>`. A return type that names one of these is a type
// VARIABLE — no type-derived sentinel is safe (the runtime type is unknown), so it
// is refused as out of scope for J-1.
function typeParamNamesInScope(method) {
  const names = new Set();
  const collect = (node) => {
    if (!node) return;
    for (const tp of node.descendantsOfType("type_parameter")) {
      // A type_parameter's identifier child is the variable name (T, U, …).
      const id = tp.namedChildren.find((c) => c.type === "identifier" || c.type === "type_identifier");
      if (id?.text) names.add(id.text);
    }
  };
  // Method-level type parameters.
  const ownTp = method.childForFieldName("type_parameters");
  if (ownTp) collect(ownTp);
  // Enclosing class/interface/record/enum type parameters.
  for (let n = method.parent; n; n = n.parent) {
    if (/_declaration$/.test(n.type)) {
      const tp = n.childForFieldName("type_parameters");
      if (tp) collect(tp);
    }
  }
  return names;
}

// True when the declared return type is a bare type variable (a type_identifier
// whose text is a type parameter in scope), e.g. `<T> T foo()` or a method that
// returns the enclosing class's `T`. tree-sitter reports both as a `type_identifier`
// with no way to distinguish a class from a type variable except the in-scope set.
function isTypeVariableReturn(typeNode, method) {
  if (typeNode.type !== "type_identifier") return false;
  return typeParamNamesInScope(method).has(typeNode.text);
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const dst = args.out || args.file;
  let source;
  try {
    source = readFileSync(args.file, "utf8");
  } catch (error) {
    fail(2, `read error: ${error instanceof Error ? error.message : String(error)}`);
    return;
  }

  return loadJavaParser().then((parser) => {
    let tree;
    try {
      tree = parser.parse(source);
    } catch (error) {
      fail(2, `parse error: ${error instanceof Error ? error.message : String(error)}`);
      return;
    }
    if (!tree) fail(2, "parse produced no tree");

    const matches = tree.rootNode
      .descendantsOfType("method_declaration")
      .filter((m) => m.childForFieldName("name")?.text === args.func);

    if (matches.length > 1) {
      fail(3, `ambiguous: ${matches.length} methods named ${JSON.stringify(args.func)} (overloads)`);
    }
    if (matches.length === 0) {
      // Distinguish a constructor of that name from a genuinely missing method.
      const ctor = tree.rootNode
        .descendantsOfType("constructor_declaration")
        .some((c) => c.childForFieldName("name")?.text === args.func);
      if (ctor) fail(5, `out of scope: ${JSON.stringify(args.func)} is a constructor (J-2)`);
      fail(4, `not found: no method named ${JSON.stringify(args.func)}`);
    }

    const method = matches[0];
    const typeNode = method.childForFieldName("type");
    const body = method.childForFieldName("body");
    if (!typeNode || !body || body.type !== "block") {
      fail(5, `out of scope: ${JSON.stringify(args.func)} has no concrete body/return type (abstract/interface?)`);
    }
    if (typeNode.type === "void_type") {
      fail(5, `out of scope: ${JSON.stringify(args.func)} returns void (J-2)`);
    }
    if (method.descendantsOfType("type_parameters").length > 0) {
      fail(5, `out of scope: ${JSON.stringify(args.func)} is generic (J-2)`);
    }
    // A return type that is a type variable (a method or enclosing-class `<T>`) has
    // no type-derived sentinel that is safe, so refuse it as out of scope.
    if (isTypeVariableReturn(typeNode, method)) {
      fail(5, `out of scope: ${JSON.stringify(args.func)} returns a type variable ${JSON.stringify(typeNode.text)} (J-2)`);
    }
    // Exactly one TOP-LEVEL return and no other return anywhere in the body. A
    // nested return (inside an if/loop/try) has topLevel === 0; a second return
    // anywhere makes all > 1. Both are refused: the sentinel replaces the whole body.
    const topReturns = topLevelReturns(body);
    const everyReturn = allReturns(body);
    if (topReturns.length !== 1 || everyReturn.length !== 1) {
      fail(5, `out of scope: ${JSON.stringify(args.func)} is not a single top-level return (nested/multiple returns) (J-2)`);
    }

    if (args.mode === "equivalent") {
      // Re-write the original bytes unchanged: a value-only test still passes.
      try {
        writeFileSync(dst, source);
      } catch (error) {
        fail(2, `write error: ${error instanceof Error ? error.message : String(error)}`);
      }
      return;
    }

    const sentinel = sentinelReturn(typeNode);
    if (sentinel === null) {
      fail(6, `not mutable: cannot derive a type-compatible sentinel for return type ${JSON.stringify(typeNode.text)}`);
    }

    // Splice the body block's byte range with a minimal `{ return <sentinel>; }`.
    const before = source.slice(0, body.startIndex);
    const after = source.slice(body.endIndex);
    const mutated = `${before}{ return ${sentinel}; }${after}`;
    try {
      writeFileSync(dst, mutated);
    } catch (error) {
      fail(2, `write error: ${error instanceof Error ? error.message : String(error)}`);
    }
  });
}

// A FIXED, deliberately-wrong-but-compiling value derived from the declared return
// type. A fixed sentinel can only cause a FALSE SURVIVE (associated_survived) when
// the real return happens to equal it — NEVER a false Proven. Returns null when no
// type-compatible constant can be named (fail closed -> exit 6, never mutated).
function sentinelReturn(typeNode) {
  const type = typeNode.type;
  const text = typeNode.text;
  if (type === "integral_type") {
    // int / short / byte / long -> a distinct wrong integer. char is integral in
    // the grammar but -999 is not a char; give it a distinct char literal.
    if (text === "char") return "'\\u0000'";
    if (text === "long") return "-999L";
    return "-999";
  }
  if (type === "floating_point_type") {
    return text === "float" ? "-999.0f" : "-999.0";
  }
  if (type === "boolean_type") {
    // A fixed constant. If the real value is false, the mutant SURVIVES (safe); if
    // it is true, the assertion FAILS -> proven. Exactly the trust bias.
    return "false";
  }
  if (type === "type_identifier" && text === "String") {
    return '"__opro_sentinel__"';
  }
  // Any other reference type (a class, an array, a boxed type, ...) -> null is a
  // valid, always-compiling wrong value for a test asserting a non-null result.
  if (
    type === "type_identifier" ||
    type === "array_type" ||
    type === "scoped_type_identifier" ||
    type === "generic_type"
  ) {
    return "null";
  }
  return null;
}

main();
