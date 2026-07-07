import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Same as the CAUGHT V102 Object.defineProperty(service, ...) -- but the receiver is
// the FRESH prototype expression, not the bound instance. defineProperty's receiver is
// resolved through bindingForReceiver, which only matches a bare bound identifier.
it("does not prove when defineProperty patches a freshly-resolved prototype", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.defineProperty(
    moduleRef.get(ApplicationService).constructor.prototype,
    "uploadDefaultPackageFilesAndSetFileIds",
    { value: async () => true }
  );
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
