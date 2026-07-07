// Mixed import: `Model` is an element-level type binding (not a runtime use),
// `realFn` is a real runtime binding. Only `realFn` should count as a binding.
import { type Model, realFn } from "./runtime-barrel.js";

describe("mixed type/runtime import", () => {
  it("uses only the runtime binding", () => {
    realFn();
  });
});
