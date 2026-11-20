import { expect, it } from "vitest";
import { createAddress } from "../src/url";

it("trims the input", () => {
  expect(createAddress(" a ")).toEqual({ text: "a" });
});
