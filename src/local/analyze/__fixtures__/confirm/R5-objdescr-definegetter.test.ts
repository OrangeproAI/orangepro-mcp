import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Target replaced via the legacy accessor combo service.__defineGetter__ (defines an own getter that shadows the prototype method). Real body bypassed.
it("does not prove when the target is replaced via __defineGetter__", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  service.__defineGetter__("uploadDefaultPackageFilesAndSetFileIds", () => async () => true);
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
