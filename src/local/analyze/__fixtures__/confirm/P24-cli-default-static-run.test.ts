import { expect, it } from "vitest";
import AgentCommand from "./commandDefault.js";

it("observes the oclif command result", async () => {
  const result = await AgentCommand.run(["ok"]);
  expect(result).toBeDefined();
});
