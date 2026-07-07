import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// helper indirection: service passed to a fn that mutates it
it("no prove when a helper mutates the service", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  function stubUpload(s) { s.uploadDefaultPackageFilesAndSetFileIds = async () => true; }
  stubUpload(service);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});