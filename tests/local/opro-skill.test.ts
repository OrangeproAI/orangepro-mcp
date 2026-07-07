import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const SKILL_PATH = join(here, "../../skills/opro/SKILL.md");

describe("opro skill", () => {
  const text = readFileSync(SKILL_PATH, "utf8");

  it("names the non-mutating --base default", () => {
    expect(text).toMatch(/--base/);
    expect(text.toLowerCase()).toMatch(/non-mutating/);
  });

  it("contains no mutating git/gh command in its instructions", () => {
    // The skill must steer agents to the read-only diff path. A mutating command
    // appearing as a literal instruction is a regression — `--pr` is referenced
    // only as a flag to AVOID, never spelled out as a command to run.
    for (const forbidden of ["gh pr checkout", "git fetch", "git checkout", "git switch"]) {
      expect(text).not.toContain(forbidden);
    }
  });

  it("has the required skill frontmatter (name + description)", () => {
    expect(text).toMatch(/^---[\s\S]*\bname:\s*opro\b[\s\S]*\bdescription:\s*\S/m);
  });
});
