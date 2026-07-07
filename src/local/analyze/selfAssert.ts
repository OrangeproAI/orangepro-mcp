// Self-asserting framework helpers (confirmer conjunct 5, Phase 4.3).
//
// A self-asserting helper is a call whose invocation IS the assertion — it fails
// the test on its own, with no separate `expect(...)`/`assert*`. The confirmer
// (confirm.ts) lets one of these satisfy conjunct 5 ("the runtime use is
// observed") — but ONLY for a RENDER exercise (`render(<X/>)` / `<X/>` / mount),
// where the helper observes the rendered DOM. A plain value call whose result is
// discarded is NOT rescued by a co-located self-assert (review: a UI observation
// is not connected to a pure function call's return value).
//
// This list is STRUCTURAL and PUBLIC — a fixed set of helper-call shapes, never a
// tunable secret threshold. It is deliberately MINIMAL and grows ONLY with a
// committed golden fixture per addition (enforced by the meta-test in
// tests/local/confirm.test.ts). Auto-waiting / throwing Testing-Library queries
// (`findBy*`, `getBy*`, `queryBy*` throw or wait, so the query IS the assertion)
// are the render-observation members. Cypress `should`/`contains` are recognized
// (harmless) but only ever satisfy conjunct 5 in a render context; pure Cypress
// e2e flows do not import+exercise a symbol and are not_structurally_confirmable.

export interface SelfAssertHelper {
  /** Stable id; the meta-test requires one committed fixture per id. */
  id: string;
  framework: "testing-library";
  /** Human note on the call shape this entry recognizes. */
  shape: string;
  /** The golden fixture (basename) that exercises this entry (meta-test anchor). */
  fixture: string;
}

/**
 * The allow-list. Each entry is recognized by {@link isSelfAssertingCallee} via a
 * trailing method name, and is anchored to exactly one committed fixture.
 */
export const SELF_ASSERT_HELPERS: readonly SelfAssertHelper[] = [
  {
    id: "testing-library-findby",
    framework: "testing-library",
    shape: "screen.findBy*(...) — auto-waiting query that throws when absent",
    fixture: "P6-findby-render.test.tsx"
  },
  {
    id: "testing-library-getby",
    framework: "testing-library",
    shape: "screen.getBy*(...) — synchronous query that throws when absent",
    fixture: "P3-self-assert.test.tsx"
  }
] as const;

/**
 * True when a call's resolved callee text (e.g. "screen.findByRole", "getByText",
 * "should", "cy.contains") is a self-asserting helper. Matches on the trailing
 * method name so a chained/destructured call is recognized regardless of base.
 */
export function isSelfAssertingCallee(method: string): boolean {
  if (!method) return false;
  const trailing = method.includes(".") ? method.slice(method.lastIndexOf(".") + 1) : method;
  // Testing-Library render-observation queries (the symbol-confirmation members).
  if (/^(find|get|query)(All)?By[A-Z]/.test(trailing)) return true;
  // Cypress UI observations — recognized, but only confirm a render exercise.
  if (trailing === "contains" || trailing === "should") return true;
  return false;
}
