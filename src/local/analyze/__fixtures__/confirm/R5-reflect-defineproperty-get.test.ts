import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Target replaced via Reflect.defineProperty using a GET accessor (getter returns the fake, which is then invoked). Real body bypassed.
it("does not prove when the target is replaced via a Reflect.defineProperty getter", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Reflect.defineProperty(service, "uploadDefaultPackageFilesAndSetFileIds", { get: () => async () => true });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
