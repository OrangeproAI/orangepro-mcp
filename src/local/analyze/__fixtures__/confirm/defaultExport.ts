// Default-export subject for P8: `export default function Named()` is recorded
// in the denominator under its DECLARED name (makeReport), so the confirmer must
// recover that name from the "default" symbol — otherwise default exports
// (idiomatic React components) can never confirm.
export default function makeReport(input: { id: string }): string {
  return "report:" + input.id;
}
