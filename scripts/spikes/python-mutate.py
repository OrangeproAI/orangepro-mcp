#!/usr/bin/env python3
"""Fail-closed Python mutation helper for dynamic proof.

A sentinel is selected from the declared return annotation. An unannotated function
may use only a direct, unambiguous observed test oracle supplied by the spike; all
other shapes are refused rather than guessing a type-incompatible mutation.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
from pathlib import Path


def fail(reason: str) -> None:
    print(json.dumps({"ok": False, "reason": reason}))
    raise SystemExit(0)


def leading_ws(line: str) -> str:
    return line[: len(line) - len(line.lstrip(" \t"))]


def annotation_name(annotation: ast.expr | None) -> str | None:
    if annotation is None:
        return None
    try:
        return ast.unparse(annotation).replace(" ", "")
    except Exception:
        return None


def sentinel_for(annotation: ast.expr | None, oracle_type: str | None) -> tuple[str, str] | None:
    """Return (expression, provenance), never infer an unsupported return type."""
    name = annotation_name(annotation)
    if name:
        lowered = name.lower().replace("typing.", "").replace("collections.abc.", "")
        if lowered == "bool":
            return "False", "annotation:bool"
        if lowered in {"str", "builtins.str"}:
            return "''", "annotation:str"
        if lowered in {"none", "nonetype"} or lowered.startswith(("optional[", "union[none,")) or ",none]" in lowered or "|none" in lowered:
            return "None", "annotation:optional"
        if lowered in {"int", "float", "complex", "decimal", "fraction", "number", "numbers.number"} or lowered.startswith(("int[", "float[")):
            return "0", "annotation:scalar"
        if lowered.startswith(("dict[", "mapping[")) or lowered in {"dict", "mapping"}:
            return "{}", "annotation:mapping"
        if lowered.startswith(("list[", "set[", "tuple[", "sequence[", "iterable[", "collection[", "frozenset[", "deque[")) or lowered in {"list", "set", "tuple", "sequence", "iterable", "collection"}:
            # [] is intentionally type-compatible enough for abstract collection return types;
            # the proof oracle still requires an assertion kill, never this heuristic alone.
            return "[]", "annotation:collection"
        return None
    observed = {
        "bool": "False",
        "str": "''",
        "collection": "[]",
        "optional": "None",
        "scalar": "0",
    }.get(oracle_type or "")
    return (observed, f"observed_oracle:{oracle_type}") if observed else None


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--func", required=True)
    parser.add_argument("--mode", choices=["sentinel", "equivalent"], default="sentinel")
    parser.add_argument("--oracle-type", choices=["bool", "str", "collection", "optional", "scalar"])
    args = parser.parse_args()

    if args.mode == "equivalent":
        print(json.dumps({"ok": True, "changed": False, "sentinel": None, "sentinel_source": "equivalent"}))
        return

    target = Path(args.file)
    text = target.read_text(encoding="utf8")
    lines = text.splitlines(keepends=True)
    try:
        tree = ast.parse(text, filename=str(target))
    except SyntaxError as exc:
        fail(f"syntax_error:{exc.lineno}")

    candidates: list[ast.FunctionDef | ast.AsyncFunctionDef] = [
        node for node in ast.walk(tree)
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == args.func
    ]
    if len(candidates) != 1:
        fail("ambiguous_function" if candidates else "function_not_found")
    fn = candidates[0]
    if fn.end_lineno is None or not fn.body:
        fail("unsupported_function_shape")
    if any(isinstance(node, (ast.Yield, ast.YieldFrom)) for node in ast.walk(fn)):
        fail("unsupported_generator")

    sentinel = sentinel_for(fn.returns, args.oracle_type)
    if sentinel is None:
        fail("return_annotation_or_observed_oracle_required")
    expression, sentinel_source = sentinel

    first_body = fn.body[0]
    start = first_body.lineno
    end = fn.end_lineno
    if start < 1 or end < start or end > len(lines):
        fail("unsupported_function_range")

    replacement: str
    if start == fn.lineno and end == fn.lineno:
        header_line = lines[fn.lineno - 1]
        match = re.match(r"^(\s*(?:async\s+)?def\s+[A-Za-z_][A-Za-z0-9_]*\([^)]*\)(?:\s*->\s*[^:]+)?):\s*.+$", header_line)
        if not match:
            fail("unsupported_inline_suite")
        body_indent = leading_ws(header_line) + "    "
        lines[start - 1 : end] = [f"{match.group(1)}:\n", f"{body_indent}return {expression}\n"]
    else:
        indent = leading_ws(lines[start - 1])
        header_indent = leading_ws(lines[fn.lineno - 1])
        if not indent or len(indent.replace("\t", "    ")) <= len(header_indent.replace("\t", "    ")):
            fail("unsupported_suite_indent")
        replacement = f"{indent}return {expression}\n"
        lines[start - 1 : end] = [replacement]

    target.write_text("".join(lines), encoding="utf8")
    print(json.dumps({
        "ok": True,
        "changed": True,
        "start_line": start,
        "end_line": end,
        "sentinel": expression,
        "sentinel_source": sentinel_source,
    }))


if __name__ == "__main__":
    main()
