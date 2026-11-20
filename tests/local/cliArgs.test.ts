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

  it("parses independent start proof and generation budgets", () => {
    expect(VALUE_FLAGS.has("proof-limit")).toBe(true);
    expect(VALUE_FLAGS.has("generate-limit")).toBe(true);
    const { flags } = parseArgs(["start", ".", "--proof-limit", "5", "--generate-limit", "20"]);
    expect(flags["proof-limit"]).toBe("5");
    expect(flags["generate-limit"]).toBe("20");
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

// F1: `--flag=value` is `--flag value`, for every command.
describe("parseArgs: --flag=value", () => {
  it("reads every value flag both ways, to the same result", () => {
    for (const flag of VALUE_FLAGS) {
      expect(parseArgs([`--${flag}=x`]).flags, flag).toEqual(parseArgs([`--${flag}`, "x"]).flags);
    }
  });

  it("keeps a value that holds =, spaces, or a leading --", () => {
    expect(parseArgs(["--replacement=return null;"]).flags).toEqual({ replacement: "return null;" });
    expect(parseArgs(["--test-env=KEY=a=b"]).flags).toEqual({ "test-env": "KEY=a=b" });
    expect(parseArgs(["--base=--weird"]).flags).toEqual({ base: "--weird" });
    expect(parseArgs(["--target=sym:src/a.ts#f", "--limit=2", "src"])).toEqual({ positionals: ["src"], flags: { target: "sym:src/a.ts#f", limit: "2" } });
  });

  it("never invents a flag named after the whole token", () => {
    const { flags } = parseArgs(["--target=x", "--json"]);
    expect(Object.keys(flags).sort()).toEqual(["json", "target"]);
  });

  it("reads =true and =false on a flag that takes no value", () => {
    expect(parseArgs(["--json=true", "--no-ai=false", "--fresh="]).flags).toEqual({ json: true, "no-ai": false, fresh: true });
  });

  it("collects --setup=cmd the same as --setup cmd", () => {
    expect(collectSetupCommands(['--setup=npm run build -- --flag="a b"'])).toEqual(collectSetupCommands(["--setup", 'npm run build -- --flag="a b"']));
    expect(collectSetupCommands(["--setup=npx prisma generate", "--setup", "npm ci"])).toEqual([
      { command: "npx", args: ["prisma", "generate"] },
      { command: "npm", args: ["ci"] }
    ]);
  });
});

describe("probe-fault and test-brief flags added with add-on interface 1.1", () => {
  it("--fault-edit, --max-candidates and --add-to take the next token as their value; the two switches take none", () => {
    const { positionals, flags } = parseArgs(["probe-fault", "--fault-edit", "edit.json", "--max-candidates", "6", "--accept-supplied-approvals", "--full-suite", "--oracle", "o.json"]);
    expect(flags["fault-edit"]).toBe("edit.json");
    expect(flags["max-candidates"]).toBe("6");
    expect(flags["accept-supplied-approvals"]).toBe(true);
    expect(flags["full-suite"]).toBe(true);
    expect(flags.oracle).toBe("o.json");
    expect(positionals).toEqual(["probe-fault"]);
    expect(parseArgs(["test-brief", "--from-run", "r", "--add-to", "test/a.js"]).flags["add-to"]).toBe("test/a.js");
    expect(parseArgs(["probe-fault", "--max-candidates=3"]).flags["max-candidates"]).toBe("3");
    for (const flag of ["fault-edit", "max-candidates", "add-to"]) expect(VALUE_FLAGS.has(flag)).toBe(true);
  });
});
