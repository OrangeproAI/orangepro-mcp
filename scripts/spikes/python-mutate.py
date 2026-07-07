#!/usr/bin/env python3
"""Minimal Python mutation helper for the P-1 proof spike.

This intentionally supports only the first safe shape: exactly one function or
method named --func in the target file, with a block suite that can be replaced
by a simple return sentinel. Unsupported or ambiguous shapes fail closed.
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


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--file", required=True)
    parser.add_argument("--func", required=True)
    parser.add_argument("--mode", choices=["sentinel", "equivalent"], default="sentinel")
    args = parser.parse_args()

    if args.mode == "equivalent":
        print(json.dumps({"ok": True, "changed": False}))
        return

    target = Path(args.file)
    text = target.read_text(encoding="utf8")
    lines = text.splitlines(keepends=True)

    try:
        tree = ast.parse(text, filename=str(target))
    except SyntaxError as exc:
        fail(f"syntax_error:{exc.lineno}")

    candidates: list[ast.FunctionDef | ast.AsyncFunctionDef] = []
    for node in ast.walk(tree):
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)) and node.name == args.func:
            candidates.append(node)

    if len(candidates) != 1:
        fail("ambiguous_function" if candidates else "function_not_found")

    fn = candidates[0]
    if fn.end_lineno is None or not fn.body:
        fail("unsupported_function_shape")
    if any(isinstance(n, (ast.Yield, ast.YieldFrom)) for n in ast.walk(fn)):
        fail("unsupported_generator")

    first_body = fn.body[0]
    start = first_body.lineno
    end = fn.end_lineno
    if start < 1 or end < start or end > len(lines):
        fail("unsupported_function_range")

    if start == fn.lineno and end == fn.lineno:
        header_line = lines[fn.lineno - 1]
        match = re.match(r"^(\s*(?:async\s+)?def\s+[A-Za-z_][A-Za-z0-9_]*\([^)]*\)(?:\s*->\s*[^:]+)?):\s*.+$", header_line)
        if not match:
            fail("unsupported_inline_suite")
        body_indent = leading_ws(header_line) + "    "
        lines[start - 1 : end] = [f"{match.group(1)}:\n", f"{body_indent}return 0\n"]
        target.write_text("".join(lines), encoding="utf8")
        print(json.dumps({"ok": True, "changed": True, "start_line": start, "end_line": end}))
        return

    indent = leading_ws(lines[start - 1])
    if not indent or len(indent.replace("\t", "    ")) <= len(leading_ws(lines[fn.lineno - 1]).replace("\t", "    ")):
        fail("unsupported_suite_indent")

    replacement = f"{indent}return 0\n"
    lines[start - 1 : end] = [replacement]
    target.write_text("".join(lines), encoding="utf8")
    print(json.dumps({"ok": True, "changed": True, "start_line": start, "end_line": end}))


if __name__ == "__main__":
    main()
