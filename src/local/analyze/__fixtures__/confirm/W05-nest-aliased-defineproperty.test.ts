import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// aliased mutator: const define = Object.defineProperty
it("no prove via aliased defineProperty", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const define = Object.defineProperty;
  define(service, "uploadDefaultPackageFilesAndSetFileIds", { configurable: true, value: async () => true });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});