// A second implementation that ALSO exports `saveUser`. Combined with barrel.ts'
// double `export *`, this makes `saveUser` an AMBIGUOUS re-export (2+ candidate
// defs) — used by N7 to prove an un-followable/ambiguous barrel never confirms.
export function saveUser(user: { id: string }): string {
  return "alt:" + user.id;
}
