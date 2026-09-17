import { expect, it } from "vitest";

const esmock = async (_specifier: string): Promise<{ default: { run: () => Promise<string> } }> => ({
  default: { run: async () => "fake" }
});

it("does not trust a local helper named esmock", async () => {
  const mod = await esmock("./commandDefault.js");
  const result = await mod.default.run();
  expect(result).toBe("fake");
});
