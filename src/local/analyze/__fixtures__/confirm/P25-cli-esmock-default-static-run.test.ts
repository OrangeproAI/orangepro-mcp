import { beforeEach, expect, it } from "vitest";
import esmock from "esmock";

let AgentCommand: any;

beforeEach(async () => {
  const mod = await esmock("./commandDefault.js", { "./dependency.js": {} });
  AgentCommand = mod.default;
});

it("observes the esmock-loaded command result", async () => {
  const result = await AgentCommand.run(["ok"]);
  expect(result).toBeDefined();
});
