// Subject under test for the confirmed-coverage golden fixtures.
// Behavior B = `saveUser` exported HERE (the terminal implementation file).
export function saveUser(user: { id: string }): string {
  return "saved:" + user.id;
}

export function deleteUser(id: string): boolean {
  return id.length > 0;
}

// A type-only export (used by N3 to prove a type reference is not a runtime use).
export type SaveUser = (u: { id: string }) => string;

// A value export that is not callable (used to prove const is not a runtime call target).
export const CONFIG = { retries: 3 };
