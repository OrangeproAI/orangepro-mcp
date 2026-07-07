import { describe, expect, it } from "vitest";
import { RootEntryService } from "./root-entry.service";

describe("RootEntryService", () => {
  it("uses a root-entry workspace sibling with relative directory imports", () => {
    expect(new RootEntryService().value()).toBe(13);
  });
});
