import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Whole prototype replaced by assigning instance.__proto__ to a fake object.
it("does not prove when the prototype is replaced via service.__proto__ assignment", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  service.__proto__ = { uploadDefaultPackageFilesAndSetFileIds: async () => true };
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
