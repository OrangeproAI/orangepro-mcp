import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// two real target calls, both asserted (no substitution)
it("proves: two real target calls", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const a = await service.uploadDefaultPackageFilesAndSetFileIds();
  const b = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(a).toBeDefined();
  expect(b).toBeDefined();
});