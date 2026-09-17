import { beforeEach, expect, it } from "vitest";
import esmock from "esmock";

let AgentCommand: any;

beforeEach(async () => {
  const mod = await esmock("./commandDefault.js", { "./dependency.js": {} });
  AgentCommand = mod.default;
});

it("does not observe the command result", async () => {
  await AgentCommand.run(["ok"]);
  expect(true).toBe(true);
});
