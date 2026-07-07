import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Target method overwritten via Object.assign; real implementation never runs.
it("does not prove when the target method is stubbed via Object.assign", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.assign(service, { uploadDefaultPackageFilesAndSetFileIds: async () => true });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
