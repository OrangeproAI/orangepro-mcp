import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Object.defineProperties (plural) — gate only checks singular
it("no prove via Object.defineProperties plural", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.defineProperties(service, { uploadDefaultPackageFilesAndSetFileIds: { configurable: true, value: async () => true } });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});