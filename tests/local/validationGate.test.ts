import { describe, it, expect, beforeAll } from "vitest";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { readdirSync } from "node:fs";
import { buildConfirmProgram, confirmPair, type ConfirmProgram } from "../../src/local/analyze/confirm.js";
import { resetResolverCaches } from "../../src/local/resolve/resolver.js";
import { resetExportIndexCache } from "../../src/local/resolve/exportIndex.js";

/**
 * VALIDATION GATE (HARD STOP between Phase 4 and Phase 5).
 *
 * A stratified gold set proving the confirmer is false-confirm-safe ACROSS the
 * two resolution modes the product targets:
 *   - NodeNext (`.js`-specifier -> `.ts`), our own repo  — __fixtures__/confirm
 *   - bundler + tsconfig paths/baseUrl (Mattermost idiom) — __fixtures__/confirm-bundler
 *
 * The gate (HARD): 0 negatives/nsc ever resolve to CONFIRMED. The recall check
 * (also asserted here, since every positive is hand-verified as genuinely
 * asserted): each positive DOES confirm — so a resolution mode silently failing
 * to confirm (e.g. bundler path-alias) is caught, not hidden.
 */

const HERE = dirname(fileURLToPath(import.meta.url));
const NODENEXT = resolve(HERE, "../../src/local/analyze/__fixtures__/confirm");
const BUNDLER = resolve(HERE, "../../src/local/analyze/__fixtures__/confirm-bundler");

type Verdict = "confirmed" | "inferred" | "none";
interface GoldCase {
  group: "nodenext" | "bundler";
  file: string; // test fixture, relative to the group dir
  impl: string; // impl fixture, relative to the group dir
  behavior: string;
  category: string; // stratification bucket
  expect: Verdict;
}

// Positives MUST confirm; negatives/nsc MUST NOT. Stratified by resolution mode
// (group) + structural category. The negative categories are the ones a false
// "confirmed" would be a product-credibility blocker.
const GOLD: GoldCase[] = [
  // ── NodeNext positives ──────────────────────────────────────────────
  { group: "nodenext", file: "P1-call-assert.test.ts", impl: "impl.ts", behavior: "saveUser", category: "pos:direct-import", expect: "confirmed" },
  { group: "nodenext", file: "P2-render-assert.test.tsx", impl: "LoginForm.tsx", behavior: "LoginForm", category: "pos:jsx-render", expect: "confirmed" },
  { group: "nodenext", file: "P3-self-assert.test.tsx", impl: "LoginForm.tsx", behavior: "LoginForm", category: "pos:self-assert-getby", expect: "confirmed" },
  { group: "nodenext", file: "P4-barrel-followed.test.ts", impl: "impl.ts", behavior: "saveUser", category: "pos:barrel-reexport", expect: "confirmed" },
  { group: "nodenext", file: "P5-cypress-should.test.tsx", impl: "LoginForm.tsx", behavior: "LoginForm", category: "pos:self-assert-findby", expect: "confirmed" },
  { group: "nodenext", file: "P6-findby-render.test.tsx", impl: "LoginForm.tsx", behavior: "LoginForm", category: "pos:self-assert-findby", expect: "confirmed" },
  { group: "nodenext", file: "P7-map-nested.test.ts", impl: "impl.ts", behavior: "saveUser", category: "pos:nested-callback", expect: "confirmed" },
  { group: "nodenext", file: "P8-default-export.test.ts", impl: "defaultExport.ts", behavior: "makeReport", category: "pos:default-export", expect: "confirmed" },
  { group: "nodenext", file: "P9-node-assert.test.ts", impl: "impl.ts", behavior: "saveUser", category: "pos:trusted-assert", expect: "confirmed" },
  { group: "nodenext", file: "P10-expect-matcher-arg.test.ts", impl: "impl.ts", behavior: "saveUser", category: "pos:matcher-arg", expect: "confirmed" },
  { group: "nodenext", file: "P11-aliased-screen.test.tsx", impl: "LoginForm.tsx", behavior: "LoginForm", category: "pos:aliased-framework-query", expect: "confirmed" },
  { group: "nodenext", file: "P12-throw-thunk.test.ts", impl: "impl.ts", behavior: "saveUser", category: "pos:invoking-matcher-thunk", expect: "confirmed" },
  { group: "nodenext", file: "P13-expect-soft.test.ts", impl: "impl.ts", behavior: "saveUser", category: "pos:expect-soft", expect: "confirmed" },
  { group: "nodenext", file: "P14-bracket-assert.test.ts", impl: "impl.ts", behavior: "saveUser", category: "pos:bracket-assert", expect: "confirmed" },
  { group: "nodenext", file: "P15-map-inline.test.ts", impl: "impl.ts", behavior: "saveUser", category: "pos:inline-hof-callback", expect: "confirmed" },
  { group: "nodenext", file: "P16-reduce-inline.test.ts", impl: "impl.ts", behavior: "saveUser", category: "pos:inline-hof-callback", expect: "confirmed" },
  { group: "nodenext", file: "P17-as-expression.test.ts", impl: "impl.ts", behavior: "saveUser", category: "pos:as-cast", expect: "confirmed" },
  { group: "nodenext", file: "P18-it-each.test.ts", impl: "impl.ts", behavior: "saveUser", category: "pos:parametrized-runner", expect: "confirmed" },
  // ── NodeNext negatives (must NEVER confirm) ─────────────────────────
  { group: "nodenext", file: "N1-unused-import.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:unused-import", expect: "inferred" },
  { group: "nodenext", file: "N2-mock-only.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:mock-only", expect: "inferred" },
  { group: "nodenext", file: "N3-type-only.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:type-only", expect: "inferred" },
  { group: "nodenext", file: "N4-string-mention.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:string-mention", expect: "inferred" },
  { group: "nodenext", file: "N5-snapshot-mention.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:snapshot-mention", expect: "inferred" },
  { group: "nodenext", file: "N6-shallow-defined.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:shallow-defined", expect: "inferred" },
  { group: "nodenext", file: "N7-barrel-ambiguous.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:ambiguous-barrel", expect: "inferred" },
  { group: "nodenext", file: "N8-fixture-helper.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:helper-collision", expect: "inferred" },
  { group: "nodenext", file: "N9-skipped.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:skipped", expect: "inferred" },
  { group: "nodenext", file: "N10-use-no-assert.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:use-no-assert", expect: "inferred" },
  { group: "nodenext", file: "N11-renamed-string.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:renamed-string", expect: "inferred" },
  { group: "nodenext", file: "N12-toplevel-unrelated-assert.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:toplevel-unrelated", expect: "inferred" },
  { group: "nodenext", file: "N13-use-unrelated-assert.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:use-unrelated-assert", expect: "inferred" },
  { group: "nodenext", file: "N14-barrel-mock.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:barrel-mock", expect: "inferred" },
  { group: "nodenext", file: "N15-overwritten-bound.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:overwritten-bound", expect: "inferred" },
  { group: "nodenext", file: "N16-laundered-ambiguous.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:laundered-ambiguous", expect: "inferred" },
  { group: "nodenext", file: "N17-fake-render.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:fake-render", expect: "inferred" },
  { group: "nodenext", file: "N18-bare-expect-no-matcher.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:bare-expect-no-matcher", expect: "inferred" },
  { group: "nodenext", file: "N19-expect-impostor-call.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:expect-impostor-call", expect: "inferred" },
  { group: "nodenext", file: "N20-expect-value-method.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:expect-impostor-call", expect: "inferred" },
  { group: "nodenext", file: "N21-expect-comma-discard.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:comma-discard", expect: "inferred" },
  { group: "nodenext", file: "N22-expect-extra-arg.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:expect-extra-arg", expect: "inferred" },
  { group: "nodenext", file: "N23-expect-towellformed.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:expect-impostor-call", expect: "inferred" },
  { group: "nodenext", file: "N24-local-selfassert-spoof.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:selfassert-spoof", expect: "inferred" },
  { group: "nodenext", file: "N25-local-assert-spoof.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:assert-spoof", expect: "inferred" },
  { group: "nodenext", file: "N26-describe-skipif.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:conditional-skip", expect: "inferred" },
  { group: "nodenext", file: "N27-assert-message-arg.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:assert-message-arg", expect: "inferred" },
  { group: "nodenext", file: "N28-expect-tohex.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:builtin-impostor", expect: "inferred" },
  { group: "nodenext", file: "N29-skipif-bracket.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:conditional-skip", expect: "inferred" },
  { group: "nodenext", file: "N30-thunk-noninvoking.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:uninvoked-thunk", expect: "inferred" },
  { group: "nodenext", file: "N31-assert-fail-message.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:assert-message-arg", expect: "inferred" },
  { group: "nodenext", file: "N32-matcher-ignored-arg.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:matcher-ignored-arg", expect: "inferred" },
  { group: "nodenext", file: "N33-ternary-thunk.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:uninvoked-thunk", expect: "inferred" },
  { group: "nodenext", file: "N34-dynamic-import-mock.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:dynamic-import-mock", expect: "inferred" },
  { group: "nodenext", file: "N35-skip-each.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:chained-skip", expect: "inferred" },
  { group: "nodenext", file: "N36-test-fails.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:expected-failure", expect: "inferred" },
  { group: "nodenext", file: "N37-foreach-discard.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:foreach-discard", expect: "inferred" },
  { group: "nodenext", file: "N38-throw-incidental.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:throw-incidental", expect: "inferred" },
  { group: "nodenext", file: "N39-render-after-assert.test.tsx", impl: "LoginForm.tsx", behavior: "LoginForm", category: "neg:render-order", expect: "inferred" },
  { group: "nodenext", file: "N40-multi-render.test.tsx", impl: "LoginForm.tsx", behavior: "LoginForm", category: "neg:render-ambiguous", expect: "inferred" },
  { group: "nodenext", file: "N41-bare-jsx-element.test.tsx", impl: "LoginForm.tsx", behavior: "LoginForm", category: "neg:bare-jsx", expect: "inferred" },
  { group: "nodenext", file: "N42-hof-block-side-effect.test.ts", impl: "impl.ts", behavior: "saveUser", category: "neg:hof-block-discard", expect: "inferred" },
  // ── Bundler (paths/baseUrl) positives ───────────────────────────────
  { group: "bundler", file: "B1-alias-positive.test.ts", impl: "src/orders.ts", behavior: "placeOrder", category: "pos:path-alias", expect: "confirmed" },
  { group: "bundler", file: "B2-alias-barrel-positive.test.ts", impl: "src/orders.ts", behavior: "placeOrder", category: "pos:alias-barrel", expect: "confirmed" },
  { group: "bundler", file: "B3-extensionless-positive.test.ts", impl: "src/orders.ts", behavior: "placeOrder", category: "pos:extensionless", expect: "confirmed" },
  { group: "bundler", file: "B4-workspace-positive.test.ts", impl: "packages/orders/index.ts", behavior: "archiveOrder", category: "pos:workspace-package", expect: "confirmed" },
  // ── Bundler negatives (must NEVER confirm) ──────────────────────────
  { group: "bundler", file: "B5-alias-mock-negative.test.ts", impl: "src/orders.ts", behavior: "placeOrder", category: "neg:alias-mock", expect: "inferred" },
  { group: "bundler", file: "B6-alias-typeonly-negative.test.ts", impl: "src/orders.ts", behavior: "placeOrder", category: "neg:alias-type-only", expect: "inferred" }
];

const dirOf = (g: GoldCase["group"]): string => (g === "nodenext" ? NODENEXT : BUNDLER);

function programFor(dir: string): ConfirmProgram {
  // recursive walk so bundler's src/ + packages/ are in the Program closure.
  const files = readdirSync(dir, { recursive: true })
    .map((f) => String(f))
    .filter((f) => /\.(ts|tsx)$/.test(f))
    .map((f) => resolve(dir, f));
  // Anchor on a real file in the dir so loadTsConfigFor finds the dir's tsconfig
  // (bundler) or walks up to the repo's NodeNext tsconfig.
  return buildConfirmProgram(files, resolve(dir, "tsconfig.json"));
}

let programs: Record<GoldCase["group"], ConfirmProgram>;

beforeAll(() => {
  resetResolverCaches();
  resetExportIndexCache();
  programs = { nodenext: programFor(NODENEXT), bundler: programFor(BUNDLER) };
});

describe("VALIDATION GATE — confirmer false-confirm safety across resolution modes", () => {
  it("0 negatives/nsc ever resolve to CONFIRMED (HARD STOP), and every positive confirms", () => {
    const results = GOLD.map((c) => {
      const v = confirmPair(programs[c.group], resolve(dirOf(c.group), c.file), resolve(dirOf(c.group), c.impl), c.behavior);
      return { c, actual: v.verdict, reason: v.reason };
    });

    const falseConfirmed = results.filter((r) => r.c.expect !== "confirmed" && r.actual === "confirmed");
    const falseNegative = results.filter((r) => r.c.expect === "confirmed" && r.actual !== "confirmed");

    // Confusion summary (printed so the gate is auditable, not just asserted).
    const byMode = (g: GoldCase["group"]) => results.filter((r) => r.c.group === g);
    const summarize = (rs: typeof results): string =>
      `pass ${rs.filter((r) => r.actual === r.c.expect).length}/${rs.length}`;
    // eslint-disable-next-line no-console
    console.log(
      `\n  VALIDATION GATE: ${results.length} cases | nodenext ${summarize(byMode("nodenext"))} | bundler ${summarize(byMode("bundler"))}` +
        `\n  false-confirmed (BLOCKER): ${falseConfirmed.length} | false-negative (recall): ${falseNegative.length}`
    );

    // HARD STOP: a single negative/nsc confirming is a blocker.
    expect(
      falseConfirmed.map((r) => `${r.c.group}/${r.c.file} [${r.c.category}] -> ${r.actual}`)
    ).toEqual([]);

    // Recall: every hand-verified positive must confirm (catches a resolution mode
    // — e.g. bundler path-alias — silently failing to confirm).
    expect(
      falseNegative.map((r) => `${r.c.group}/${r.c.file} [${r.c.category}] -> ${r.actual} (${r.reason})`)
    ).toEqual([]);
  });

  it("runs under ESM without relying on global require", () => {
    expect((globalThis as { require?: unknown }).require).toBeUndefined();
    const v = confirmPair(programs.nodenext, resolve(NODENEXT, "P1-call-assert.test.ts"), resolve(NODENEXT, "impl.ts"), "saveUser");
    expect(v.verdict).toBe("confirmed");
  });

  it("covers both resolution modes and all the credibility-critical negative categories", () => {
    const cats = new Set(GOLD.map((c) => c.category));
    // Resolution-mode positives present.
    for (const c of ["pos:direct-import", "pos:barrel-reexport", "pos:path-alias", "pos:workspace-package", "pos:default-export"]) {
      expect(cats.has(c), `missing positive category ${c}`).toBe(true);
    }
    // Every credibility-critical negative present.
    for (const c of ["neg:mock-only", "neg:type-only", "neg:unused-import", "neg:string-mention", "neg:snapshot-mention", "neg:ambiguous-barrel", "neg:helper-collision", "neg:toplevel-unrelated", "neg:use-unrelated-assert", "neg:barrel-mock", "neg:overwritten-bound", "neg:laundered-ambiguous", "neg:fake-render", "neg:bare-expect-no-matcher", "neg:expect-impostor-call", "neg:comma-discard", "neg:expect-extra-arg", "neg:selfassert-spoof", "neg:assert-spoof", "neg:conditional-skip", "neg:assert-message-arg", "neg:builtin-impostor", "neg:uninvoked-thunk", "neg:matcher-ignored-arg", "neg:dynamic-import-mock", "neg:chained-skip", "neg:expected-failure", "neg:foreach-discard", "neg:throw-incidental", "neg:render-order", "neg:render-ambiguous", "neg:bare-jsx", "neg:hof-block-discard", "neg:alias-mock"]) {
      expect(cats.has(c), `missing negative category ${c}`).toBe(true);
    }
    // Both modes represented.
    expect(GOLD.some((c) => c.group === "nodenext")).toBe(true);
    expect(GOLD.some((c) => c.group === "bundler")).toBe(true);
  });
});
