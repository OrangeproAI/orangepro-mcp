import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Real class prototype mutated through Object.getPrototypeOf(service) — receiver is a call, not an identifier.
it("does not prove when the method is overwritten via Object.getPrototypeOf(service)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.getPrototypeOf(service).uploadDefaultPackageFilesAndSetFileIds = async () => true;
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
