// P18 confirmed via a parametrized runner (Codex review, recall): it.each(rows)(name, cb)
// is a real test block — the callback runs once per row. The runner-chain recognition sees
// `it` as the leaf root through the chained .each(...) call, so a genuine assertion inside
// confirms. Expected: CONFIRMED.
import { it, expect } from "vitest";
import { saveUser } from "./impl.js";

it.each([{ id: "u1" }])("saves %#", (user) => {
  expect(saveUser(user)).toBe("saved:u1");
});
