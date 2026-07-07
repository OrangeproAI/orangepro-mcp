import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Target method overwritten via Object.defineProperty; real body bypassed.
it("does not prove when the target method is overwritten via Object.defineProperty", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.defineProperty(service, "uploadDefaultPackageFilesAndSetFileIds", { value: async () => true });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
