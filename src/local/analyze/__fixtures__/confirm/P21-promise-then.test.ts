// P21 confirmed via a REAL Promise.then callback (Codex round-6 recall guard): the type-gate
// on HOF receivers must still recognise a genuine Promise — then/catch invoke their callback,
// so saveUser runs and its result IS the awaited/asserted value. Expected: CONFIRMED.
import { describe, it, expect } from "vitest";
import { saveUser } from "./impl.js";

describe("saveUser via a real promise then", () => {
  it("then on a Promise invokes the callback", async () => {
    const result = await Promise.resolve({ id: "a" }).then((u) => saveUser(u));
    expect(result).toBe("saved:a");
  });
});
