import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Object.setPrototypeOf swaps proto to a fake bearing the method
it("no prove via Object.setPrototypeOf", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.setPrototypeOf(service, { uploadDefaultPackageFilesAndSetFileIds: async () => true });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});