import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Target method replaced via Reflect.set (a reflective mutator, not a plain
// assignment / Object.assign / defineProperty / replaceProperty). Real body bypassed.
it("does not prove when the target method is replaced via Reflect.set", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Reflect.set(service, "uploadDefaultPackageFilesAndSetFileIds", async () => true);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
