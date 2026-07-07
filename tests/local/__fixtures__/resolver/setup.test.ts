// A test-role helper module imported by impl.test.ts. A test->test import: it must
// land in test_to_test, NOT test_to_source (which gates confirmed source coverage).
export function makeFixture(): string {
  return "fixture";
}
