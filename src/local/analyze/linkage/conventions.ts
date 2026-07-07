// Per-language test<->source CONVENTION linkage (PR-2 of multi-language coverage).
//
// For non-TS/JS languages the import-graph resolver does not run, so the only
// test->source signal is a naming/path convention. The previous global
// basename-stem matcher was both too coarse (Java's `FooTest.java` stem
// `footest` never matched `Foo.java`) and too loose (any same-stem file in the
// repo). This module replaces guessing with PREDICT-AND-VERIFY: from a test
// file we DERIVE the exact source-sibling path its language convention implies,
// then confirm that file was actually scanned. A wrong derivation simply finds
// nothing — it can never invent a false link.
//
// These are CANDIDATE associations ("this behavior has an associated test"),
// never structural proof. Callers emit them as `weak` MAY_RELATE_TO edges so
// they are excluded from the TS/JS structural confirmer. Per the product bar,
// convention linkage is the "has-a-test" tier and is NEVER blended with the
// hard-confirmed tier.

export interface ConventionSibling {
  /** relPath of the source file the test conventionally exercises. */
  relPath: string;
  /** 0..1 — precision of the convention rule that matched (predict-verify, so high). */
  confidence: number;
  /** Human-readable basis, names the convention + the matched pair. */
  reason: string;
}

// Languages with a strong, unambiguous test convention. For these, a file that
// does NOT match the convention is a test-tree helper/shadow, not a behavior
// test — callers must under-link rather than fall back to the coarse global
// basename-stem matcher (which resurrects cross-file false links). Keep in sync
// with the conventionSibling() switch.
const CONVENTION_LANGUAGES = new Set(["go", "java", "kotlin", "python"]);

/** True when conventionSibling() authoritatively decides linkage for `language`. */
export function isConventionLanguage(language: string): boolean {
  return CONVENTION_LANGUAGES.has(language);
}

const baseOf = (relPath: string): string => relPath.split("/").pop() || relPath;
const dirOf = (relPath: string): string => {
  const i = relPath.lastIndexOf("/");
  return i >= 0 ? relPath.slice(0, i) : "";
};
const join = (dir: string, base: string): string => (dir ? `${dir}/${base}` : base);

/**
 * Source sibling implied by the test file's language convention, or null when
 * no predicted sibling was actually scanned. `codeFiles` is the set of scanned
 * source-file relPaths (case-preserving, ignore-rules already applied), so an
 * existence check here respects the analyzed scope.
 *
 * Languages without a strong, unambiguous convention (notably TS/JS, handled by
 * the resolver + co-located stem fallback) return null so the caller's existing
 * logic stays authoritative.
 */
export function conventionSibling(testRel: string, language: string, codeFiles: ReadonlySet<string>): ConventionSibling | null {
  switch (language) {
    case "go":
      return goSibling(testRel, codeFiles);
    case "java":
    case "kotlin":
      return jvmSibling(testRel, codeFiles);
    case "python":
      return pythonSibling(testRel, codeFiles);
    default:
      return null;
  }
}

// ── Go: `foo_test.go` ↔ `foo.go` in the SAME package directory (language rule). ──
function goSibling(testRel: string, codeFiles: ReadonlySet<string>): ConventionSibling | null {
  const base = baseOf(testRel);
  const m = /^(.+)_test\.go$/.exec(base);
  if (!m) return null;
  const predicted = join(dirOf(testRel), `${m[1]}.go`);
  if (predicted === testRel || !codeFiles.has(predicted)) return null;
  return { relPath: predicted, confidence: 0.7, reason: `Go test sibling (${base} ↔ ${m[1]}.go, same package)` };
}

// ── JVM (Java/Kotlin): `FooTest`/`FooTests`/`FooIT`/`FooITCase`/`FooTestCase` ──
//    ↔ `Foo`, in the src/test → src/main mirror or the same directory.
//    Case is preserved (camelCase suffix), so the strip is unambiguous.
function jvmSibling(testRel: string, codeFiles: ReadonlySet<string>): ConventionSibling | null {
  const base = baseOf(testRel);
  const m = /^(.+?)(Tests?|IT|ITCase|TestCase|Spec)\.(java|kt)$/.exec(base);
  if (!m) return null;
  const stem = m[1];
  const ext = m[3];
  const srcBase = `${stem}.${ext}`;
  if (srcBase === base) return null;

  // src/test/<lang>/<pkg>/FooTest.java -> src/main/<lang>/<pkg>/Foo.java
  const mirrorDir = mirrorTestToMain(dirOf(testRel));
  if (mirrorDir != null) {
    const predicted = join(mirrorDir, srcBase);
    if (predicted !== testRel && codeFiles.has(predicted)) {
      return { relPath: predicted, confidence: 0.7, reason: `JVM test sibling (${base} ↔ ${srcBase}, src/test→src/main mirror)` };
    }
  }
  // Co-located fallback: some projects keep the test beside the class.
  const sameDir = join(dirOf(testRel), srcBase);
  if (sameDir !== testRel && codeFiles.has(sameDir)) {
    return { relPath: sameDir, confidence: 0.65, reason: `JVM test sibling (${base} ↔ ${srcBase}, same directory)` };
  }
  return null;
}

/** Replace a `src/test/...` (or `src/integration-test/`, `src/it/`) prefix segment with `src/main/...`. */
function mirrorTestToMain(dir: string): string | null {
  const replaced = dir.replace(/(^|\/)src\/(test|integration-test|it|androidTest)(\/|$)/, "$1src/main$3");
  return replaced !== dir ? replaced : null;
}

// ── Python: `test_x.py` / `x_test.py` ↔ `x.py`. ──
//   Python test trees vary (same-dir, or `tests/<...mirror...>/test_x.py` under an
//   unknown package root like `mealie/` or `src/`). We strip the test-root dir
//   names, then take the LONGEST path-suffix of the remaining test directory that
//   uniquely identifies a module file of the right basename. The suffix match
//   absorbs the unknown source-package prefix; "unique" keeps it from guessing.
const PY_TEST_ROOT = /^(tests?|unit_?tests?|integration_?tests?|functional_?tests?|e2e|it|specs?)$/i;

function pythonSibling(testRel: string, codeFiles: ReadonlySet<string>): ConventionSibling | null {
  const base = baseOf(testRel);
  let stem: string | null = null;
  let m = /^test_(.+)\.py$/.exec(base);
  if (m) stem = m[1];
  if (!stem) {
    m = /^(.+)_test\.py$/.exec(base);
    if (m) stem = m[1];
  }
  if (!stem) return null;
  const srcBase = `${stem}.py`;
  const dir = dirOf(testRel);

  // 1. Same directory (tests co-located with modules).
  const sameDir = join(dir, srcBase);
  if (sameDir !== testRel && codeFiles.has(sameDir)) {
    return { relPath: sameDir, confidence: 0.65, reason: `Python test sibling (${base} ↔ ${srcBase}, same package)` };
  }

  // 2. Module mirror. Candidate source files sharing the basename:
  const sameBase: string[] = [];
  for (const f of codeFiles) {
    if (f !== testRel && baseOf(f) === srcBase) sameBase.push(f);
  }
  if (sameBase.length === 0) return null;

  // Drop test-root dir names, then longest-unique path-suffix match.
  const meaningful = dir.split("/").filter((s) => s && !PY_TEST_ROOT.test(s));
  let ambiguous = false;
  for (let start = 0; start < meaningful.length; start++) {
    const tail = meaningful.slice(start).join("/"); // e.g. "core/security/providers"
    const exact = `${tail}/${srcBase}`;
    const suffix = `/${exact}`;
    const matches = sameBase.filter((f) => f === exact || f.endsWith(suffix));
    if (matches.length === 1) {
      const depth = tail.split("/").length;
      return { relPath: matches[0], confidence: depth >= 2 ? 0.62 : 0.58, reason: `Python test sibling (${base} ↔ ${srcBase}, module mirror)` };
    }
    if (matches.length > 1) {
      ambiguous = true; // ambiguous at the most specific depth — do not guess
      break;
    }
  }

  // 3. Flat layout (`tests/test_x.py` → `src/x.py`): the `test_`/`_test` prefix
  //    explicitly names the module, so a UNIQUE `x.py` anywhere is a confident
  //    match. Convention-gated (only fires for genuinely named test files), so a
  //    non-test file like `tests/helpers.py` never reaches here.
  if (!ambiguous && sameBase.length === 1) {
    return { relPath: sameBase[0], confidence: 0.5, reason: `Python test sibling (${base} ↔ ${srcBase}, unique module)` };
  }
  return null;
}
