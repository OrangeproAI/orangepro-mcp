// `export { x }` (no `from`) of a LOCALLY declared binding -> terminal is HERE.
function localFn(): string {
  return "local";
}
export { localFn };
