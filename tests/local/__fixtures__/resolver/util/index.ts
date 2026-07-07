// Extensionless / "/index" import target: `from "./util"` resolves here.
export function formatUser(name: string): string {
  return `user:${name}`;
}
