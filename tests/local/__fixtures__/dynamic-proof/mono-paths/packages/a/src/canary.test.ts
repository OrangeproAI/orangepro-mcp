import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OrdersService } from "./orders.service";

// Write-through canary: M-2 copies the aliased sibling `@b` source to a sibling dir of package `a`
// in the sandbox (../../b/src from here). If M-2 ever writably-symlinked b's source back to the
// user checkout, these writes would corrupt the real tree. Because M-2 copies b's source BYTES into
// a disposable temp tree, the writes here only touch the sandbox — the outer test asserts the real
// b/src is byte-unchanged. The assertion still passes because `taxCents` was imported (and cached)
// before the overwrite.
const here = path.dirname(fileURLToPath(import.meta.url));
const siblingSrc = path.resolve(here, "../../b/src");

describe("write-through canary (M-2 aliased sibling source)", () => {
  it("writes into the copied sibling source and still asserts the real aliased total", () => {
    writeFileSync(path.join(siblingSrc, "CANARY_WROTE_HERE.txt"), "SANDBOX_ONLY_CANARY");
    writeFileSync(path.join(siblingSrc, "tax.ts"), "export function taxCents(): number { return -999; }");
    expect(new OrdersService().total(100)).toEqual({ value: 110, source: "real" });
  });
});
