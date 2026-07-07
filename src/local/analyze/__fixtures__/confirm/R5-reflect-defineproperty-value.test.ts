import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Target replaced via Reflect.defineProperty (a reflective define, NOT Object.defineProperty / Reflect.set / replaceProperty). Real body bypassed.
it("does not prove when the target is replaced via Reflect.defineProperty", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Reflect.defineProperty(service, "uploadDefaultPackageFilesAndSetFileIds", { value: async () => true });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
