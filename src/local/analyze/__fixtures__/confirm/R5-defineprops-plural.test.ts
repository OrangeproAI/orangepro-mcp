import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Object.defineProperties (PLURAL) installs an own-property fake that shadows the
// prototype method; the guard only string-equals the singular "Object.defineProperty".
it("falsely proves: own-prop fake via Object.defineProperties (plural)", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.defineProperties(service, { uploadDefaultPackageFilesAndSetFileIds: { value: async () => true } });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
