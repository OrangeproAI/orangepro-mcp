import { Test } from "@nestjs/testing";
import { ApplicationService } from "./application.service";
// canonical real proof
it("proves: minimal real target call", async () => {
  const moduleRef = await Test.createTestingModule({ providers: [ApplicationService] }).compile();
  const service = moduleRef.get(ApplicationService);
  const result = await service.uploadDefaultPackageFilesAndSetFileIds();
  expect(result).toBeDefined();
});