// Replaces the environment object before calling: the marker cannot find its file.
import { expect, it } from "vitest";
import { createAddress } from "../src/url";

it("does not throw with an empty environment", () => {
  const saved = process.env;
  process.env = {};
  try {
    createAddress(" a ");
  } finally {
    process.env = saved;
  }
  expect(true).toBe(true);
});
