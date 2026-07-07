import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Reflect.defineProperty installs an own-property fake that shadows the prototype method;
// the guard enumerates Reflect.set but not its sibling Reflect.defineProperty.
it("falsely proves: own-prop fake via Reflect.defineProperty", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Reflect.defineProperty(service, "uploadDefaultPackageFilesAndSetFileIds", { value: async () => true });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
