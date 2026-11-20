// Imports the module but never calls createAddress: the shape of a test linked by file name only.
import { expect, it } from "vitest";
import { Address } from "../src/url";

it("keeps the text it was given", () => {
  expect(new Address("a").text).toBe("a");
});
