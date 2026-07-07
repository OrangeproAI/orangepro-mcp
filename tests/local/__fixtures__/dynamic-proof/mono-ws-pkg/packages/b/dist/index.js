// BUILT output of @wspkg/b (the package.json runtime entry: main + exports "."). base=1 here is the
// value aspect-2 must resolve; the src/index.ts decoy is base=999, so the built-output preference is
// what makes calc.test.ts assert 6. Committed via `git add -f` (repo .gitignore ignores dist/).
export const base = 1;
