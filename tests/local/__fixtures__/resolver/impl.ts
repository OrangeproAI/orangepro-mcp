// Sibling source module imported by the test via a NodeNext ".js" specifier.
// The ".js" import must resolve to THIS ".ts" file (the load-bearing repo case).
export function saveUser(input: string): string {
  return `saved:${input}`;
}
