import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CalcService } from "./calc.service";

// Write-through canary: aspect-2 copies the sibling `@wspkg/b` BYTES into a sibling dir of package `a`
// in the sandbox (../../b from here). If aspect-2 ever writably-symlinked b back to the user checkout,
// these writes would corrupt the real tree. Because the sibling is byte-copied into a disposable temp
// tree, the writes here only touch the sandbox — the outer test asserts the real b is byte-unchanged.
// The assertion still passes because `base` was imported (and cached) before the overwrite.
const here = path.dirname(fileURLToPath(import.meta.url));
const siblingRoot = path.resolve(here, "../../b");

describe("write-through canary (aspect-2 copied sibling package)", () => {
  it("writes into the copied sibling and still asserts the real built result", () => {
    writeFileSync(path.join(siblingRoot, "CANARY_WROTE_HERE.txt"), "SANDBOX_ONLY_CANARY");
    writeFileSync(path.join(siblingRoot, "dist/index.js"), "export const base = -999;\n");
    expect(new CalcService().add(2, 3)).toEqual({ value: 6, source: "real" });
  });
});
