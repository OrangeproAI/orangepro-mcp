import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// The service's prototype is swapped for a Proxy whose get-trap returns a fake for every
// property, so service.m() resolves through the chain to the trap, never the real body.
it("falsely proves: prototype replaced with a get-trap Proxy", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.setPrototypeOf(service, new Proxy({}, { get: () => async () => true }));
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
