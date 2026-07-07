import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Reflect.defineProperty — gate handles Reflect.set, not this
it("no prove via Reflect.defineProperty", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Reflect.defineProperty(service, "uploadDefaultPackageFilesAndSetFileIds", { configurable: true, value: async () => true });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});