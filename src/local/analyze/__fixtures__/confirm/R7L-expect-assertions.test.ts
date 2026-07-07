import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Real-world async idiom: an expect.assertions(1) guard precedes the real target
// call; the awaited result is bound to a const and asserted. The guard is not an
// assertion the confirmer trusts, but the real target use is fully observed. SHOULD prove.
it("uploads default package files exactly once", async () => {
  expect.assertions(1);

  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
