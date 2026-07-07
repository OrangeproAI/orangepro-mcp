import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";

// Guards that DI resolved the real concrete class (not a stub), then exercises the
// REAL target and asserts its REAL result. SHOULD prove.
it("resolves the real ApplicationService and uploads", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);

  expect(service).toBeInstanceOf(ApplicationService);

  const ok = await service.uploadDefaultPackageFilesAndSetFileIds();

  expect(ok).toBe(true);
});
