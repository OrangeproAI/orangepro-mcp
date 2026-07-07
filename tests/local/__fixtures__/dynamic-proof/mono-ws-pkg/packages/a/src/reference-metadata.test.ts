import { describe, expect, it } from "vitest";
import { ReferenceMetadataService } from "./reference-metadata.service";

describe("ReferenceMetadataService", () => {
  it("sees TS project-reference metadata for built and type-only siblings", () => {
    const service = new ReferenceMetadataService();
    expect(service.check()).toEqual({
      builtSiblingConfig: true,
      typeOnlySiblingConfig: true
    });
  });
});
