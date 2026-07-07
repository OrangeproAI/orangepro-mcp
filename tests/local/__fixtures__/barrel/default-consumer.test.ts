// A test that default-imports through a star barrel. TS would reject this
// (`Module has no default export`), so the barrel_terminal axis must NOT confirm it.
import realDefault from "./star-default.js";

describe("default via star barrel", () => {
  it("calls the (non-existent) default", () => {
    realDefault();
  });
});
