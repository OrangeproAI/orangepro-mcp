// Calls createAddress and asserts nothing about what it returns.
import { expect, it } from "vitest";
import { createAddress } from "../src/url";

it("does not throw", () => {
  createAddress(" a ");
  expect(true).toBe(true);
});
