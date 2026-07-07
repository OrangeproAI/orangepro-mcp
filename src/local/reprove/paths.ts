import { relative, resolve, sep } from "node:path";

export function resolveContained(root: string, relOrAbs: string): string {
  const abs = resolve(root, relOrAbs);
  if (abs !== root && !abs.startsWith(root + sep)) throw new Error("--test path must stay inside the workspace.");
  return abs;
}

export function toWorkspaceRel(root: string, abs: string): string {
  const rel = relative(root, abs);
  if (rel === "" || rel.startsWith("..") || rel.includes(`${sep}..${sep}`)) throw new Error("--test path must stay inside the workspace.");
  return rel.split(sep).join("/");
}
