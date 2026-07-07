import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// Target replaced via Object.defineProperties (PLURAL); gate only recognizes singular Object.defineProperty and reads args[1] as a string. Real body bypassed.
it("does not prove when the target is replaced via Object.defineProperties", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  Object.defineProperties(service, { uploadDefaultPackageFilesAndSetFileIds: { value: async () => true } });
  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(uploaded).toBe(true);
});
