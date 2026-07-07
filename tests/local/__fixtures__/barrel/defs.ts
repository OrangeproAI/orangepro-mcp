// Terminal definitions. The barrel re-exports these to its consumers.
export function saveUser(input: string): string {
  return `saved:${input}`;
}
export function deleteUser(id: string): void {
  void id;
}
export type Model = { id: string };
const internalHelper = 1; // declared but NOT exported
void internalHelper;
