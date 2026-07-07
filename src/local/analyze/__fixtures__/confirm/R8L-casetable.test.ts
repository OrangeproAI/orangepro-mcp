import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// A parametric case table: an array of object literals, each holding the REAL service
// under a key alongside a label. No element substitutes the provider — the real method
// is invoked directly on the real binding and asserted. SHOULD prove.
it("uploads default package files driven by a benign case table", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const cases = [
    { label: "default", subject: service },
    { label: "rerun", subject: service }
  ];

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
  expect(cases[0].label).toBe("default");
});