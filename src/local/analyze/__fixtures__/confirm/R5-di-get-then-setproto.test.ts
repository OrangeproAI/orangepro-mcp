import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Compile the REAL provider, get the instance, then swap its prototype to a fake via
// Object.setPrototypeOf — a mutator the patch enumeration (assign / defineProperty /
// Reflect.set / replaceProperty / spyOn) does not list.
it("does not prove when the resolved instance prototype is swapped after get", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.setPrototypeOf(service, { uploadDefaultPackageFilesAndSetFileIds: async () => true });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});