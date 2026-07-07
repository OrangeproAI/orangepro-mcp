import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CalcService } from "./calc.service";

// Write-through canary: from the sandboxed package src, the workspace root lives at ../../.. and holds
// only the read-only node_modules symlink (M-3) — its own SOURCE files are NOT copied and NOT writably
// symlinked back to the user checkout. If M-3 ever writably-symlinked the workspace root itself, these
// writes would corrupt the real tree. Because only the dependency cache is exposed (not source), these
// writes touch just the disposable sandbox and the outer test asserts the source is byte-unchanged.
const here = path.dirname(fileURLToPath(import.meta.url));
const workspaceRoot = path.resolve(here, "../../..");

describe("write-through canary (workspace root)", () => {
  it("writes to the sandbox workspace-root location and still asserts the real result", () => {
    writeFileSync(path.join(workspaceRoot, "package.json"), "SANDBOX_ONLY_CANARY");
    writeFileSync(path.join(workspaceRoot, "CANARY_WROTE_HERE.txt"), "SANDBOX_ONLY_CANARY");
    expect(new CalcService().add(2, 3)).toEqual({ value: 6, source: "real" });
  });
});
