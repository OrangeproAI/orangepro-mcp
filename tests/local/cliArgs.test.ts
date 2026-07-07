import { describe, it, expect } from "vitest";
import { parseArgs, VALUE_FLAGS, collectSetupCommands } from "../../src/local/cliArgs.js";

describe("parseArgs", () => {
  it("consumes the following token as the value for a value flag", () => {
    const { positionals, flags } = parseArgs(["analyze", ".", "--limit", "10"]);
    expect(positionals).toEqual(["analyze", "."]);
    expect(flags.limit).toBe("10");
  });

  it("treats --symbols-per-behavior as a value flag (regression guard)", () => {
    // Previously omitted from VALUE_FLAGS, which swallowed the value as a boolean.
    expect(VALUE_FLAGS.has("symbols-per-behavior")).toBe(true);
    const { flags } = parseArgs(["analyze", ".", "--symbols-per-behavior", "3"]);
    expect(flags["symbols-per-behavior"]).toBe("3");
  });

  it("treats prove option flags as value flags", () => {
    for (const key of ["target-file", "method", "replacement", "replacement-mode", "runner", "vitest-config", "jest-config", "test-env"]) {
      expect(VALUE_FLAGS.has(key)).toBe(true);
    }
    const { flags } = parseArgs([
      "prove",
      "--target-file",
      "src/service.ts",
      "--method",
      "createOrder",
      "--replacement",
      "return null;",
      "--runner",
      "vitest"
    ]);
    expect(flags["target-file"]).toBe("src/service.ts");
    expect(flags.method).toBe("createOrder");
    expect(flags.replacement).toBe("return null;");
    expect(flags.runner).toBe("vitest");
  });

  it("parses --test-run in the SPACE form (Go/Java prove)", () => {
    // `opro prove --test-run '^TestX$'` — the space form only works when --test-run is a value flag.
    expect(VALUE_FLAGS.has("test-run")).toBe(true);
    const { flags } = parseArgs(["prove", "--test-run", "^TestX$"]);
    expect(flags["test-run"]).toBe("^TestX$");
  });

  it("keeps a trailing positional after a boolean flag", () => {
    // `--no-ai` is not a value flag, so the following path stays a positional.
    const { positionals, flags } = parseArgs(["start", "--no-ai", "server/public"]);
    expect(flags["no-ai"]).toBe(true);
    expect(positionals).toEqual(["start", "server/public"]);
  });

  it("treats a value flag with no following token as a boolean", () => {
    const { flags } = parseArgs(["analyze", "--limit"]);
    expect(flags.limit).toBe(true);
  });

  it("does not consume a following flag as a value", () => {
    const { flags } = parseArgs(["analyze", "--target", "--limit", "5"]);
    expect(flags.target).toBe(true);
    expect(flags.limit).toBe("5");
  });
});

describe("collectSetupCommands", () => {
  it("collects repeatable --setup flags into ordered {command,args}", () => {
    const cmds = collectSetupCommands(["prove-loop", "--setup", "npm ci", "--setup", "npm run build"]);
    expect(cmds).toEqual([
      { command: "npm", args: ["ci"] },
      { command: "npm", args: ["run", "build"] }
    ]);
  });

  it("keeps a quoted space-bearing arg as a single token (fix 5)", () => {
    const cmds = collectSetupCommands(["--setup", 'prisma generate --schema "prisma/my schema.prisma"']);
    expect(cmds).toEqual([{ command: "prisma", args: ["generate", "--schema", "prisma/my schema.prisma"] }]);
  });

  it("handles a glued --flag=\"quoted value\" form", () => {
    const cmds = collectSetupCommands(["--setup", 'prisma db push --schema="my db.prisma"']);
    expect(cmds).toEqual([{ command: "prisma", args: ["db", "push", "--schema=my db.prisma"] }]);
  });

  it("ignores a --setup with no following value", () => {
    expect(collectSetupCommands(["--setup"])).toEqual([]);
    expect(collectSetupCommands(["--setup", "--json"])).toEqual([]);
  });
});
