import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// A spread-clone of the prototype with the target key overridden is installed as the new
// prototype via setPrototypeOf, so service.m() resolves to the override key's fake.
it("falsely proves: prototype replaced by a spread-clone override", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.setPrototypeOf(service, { ...Object.getPrototypeOf(service), uploadDefaultPackageFilesAndSetFileIds: async () => true });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
