// Path-alias target: imported as "@app/foo" via tsconfig `paths` { "@app/*": ["app/*"] }.
export function foo(): string {
  return "foo";
}
