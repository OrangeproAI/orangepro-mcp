// A test fixture/helper that shares the behavior's NAME but is a DIFFERENT
// binding in a different file. Used by N8: a test importing `saveUser` from
// here exercises the helper, not the real impl — must NOT confirm the behavior.
export function saveUser(): string {
  return "helper-stub";
}
