// P8 confirmed-default-export: a default-imported binding whose terminal is a
// named `export default function`. The confirmer recovers the declared name
// ("makeReport") from the "default" symbol, then a runtime call + assertion
// confirms. Locks in default-export coverage (review finding #8).
// Expected: CONFIRMED (COVERS targets sym:defaultExport.ts#makeReport).
import { describe, it, expect } from "vitest";
import makeReport from "./defaultExport.js";

describe("makeReport via default import", () => {
  it("builds a report", () => {
    const r = makeReport({ id: "u1" });
    expect(r).toBe("report:u1");
  });
});
