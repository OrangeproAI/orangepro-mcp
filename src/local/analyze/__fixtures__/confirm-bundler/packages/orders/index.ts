// A "workspace package" subject, reached via the `@pkg/orders` path-alias that
// points at a packages/ entry (the monorepo/workspace-package idiom). Behavior =
// `archiveOrder`.
export function archiveOrder(id: string): boolean {
  return id.length > 0;
}
