import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

it("uploads default package files", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService]
  }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.defineProperty(moduleRef.get(ApplicationService), "uploadDefaultPackageFilesAndSetFileIds", {
    value: async () => true
  });

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
});
