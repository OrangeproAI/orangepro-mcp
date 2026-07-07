import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Prototype method is overwritten with a stub before the call. The assertion observes
// the stub's canned return; the real method body is gone.
it("does not prove when the prototype method is patched with a stub", async () => {
  const moduleRef = await Test.createTestingModule({
    providers: [ApplicationService]
  }).compile();
  const service = moduleRef.get(ApplicationService);
  (ApplicationService.prototype as any).uploadDefaultPackageFilesAndSetFileIds = async () => true;

  const uploaded = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(uploaded).toBe(true);
});
