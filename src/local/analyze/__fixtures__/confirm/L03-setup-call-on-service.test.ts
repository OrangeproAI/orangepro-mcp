import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// real proof + a non-target setup call
it("proves: setup call then real target", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  await service.onModuleInit();
  const result = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(result).toBeDefined();
});