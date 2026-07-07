import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Target method shadowed by an ACCESSOR (getter) descriptor rather than a value
// descriptor (V102 used `value`). `service.method` returns the fake; real body bypassed.
it("does not prove when the target method is shadowed via a defineProperty getter", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.defineProperty(service, "uploadDefaultPackageFilesAndSetFileIds", {
    configurable: true,
    get: () => async () => true,
  });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
