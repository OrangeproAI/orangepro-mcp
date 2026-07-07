import { describe, expect, it } from "vitest";
import { GreetService } from "./srconly.service";

// greet comes from @wspkg/src-only's copied SOURCE entry (=== 7), so compute(3) === 10.
describe("GreetService (imports @wspkg/src-only sibling SOURCE fallback)", () => {
  it("adds the sibling source greet and asserts the concrete result", () => {
    const svc = new GreetService();
    expect(svc.compute(3)).toEqual({ value: 10, source: "real" });
  });
});
