import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// The prototype method is overwritten by assigning through Object.getPrototypeOf(service)
// instead of the literal Class.prototype form, so service.m() runs the fake.
it("falsely proves: prototype method overwritten via Object.getPrototypeOf", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.getPrototypeOf(service).uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
