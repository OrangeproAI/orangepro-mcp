/**
 * The modules a file only re-exports: a package entry such as `module.exports = require('./lib/x')`,
 * or `export * from './x'` / `export { default } from './x'` / `export { a, b } from './x'`.
 * A file that also defines something of its own returns its re-export lines only when every other
 * statement is a re-export, `'use strict'`, or a comment; otherwise it is not a re-export file and
 * returns nothing.
 */
const LINE_COMMENT = /\/\/[^\n]*/g;
const BLOCK_COMMENT = /\/\*[\s\S]*?\*\//g;
const STATEMENT_PATTERNS: Array<{ re: RegExp; spec: number }> = [
  { re: /^module\.exports\s*=\s*require\(\s*(['"])([^'"]+)\1\s*\)$/, spec: 2 },
  { re: /^export\s*\*\s*(?:as\s+[A-Za-z_$][\w$]*\s*)?from\s*(['"])([^'"]+)\1$/, spec: 2 },
  { re: /^export\s*\{[^}]*\}\s*from\s*(['"])([^'"]+)\1$/, spec: 2 }
];

export function reexportSpecifiers(text: string): string[] {
  const body = text.replace(BLOCK_COMMENT, "").replace(LINE_COMMENT, "");
  const statements = body.split(/;|\n/).map((s) => s.trim()).filter(Boolean);
  const specs: string[] = [];
  for (const stmt of statements) {
    if (/^(['"])use strict\1$/.test(stmt)) continue;
    const hit = STATEMENT_PATTERNS.map((p) => ({ m: p.re.exec(stmt), i: p.spec })).find((x) => x.m);
    if (!hit || !hit.m) return [];
    specs.push(hit.m[hit.i]!);
  }
  return specs;
}
