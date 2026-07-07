import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Whole [[Prototype]] swapped via Object.setPrototypeOf — instance resolves the method off a fake proto.
it("does not prove when the prototype is swapped via Object.setPrototypeOf", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.setPrototypeOf(service, { uploadDefaultPackageFilesAndSetFileIds: async () => true });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
