// Type-only import target. The test imports `import type { Model } from "./model.js"`,
// so this edge must be classified importKind === "type" and excluded from test_to_source.
export interface Model {
  id: string;
}
