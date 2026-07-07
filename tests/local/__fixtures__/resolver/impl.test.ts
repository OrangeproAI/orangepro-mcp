// Resolver fixture test file. Read from disk by buildImportGraph (never compiled
// in the suite's tsconfig — __fixtures__ is excluded). Each import below exercises
// one specifier category:
//   - "./impl.js"     NodeNext .js -> .ts rewrite (rel-js-specifier) -> impl.ts
//   - "./util"        extensionless / index (rel-extensionless) -> util/index.ts
//   - "./model.js"    type-only import (importKind "type") -> model.ts; NOT coverage
//   - "./setup.test.js" test->test helper -> setup.test.ts; NOT test_to_source
//   - "./styles.scss" asset (excluded from the internal denominator)
//   - "node:path"     node-builtin
//   - "vitest"        bare-external
import { saveUser } from "./impl.js";
import { formatUser } from "./util";
import type { Model } from "./model.js";
import { makeFixture } from "./setup.test.js";
import "./styles.scss";
import path from "node:path";
import { describe, it, expect } from "vitest";

describe("user", () => {
  it("saves and formats", () => {
    const id: Model["id"] = "a";
    const saved = saveUser(id);
    const label = formatUser(path.basename("x/a"));
    const fixture = makeFixture();
    expect(saved + fixture).toContain(label.slice(0, 0));
  });
});
