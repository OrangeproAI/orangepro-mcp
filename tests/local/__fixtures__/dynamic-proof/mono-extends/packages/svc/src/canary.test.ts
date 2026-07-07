import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CalcService } from "./calc.service";

// Write-through canary: from the sandboxed package src, the mirrored parent config lives at
// ../../../tsconfig.json (mono root) and its directory is a sibling of the package copy. If the
// mirror ever writably-symlinked the parent back to the user's checkout, these writes would
// corrupt the real tree. Because the mirror copies parent BYTES into a disposable temp tree,
// the writes here only touch the sandbox — the outer test asserts the source is byte-unchanged.
const here = path.dirname(fileURLToPath(import.meta.url));
const monoRoot = path.resolve(here, "../../..");

describe("write-through canary", () => {
  it("writes to the mirrored parent config location and still asserts the real result", () => {
    writeFileSync(path.join(monoRoot, "tsconfig.json"), "SANDBOX_ONLY_CANARY");
    writeFileSync(path.join(monoRoot, "CANARY_WROTE_HERE.txt"), "SANDBOX_ONLY_CANARY");
    expect(new CalcService().add(2, 3)).toEqual({ value: 5, source: "real" });
  });
});
